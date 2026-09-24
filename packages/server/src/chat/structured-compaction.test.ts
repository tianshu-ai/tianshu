// Unit tests for structured-compaction helpers.
//
// Only exercises the pure computation surfaces:
//   - computeCompactionTurnRange (DB read + math over turn_number)
//   - buildStructuredSummary (header/footer wrapping around model text)
//
// The end-to-end hook invocation (before_compaction → completeSimple)
// runs a real model call in production; keep that out of the unit
// suite. A hook-level integration check would live under a separate
// `.integration.test.ts` gated by a live model, not here.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  buildStructuredSummary,
  computeCompactionTurnRange,
} from "./structured-compaction.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      parent_id TEXT
    );
    CREATE TABLE messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      entry_type  TEXT NOT NULL DEFAULT 'message',
      entry_details TEXT,
      parent_id   TEXT,
      seq         INTEGER,
      turn_number INTEGER
    );
    INSERT INTO sessions (id, parent_id) VALUES ('S', NULL);
  `);
  return db;
}

function seed(
  db: Database.Database,
  rows: Array<{
    id: string;
    role: string;
    entry_type?: string;
    turn: number | null;
    createdAt: number;
    seq: number;
  }>,
): void {
  const ins = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, created_at,
                           entry_type, seq, turn_number)
     VALUES (?, 'S', ?, '{}', ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    ins.run(r.id, r.role, r.createdAt, r.entry_type ?? "message", r.seq, r.turn);
  }
}

describe("computeCompactionTurnRange", () => {
  it("returns null when the session has no messages", () => {
    const db = makeDb();
    expect(computeCompactionTurnRange(db, "S", 0)).toBeNull();
  });

  it("returns null when the retained tail covers everything", () => {
    const db = makeDb();
    seed(db, [
      { id: "a", role: "user", turn: 1, createdAt: 1, seq: 1 },
      { id: "b", role: "assistant", turn: 1, createdAt: 2, seq: 2 },
    ]);
    expect(computeCompactionTurnRange(db, "S", 2)).toBeNull();
    expect(computeCompactionTurnRange(db, "S", 5)).toBeNull();
  });

  it("returns [1,2] when 2 turns are summarized and one entry retained", () => {
    const db = makeDb();
    seed(db, [
      { id: "u1", role: "user", turn: 1, createdAt: 1, seq: 1 },
      { id: "a1", role: "assistant", turn: 1, createdAt: 2, seq: 2 },
      { id: "u2", role: "user", turn: 2, createdAt: 3, seq: 3 },
      { id: "a2", role: "assistant", turn: 2, createdAt: 4, seq: 4 },
      { id: "u3", role: "user", turn: 3, createdAt: 5, seq: 5 },
    ]);
    // Keep the last message; summarize the first four.
    expect(computeCompactionTurnRange(db, "S", 1)).toEqual({
      turnStart: 1,
      turnEnd: 2,
    });
  });

  it("skips pre-first-user injected rows (turn=0)", () => {
    const db = makeDb();
    seed(db, [
      { id: "n0", role: "user", turn: 0, createdAt: 1, seq: 1 }, // plugin notice pre-turn
      { id: "u1", role: "user", turn: 1, createdAt: 2, seq: 2 },
      { id: "a1", role: "assistant", turn: 1, createdAt: 3, seq: 3 },
      { id: "u2", role: "user", turn: 2, createdAt: 4, seq: 4 },
    ]);
    // Retain 1 → summarize 3 rows. The first is turn=0, ignored;
    // the next two both turn=1.
    expect(computeCompactionTurnRange(db, "S", 1)).toEqual({
      turnStart: 1,
      turnEnd: 1,
    });
  });

  it("ignores non-message rows in the ORDER-BY read", () => {
    const db = makeDb();
    seed(db, [
      { id: "u1", role: "user", turn: 1, createdAt: 1, seq: 1 },
      // A compaction entry that would inherit turn=1; only message-typed
      // rows should feed the count.
      {
        id: "c1",
        role: "system",
        entry_type: "compaction",
        turn: 1,
        createdAt: 2,
        seq: 2,
      },
      { id: "u2", role: "user", turn: 2, createdAt: 3, seq: 3 },
      { id: "a2", role: "assistant", turn: 2, createdAt: 4, seq: 4 },
    ]);
    // Retain 1 message-typed row (a2, turn=2) → summarize the other 2
    // (u1 turn=1, u2 turn=2). Compaction rows are excluded from the
    // SELECT entirely, so retainedTailLength==1 leaves 2 to summarize.
    expect(computeCompactionTurnRange(db, "S", 1)).toEqual({
      turnStart: 1,
      turnEnd: 2,
    });
  });
});

describe("buildStructuredSummary", () => {
  it("wraps model text with a [Compacted context] header + recall footer", () => {
    const out = buildStructuredSummary(3, 7, "## turns 3-7: intro\n\ndetails.", 5);
    expect(out.startsWith("[Compacted context — turns 3-7, 5 turns]")).toBe(true);
    expect(out).toContain("## turns 3-7: intro");
    expect(out).toContain("recall_range(3, 7)");
  });

  it("uses singular 'turn' for a single-turn range", () => {
    const out = buildStructuredSummary(4, 4, "brief note.", 1);
    expect(out).toContain("[Compacted context — turns 4-4, 1 turn]");
  });

  it("trims incidental whitespace on the model body", () => {
    const out = buildStructuredSummary(
      1,
      2,
      "\n\n  ## turns 1-2: label\n\nbody\n\n   ",
      2,
    );
    // Header ends with two newlines before the trimmed body.
    expect(out).toContain("]\n\n## turns 1-2: label");
    expect(out.endsWith("recall_tool_call(id).")).toBe(true);
  });
});
