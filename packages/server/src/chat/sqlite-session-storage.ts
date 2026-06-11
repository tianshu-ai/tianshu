// SQLite-backed implementation of pi-agent-core's
// `SessionStorage<TMetadata>` interface.
//
// Why this exists: pi's harness reads/writes a session as a tree
// of typed entries (message, compaction, label, model_change, ...).
// Tianshu has its own `messages` SQLite table (extended in
// migration 003 with entry_type / entry_details / parent_id) and
// wants to keep using it — so we expose pi's interface as a thin
// adapter on top of the SQL.
//
// Mapping cheat sheet:
//   pi entry             | tianshu messages row
//   ---------------------|----------------------------------------------
//   { type: "message" }  | role ∈ {user,assistant,tool},
//                          content = JSON.stringify(AgentMessage),
//                          entry_type = "message",
//                          entry_details = NULL
//   any other type       | role = "system",
//                          content = "" (unused),
//                          entry_type = entry.type,
//                          entry_details = JSON.stringify(rest of entry)
//
// `parent_id` always points at the entry that came immediately
// before this one in the active branch (NULL for the first entry).
// `sessions.leaf_id` records the most-recently-appended entry in
// the active branch.
//
// `findEntries(type)` reverses: pulls rows by entry_type, then
// reconstructs the typed entry from `entry_details` (plus core
// fields).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentMessage,
  SessionMetadata,
  SessionStorage,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { TenantContext } from "../core/index.js";
import {
  cacheGet,
  cachePut,
  fitToLimit,
  imageFitCacheKey,
} from "./image-fit.js";

/**
 * How `getPathToRoot` should hydrate stored `{type:"image"}` parts
 * before handing the path back to pi's LLM call site.
 *
 * `userHome` is the per-user root the wire-side `path` field is
 * relative to (e.g. `/tenant/users/<userId>`). `imageMaxBytes` is
 * the model's encoded-base64 budget; `supportsImages` is the
 * vision flag from `ResolvedModelInfo`.
 *
 * Caller leaves this unset on storages that don't drive an LLM
 * call (manual compact, repo-level fork, tests). In that case
 * `getPathToRoot` returns image parts with their stored shape
 * untouched. */
export interface ImageInflateOptions {
  userHome: string;
  imageMaxBytes: number;
  supportsImages: boolean;
}

interface MessagesRow {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  parent_id: string | null;
  entry_type: string;
  entry_details: string | null;
  created_at: number;
}

interface SessionRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  status: string;
  kind: string;
  worker_role: string | null;
  title: string | null;
  leaf_id: string | null;
  created_at: number;
}

export interface SqliteSessionMetadata extends SessionMetadata {
  /** Tenant id. Same value for the lifetime of a session. */
  tenantId: string;
  /** Owner user id. */
  userId: string;
  /** Worker / chat / system kind, mirrors `sessions.kind`. */
  kind: "user" | "worker" | "system";
  /** Optional worker role tag (e.g. "llm"). */
  workerRole: string | null;
  /** Parent session id (for forks). */
  parentSessionId: string | null;
  /** Session display title. */
  title: string | null;
}

/**
 * Sidecar slot the chat handler uses to attach `attachments[]`
 * to the next user message the harness creates. Workboard /
 * worker callers don't need this; chat callers set it just before
 * `harness.prompt()` and clear it inside the consumer.
 *
 * Why it's a per-storage field rather than a parameter: the
 * harness owns user-message creation, so we have no callsite to
 * pass attachments through. The closure-style sidecar lets the
 * storage stamp them onto the JSON for the *first* user-role
 * message it sees, then forget.
 */
export interface PendingUserAttachments {
  /** Cleared after the first user message lands. Subsequent
   *  user messages in the same turn (e.g. follow-up after a
   *  tool result) won't pick this up. */
  attachments: unknown[];
}

