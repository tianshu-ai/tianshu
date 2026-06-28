// Direct tool-execute tests for the recovery toolset. These are
// the three host tools the session-recovery agent gets:
//
//   - inspect_session   : read-only session snapshot
//   - read_session_log  : read-only log tail
//   - nudge_session     : MUTATING inbox post
//
// We don't spin up the full recovery agent here \u2014 just call each
// tool's execute() with a hand-built TenantContext (real sqlite,
// no plugin registry) and assert the surface. Spawning the agent
// itself is exercised by smoke tests after deploy.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentToolContext } from "@tianshu-ai/plugin-sdk";
import {
  buildInspectSessionTool,
  buildNudgeSessionTool,
  buildReadSessionLogTool,
} from "./recovery-tools.js";
import { runMigrations } from "../../core/migrations/index.js";
import type { TenantContext } from "../../core/tenant-context.js";

function makeCtx(home: string): TenantContext {
  const db = new Database(path.join(home, "db.sqlite"));
  runMigrations(db);
  return {
    tenantId: "alpha",
    workspaceDir: path.join(home, "workspace"),
    userHomeDir: (u: string) => path.join(home, "workspace", "users", u),
    db,
  } as unknown as TenantContext;
}

function makeAgentCtx(): AgentToolContext {
  return {
    pluginId: "host",
    tenantId: "alpha",
    userId: "alice",
    userHomeDir: "/tmp/whatever",
    tenantHomeDir: "/tmp/whatever",
  } as AgentToolContext;
}

