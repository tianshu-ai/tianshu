// SqliteStorage — pi-agent-core 0.85 `Storage` implementation.
//
// pi 0.85 rewrote its session persistence contract. The old
// SessionStorage (which SqliteSessionStorage implements) is gone;
// the new contract is `Storage` — a lower-level KV+entries+usage
// interface (see @earendil-works/pi-agent-core/dist/harness/
// session/types.d.ts::Storage). `StorageBackedSession` wraps our
// Storage into the full Session<TMetadata> facade pi's harness
// consumes.
//
// Scope of this module:
//   Implement Storage against tianshu's tenant sqlite DB. Every
//   method is scoped to one session_id (Storage instances are
//   1:1 with sessions). All writes go through a single monotonic
//   `seq` counter (session_seq_counter table) that pi uses to
//   order entries, value updates, list appends, and usage rows.
//
// Not implemented here:
//   - session-level attachments handoff (pendingUserAttachments):
//     still lives on SqliteSessionStorage because it's tianshu-
//     specific glue for the chat handler to inject inbox events
//     and image attachments into the next user message. That
//     module stays alongside this one; handler.ts owns the
//     bridging.
//
// Why we don't reuse InMemoryStorageState:
//   pi ships InMemoryStorageState (materializes all state in memory
//   and reindexes on every commit). Its own docstring says:
//     "This is intentionally unsuitable for database backends and
//     long-running sessions that may not fit in memory. Those
//     backends should query indexed durable state and update
//     durable aggregates within each commit transaction."
//   So we go straight to sqlite. Reads use covering indexes; writes
//   apply per-kind and stamp seq via the counter table.

