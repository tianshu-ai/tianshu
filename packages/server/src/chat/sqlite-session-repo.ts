// SQLite-backed implementation of pi-agent-core's `SessionRepo`.
//
// Thin layer on top of `SqliteSessionStorage`: pi's harness only
// needs `create / open / list / delete / fork`, all of which map
// cleanly to operations on the existing `sessions` table.
//
// Design notes:
//   * `create` and `open` both return a `Session<TMetadata>` whose
//     storage points at the same SQLite db handle in `ctx`.
//   * `fork` is the only one with non-trivial semantics: pi can
//     fork from any entry id (entryId + position="before"|"at").
//     We map this to a new `sessions` row whose `parent_id` points
//     at the source session, then replay the parent's path-to-root
//     up to (or excluding) the chosen entry into the child via
//     fresh appendEntry calls. That keeps fork semantics under our
//     control without `messages` rows being shared across sessions.
//   * `list` is bounded to the calling tenant + an optional kind
//     filter. The harness only calls it from harness-level admin
//     UI, none of which we ship today, but supporting it keeps
//     the interface honest.
//   * `delete` is hard-delete: removes the sessions row + its
//     messages. There's no soft-delete; if a future audit log
//     wants to retain compacted bodies it should hold a separate
//     reference.

import { randomUUID } from "node:crypto";
import type {
  Session,
  SessionForkOptions,
  SessionRepo,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { Session as PiSession } from "@earendil-works/pi-agent-core";
import type { TenantContext } from "../core/index.js";
import {
  SqliteSessionStorage,
  type SqliteSessionMetadata,
} from "./sqlite-session-storage.js";

export interface SqliteSessionCreateOptions {
  /** Optional pre-allocated id; otherwise generated. */
  id?: string;
  userId: string;
  kind?: "user" | "worker" | "system";
  workerRole?: string | null;
  parentSessionId?: string | null;
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
    return new PiSession(new SqliteSessionStorage(this.ctx, id));
  }

  async open(
    metadata: SqliteSessionMetadata,
  ): Promise<Session<SqliteSessionMetadata>> {
    // Confirm the row still exists; the storage will throw on its
    // first read otherwise, but a clearer error here helps debug.
    const row = this.ctx.db
      .prepare<[string], { id: string }>(
        `SELECT id FROM sessions WHERE id = ?`,
      )
      .get(metadata.id);
    if (!row) {
      throw new Error(`session not found: ${metadata.id}`);
    }
    return new PiSession(new SqliteSessionStorage(this.ctx, metadata.id));
  }

  async list(
    options?: SqliteSessionListOptions,
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
      createdAt: new Date(r.created_at).toISOString(),
      tenantId: this.ctx.tenantId,
      userId: r.user_id,
      kind: r.kind as SqliteSessionMetadata["kind"],
      workerRole: r.worker_role,
      parentSessionId: r.parent_id,
      title: r.title,
    }));
  }

  async delete(metadata: SqliteSessionMetadata): Promise<void> {
    // Hard delete. messages have no FK cascade in 001-initial, so
    // we delete them explicitly first.
    this.ctx.db
      .prepare<[string], unknown>(
        `DELETE FROM messages WHERE session_id = ?`,
      )
      .run(metadata.id);
    this.ctx.db
      .prepare<[string], unknown>(`DELETE FROM sessions WHERE id = ?`)
      .run(metadata.id);
  }

  async fork(
    source: SqliteSessionMetadata,
    options: SessionForkOptions & SqliteSessionCreateOptions,
  ): Promise<Session<SqliteSessionMetadata>> {
    // Build the entry-id chain to copy: walk parent's path-to-root,
    // truncate at options.entryId per options.position.
    const sourceStorage = new SqliteSessionStorage(this.ctx, source.id);
    const parentLeaf = await sourceStorage.getLeafId();
    const path = await sourceStorage.getPathToRoot(parentLeaf);

    const cutEntries = sliceForFork(path, options);

    const child = await this.create({
      ...options,
      userId: options.userId ?? source.userId,
      kind: options.kind ?? source.kind,
      workerRole:
        options.workerRole === undefined ? source.workerRole : options.workerRole,
      parentSessionId: source.id,
      title: options.title ?? source.title ?? null,
    });
    const childMeta = await child.getMetadata();
    const childStorage = new SqliteSessionStorage(this.ctx, childMeta.id);

    // Re-append entries with fresh ids; preserve order so parentId
    // chains stay coherent.
    let prev: string | null = null;
    for (const entry of cutEntries) {
      const id = await childStorage.createEntryId();
      const cloned = { ...entry, id, parentId: prev } as SessionTreeEntry;
      await childStorage.appendEntry(cloned);
      prev = id;
    }
    if (prev) await childStorage.setLeafId(prev);
    return child;
  }
}

function sliceForFork(
  path: SessionTreeEntry[],
  options: SessionForkOptions,
): SessionTreeEntry[] {
  if (!options.entryId) return path;
  const idx = path.findIndex((e) => e.id === options.entryId);
  if (idx < 0) return path;
  const position = options.position ?? "at";
  return position === "before" ? path.slice(0, idx) : path.slice(0, idx + 1);
}
