// SqliteSessionRepo — pi-agent-core 0.85 `SessionRepo` implementation.
//
// pi 0.85 tightened the SessionRepo contract:
//   * create/open/fork return Promise<Session<TMetadata>>
//   * list/delete take a `Context` argument
//   * fork uses the new ForkOptions (scope: "branch" | "tree")
//     rather than the old (entryId, position) pair
//
// We keep the tenant-scoped table layout (sessions + messages +
// the pi 0.85 storage tables added by migration 015) and produce
// Session instances by wrapping SqliteStorage in
// pi.StorageBackedSession.
//
// The old SqliteSessionStorage stays around as tianshu-specific
// glue for the chat handler (pendingUserAttachments, inbox
// events, image inflate). Its role narrows to "pre-write hooks
// for the next user message"; the durable session state itself
// travels through pi.StorageBackedSession + SqliteStorage.
//
// Fork strategy:
//   pi provides `captureForkSource` / `createForkSnapshot` /
//   `forkSnapshotWrites` helpers. For "branch" scope we truncate
//   the ancestor chain at options.entryId per options.position;
//   for "tree" scope we copy every entry + value. Both go through
//   Storage.commit on the destination.

import { randomUUID } from "node:crypto";
import type {
  Context,
  Entry,
  ForkOptions,
  Session,
  SessionRepo,
  Write,
} from "@earendil-works/pi-agent-core";
import { StorageBackedSession } from "@earendil-works/pi-agent-core";
import type { TenantContext } from "../core/index.js";
import { SqliteStorage } from "./sqlite-storage.js";
import type { SqliteSessionMetadata } from "./sqlite-session-storage.js";

/**
 * Options accepted by `create`. Extends the pi.SessionCreateOptions
 * contract with tianshu-specific extras (userId, kind, workerRole,
 * title) that map to the sessions table columns.
 *
 * pi's SessionRepo generic constrains TCreateOptions to
 * `{ id?: string; parentSessionId?: string }`, so we keep those two
 * fields at exactly the pi shape (optional strings, no null).
 */
export interface SqliteSessionCreateOptions {
  /** Optional pre-allocated id; otherwise generated. */
  id?: string;
  /** Optional parent session id for forks (pi.SessionCreateOptions). */
  parentSessionId?: string;
  userId: string;
  kind?: "user" | "worker" | "system";
  workerRole?: string | null;
  title?: string | null;
}

export interface SqliteSessionListOptions {
  userId?: string;
  kind?: "user" | "worker" | "system";
}

