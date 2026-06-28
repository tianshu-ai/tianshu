// Focused tests on session-inbox's markDeliveredFromMessage.
//
// Background:
// Yu reported on 2026-06-28 that a task_done notification got
// re-injected as a system-note 8 times in a single chat session.
// Root cause: the regex only matched the raw form
//   <inbox kind="task_done" id="inbox_x">
// but the chat handler reads back messages.content which stores
// JSON.stringify(AgentMessage), where the same bytes are escaped:
//   <inbox kind=\"task_done\" id=\"inbox_x\">
// markDeliveredFromMessage silently returned 0 matches, the rows
// stayed pending, and every flush re-pushed them through
// harness.followUp(). These tests pin both forms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { markDeliveredFromMessage } from "./session-inbox.js";
import { runMigrations } from "../core/migrations/index.js";
import type { TenantContext } from "../core/tenant-context.js";

function tenantCtx(home: string): TenantContext {
  const db = new Database(path.join(home, "db.sqlite"));
  runMigrations(db);
  return {
    tenantId: "alpha",
    workspaceDir: path.join(home, "workspace"),
    userHomeDir: (u: string) => path.join(home, "workspace", "users", u),
    db,
    config: { defaultModel: "x" } as never,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  } as TenantContext;
}

describe("session-inbox.markDeliveredFromMessage", () => {
  let home: string;
  let ctx: TenantContext;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-inbox-"));
    fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
    ctx = tenantCtx(home);
    // session_inbox doesn't FK to sessions/users (it's an
    // independent table), so the tests don't need to seed those.
    // We use a freeform session id below.
  });

  afterEach(() => {
    try {
      (ctx.db as unknown as { close: () => void }).close();
    } catch {
      /* ignore */
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  function enqueue(): string {
    // Direct INSERT to avoid the flush side-effect path the real
    // enqueue() runs (it schedules a follow-up turn, which we
    // don't have wired here).
    const id = `inbox_${randomUUID()}`;
    ctx.db
      .prepare(
        `INSERT INTO session_inbox (id, target_session_id, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        "sess-1",
        JSON.stringify({ kind: "task_done", text: "Task finished." }),
        Date.now(),
      );
    return id;
  }

  function pendingCount(): number {
    return (
      ctx.db
        .prepare(
          `SELECT COUNT(*) as n FROM session_inbox WHERE target_session_id = ? AND status = 'pending'`,
        )
        .get("sess-1") as { n: number }
    ).n;
  }

  it("marks rows delivered when text is raw (matches pre-2026-06-28 callsites)", () => {
    const id = enqueue();
    expect(pendingCount()).toBe(1);
    const raw = `<inbox kind="task_done" id="${id}">\nbody\n</inbox>`;
    markDeliveredFromMessage(ctx, raw);
    expect(pendingCount()).toBe(0);
  });

  it("marks rows delivered when text is JSON-escaped (chat handler callsite)", () => {
    // This is the format messages.content stores: JSON.stringify of
    // the AgentMessage object. The quotes around the regex
    // attribute values are backslash-escaped in the on-disk bytes.
    const id = enqueue();
    expect(pendingCount()).toBe(1);
    const agentMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `<system-note>\n<inbox kind="task_done" id="${id}">\nbody\n</inbox>\n</system-note>`,
        },
      ],
    };
    const serialized = JSON.stringify(agentMessage);
    // Sanity-check: the on-disk bytes really do contain the
    // escaped form, not raw.
    expect(serialized).toContain('kind=\\"task_done\\"');
    expect(serialized).not.toContain('kind="task_done"');

    markDeliveredFromMessage(ctx, serialized);
    expect(pendingCount()).toBe(0);
  });

  it("handles multiple inbox tags in one text (batched followUp case)", () => {
    const ids = [enqueue(), enqueue(), enqueue()];
    expect(pendingCount()).toBe(3);
    const blocks = ids
      .map((id) => `<inbox kind="task_done" id="${id}">x</inbox>`)
      .join("\n");
    const serialized = JSON.stringify({
      role: "user",
      content: [{ type: "text", text: blocks }],
    });
    markDeliveredFromMessage(ctx, serialized);
    expect(pendingCount()).toBe(0);
  });

  it("is a no-op when text has no inbox marker", () => {
    const id = enqueue();
    markDeliveredFromMessage(ctx, "plain user message, no inbox here");
    expect(pendingCount()).toBe(1);
    // Sanity: still marks when we feed the right id.
    markDeliveredFromMessage(ctx, `<inbox kind="task_done" id="${id}">`);
    expect(pendingCount()).toBe(0);
  });

  it("ignores unrelated inbox ids without affecting the real ones", () => {
    enqueue();
    markDeliveredFromMessage(ctx, `<inbox kind="task_done" id="inbox_unknown">`);
    expect(pendingCount()).toBe(1);
  });
});
