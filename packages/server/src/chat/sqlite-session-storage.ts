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
} from "@earendil-works/pi-agent-core";
import type {
  Entry,
  EntryQuery,
  BranchBounds,
  LaneRecord,
  NewRecord,
  OperationStartedRecord,
  ProvisionedEntry,
  RecordQuery,
  SessionMetadata,
  SessionStorage,
  SessionStats,
  LogItem,
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
  parentSessionId?: string;
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
  /** Internal monotonic counter used to assign seq to entries/records. */
  private _seqCounter = 0;
  /** Optional: when set, the next user-role message persisted
   *  through `appendEntry` gets the `attachments` array spliced
   *  into its JSON content as a sibling field. Cleared after one
   *  use. */
  pendingUserAttachments: PendingUserAttachments | null = null;
  /** Inbox events to splice onto the next persisted user message. */
  pendingInboxEvents: unknown[] | null = null;

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
      createdAt: row.created_at,
      tenantId: this.ctx.tenantId,
      userId: row.user_id,
      kind: row.kind as SqliteSessionMetadata["kind"],
      workerRole: row.worker_role,
      parentSessionId: row.parent_id ?? undefined,
      title: row.title,
    };
  }

  async getName(): Promise<string | undefined> {
    const row = this.ctx.db
      .prepare<[string], { title: string | null }>(
        `SELECT title FROM sessions WHERE id = ?`,
      )
      .get(this.sessionId);
    return row?.title ?? undefined;
  }

  async setName(name: string | undefined): Promise<void> {
    this.ctx.db
      .prepare<[string | null, string], unknown>(
        `UPDATE sessions SET title = ? WHERE id = ?`,
      )
      .run(name ?? null, this.sessionId);
  }

  async getStats(): Promise<SessionStats> {
    const count = this.ctx.db
      .prepare<[string], { cnt: number }>(
        `SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?`,
      )
      .get(this.sessionId);
    return {
      messageCount: count?.cnt ?? 0,
      cachedTokens: 0,
      uncachedTokens: 0,
      totalTokens: 0,
      costTotal: 0,
    };
  }

  async getLanes(): Promise<{ lane: string; leafId: string | null }[]> {
    const leafId = await this.getLeafId();
    return [{ lane: "main", leafId }];
  }

  async createLane(_lane: string, _at: string | null): Promise<void> {
    // Single-lane: no-op
  }

  async moveLane(_lane: string, to: string | null): Promise<void> {
    await this.setLeafId(to);
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
      if ((entry.type as string) === "label" && (entry as unknown as { targetId?: string }).targetId === id) {
        return (entry as unknown as { label?: string }).label ?? undefined;
      }
    }
    return undefined;
  }

  async setLabel(id: string, label: string | undefined): Promise<void> {
    // Store as a label entry
    const entryId = await this.createEntryId();
    const leafId = await this.getLeafId();
    const entry: ProvisionedEntry = {
      type: "custom" as Entry["type"],
      id: entryId,
      customType: "label",
      data: { targetId: id, label },
    } as unknown as ProvisionedEntry;
    await this.appendEntry(entry, "main");
    void leafId; // suppress unused
  }

  async createEntryId(): Promise<string> {
    return `msg_${randomUUID()}`;
  }

  private nextSeq(): number {
    return ++this._seqCounter;
  }

  async appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, _lane: string): Promise<TEntry> {
    // If the chat handler stashed attachments for this turn,
    // splice them onto the first user message we persist.
    let mutated: ProvisionedEntry<TEntry> = entry;
    if (
      this.pendingUserAttachments &&
      entry.type === "message" &&
      (entry as unknown as { message: { role: string } }).message.role === "user"
    ) {
      const m = (entry as unknown as { message: Record<string, unknown> }).message;
      const merged = {
        ...m,
        attachments: this.pendingUserAttachments.attachments,
      };
      mutated = {
        ...entry,
        message: merged as unknown as (typeof entry & { type: "message" })["message" & keyof typeof entry],
      } as unknown as ProvisionedEntry<TEntry>;
      this.pendingUserAttachments = null;
    }
    // Splice inbox events onto user message (same pattern).
    if (
      this.pendingInboxEvents &&
      mutated.type === "message" &&
      (mutated as unknown as { message: { role: string } }).message.role === "user"
    ) {
      const m = (mutated as unknown as { message: Record<string, unknown> }).message;
      mutated = {
        ...mutated,
        message: { ...m, inboxEvents: this.pendingInboxEvents },
      } as unknown as ProvisionedEntry<TEntry>;
      this.pendingInboxEvents = null;
    }
    const leafId = await this.getLeafId();
    const seq = this.nextSeq();
    const now = Date.now();
    // Synthesise the full entry with seq, parentId, timestamp
    const fullEntry = {
      ...mutated,
      seq,
      parentId: leafId,
      timestamp: now,
    } as unknown as TEntry;
    const row = entryToRow(this.sessionId, fullEntry as unknown as Entry);
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
    // row as its parent.
    await this.setLeafId(fullEntry.id);
    return fullEntry;
  }

  async appendRecord<TRecord extends LaneRecord>(
    record: NewRecord<TRecord>,
  ): Promise<TRecord> {
    // Lane records are an operational log. We don't persist them to
    // SQLite (they're ephemeral runtime state in pi's harness). Return
    // the record with synthesised seq/timestamp so the caller can
    // proceed.
    return {
      ...record,
      seq: this.nextSeq(),
      timestamp: Date.now(),
    } as unknown as TRecord;
  }

  async findEntriesOnBranch(
    _query: EntryQuery & BranchBounds & { start: string },
  ): Promise<Entry[]> {
    // Walk the branch from `start` toward root, applying query filters.
    // For now, delegate to the path-to-root walker and filter.
    const path = await this.getPathToRoot(_query.start);
    let entries: Entry[] = path as unknown as Entry[];
    if (_query.type) {
      entries = entries.filter((e) => e.type === _query.type);
    }
    if (_query.stopAtType) {
      const idx = entries.findIndex((e) => e.type === _query.stopAtType);
      if (idx >= 0) entries = entries.slice(idx);
    }
    if (_query.limit) {
      entries = entries.slice(0, _query.limit);
    }
    return entries;
  }

  async findRecords<K extends LaneRecord["type"]>(
    _query?: RecordQuery & { type?: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]> {
    // Lane records are not persisted to SQLite.
    return [] as Extract<LaneRecord, { type: K }>[];
  }

  async findOpenOperations(
    _lane: string,
    _options?: { limit?: number },
  ): Promise<OperationStartedRecord[]> {
    return [];
  }

  async getLog(
    _options?: { afterSeq?: number; limit?: number },
  ): Promise<LogItem[]> {
    return [];
  }

  async getEntry(id: string): Promise<Entry | undefined> {
    const row = this.ctx.db
      .prepare<[string, string], MessagesRow>(
        `SELECT id, session_id, role, content, parent_id, entry_type, entry_details, created_at
         FROM messages WHERE session_id = ? AND id = ?`,
      )
      .get(this.sessionId, id);
    return row ? rowToEntry(row) : undefined;
  }

  async findEntries(
    query?: EntryQuery,
  ): Promise<Entry[]> {
    if (query?.type) {
      const rows = this.ctx.db
        .prepare<[string, string], MessagesRow>(
          `SELECT id, session_id, role, content, parent_id, entry_type, entry_details, created_at
           FROM messages WHERE session_id = ? AND entry_type = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(this.sessionId, query.type);
      let entries = rows.map(rowToEntry);
      if (query.limit) entries = entries.slice(0, query.limit);
      return entries;
    }
    const rows = this.ctx.db
      .prepare<[string], MessagesRow>(
        `SELECT id, session_id, role, content, parent_id, entry_type, entry_details, created_at
         FROM messages WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(this.sessionId);
    let entries = rows.map(rowToEntry);
    if (query?.limit) entries = entries.slice(0, query.limit);
    return entries;
  }

  async getPathToRoot(leafId: string | null): Promise<Entry[]> {
    console.log(`[storage] getPathToRoot called, session=${this.sessionId}, leafId=${leafId?.slice(0,8)}`);
    if (!leafId) return [];
    const rows = this.ctx.db
      .prepare<[string], MessagesRow>(
        `SELECT id, session_id, role, content, parent_id, entry_type, entry_details, created_at
         FROM messages WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(this.sessionId);
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    let path: Entry[] = [];
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
          entry.type === "message" && (entry as { message: AgentMessage }).message.role === "user"
            ? {
                ...entry,
                message: await inflateUserImages((entry as { message: AgentMessage }).message, inflate),
              } as unknown as Entry
            : entry,
        ),
      );
    }
    // Filter orphaned toolResult entries (can appear after compaction
    // removes the assistant message containing the toolCall but keeps
    // the toolResult). Without this, Anthropic rejects with 400.
    console.log(`[storage] getPathToRoot: ${path.length} entries before filter, session=${this.sessionId}`);
    // Brute-force search for any entry containing the problematic ID pattern
    for (const entry of path) {
      const json = JSON.stringify(entry);
      // Search for any tool_use_id / toolCallId patterns
      const idMatches = json.match(/toolu_bdrk_[A-Za-z0-9]+/g);
      if (idMatches) {
        for (const id of new Set(idMatches)) {
          const isToolCall = json.includes(`"type":"toolCall"`) && json.includes(`"id":"${id}"`);
          const isToolResult = json.includes(`"toolCallId":"${id}"`);
          const entryType = entry.type;
          const role = entryType === "message" ? (entry as { message: { role: string } }).message.role : entryType;
          if (isToolCall) console.log(`[storage]   toolCall id=${id} role=${role} entry=${entry.id}`);
          if (isToolResult) console.log(`[storage]   toolResult ref=${id} role=${role} entry=${entry.id}`);
          if (!isToolCall && !isToolResult) console.log(`[storage]   OTHER ref=${id} role=${role} entry=${entry.id} snippet=${json.slice(json.indexOf(id) - 30, json.indexOf(id) + 60)}`);
        }
      }
    }
    const filtered = filterOrphanedToolResults(path);
    const patched = patchDanglingToolCalls(filtered);
    // Re-run orphan filter: patchDanglingToolCalls may have stripped
    // toolCall blocks, turning their paired toolResults into new orphans.
    const refiltered = filterOrphanedToolResults(patched);
    const sanitized = stripNestedOrphanToolBlocks(refiltered);
    console.log(`[storage] getPathToRoot: ${sanitized.length} entries after filter (removed ${path.length - sanitized.length})`);
    return sanitized;
  }
}

// ─── row ↔ entry conversion ─────────────────────────────────────

function entryToRow(
  sessionId: string,
  entry: Entry,
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
  const created_at = typeof entry.timestamp === "number" ? entry.timestamp : (Date.parse(String(entry.timestamp)) || Date.now());
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

function rowToEntry(row: MessagesRow): Entry {
  const base = {
    id: row.id,
    parentId: row.parent_id,
    seq: 0,
    timestamp: row.created_at,
  };
  if (row.entry_type === "message") {
    const message = parseMessage(row.content, row.role);
    return { type: "message", ...base, message } as unknown as Entry;
  }
  const parsed = row.entry_details ? safeParse(row.entry_details) : null;
  const details =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  // Cast through unknown — the `details` JSON keys have to line up
  // with the typed entry's fields (we control the writer).
  return { type: row.entry_type, ...base, ...details } as unknown as Entry;
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

// ─── Orphan filter ────────────────────────────────────────────────────
/**
 * Remove toolResult entries whose toolCallId doesn't match any toolCall
 * in a prior assistant message. Prevents Anthropic 400 after compaction.
 */
function filterOrphanedToolResults(path: Entry[]): Entry[] {
  // Anthropic requires every tool_result to reference a tool_use from
  // the IMMEDIATELY PRECEDING assistant message. After compaction,
  // ordering can break this invariant. We fix it by tracking which
  // toolCall ids are in the "current" (most recent) assistant message
  // and dropping any toolResult that references a different one.
  //
  // Walk entries in order. Track the last-seen assistant's toolCall ids.
  // Any toolResult whose toolCallId is NOT in that set gets dropped.

  // First pass: flatten the path into a linear message sequence
  // (expanding retainedTails inline).
  interface MsgRef {
    role: string;
    toolCallId?: string;
    toolCallIds?: Set<string>; // for assistant msgs
    entryIdx: number;
    tailIdx?: number; // if inside a retainedTail
  }
  const msgs: MsgRef[] = [];
  for (let i = 0; i < path.length; i++) {
    const entry = path[i];
    if (entry.type === "message") {
      const msg = (entry as { message: { role: string; toolCallId?: string; content?: unknown[] } }).message;
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const ids = new Set<string>();
        for (const part of msg.content) {
          const p = part as { type?: string; id?: string };
          if (p.type === "toolCall" && p.id) ids.add(p.id);
        }
        msgs.push({ role: "assistant", toolCallIds: ids, entryIdx: i });
      } else if (msg.role === "toolResult") {
        msgs.push({ role: "toolResult", toolCallId: msg.toolCallId, entryIdx: i });
      } else {
        msgs.push({ role: msg.role, entryIdx: i });
      }
    } else if (entry.type === "compaction") {
      const ce = entry as { retainedTail?: Array<{ role: string; toolCallId?: string; content?: unknown[] }> };
      msgs.push({ role: "compaction", entryIdx: i });
      if (Array.isArray(ce.retainedTail)) {
        for (let t = 0; t < ce.retainedTail.length; t++) {
          const msg = ce.retainedTail[t];
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            const ids = new Set<string>();
            for (const part of msg.content) {
              const p = part as { type?: string; id?: string };
              if (p.type === "toolCall" && p.id) ids.add(p.id);
            }
            msgs.push({ role: "assistant", toolCallIds: ids, entryIdx: i, tailIdx: t });
          } else if (msg.role === "toolResult") {
            msgs.push({ role: "toolResult", toolCallId: msg.toolCallId, entryIdx: i, tailIdx: t });
          } else {
            msgs.push({ role: msg.role, entryIdx: i, tailIdx: t });
          }
        }
      }
    }
  }

  // Second pass: walk msgs in order, track last assistant's toolCallIds,
  // collect indices of orphaned toolResults to remove.
  let lastAssistantIds = new Set<string>();
  const orphanEntryIndices = new Set<number>(); // top-level entry indices to drop
  const orphanTailPositions: Map<number, Set<number>> = new Map();
  for (const m of msgs) {
    if (m.role === "assistant" && m.toolCallIds) {
      lastAssistantIds = m.toolCallIds;
    } else if (m.role === "toolResult" && m.toolCallId) {
      if (!lastAssistantIds.has(m.toolCallId)) {
        // Orphan: this toolResult's id is not in the immediately preceding assistant
        if (m.tailIdx !== undefined) {
          if (!orphanTailPositions.has(m.entryIdx)) orphanTailPositions.set(m.entryIdx, new Set());
          orphanTailPositions.get(m.entryIdx)!.add(m.tailIdx);
        } else {
          orphanEntryIndices.add(m.entryIdx);
        }
      }
    }
  }

  const removed = orphanEntryIndices.size + [...orphanTailPositions.values()].reduce((n, s) => n + s.size, 0);
  if (removed > 0) {
    console.log(`[storage] filterOrphanedToolResults: removing ${removed} positionally-orphaned toolResult(s)`);
  }
  if (removed === 0) return path;

  // Third pass: build filtered path
  const filtered: Entry[] = [];
  for (let i = 0; i < path.length; i++) {
    if (orphanEntryIndices.has(i)) continue;
    const entry = path[i];
    const tailDrops = orphanTailPositions.get(i);
    if (tailDrops && entry.type === "compaction") {
      const ce = entry as { retainedTail?: unknown[] };
      if (Array.isArray(ce.retainedTail)) {
        const cleanTail = ce.retainedTail.filter((_: unknown, t: number) => !tailDrops.has(t));
        filtered.push({ ...entry, retainedTail: cleanTail } as unknown as Entry);
        continue;
      }
    }
    filtered.push(entry);
  }
  return filtered;
}

/**
 * Strip toolCall blocks from assistant messages when no matching
 * toolResult exists anywhere in the path. This happens when a
 * harness abort / cancel interrupts tool execution after the
 * assistant message was persisted but before the toolResult landed.
 * Anthropic rejects requests where tool_use has no tool_result.
 */
function patchDanglingToolCalls(path: Entry[]): Entry[] {
  const allToolResultIds = new Set<string>();
  for (const entry of path) {
    if (entry.type !== "message") continue;
    const msg = (entry as { message: { role: string; toolCallId?: string } }).message;
    if (msg.role === "toolResult" && msg.toolCallId) {
      allToolResultIds.add(msg.toolCallId);
    }
  }
  // Also scan compaction retainedTails
  for (const entry of path) {
    if (entry.type !== "compaction") continue;
    const ce = entry as { retainedTail?: Array<{ role: string; toolCallId?: string }> };
    if (!Array.isArray(ce.retainedTail)) continue;
    for (const msg of ce.retainedTail) {
      if (msg.role === "toolResult" && msg.toolCallId) {
        allToolResultIds.add(msg.toolCallId);
      }
    }
  }

  let modified = false;
  const result = path.map((entry) => {
    if (entry.type !== "message") return entry;
    const msg = (entry as { message: { role: string; content?: unknown[] } }).message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return entry;

    const cleaned = msg.content.filter((block: unknown) => {
      const b = block as { type?: string; id?: string };
      if (b.type === "toolCall" && b.id && !allToolResultIds.has(b.id)) {
        console.log(`[storage] patchDanglingToolCalls: stripping toolCall id=${b.id} (no matching toolResult) from entry=${entry.id}`);
        modified = true;
        return false;
      }
      return true;
    });

    if (cleaned.length === msg.content.length) return entry;
    return {
      ...entry,
      message: { ...msg, content: cleaned },
    } as unknown as Entry;
  });

  if (modified) {
    console.log(`[storage] patchDanglingToolCalls: patched assistant entries`);
  }
  return result;
}

/**
 * Strip nested toolCall/toolResult blocks from toolResult messages
 * whose IDs don't match any toolCall in the preceding assistant message.
 *
 * This handles the case where a toolResult entry's content array
 * contains embedded toolCall blocks from an aborted turn — IDs that
 * were never in the assistant's toolCall list.
 */
function stripNestedOrphanToolBlocks(path: Entry[]): Entry[] {
  // Collect all toolCall ids from assistant messages.
  const allToolCallIds = new Set<string>();
  for (const entry of path) {
    if (entry.type !== "message") continue;
    const msg = (entry as { message: { role: string; content?: unknown[] } }).message;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const p = part as { type?: string; id?: string };
        if (p.type === "toolCall" && p.id) allToolCallIds.add(p.id);
      }
    }
  }

  let modified = false;
  const result = path.map((entry) => {
    if (entry.type !== "message") return entry;
    const msg = (entry as { message: { role: string; content?: unknown[] } }).message;
    if (msg.role !== "toolResult" || !Array.isArray(msg.content)) return entry;

    // Scan content for embedded toolCall blocks with orphan IDs
    const cleaned = msg.content.filter((block: unknown) => {
      const b = block as { type?: string; id?: string; toolCallId?: string };
      // Remove toolCall blocks whose ID isn't in any assistant
      if (b.type === "toolCall" && b.id && !allToolCallIds.has(b.id)) {
        console.log(`[storage] stripNestedOrphanToolBlocks: removing embedded toolCall id=${b.id} from toolResult entry=${entry.id}`);
        modified = true;
        return false;
      }
      // Remove toolResult blocks whose toolCallId isn't in any assistant
      if (b.type === "toolResult" && b.toolCallId && !allToolCallIds.has(b.toolCallId)) {
        console.log(`[storage] stripNestedOrphanToolBlocks: removing embedded toolResult ref=${b.toolCallId} from entry=${entry.id}`);
        modified = true;
        return false;
      }
      return true;
    });

    if (cleaned.length === msg.content.length) return entry;
    // Return a patched entry with cleaned content
    return {
      ...entry,
      message: { ...msg, content: cleaned },
    } as unknown as Entry;
  });

  if (modified) {
    console.log(`[storage] stripNestedOrphanToolBlocks: patched entries in path`);
  }
  return result;
}