export class SqliteSessionRepo
  implements
    SessionRepo<
      SqliteSessionMetadata,
      SqliteSessionCreateOptions,
      SqliteSessionListOptions
    >
{
  constructor(private readonly ctx: TenantContext) {}

  async create(
    options: SqliteSessionCreateOptions,
    context: Context,
  ): Promise<Session<SqliteSessionMetadata>> {
    const id = options.id ?? `session_${randomUUID()}`;
    const now = Date.now();
    this.ctx.db
      .prepare<
        [
          string,
          string,
          string | null,
          string,
          string,
          string | null,
          string | null,
          number,
        ],
        unknown
      >(
        `INSERT INTO sessions
           (id, user_id, parent_id, status, kind, worker_role, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        options.userId,
        options.parentSessionId ?? null,
        "active",
        options.kind ?? "user",
        options.workerRole ?? null,
        options.title ?? null,
        now,
      );
    return this.buildSession(id, context);
  }

  async open(
    metadata: SqliteSessionMetadata,
    context: Context,
  ): Promise<Session<SqliteSessionMetadata>> {
    const row = this.ctx.db
      .prepare<[string], { id: string }>(
        `SELECT id FROM sessions WHERE id = ?`,
      )
      .get(metadata.id);
    if (!row) {
      throw new Error(`session not found: ${metadata.id}`);
    }
    return this.buildSession(metadata.id, context);
  }

  async list(
    options: SqliteSessionListOptions | undefined,
    _context: Context,
  ): Promise<SqliteSessionMetadata[]> {
    const filters: string[] = [];
    const params: string[] = [];
    if (options?.userId) {
      filters.push("user_id = ?");
      params.push(options.userId);
    }
    if (options?.kind) {
      filters.push("kind = ?");
      params.push(options.kind);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.ctx.db
      .prepare<
        string[],
        {
          id: string;
          user_id: string;
          parent_id: string | null;
          status: string;
          kind: string;
          worker_role: string | null;
          title: string | null;
          created_at: number;
        }
      >(
        `SELECT id, user_id, parent_id, status, kind, worker_role, title, created_at
         FROM sessions${where}
         ORDER BY created_at DESC`,
      )
      .all(...params);
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      // pi 0.85 requires storageVersion on SessionMetadata. Every row
      // in this table lives on schema 015 (or later); nothing older
      // exists once migrations have run.
      storageVersion: 1,
      tenantId: this.ctx.tenantId,
      userId: r.user_id,
      kind: r.kind as SqliteSessionMetadata["kind"],
      workerRole: r.worker_role,
      // pi 0.85 typed parentSessionId as optional string (null is
      // no longer legal). Legacy rows may still hold NULL — map to
      // undefined so the type contract holds.
      parentSessionId: r.parent_id ?? undefined,
      title: r.title,
    }));
  }

  async delete(
    metadata: SqliteSessionMetadata,
    _context: Context,
  ): Promise<void> {
    // Hard delete. ON DELETE CASCADE on the pi 0.85 tables cleans up
    // session_values / session_lists / session_usage / session_seq_counter
    // automatically; messages needs explicit cleanup because that
    // table predates the cascade convention.
    const del = this.ctx.db.transaction((id: string) => {
      this.ctx.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
      this.ctx.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    });
    del(metadata.id);
  }

  async fork(
    source: SqliteSessionMetadata,
    options: ForkOptions,
    context: Context,
  ): Promise<Session<SqliteSessionMetadata>> {
    // Build the destination row first so the child has an id we can
    // stamp into every copied entry's session_id column.
    const destId = options.id ?? `session_${randomUUID()}`;
    const child = await this.create(
      {
        id: destId,
        userId: source.userId,
        kind: source.kind,
        workerRole: source.workerRole ?? null,
        parentSessionId: source.id,
        title: source.title ?? null,
      },
      context,
    );

    // Load the source's entries to copy. For "branch" scope we
    // stop at the chosen entry per position; for "tree" scope we
    // take everything (all branches). Given our sqlite schema is
    // single-branch per session in practice, both scopes collapse
    // to "walk the source's leaf chain".
    const sourceStorage = new SqliteStorage(this.ctx.db, source.id);
    const sourceLeafId = this.ctx.db
      .prepare<[string], { leaf_id: string | null }>(
        `SELECT leaf_id FROM sessions WHERE id = ?`,
      )
      .get(source.id)?.leaf_id;
    let entries: Entry[] = [];
    if (sourceLeafId) {
      entries = await sourceStorage.scanBranch(
        {
          start: sourceLeafId,
          order: "oldestFirst",
        },
        context,
      );
      // Truncate for branch-scope forks.
      if (options.scope === "branch" && options.entryId) {
        const idx = entries.findIndex((e) => e.id === options.entryId);
        if (idx >= 0) {
          const inclusive = (options.position ?? "at") === "at";
          entries = entries.slice(0, inclusive ? idx + 1 : idx);
        }
      }
    }

    // Rewrite entry ids so the child's chain doesn't collide with
    // the parent's. Preserve the parent-of relationship by carrying
    // an id-remap map as we go.
    const remap = new Map<string, string>();
    const destStorage = new SqliteStorage(this.ctx.db, destId);
    const writes: Write[] = [];
    for (const entry of entries) {
      const oldId = entry.id;
      const newId = `entry_${randomUUID()}`;
      remap.set(oldId, newId);
      const newParent = entry.parentId
        ? remap.get(entry.parentId) ?? null
        : null;
      // Build a NewEntry (Entry minus seq + timestamp, which the
      // storage layer assigns on commit).
      const asNew = {
        ...entry,
        id: newId,
        parentId: newParent,
      };
      const { seq: _seq, timestamp: _timestamp, ...bare } = asNew as {
        seq: number;
        timestamp: number;
        [k: string]: unknown;
      };
      void _seq;
      void _timestamp;
      writes.push({
        kind: "entry",
        entry: bare as Parameters<typeof destStorage.commit>[0][number] extends {
          kind: "entry";
          entry: infer E;
        }
          ? E
          : never,
      });
    }
    if (writes.length > 0) {
      await destStorage.commit(writes, context);
    }
    return child;
  }

  /** Build a `Session<TMetadata>` for a session_id that already
   *  exists in the sessions table. */
  private async buildSession(
    sessionId: string,
    _context: Context,
  ): Promise<Session<SqliteSessionMetadata>> {
    const row = this.ctx.db
      .prepare<
        [string],
        {
          id: string;
          user_id: string;
          parent_id: string | null;
          kind: string;
          worker_role: string | null;
          title: string | null;
          created_at: number;
        }
      >(
        `SELECT id, user_id, parent_id, kind, worker_role, title, created_at
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    const metadata: SqliteSessionMetadata = {
      id: row.id,
      createdAt: row.created_at,
      storageVersion: 1,
      tenantId: this.ctx.tenantId,
      userId: row.user_id,
      kind: row.kind as SqliteSessionMetadata["kind"],
      workerRole: row.worker_role,
      parentSessionId: row.parent_id ?? undefined,
      title: row.title,
    };
    const storage = new SqliteStorage(this.ctx.db, sessionId);
    return new StorageBackedSession<SqliteSessionMetadata>(metadata, storage);
  }
}
