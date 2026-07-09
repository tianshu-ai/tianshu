// Tests for takeResumableUserPrompt — the retry helper that resumes an
// interrupted turn WITHOUT duplicating the user message.
//
// Bug it fixes (Yu, 2026-07-10): the client auto-retry loop was
// resending a full new prompt each attempt, so a flaky connection
// produced a stack of duplicate user messages ("继续" ×N). Retry must
// keep exactly one user message and re-run that turn in place.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../core/migrations/index.js";
import type { TenantContext } from "../core/tenant-context.js";
import type { ChatMessage } from "./messages.js";
import { takeResumableUserPrompt } from "./handler.js";

function tenantCtx(home: string): TenantContext {
  const db = new Database(path.join(home, "db.sqlite"));
  runMigrations(db);
  return {
    tenantId: "alpha",
    workspaceDir: path.join(home, "workspace"),
    userHomeDir: (u: string) => path.join(home, "workspace", "users", u),
    db,
    config: { defaultModel: "x" } as never,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as TenantContext;
}

let seq = 0;
function seed(
  ctx: TenantContext,
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
): string {
  const id = `msg_${randomUUID()}`;
  // Force strictly increasing created_at so ORDER BY created_at DESC is
  // deterministic in-test (Date.now() can collide within a tick).
  const now = 1_000_000 + seq++;
  ctx.db
    .prepare<[string, string, string, string, number], unknown>(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, sessionId, role, content, now);
  return id;
}

function seedUser(ctx: TenantContext, userId: string) {
  // sessions.user_id FKs to users(id); FK enforcement is on.
  ctx.db
    .prepare<[string, string, string, number], unknown>(
      `INSERT OR IGNORE INTO users (id, external_id, provider, created_at)
       VALUES (?, ?, 'test', ?)`,
    )
    .run(userId, userId, Date.now());
}

function seedSession(ctx: TenantContext, sessionId: string, leafId: string | null) {
  seedUser(ctx, "alice");
  ctx.db
    .prepare<[string, string, string, string | null, number], unknown>(
      `INSERT INTO sessions (id, user_id, status, leaf_id, created_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(sessionId, "alice", leafId, Date.now());
}

function rowCount(ctx: TenantContext, sessionId: string): number {
  return (
    ctx.db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`,
      )
      .get(sessionId)?.n ?? 0
  );
}

function leafId(ctx: TenantContext, sessionId: string): string | null {
  return (
    ctx.db
      .prepare<[string], { leaf_id: string | null }>(
        `SELECT leaf_id FROM sessions WHERE id = ?`,
      )
      .get(sessionId)?.leaf_id ?? null
  );
}

