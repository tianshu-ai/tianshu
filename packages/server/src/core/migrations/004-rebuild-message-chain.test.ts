// Migration 004 — fan-out → chain rebuild for messages.parent_id.
//
// We drive the migration directly against an in-memory SQLite DB
// so the test is hermetic. The DB schema we set up matches what
// 001/002/003 leave behind: sessions + messages with parent_id /
// entry_type / leaf_id columns.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "./004-rebuild-message-chain.js";

interface MsgRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  created_at: number;
}

interface SessionRow {
  id: string;
  leaf_id: string | null;
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id      TEXT PRIMARY KEY,
      leaf_id TEXT
    );
    CREATE TABLE messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      parent_id   TEXT,
      entry_type  TEXT NOT NULL DEFAULT 'message',
      created_at  INTEGER NOT NULL
    );
  `);
  return db;
}

function insertSession(db: Database.Database, id: string, leafId: string | null): void {
  db.prepare(`INSERT INTO sessions (id, leaf_id) VALUES (?, ?)`).run(id, leafId);
}

function insertMsg(
  db: Database.Database,
  args: { id: string; sessionId: string; parentId: string | null; createdAt: number },
): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, parent_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(args.id, args.sessionId, args.parentId, args.createdAt);
}

function loadMessages(db: Database.Database, sessionId: string): MsgRow[] {
  return db
    .prepare<[string], MsgRow>(
      `SELECT id, session_id, parent_id, created_at FROM messages
       WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(sessionId);
}

function loadSession(db: Database.Database, sessionId: string): SessionRow {
  return db
    .prepare<[string], SessionRow>(
      `SELECT id, leaf_id FROM sessions WHERE id = ?`,
    )
    .get(sessionId)!;
}

describe("migration 004-rebuild-message-chain", () => {
  it("rewrites a fan-out into a strict chain and stamps leaf_id", () => {
    const db = makeDb();
    // Fan-out: every row points at row #1 as parent (the bug N+6.4
    // initial cut had).
    insertSession(db, "s1", "m1");
    insertMsg(db, { id: "m1", sessionId: "s1", parentId: null, createdAt: 100 });
    insertMsg(db, { id: "m2", sessionId: "s1", parentId: "m1", createdAt: 200 });
    insertMsg(db, { id: "m3", sessionId: "s1", parentId: "m1", createdAt: 300 });
    insertMsg(db, { id: "m4", sessionId: "s1", parentId: "m1", createdAt: 400 });

    up(db);

    const msgs = loadMessages(db, "s1");
    expect(msgs.map((m) => m.parent_id)).toEqual([null, "m1", "m2", "m3"]);
    expect(loadSession(db, "s1").leaf_id).toBe("m4");
  });

  it("is idempotent on an already-correct chain", () => {
    const db = makeDb();
    insertSession(db, "s2", "m3");
    insertMsg(db, { id: "m1", sessionId: "s2", parentId: null, createdAt: 100 });
    insertMsg(db, { id: "m2", sessionId: "s2", parentId: "m1", createdAt: 200 });
    insertMsg(db, { id: "m3", sessionId: "s2", parentId: "m2", createdAt: 300 });

    up(db);

    const msgs = loadMessages(db, "s2");
    expect(msgs.map((m) => m.parent_id)).toEqual([null, "m1", "m2"]);
    expect(loadSession(db, "s2").leaf_id).toBe("m3");
  });

  it("resets leaf_id when a session has no messages", () => {
    const db = makeDb();
    insertSession(db, "s3", "ghost-id");

    up(db);

    expect(loadSession(db, "s3").leaf_id).toBeNull();
  });

  it("rebuilds independently for each session", () => {
    const db = makeDb();
    insertSession(db, "a", null);
    insertSession(db, "b", null);
    insertMsg(db, { id: "a1", sessionId: "a", parentId: null, createdAt: 100 });
    insertMsg(db, { id: "a2", sessionId: "a", parentId: "a1", createdAt: 200 });
    // Session b has a fan: both rows parent off a1 (cross-session
    // pollution from the bug we're fixing).
    insertMsg(db, { id: "b1", sessionId: "b", parentId: "a1", createdAt: 150 });
    insertMsg(db, { id: "b2", sessionId: "b", parentId: "a1", createdAt: 250 });

    up(db);

    expect(loadMessages(db, "a").map((m) => m.parent_id)).toEqual([null, "a1"]);
    expect(loadMessages(db, "b").map((m) => m.parent_id)).toEqual([null, "b1"]);
    expect(loadSession(db, "a").leaf_id).toBe("a2");
    expect(loadSession(db, "b").leaf_id).toBe("b2");
  });

  it("re-stamps leaf_id even when it points at a stale row", () => {
    const db = makeDb();
    insertSession(db, "s4", "m1"); // stale: actual leaf is m3
    insertMsg(db, { id: "m1", sessionId: "s4", parentId: null, createdAt: 100 });
    insertMsg(db, { id: "m2", sessionId: "s4", parentId: "m1", createdAt: 200 });
    insertMsg(db, { id: "m3", sessionId: "s4", parentId: "m2", createdAt: 300 });

    up(db);

    expect(loadSession(db, "s4").leaf_id).toBe("m3");
  });
});