describe("recovery-tools", () => {
  let home: string;
  let ctx: TenantContext;
  let openTenant: (tenantId: string) => TenantContext;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-recovery-"));
    fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
    ctx = makeCtx(home);
    openTenant = () => ctx;
    // Seed a fake user + session row so inspect / nudge have
    // something to point at. Schema is the standard 'sessions'
    // table from the production migrations.
    ctx.db
      .prepare(
        `INSERT INTO users (id, external_id, provider, display_name, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("alice", "alice", "test", "Alice", Date.now());
    ctx.db
      .prepare(
        `INSERT INTO sessions
           (id, user_id, status, kind, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "sess-broken",
        "alice",
        "active",
        "user",
        "Broken session",
        Date.now(),
      );
  });

  afterEach(() => {
    try {
      (ctx.db as unknown as { close: () => void }).close();
    } catch {
      /* ignore */
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe("inspect_session", () => {
    it("returns the session metadata + empty messages when there are none", async () => {
      const tool = buildInspectSessionTool({ openTenant });
      const result = (await tool.execute(
        { sessionId: "sess-broken" },
        makeAgentCtx(),
      )) as {
        ok: boolean;
        session: { id: string; status: string; title: string | null };
        messages: unknown[];
        pendingInbox: number;
      };
      expect(result.ok).toBe(true);
      expect(result.session.id).toBe("sess-broken");
      expect(result.session.status).toBe("active");
      expect(result.session.title).toBe("Broken session");
      expect(result.messages).toEqual([]);
      expect(result.pendingInbox).toBe(0);
    });

    it("returns a not-found error for an unknown session id", async () => {
      const tool = buildInspectSessionTool({ openTenant });
      const result = (await tool.execute(
        { sessionId: "sess-nope" },
        makeAgentCtx(),
      )) as { ok: boolean; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/);
    });

    it("rejects an empty sessionId without touching the db", async () => {
      const tool = buildInspectSessionTool({ openTenant });
      const result = (await tool.execute(
        { sessionId: "  " },
        makeAgentCtx(),
      )) as { ok: boolean; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/required/);
    });
  });

  describe("read_session_log", () => {
    it("rejects when both sessionId and pattern are missing", async () => {
      const tool = buildReadSessionLogTool();
      const result = (await tool.execute({}, makeAgentCtx())) as {
        ok: boolean;
        error: string;
      };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/sessionId or pattern/);
    });

    it("returns no_log_available when no log file is wired up", async () => {
      // The test env doesn't have TIANSHU_LOG_PATH; we point HOME
      // at a path with no log so the resolver returns null.
      const prevHome = process.env.HOME;
      const prevPath = process.env.TIANSHU_LOG_PATH;
      const fakeHome = fs.mkdtempSync(
        path.join(os.tmpdir(), "tianshu-no-log-"),
      );
      process.env.HOME = fakeHome;
      delete process.env.TIANSHU_LOG_PATH;
      try {
        const tool = buildReadSessionLogTool();
        const result = (await tool.execute(
          { pattern: "anything" },
          makeAgentCtx(),
        )) as { ok: boolean; reason?: string };
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("no_log_available");
      } finally {
        process.env.HOME = prevHome;
        if (prevPath !== undefined) process.env.TIANSHU_LOG_PATH = prevPath;
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    it("greps a real log file for sessionId matches with a time window", async () => {
      const prevPath = process.env.TIANSHU_LOG_PATH;
      const logPath = path.join(home, "server.log");
      const now = Date.now();
      const oldMs = now - 60 * 60_000; // 1 hour ago
      const newMs = now - 30_000; // 30 s ago
      const oldIso = new Date(oldMs).toISOString();
      const newIso = new Date(newMs).toISOString();
      fs.writeFileSync(
        logPath,
        [
          `[${oldIso}] noise unrelated to anything`,
          `[${oldIso}] handler: session=sess-broken stale entry`,
          `[${newIso}] handler: session=sess-broken stream_error reason=boom`,
          `[${newIso}] handler: session=sess-other other-session noise`,
        ].join("\n") + "\n",
      );
      process.env.TIANSHU_LOG_PATH = logPath;
      try {
        const tool = buildReadSessionLogTool();
        const result = (await tool.execute(
          { sessionId: "sess-broken", minutesBack: 15 },
          makeAgentCtx(),
        )) as { ok: boolean; lines: string[] };
        expect(result.ok).toBe(true);
        // 1-hour-old entry filtered out by the 15-minute window;
        // 30-second-old entry kept; sess-other entry filtered by
        // session id.
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0]).toContain("stream_error");
      } finally {
        if (prevPath === undefined) {
          delete process.env.TIANSHU_LOG_PATH;
        } else {
          process.env.TIANSHU_LOG_PATH = prevPath;
        }
      }
    });
  });

  describe("nudge_session", () => {
    it("posts an inbox_recovery_note row for an existing session", async () => {
      const tool = buildNudgeSessionTool({ openTenant });
      const result = (await tool.execute(
        {
          sessionId: "sess-broken",
          text: "The model 401'd. Retry once your API key is fresh.",
        },
        makeAgentCtx(),
      )) as { ok: boolean; inboxId: string };
      expect(result.ok).toBe(true);
      expect(result.inboxId).toMatch(/^inbox_/);

      const rows = ctx.db
        .prepare(
          `SELECT target_session_id, status, payload FROM session_inbox
             WHERE target_session_id = ?`,
        )
        .all("sess-broken") as Array<{
        target_session_id: string;
        status: string;
        payload: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("pending");
      const payload = JSON.parse(rows[0]!.payload) as {
        kind: string;
        text: string;
      };
      expect(payload.kind).toBe("inbox_recovery_note");
      expect(payload.text).toMatch(/Retry once your API key is fresh/);
    });

    it("refuses to nudge a missing session", async () => {
      const tool = buildNudgeSessionTool({ openTenant });
      const result = (await tool.execute(
        { sessionId: "sess-nope", text: "hi" },
        makeAgentCtx(),
      )) as { ok: boolean; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/);
    });

    it("requires non-empty sessionId and text", async () => {
      const tool = buildNudgeSessionTool({ openTenant });
      for (const bad of [
        { sessionId: "", text: "x" },
        { sessionId: "sess-broken", text: "" },
        { sessionId: "  ", text: "x" },
      ]) {
        const r = (await tool.execute(bad, makeAgentCtx())) as {
          ok: boolean;
          error: string;
        };
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/required/);
      }
    });
  });
});