import type { Database } from "better-sqlite3";
import type { Context } from "@earendil-works/pi-agent-core";
import type {
  CommitResult,
  Entry,
  EntryScan,
  EntryStructure,
  MessageEntry,
  CompactionEntry,
  BranchSummaryEntry,
  CustomEntry,
  NewEntry,
  SessionStats,
  Storage,
  StorageBranchScan,
  UsageRow,
  UsageScan,
  Write,
} from "@earendil-works/pi-agent-core";
import type {
  ListElement,
  ListReadOptions,
  StoredValue,
  Value,
  ValueList,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

// Row shape mirrors the `messages` table augmented by 003-session-tree
// + 015-pi-storage-v2. `entry_type` narrows to pi's EntryType; the
// concrete payload lives either in `content` (message entries) or
// `entry_details` (compaction / branch_summary / custom).
interface MessageRow {
  id: string;
  parent_id: string | null;
  role: string; // legacy: user|assistant|tool|system (only for entry_type='message')
  content: string; // JSON
  created_at: number;
  entry_type: string; // pi EntryType
  entry_details: string | null; // JSON blob for non-message entries
  seq: number | null; // NULL only for legacy rows before 015 backfill
}

interface ValueRow {
  namespace: string;
  key: string;
  value: string; // JSON
  seq: number;
}

interface ListRow {
  namespace: string;
  key: string;
  seq: number;
  value: string; // JSON
}

interface UsageRowSql {
  id: string;
  seq: number;
  usage: string; // JSON
  entry_id: string | null;
  adjustment: number; // 0 | 1
  details: string | null; // JSON
}

/**
 * Concrete Storage implementation over one session's rows in the
 * tenant sqlite DB.
 *
 * Instances are cheap; construct one per Session lifecycle. The
 * class doesn't hold a connection — the db handle passed in is
 * owned by the caller (the tenant context).
 */
export class SqliteStorage implements Storage {
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly sessionId: string,
  ) {}

  // ─── entries ────────────────────────────────────────────────

  async getEntries(
    ids: string[],
    _ctx: Context,
  ): Promise<Map<string, Entry>> {
    this.assertOpen();
    const out = new Map<string, Entry>();
    if (ids.length === 0) return out;
    // sqlite has no array binding; do individual lookups (small N in
    // practice, and the pk lookup is O(1)).
    const stmt = this.db.prepare<[string, string], MessageRow>(
      `SELECT id, parent_id, role, content, created_at, entry_type,
              entry_details, seq
       FROM messages WHERE session_id = ? AND id = ?`,
    );
    for (const id of ids) {
      const row = stmt.get(this.sessionId, id);
      if (row) out.set(id, rowToEntry(row));
    }
    return out;
  }

  async scanBranch(
    query: StorageBranchScan,
    _ctx: Context,
  ): Promise<Entry[]> {
    this.assertOpen();
    // Walk from `query.start` toward the root, respecting order +
    // stop / type filters. Sqlite doesn't have recursive CTE by
    // default, but we can walk parent_id iteratively — a session's
    // depth is bounded by user turns.
    const walkStmt = this.db.prepare<[string, string], MessageRow>(
      `SELECT id, parent_id, role, content, created_at, entry_type,
              entry_details, seq
       FROM messages WHERE session_id = ? AND id = ?`,
    );
    // Materialise the ancestor chain from `start` to root.
    const chain: MessageRow[] = [];
    let cursor: string | null = query.start;
    while (cursor) {
      const row = walkStmt.get(this.sessionId, cursor);
      if (!row) break;
      chain.push(row);
      // Early stop by id or type.
      if (query.stopAtId && row.id === query.stopAtId) break;
      if (
        query.stopAtType &&
        (row.entry_type as EntryTypeStr) === query.stopAtType
      )
        break;
      cursor = row.parent_id;
    }
    // Filter by type / customType if requested.
    let filtered = chain.filter((r) => {
      if (query.type && r.entry_type !== query.type) return false;
      if (query.customType) {
        const details = r.entry_details ? JSON.parse(r.entry_details) : null;
        if (!details || details.customType !== query.customType) return false;
      }
      return true;
    });
    // Cursor pagination (seq-based).
    if (query.cursor) {
      const from = query.cursor.seq;
      filtered = filtered.filter((r) => (r.seq ?? 0) < from);
    }
    // Order.
    if (query.order === "oldestFirst") {
      filtered.reverse();
    }
    // Limit.
    if (query.limit && query.limit > 0) filtered = filtered.slice(0, query.limit);
    return filtered.map(rowToEntry);
  }

  async scanBranchStructure(
    query: StorageBranchScan,
    _ctx: Context,
  ): Promise<EntryStructure[]> {
    // Same walk as scanBranch but return only structural columns.
    const entries = await this.scanBranch(query, _ctx);
    return entries.map((e) => ({
      id: e.id,
      parentId: e.parentId,
      seq: e.seq,
      timestamp: e.timestamp,
      type: e.type,
      customType: (e as { customType?: string }).customType,
    }));
  }

  async scanEntries(query: EntryScan, _ctx: Context): Promise<Entry[]> {
    this.assertOpen();
    // Global scan by seq range (not confined to one branch).
    const clauses: string[] = ["session_id = ?"];
    const bindings: unknown[] = [this.sessionId];
    if (query.type) {
      clauses.push("entry_type = ?");
      bindings.push(query.type);
    }
    if (query.fromSeq !== undefined) {
      clauses.push("seq >= ?");
      bindings.push(query.fromSeq);
    }
    if (query.toSeq !== undefined) {
      clauses.push("seq <= ?");
      bindings.push(query.toSeq);
    }
    const order = query.order === "desc" ? "DESC" : "ASC";
    const limit = query.limit && query.limit > 0 ? `LIMIT ${query.limit}` : "";
    const sql =
      `SELECT id, parent_id, role, content, created_at, entry_type,
              entry_details, seq
       FROM messages WHERE ${clauses.join(" AND ")}
       ORDER BY seq ${order}, rowid ${order} ${limit}`;
    const rows = this.db.prepare<unknown[], MessageRow>(sql).all(...bindings);
    let entries = rows.map(rowToEntry);
    if (query.customType) {
      entries = entries.filter(
        (e) =>
          e.type === "custom" &&
          (e as CustomEntry).customType === query.customType,
      );
    }
    return entries;
  }

  // ─── values (scalar KV) ─────────────────────────────────────

  async getValue<T>(
    address: Value<T>,
    _ctx: Context,
  ): Promise<StoredValue<T> | undefined> {
    this.assertOpen();
    const row = this.db
      .prepare<[string, string, string], ValueRow>(
        `SELECT namespace, key, value, seq
         FROM session_values
         WHERE session_id = ? AND namespace = ? AND key = ?`,
      )
      .get(this.sessionId, address.namespace, address.key);
    if (!row) return undefined;
    return {
      address,
      value: JSON.parse(row.value) as T,
      seq: row.seq,
    };
  }

  async scanValues<T>(
    prefix: Value<T>,
    _ctx: Context,
  ): Promise<StoredValue<T>[]> {
    this.assertOpen();
    // pi's `Value<T>` is namespace + key; scanning "by prefix" means
    // all rows sharing the namespace (and, if key is set, the exact
    // key — the pi convention is that a namespace with no key is a
    // scan-of-namespace). We honour both.
    const clauses = ["session_id = ?", "namespace = ?"];
    const bindings: unknown[] = [this.sessionId, prefix.namespace];
    if (prefix.key) {
      clauses.push("key = ?");
      bindings.push(prefix.key);
    }
    const rows = this.db
      .prepare<unknown[], ValueRow>(
        `SELECT namespace, key, value, seq
         FROM session_values
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq ASC`,
      )
      .all(...bindings);
    return rows.map((r) => ({
      address: {
        namespace: r.namespace,
        key: r.key,
        kind: "value" as const,
      } as Value<T>,
      value: JSON.parse(r.value) as T,
      seq: r.seq,
    }));
  }

  // ─── lists (namespaced append-only) ─────────────────────────

  async readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    _ctx: Context,
  ): Promise<ListElement<T>[]> {
    this.assertOpen();
    const clauses = ["session_id = ?", "namespace = ?", "key = ?"];
    const bindings: unknown[] = [
      this.sessionId,
      address.namespace,
      address.key,
    ];
    if (options?.cursor) {
      clauses.push("seq > ?");
      bindings.push(options.cursor.seq);
    }
    const order = options?.order === "desc" ? "DESC" : "ASC";
    const limit =
      options?.limit && options.limit > 0 ? `LIMIT ${options.limit}` : "";
    const rows = this.db
      .prepare<unknown[], ListRow>(
        `SELECT namespace, key, seq, value
         FROM session_lists
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq ${order} ${limit}`,
      )
      .all(...bindings);
    return rows.map((r) => ({
      seq: r.seq,
      value: JSON.parse(r.value) as T,
    }));
  }

  // ─── usage ──────────────────────────────────────────────────

  async scanUsage(query: UsageScan, _ctx: Context): Promise<UsageRow[]> {
    this.assertOpen();
    const clauses = ["session_id = ?"];
    const bindings: unknown[] = [this.sessionId];
    if (query.fromSeq !== undefined) {
      clauses.push("seq >= ?");
      bindings.push(query.fromSeq);
    }
    if (query.toSeq !== undefined) {
      clauses.push("seq <= ?");
      bindings.push(query.toSeq);
    }
    const order = query.order === "desc" ? "DESC" : "ASC";
    const limit = query.limit && query.limit > 0 ? `LIMIT ${query.limit}` : "";
    const rows = this.db
      .prepare<unknown[], UsageRowSql>(
        `SELECT id, seq, usage, entry_id, adjustment, details
         FROM session_usage
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq ${order} ${limit}`,
      )
      .all(...bindings);
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      usage: JSON.parse(r.usage),
      entryId: r.entry_id ?? undefined,
      adjustment: r.adjustment === 1,
      details: r.details ? JSON.parse(r.details) : undefined,
    }));
  }

  // ─── stats ──────────────────────────────────────────────────

  async getStats(_ctx: Context): Promise<SessionStats> {
    this.assertOpen();
    const msgCount = (this.db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM messages
         WHERE session_id = ? AND entry_type = 'message'`,
      )
      .get(this.sessionId)?.n) ?? 0;
    // Aggregate usage from the session_usage table.
    const usageRows = this.db
      .prepare<[string], { usage: string; adjustment: number }>(
        `SELECT usage, adjustment FROM session_usage WHERE session_id = ?`,
      )
      .all(this.sessionId);
    const usage = aggregateUsage(usageRows);
    return { messageCount: msgCount, usage };
  }

  // ─── commit (mutation entry point) ──────────────────────────

  async commit(writes: Write[], _ctx: Context): Promise<CommitResult> {
    this.assertOpen();
    console.log(`[storage:diag] commit: ${writes.length} write(s) session=${this.sessionId}`);
    for (const w of writes.slice(0, 5)) {
      console.log(`[storage:diag]   write: kind=${(w as any).kind ?? '?'} type=${(w as any).type ?? (w as any).entry?.type ?? '?'} id=${(w as any).id ?? (w as any).entry?.id ?? '?'}`);
    }
    if (writes.length === 0) {
      // Nothing to do — return current stats + a zero-seq range.
      const stats = await this.getStats(_ctx);
      return {
        firstSeq: 0,
        seqs: [],
        timestamp: Date.now(),
        stats,
      };
    }
    const timestamp = Date.now();

    // Run everything in one transaction so we either commit all
    // writes or none.
    const seqs: number[] = [];
    let firstSeq = 0;
    let stats: SessionStats = { messageCount: 0, usage: emptyUsage() };
    const txn = this.db.transaction((batch: Write[]) => {
      // Allocate consecutive seq numbers for the batch. We use one
      // `next_seq` counter per session; INSERT OR IGNORE creates
      // it lazily at 1 for fresh sessions.
      this.db
        .prepare<[string], unknown>(
          `INSERT OR IGNORE INTO session_seq_counter (session_id, next_seq)
           VALUES (?, 1)`,
        )
        .run(this.sessionId);
      const currentSeqRow = this.db
        .prepare<[string], { next_seq: number }>(
          `SELECT next_seq FROM session_seq_counter WHERE session_id = ?`,
        )
        .get(this.sessionId);
      const startSeq = currentSeqRow?.next_seq ?? 1;
      firstSeq = startSeq;

      const insertMessage = this.db.prepare(
        `INSERT INTO messages
          (id, session_id, role, content, created_at, entry_type,
           entry_details, parent_id, seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const setLeaf = this.db.prepare(
        `UPDATE sessions SET leaf_id = ? WHERE id = ?`,
      );
      const upsertValue = this.db.prepare(
        `INSERT INTO session_values
          (session_id, namespace, key, value, seq)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id, namespace, key) DO UPDATE SET
            value = excluded.value,
            seq   = excluded.seq`,
      );
      const deleteValue = this.db.prepare(
        `DELETE FROM session_values
         WHERE session_id = ? AND namespace = ? AND key = ?`,
      );
      const insertListElement = this.db.prepare(
        `INSERT INTO session_lists
          (session_id, namespace, key, seq, value)
          VALUES (?, ?, ?, ?, ?)`,
      );
      const deleteList = this.db.prepare(
        `DELETE FROM session_lists
         WHERE session_id = ? AND namespace = ? AND key = ?`,
      );
      const insertUsage = this.db.prepare(
        `INSERT INTO session_usage
          (session_id, id, seq, usage, entry_id, adjustment, details)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      let cursorSeq = startSeq;
      for (const w of batch) {
        const seq = cursorSeq++;
        seqs.push(seq);
        if (w.kind === "entry") {
          const e = w.entry;
          const rowShape = entryToRow(e, seq, timestamp);
          insertMessage.run(
            rowShape.id,
            this.sessionId,
            rowShape.role,
            rowShape.content,
            timestamp,
            rowShape.entry_type,
            rowShape.entry_details,
            rowShape.parent_id,
            seq,
          );
          setLeaf.run(rowShape.id, this.sessionId);
        } else if (w.kind === "value") {
          if (w.op === "set") {
            upsertValue.run(
              this.sessionId,
              w.namespace,
              w.key,
              JSON.stringify(w.value),
              seq,
            );
          } else {
            deleteValue.run(this.sessionId, w.namespace, w.key);
          }
        } else if (w.kind === "list") {
          if (w.op === "append") {
            insertListElement.run(
              this.sessionId,
              w.namespace,
              w.key,
              seq,
              JSON.stringify(w.value),
            );
          } else {
            deleteList.run(this.sessionId, w.namespace, w.key);
          }
        } else if (w.kind === "usage") {
          // pi's UsageWrite carries UsageRow minus `seq`; we assign it.
          insertUsage.run(
            this.sessionId,
            w.row.id,
            seq,
            JSON.stringify(w.row.usage),
            w.row.entryId ?? null,
            w.row.adjustment ? 1 : 0,
            w.row.details ? JSON.stringify(w.row.details) : null,
          );
        }
      }

      // Advance the counter.
      this.db
        .prepare<[number, string], unknown>(
          `UPDATE session_seq_counter SET next_seq = ? WHERE session_id = ?`,
        )
        .run(cursorSeq, this.sessionId);
    });
    txn(writes);

    // Recompute stats after the write. Cheap: just two counts.
    stats = await this.getStats(_ctx);

    return { firstSeq, seqs, timestamp, stats };
  }

  async close(_ctx: Context): Promise<void> {
    // Nothing session-owned to release — the db handle belongs to
    // the tenant context. Idempotent.
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SqliteStorage: already closed");
  }
}

// ─── row ⇄ Entry conversion ─────────────────────────────────

type EntryTypeStr = "message" | "compaction" | "branch_summary" | "custom";

// ─── Legacy-safe parsing helpers ─────────────────────────────
// See rowToEntry() for context. These mirror the tolerant
// parseMessage/safeParse pair in sqlite-session-storage.ts.

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — non-JSON entry_details is treated as empty
  }
  return {};
}

function parseLegacySafeMessage(content: string, role: string): unknown {
  // Try the modern path first: content should be a JSON-serialised
  // pi-ai Message. If it parses to an object with a role, use it.
  try {
    const parsed = JSON.parse(content);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { role?: unknown }).role === "string"
    ) {
      return parsed;
    }
  } catch {
    // fall through to legacy plain-text upgrade
  }
  // Legacy plain-text upgrade — best-effort minimum viable pi-ai
  // Message. We fill just enough so callers that inspect .role /
  // .content / .usage / .stopReason don't NPE; the fake
  // provider/model strings are inert (they only affect display).
  const now = Date.now();
  if (role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: content }],
      timestamp: now,
    };
  }
  if (role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text: content }],
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      api: "anthropic-messages",
      provider: "unknown",
      model: "unknown",
      timestamp: now,
    };
  }
  if (role === "tool") {
    return {
      role: "toolResult",
      toolCallId: "",
      toolName: "",
      content: [{ type: "text", text: content }],
      isError: false,
      timestamp: now,
    };
  }
  // system / unknown roles: treat as a system-flavoured user
  // message so it still shows in the branch.
  return {
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp: now,
  };
}

function rowToEntry(row: MessageRow): Entry {
  const base = {
    id: row.id,
    parentId: row.parent_id,
    seq: row.seq ?? 0,
    timestamp: row.created_at,
  };
  const kind = row.entry_type as EntryTypeStr;
  if (kind === "message") {
    // Legacy-safe parse. Old rows (migrations pre-006 and the
    // `appendMessage(role:"user", text)` shortcut in index.ts /
    // compact.ts / flush-tool-delta.ts / tool-catalog-refresh.ts)
    // stuffed a plain string like `[plugin-system] Plugin "X"
    // was just ENABLED. ...` straight into messages.content.
    // SqliteSessionStorage.parseMessage tolerated this by
    // upgrading to a minimal pi-ai message shell; we do the same
    // here so pi's Session.findEntries()/getBranch() never
    // crashes on real production data. JSON.parse blowing up
    // aborts every auto-compact decision (see chat/compact-
    // decision.ts catch block).
    const msg = parseLegacySafeMessage(row.content, row.role);
    return { ...base, type: "message", message: msg } as MessageEntry;
  }
  const details = row.entry_details ? safeParseJson(row.entry_details) : {};
  if (kind === "compaction") {
    return {
      ...base,
      type: "compaction",
      summary: details.summary ?? "",
      retainedTail: details.retainedTail ?? [],
      tokensBefore: details.tokensBefore ?? 0,
      details: details.details,
      usage: details.usage,
      fromHook: details.fromHook ?? false,
    } as CompactionEntry;
  }
  if (kind === "branch_summary") {
    return {
      ...base,
      type: "branch_summary",
      fromId: details.fromId ?? null,
      summary: details.summary ?? "",
      details: details.details,
      usage: details.usage,
      fromHook: details.fromHook ?? false,
    } as BranchSummaryEntry;
  }
  // custom
  return {
    ...base,
    type: "custom",
    customType: details.customType ?? "unknown",
    data: details.data,
  } as CustomEntry;
}

function entryToRow(
  entry: NewEntry,
  _seq: number,
  _timestamp: number,
): {
  id: string;
  role: string;
  content: string;
  entry_type: string;
  entry_details: string | null;
  parent_id: string | null;
} {
  // `NewEntry` is pi's discriminated union with the same fields as
  // Entry but without `seq` and `timestamp` — storage assigns those.
  if (entry.type === "message") {
    // Column-role convention. tianshu's messages.role column is
    // narrow: user | assistant | tool | system. pi-ai's Message
    // union uses `toolResult` for tool-result messages, which is
    // what entry.message.role reports. Map it back to `tool` here
    // so the wire layer, history reads, listMessagesForSessionPage,
    // and the browser's mergeToolTurns keep matching by
    // role === "tool". Without this, tool chips loaded from history
    // stay stuck at 'running…' because the paired tool row is
    // present but under an unexpected role.
    const pi85Role = (entry.message as { role: string }).role;
    const columnRole = pi85Role === "toolResult" ? "tool" : pi85Role;
    return {
      id: entry.id,
      role: columnRole,
      content: JSON.stringify(entry.message),
      entry_type: "message",
      entry_details: null,
      parent_id: entry.parentId,
    };
  }
  if (entry.type === "compaction") {
    return {
      id: entry.id,
      role: "system",
      content: "",
      entry_type: "compaction",
      entry_details: JSON.stringify({
        summary: entry.summary,
        retainedTail: entry.retainedTail,
        tokensBefore: entry.tokensBefore,
        details: entry.details,
        usage: entry.usage,
        fromHook: entry.fromHook,
      }),
      parent_id: entry.parentId,
    };
  }
  if (entry.type === "branch_summary") {
    return {
      id: entry.id,
      role: "system",
      content: "",
      entry_type: "branch_summary",
      entry_details: JSON.stringify({
        fromId: entry.fromId,
        summary: entry.summary,
        details: entry.details,
        usage: entry.usage,
        fromHook: entry.fromHook,
      }),
      parent_id: entry.parentId,
    };
  }
  // custom
  return {
    id: entry.id,
    role: "system",
    content: "",
    entry_type: "custom",
    entry_details: JSON.stringify({
      customType: entry.customType,
      data: entry.data,
    }),
    parent_id: entry.parentId,
  };
}

// ─── usage aggregation ─────────────────────────────────────

interface RawUsage {
  usage: string;
  adjustment: number;
}

function aggregateUsage(rows: RawUsage[]): Usage {
  // pi 0.85 pi-ai Usage is an open record of provider-specific token
  // counters (input, output, cacheRead, cacheWrite, ...). Row values
  // are already those provider names as JSON keys, so we accumulate
  // them additively (positive for a normal usage row, negative for an
  // adjustment row that reverses a previous accounting).
  const total: Record<string, number> = {};
  for (const r of rows) {
    const parsed = JSON.parse(r.usage) as Record<string, number>;
    const sign = r.adjustment === 1 ? -1 : 1;
    for (const k of Object.keys(parsed)) {
      const v = parsed[k];
      if (typeof v === "number") {
        total[k] = (total[k] ?? 0) + sign * v;
      }
    }
  }
  return total as unknown as Usage;
}

function emptyUsage(): Usage {
  return {} as unknown as Usage;
}