export class SqliteSessionStorage
  implements SessionStorage<SqliteSessionMetadata>
{
  /** Optional: when set, the next user-role message persisted
   *  through `appendEntry` gets the `attachments` array spliced
   *  into its JSON content as a sibling field. Cleared after one
   *  use. */
  pendingUserAttachments: PendingUserAttachments | null = null;

  /** Optional: when set, `getPathToRoot` reads the bytes for every
   *  `{type:"image"}` part it finds in a user message, runs them
   *  through `fitToLimit`, and emits a fresh ImageContent with
   *  inline base64. Failed reads degrade to a short text note —
   *  same shape the chat handler used to write before N+6.4. */
  imageInflate: ImageInflateOptions | null = null;

  constructor(
    private readonly ctx: TenantContext,
    private readonly sessionId: string,
    options: { imageInflate?: ImageInflateOptions } = {},
  ) {
    this.imageInflate = options.imageInflate ?? null;
  }

  async getMetadata(): Promise<SqliteSessionMetadata> {
    const row = this.ctx.db
      .prepare<[string], SessionRow>(
        `SELECT id, user_id, parent_id, status, kind, worker_role, title, leaf_id, created_at
         FROM sessions WHERE id = ?`,
      )
      .get(this.sessionId);
    if (!row) throw new Error(`session not found: ${this.sessionId}`);
    return {
      id: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      tenantId: this.ctx.tenantId,
      userId: row.user_id,
      kind: row.kind as SqliteSessionMetadata["kind"],
      workerRole: row.worker_role,
      parentSessionId: row.parent_id,
      title: row.title,
    };
  }

  async getLeafId(): Promise<string | null> {
    const row = this.ctx.db
      .prepare<[string], { leaf_id: string | null }>(
        `SELECT leaf_id FROM sessions WHERE id = ?`,
      )
      .get(this.sessionId);
    return row?.leaf_id ?? null;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    this.ctx.db
      .prepare<[string | null, string], unknown>(
        `UPDATE sessions SET leaf_id = ? WHERE id = ?`,
      )
      .run(leafId, this.sessionId);
  }

  async createEntryId(): Promise<string> {
    return `msg_${randomUUID()}`;
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    // If the chat handler stashed attachments for this turn,
    // splice them onto the first user message we persist.
    let mutated = entry;
    if (
      this.pendingUserAttachments &&
      entry.type === "message" &&
      entry.message.role === "user"
    ) {
      const m = entry.message as unknown as Record<string, unknown>;
      const merged = {
        ...m,
        attachments: this.pendingUserAttachments.attachments,
      };
      mutated = {
        ...entry,
        message: merged as unknown as typeof entry.message,
      };
      this.pendingUserAttachments = null;
    }
    const row = entryToRow(this.sessionId, mutated);
    this.ctx.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string | null,
          string,
          string | null,
          number,
        ],
        unknown
      >(
        `INSERT INTO messages
           (id, session_id, role, content, parent_id, entry_type, entry_details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.session_id,
        row.role,
        row.content,
        row.parent_id,
        row.entry_type,
        row.entry_details,
        row.created_at,
      );
    // Advance the leaf so the next appendMessage call picks this
    // row as its parent. Pi's Session class reads the leafId at
    // turn-start time but never writes it back — the storage owns
    // that responsibility. Without this, every entry in a turn
    // gets the SAME parent (the leaf at turn-start), which makes
    // path-to-root walk only return one entry.
    await this.setLeafId(mutated.id);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const row = this.ctx.db
      .prepare<[string, string], MessagesRow>(
        `SELECT id, session_id, role, content, parent_id, entry_type, entry_details, created_at
         FROM messages WHERE session_id = ? AND id = ?`,
      )
      .get(this.sessionId, id);
    return row ? rowToEntry(row) : undefined;
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    const rows = this.ctx.db
      .prepare<[string, string], MessagesRow>(
        `SELECT id, session_id, role, content, parent_id, entry_type, entry_details, created_at
         FROM messages WHERE session_id = ? AND entry_type = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(this.sessionId, type);
    return rows.map((r) => rowToEntry(r) as never);
  }

  async getLabel(id: string): Promise<string | undefined> {
    // Labels are stored as their own entries (`entry_type='label'`)
    // and reference the labelled entry via `targetId`. The most
    // recent label wins.
    const rows = this.ctx.db
      .prepare<[string], MessagesRow>(
        `SELECT id, session_id, role, content, parent_id, entry_type, entry_details, created_at
         FROM messages WHERE session_id = ? AND entry_type = 'label'
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(this.sessionId);
    for (const r of rows) {
      const entry = rowToEntry(r);
      if (entry.type === "label" && entry.targetId === id) {
        return entry.label ?? undefined;
      }
    }
    return undefined;
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (!leafId) return [];
    const rows = this.ctx.db
      .prepare<[string], MessagesRow>(
        `SELECT id, session_id, role, content, parent_id, entry_type, entry_details, created_at
         FROM messages WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(this.sessionId);
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    let path: SessionTreeEntry[] = [];
    let cursor: string | null = leafId;
    const guard = new Set<string>();
    while (cursor) {
      if (guard.has(cursor)) break;
      guard.add(cursor);
      const r = byId.get(cursor);
      if (!r) break;
      path.unshift(rowToEntry(r));
      cursor = r.parent_id;
    }
    // Migration 004 guarantees every session's parent_id forms a
    // strict chronological chain rooted at NULL, so the walk above
    // covers every row when leafId is current. We deliberately
    // don't paper over a short walk here — if it happens we want
    // to see it (storage corruption / out-of-date leaf_id) rather
    // than silently splice rows in.
    if (this.imageInflate) {
      const inflate = this.imageInflate;
      path = await Promise.all(
        path.map(async (entry) =>
          entry.type === "message" && entry.message.role === "user"
            ? {
                ...entry,
                message: await inflateUserImages(entry.message, inflate),
              }
            : entry,
        ),
      );
    }
    return path;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    const rows = this.ctx.db
      .prepare<[string], MessagesRow>(
        `SELECT id, session_id, role, content, parent_id, entry_type, entry_details, created_at
         FROM messages WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(this.sessionId);
    return rows.map(rowToEntry);
  }
}

// ─── row ↔ entry conversion ─────────────────────────────────────

function entryToRow(
  sessionId: string,
  entry: SessionTreeEntry,
): {
  id: string;
  session_id: string;
  role: MessagesRow["role"];
  content: string;
  parent_id: string | null;
  entry_type: string;
  entry_details: string | null;
  created_at: number;
} {
  const created_at = Date.parse(entry.timestamp) || Date.now();
  if (entry.type === "message") {
    const m = entry.message;
    const role: MessagesRow["role"] =
      m.role === "toolResult" ? "tool" : (m.role as MessagesRow["role"]);
    return {
      id: entry.id,
      session_id: sessionId,
      role,
      content: JSON.stringify(m),
      parent_id: entry.parentId,
      entry_type: "message",
      entry_details: null,
      created_at,
    };
  }
  // Non-message entries are stamped with role='system'; the actual
  // payload lives in `entry_details`. We strip the four base
  // fields the writer already encodes elsewhere (id / parentId /
  // timestamp / type) and stash the remaining typed fields under
  // entry_details. The cast through Record satisfies the
  // type-checker; entry-shape correctness is the caller's concern.
  const erased = entry as unknown as Record<string, unknown>;
  const rest = { ...erased };
  delete rest.id;
  delete rest.parentId;
  delete rest.timestamp;
  delete rest.type;
  return {
    id: entry.id,
    session_id: sessionId,
    role: "system",
    content: "",
    parent_id: entry.parentId,
    entry_type: entry.type,
    entry_details: JSON.stringify(rest),
    created_at,
  };
}

function rowToEntry(row: MessagesRow): SessionTreeEntry {
  const base = {
    id: row.id,
    parentId: row.parent_id,
    timestamp: new Date(row.created_at).toISOString(),
  };
  if (row.entry_type === "message") {
    const message = parseMessage(row.content, row.role);
    return { type: "message", ...base, message };
  }
  const parsed = row.entry_details ? safeParse(row.entry_details) : null;
  const details =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  // Cast through unknown — the `details` JSON keys have to line up
  // with the typed entry's fields (we control the writer).
  return { type: row.entry_type, ...base, ...details } as unknown as SessionTreeEntry;
}

function parseMessage(content: string, role: MessagesRow["role"]): AgentMessage {
  const parsed = safeParse(content);
  if (
    parsed &&
    typeof parsed === "object" &&
    typeof (parsed as { role?: unknown }).role === "string"
  ) {
    return parsed as AgentMessage;
  }
  // Legacy plain-text rows: best-effort upgrade.
  if (role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: content } as never],
      timestamp: Date.now(),
    } as UserMessage;
  }
  if (role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text: content } as never],
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
      } as never,
      api: "anthropic" as never,
      provider: "unknown" as never,
      model: "unknown",
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
  }
  if (role === "tool") {
    return {
      role: "toolResult",
      toolCallId: "",
      toolName: "",
      content: [{ type: "text", text: content } as never],
      isError: false,
      timestamp: Date.now(),
    } as unknown as ToolResultMessage;
  }
  // 'system' entries shouldn't reach this path (we route non-message
  // entries through entry_details). Fallback to a synthetic user
  // message to keep types happy.
  return {
    role: "user",
    content: [{ type: "text", text: content } as never],
    timestamp: Date.now(),
  } as UserMessage;
}

/**
 * Hydrate a user message's `{type:"image"}` parts before the LLM
 * call.
 *
 * Stored shape: `{ type:"image", path, mimeType, name?, size?,
 * data:"" }`. The chat handler writes this when the user uploads
 * a file (size + path are stable, base64 isn't — stuffing it on
 * disk would bloat every read). At LLM-call time we resolve the
 * path under `userHome`, run the bytes through `fitToLimit` (which
 * caches by path|mtime|maxBytes) and emit a fresh ImageContent
 * with inline base64.
 *
 * Three failure shapes degrade to a short text note instead of
 * poisoning the request:
 *   - vision-incapable model → `[Attached image (no vision support):
 *     <name>]`
 *   - file vanished or read errored → `[Attached image: <name> —
 *     read failed: <reason>]`
 *   - already-inlined image (no `path`) → pass through verbatim
 */
async function inflateUserImages(
  msg: AgentMessage,
  options: ImageInflateOptions,
): Promise<AgentMessage> {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
  const parts = msg.content as unknown as Array<Record<string, unknown>>;
  let mutated = false;
  const out: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type !== "image") {
      out.push(part);
      continue;
    }
    const data = typeof part.data === "string" ? part.data : "";
    const filePath =
      typeof part.path === "string" && part.path.length > 0
        ? (part.path as string)
        : "";
    const name =
      typeof part.name === "string"
        ? (part.name as string)
        : filePath
          ? path.basename(filePath)
          : "image";
    if (data.length > 0) {
      // Already inlined (e.g. a turn we just persisted) — keep it.
      out.push(part);
      continue;
    }
    if (!options.supportsImages) {
      out.push({
        type: "text",
        text: `[Attached image (current model has no vision support): ${name}]`,
      });
      mutated = true;
      continue;
    }
    if (!filePath) {
      // Nothing to read — strip and degrade.
      out.push({
        type: "text",
        text: `[Attached image: ${name} — read failed (empty payload)]`,
      });
      mutated = true;
      continue;
    }
    const abs = path.join(
      options.userHome,
      filePath.startsWith("/") ? filePath.slice(1) : filePath,
    );
    try {
      const stat = fs.statSync(abs);
      const cacheKey = imageFitCacheKey(
        abs,
        stat.mtimeMs,
        options.imageMaxBytes,
      );
      const cached = cacheGet(cacheKey);
      let buf: Buffer;
      let mimeType: string;
      if (cached) {
        buf = cached.buf;
        mimeType = cached.mimeType;
      } else {
        const raw = fs.readFileSync(abs);
        const mt = typeof part.mimeType === "string" ? part.mimeType : "";
        const fitted = await fitToLimit(raw, mt, options.imageMaxBytes);
        buf = fitted.buf;
        mimeType = fitted.mimeType;
        cachePut(cacheKey, buf, mimeType);
      }
      out.push({
        type: "image",
        data: buf.toString("base64"),
        mimeType,
      });
      mutated = true;
    } catch (err) {
      const reason =
        (err as { message?: string } | null)?.message ?? "read failed";
      out.push({
        type: "text",
        text: `[Attached image: ${name} — read failed: ${reason}]`,
      });
      mutated = true;
    }
  }
  if (!mutated) return msg;
  return { ...msg, content: out } as unknown as AgentMessage;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
