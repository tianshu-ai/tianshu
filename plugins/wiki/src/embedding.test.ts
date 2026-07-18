// Exercises the SQLite-backed wiki index (sqlite-vec vec0 + FTS5 + RRF)
// against a REAL in-memory better-sqlite3 connection with the vector
// extension loaded — same shape the host provides at runtime.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { WikiIndex, type SemanticHit } from "./embedding.js";

// Build a TenantDbHandle-shaped wrapper over a real DB with sqlite-vec
// loaded (host loads it in db-pool.open and sets vecAvailable).
function makeHandle(vec: boolean) {
  const db = new Database(":memory:");
  let vecAvailable = false;
  if (vec) {
    try {
      sqliteVec.load(db);
      vecAvailable = true;
    } catch {
      vecAvailable = false;
    }
  }
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    vecAvailable,
  };
}

// A deterministic fake embedding: map text → a 4-dim vector by keyword
// presence so we can assert vector ranking without a network call.
function fakeVec(text: string): number[] {
  const t = text.toLowerCase();
  return [
    t.includes("graph") ? 1 : 0,
    t.includes("board") ? 1 : 0,
    t.includes("embed") ? 1 : 0,
    0.01,
  ];
}

describe("WikiIndex (sqlite-vec + FTS5)", () => {
  let handle: ReturnType<typeof makeHandle>;
  let idx: WikiIndex;

  beforeEach(() => {
    handle = makeHandle(true);
    idx = new WikiIndex(handle, "u1");
    idx.prepare("test-model", 4);
  });

  it("loads the vector extension in the test harness", () => {
    expect(handle.vecAvailable).toBe(true);
  });

  it("upserts + hybrid-searches a page (vector ⊕ FTS via RRF)", () => {
    idx.upsert("concepts/graph-lib", "chose the react force graph library", fakeVec("graph"), 4);
    idx.upsert("entities/board", "the board plugin dashboard", fakeVec("board"), 4);
    const hits = idx.fuse(fakeVec("graph"), "graph library", 5);
    expect(hits[0]?.path).toBe("concepts/graph-lib");
  });

  it("isolates users (partition key)", () => {
    idx.upsert("concepts/a", "graph stuff", fakeVec("graph"), 4);
    const other = new WikiIndex(handle, "u2");
    other.prepare("test-model", 4);
    other.upsert("concepts/b", "graph stuff too", fakeVec("graph"), 4);
    const u1 = idx.fuse(fakeVec("graph"), "graph", 5).map((h: SemanticHit) => h.path);
    expect(u1).toContain("concepts/a");
    expect(u1).not.toContain("concepts/b");
  });

  it("clear() wipes only the current user's rows", () => {
    idx.upsert("concepts/a", "graph", fakeVec("graph"), 4);
    expect(idx.count()).toBe(1);
    idx.clear();
    expect(idx.count()).toBe(0);
  });

  it("removePage drops a single page from both tables", () => {
    idx.upsert("concepts/a", "graph", fakeVec("graph"), 4);
    idx.upsert("concepts/b", "board", fakeVec("board"), 4);
    idx.removePage("concepts/a");
    expect(idx.count()).toBe(1);
    const hits = idx.fuse(fakeVec("graph"), "graph", 5).map((h) => h.path);
    expect(hits).not.toContain("concepts/a");
  });

  it("CJK keyword match works (trigram tokenizer) and scores are normalised", () => {
    // No query vector → pure FTS path; the Chinese page must still match
    // a Chinese query, and the fused score must be on the [0,1] scale
    // (not the tiny raw-RRF ~0.016 that the old threshold nuked).
    idx.upsert(
      "entities/board-pomodoro",
      "番茄钟 Board 番茄钟计时器 pomodoro timer 专注",
      fakeVec("board"),
      4,
    );
    const hits = idx.fuse(undefined, "番茄钟计时器", 5);
    expect(hits[0]?.path).toBe("entities/board-pomodoro");
    expect(hits[0]!.score).toBeGreaterThan(0.15); // would fail pre-fix
    expect(hits[0]!.score).toBeLessThanOrEqual(1);
  });

  it("rebuilds the vector table when the dimension changes", () => {
    idx.upsert("concepts/a", "graph", fakeVec("graph"), 4);
    expect(idx.count()).toBe(1);
    // Re-prepare with a different dim → vec table is recreated (dropped).
    idx.prepare("test-model-2", 8);
    // FTS row survives (count is FTS-based) but the vec table is empty;
    // a fresh upsert with the new dim must work without throwing.
    const v8 = [1, 0, 0, 0, 0, 0, 0, 0.01];
    idx.upsert("concepts/a", "graph", v8, 8);
    const hits = idx.fuse(v8, "graph", 5).map((h) => h.path);
    expect(hits).toContain("concepts/a");
  });
});

describe("WikiIndex (FTS-only, no sqlite-vec)", () => {
  it("still keyword-searches when vec is unavailable", () => {
    const handle = makeHandle(false);
    const idx = new WikiIndex(handle, "u1");
    idx.prepare("test-model", 4);
    idx.upsert("concepts/a", "react force graph library selection", undefined, undefined);
    // No query vector → FTS-only fusion still returns the keyword hit.
    const hits = idx.fuse(undefined, "graph library", 5).map((h) => h.path);
    expect(hits).toContain("concepts/a");
  });
});