describe("takeResumableUserPrompt", () => {
  let home: string;
  let ctx: TenantContext;
  const sid = "sess_1";

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-resume-"));
    ctx = tenantCtx(home);
    seq = 0;
    seedSession(ctx, sid, null);
  });
  afterEach(() => {
    try {
      ctx.db.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("resumes a dangling user turn: returns text, deletes it, keeps one user msg", () => {
    // Completed turn: user + assistant reply.
    seed(ctx, sid, "user", "first question");
    const doneAssistant = seed(ctx, sid, "assistant", "first answer");
    // Dangling failed turn: user prompt with no completed reply.
    seed(ctx, sid, "user", "继续");

    const text = takeResumableUserPrompt(ctx, sid);
    expect(text).toBe("继续");
    // The dangling user row is gone; the completed turn (2 rows) stays.
    expect(rowCount(ctx, sid)).toBe(2);
    // Leaf re-points at the last completed assistant reply.
    expect(leafId(ctx, sid)).toBe(doneAssistant);
  });

  it("drops a partial (empty) assistant left by a mid-stream failure", () => {
    seed(ctx, sid, "user", "q1");
    const doneAssistant = seed(ctx, sid, "assistant", "a1");
    seed(ctx, sid, "user", "继续");
    // A partial assistant row with empty content (stream died early).
    seed(ctx, sid, "assistant", "   ");

    const text = takeResumableUserPrompt(ctx, sid);
    expect(text).toBe("继续");
    // Both the empty assistant and the dangling user are removed.
    expect(rowCount(ctx, sid)).toBe(2);
    expect(leafId(ctx, sid)).toBe(doneAssistant);
  });

  it("resumes past an errored partial assistant (provider 'terminated' mid-stream)", () => {
    // The real bug: a stream terminated mid-sentence persists an
    // assistant row WITH partial content but stopReason:error. It must
    // be treated as a failed turn (dropped + resumed), not a boundary.
    seed(ctx, sid, "user", "q1");
    const doneAssistant = seed(ctx, sid, "assistant", "a1 complete");
    seed(ctx, sid, "user", "写一个长故事");
    // Partial assistant with real text but stopReason:error.
    seed(
      ctx,
      sid,
      "assistant",
      JSON.stringify({ role: "assistant", stopReason: "error", errorMessage: "terminated", content: [{ type: "text", text: "很久以前……（被截断）" }] }),
    );

    const text = takeResumableUserPrompt(ctx, sid);
    expect(text).toBe("写一个长故事");
    // Errored partial + its user prompt removed; completed turn stays.
    expect(rowCount(ctx, sid)).toBe(2);
    expect(leafId(ctx, sid)).toBe(doneAssistant);
  });

  it("treats an aborted partial assistant as a failed turn too", () => {
    seed(ctx, sid, "user", "q1");
    const doneAssistant = seed(ctx, sid, "assistant", "a1");
    seed(ctx, sid, "user", "继续");
    seed(ctx, sid, "assistant", JSON.stringify({ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "部分" }] }));

    expect(takeResumableUserPrompt(ctx, sid)).toBe("继续");
    expect(leafId(ctx, sid)).toBe(doneAssistant);
  });

  it("a COMPLETED assistant reply (stopReason stop) IS a boundary", () => {
    seed(ctx, sid, "user", "q1");
    seed(ctx, sid, "assistant", JSON.stringify({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }));
    // No dangling user after it → nothing to resume.
    expect(takeResumableUserPrompt(ctx, sid)).toBeNull();
  });

  it("returns null when the last turn actually completed (nothing to resume)", () => {
    seed(ctx, sid, "user", "q1");
    seed(ctx, sid, "assistant", "a1 (complete)");

    const text = takeResumableUserPrompt(ctx, sid);
    expect(text).toBeNull();
    // Untouched.
    expect(rowCount(ctx, sid)).toBe(2);
  });

  it("returns null for an empty session", () => {
    expect(takeResumableUserPrompt(ctx, sid)).toBeNull();
  });

  it("extracts PLAIN TEXT from an AgentMessage-JSON user row (no nesting)", () => {
    // Real storage: user rows are full AgentMessage JSON. Resuming
    // must return the inner text, NOT the raw JSON — else prompt()
    // re-wraps it and the JSON nests one layer deeper each retry
    // (the "repeated JSON messages" bug Yu hit).
    seed(ctx, sid, "user", "q1");
    seed(ctx, sid, "assistant", "a1");
    seed(
      ctx,
      sid,
      "user",
      JSON.stringify({ role: "user", content: [{ type: "text", text: "讲故事" }], timestamp: 123 }),
    );

    const text = takeResumableUserPrompt(ctx, sid);
    expect(text).toBe("讲故事");
    // Not the raw JSON.
    expect(text).not.toContain("role");
    expect(text).not.toContain("{");
  });

  it("resumes the very first turn (no prior completed assistant)", () => {
    // Only a dangling user message exists (first prompt ever failed).
    seed(ctx, sid, "user", "hello");

    const text = takeResumableUserPrompt(ctx, sid);
    expect(text).toBe("hello");
    expect(rowCount(ctx, sid)).toBe(0);
    expect(leafId(ctx, sid)).toBeNull();
  });

  it("is idempotent-ish: a second call after resume finds nothing", () => {
    seed(ctx, sid, "user", "q1");
    seed(ctx, sid, "assistant", "a1");
    seed(ctx, sid, "user", "继续");

    expect(takeResumableUserPrompt(ctx, sid)).toBe("继续");
    // After removing the dangling turn, the tail is a completed
    // assistant reply — nothing more to resume.
    expect(takeResumableUserPrompt(ctx, sid)).toBeNull();
  });
});
