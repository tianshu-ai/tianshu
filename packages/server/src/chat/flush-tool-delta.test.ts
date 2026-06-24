// Integration test for `flushToolDeltaForSession`.
//
// We use a real GlobalOps + DbPool + bootstrapped dev tenant so the
// migration chain runs (especially 009-session-app-version), then
// hand-build a fake PluginRegistry that returns a controlled
// toolCatalog. The point is to pin the end-to-end shape:
//   - reads `created_under_app_version` from the row
//   - computes the delta against a fake catalog
//   - appends a `role: "user"` message to the session
//   - bumps the row's stamp so a second call is a no-op
//
// `getPackageVersion()` reads `package.json`; we don't mock it.
// The current monorepo version is whatever this checkout is on
// (e.g. 0.3.20). We pass that through explicitly to the test
// fixtures.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DbPool } from "../core/db-pool.js";
import { GlobalOps } from "../core/global-ops.js";
import {
  bootstrapDevTenantIfNeeded,
  DEV_TENANT_ID,
  DEV_USER_ID,
} from "../core/dev-mode.js";
import { ensureActiveSession } from "./messages.js";
import { flushToolDeltaForSession } from "./flush-tool-delta.js";
import { getPackageVersion } from "../setup/repo-root.js";

// Minimal PluginRegistry stand-in: only `toolCatalogForTenant` is
// consumed by flushToolDeltaForSession.
function fakeRegistry(catalog: Array<{
  toolName: string;
  pluginId: string;
  since?: string | null;
  description?: string;
}>): unknown {
  return {
    toolCatalogForTenant: () => catalog,
  };
}

let home: string;
let prevHome: string | undefined;
let ops: GlobalOps;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-flush-"));
  prevHome = process.env.TIANSHU_HOME;
  process.env.TIANSHU_HOME = home;
  ops = new GlobalOps({ home, pool: new DbPool({ home }) });
  bootstrapDevTenantIfNeeded(ops, {});
});
afterEach(() => {
  ops.closePool();
  if (prevHome === undefined) delete process.env.TIANSHU_HOME;
  else process.env.TIANSHU_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("flushToolDeltaForSession (integration)", () => {
  it("appends a system note when a session is stale and a new tool exists", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const session = ensureActiveSession(ctx, DEV_USER_ID);

    // Force the session's stamp to an old version.
    ctx.db
      .prepare(
        `UPDATE sessions SET created_under_app_version = ? WHERE id = ?`,
      )
      .run("0.1.0", session.id);

    const currentVersion = getPackageVersion();
    if (!currentVersion) throw new Error("expected getPackageVersion to resolve");

    const fakeReg = fakeRegistry([
      {
        toolName: "ancient_tool",
        pluginId: "p",
        since: "0.0.1",
        description: "Old.",
      },
      {
        toolName: "future_tool",
        pluginId: "p",
        since: currentVersion, // shipped in the version we're on
        description: "Shipped in the current release.",
      },
    ]);

    const before = ctx.db
      .prepare<[string], { count: number }>(
        `SELECT count(*) as count FROM messages WHERE session_id = ?`,
      )
      .get(session.id)?.count ?? 0;

    const fired = flushToolDeltaForSession({
      ctx,
      session,
      pluginRegistry: fakeReg as never,
    });
    expect(fired).toBe(true);

    const after = ctx.db
      .prepare<[string], { content: string; role: string }>(
        `SELECT content, role FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(session.id);
    expect(after).toBeTruthy();
    expect(after!.role).toBe("user");
    expect(after!.content).toContain("future_tool");
    expect(after!.content).toContain(currentVersion);
    // Old tool predates the 0.1.0 stamp; must not be advertised.
    expect(after!.content).not.toContain("ancient_tool");

    const messageCount = ctx.db
      .prepare<[string], { count: number }>(
        `SELECT count(*) as count FROM messages WHERE session_id = ?`,
      )
      .get(session.id)?.count ?? 0;
    expect(messageCount).toBe(before + 1);

    // Stamp got bumped.
    const stamp = ctx.db
      .prepare<[string], { v: string | null }>(
        `SELECT created_under_app_version as v FROM sessions WHERE id = ?`,
      )
      .get(session.id)?.v;
    expect(stamp).toBe(currentVersion);
  });

  it("is a no-op on a second call once the session is up-to-date", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const session = ensureActiveSession(ctx, DEV_USER_ID);
    ctx.db
      .prepare(
        `UPDATE sessions SET created_under_app_version = ? WHERE id = ?`,
      )
      .run("0.1.0", session.id);

    const fakeReg = fakeRegistry([
      {
        toolName: "ft",
        pluginId: "p",
        since: getPackageVersion()!,
        description: "x",
      },
    ]);

    expect(
      flushToolDeltaForSession({
        ctx,
        session,
        pluginRegistry: fakeReg as never,
      }),
    ).toBe(true);
    // Second call: nothing to advertise.
    expect(
      flushToolDeltaForSession({
        ctx,
        session,
        pluginRegistry: fakeReg as never,
      }),
    ).toBe(false);
  });

  it("bumps the stamp without notification when session has NULL version", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const session = ensureActiveSession(ctx, DEV_USER_ID);
    ctx.db
      .prepare(
        `UPDATE sessions SET created_under_app_version = NULL WHERE id = ?`,
      )
      .run(session.id);

    const fakeReg = fakeRegistry([
      {
        toolName: "anything",
        pluginId: "p",
        since: getPackageVersion()!,
      },
    ]);

    const before = ctx.db
      .prepare<[string], { count: number }>(
        `SELECT count(*) as count FROM messages WHERE session_id = ?`,
      )
      .get(session.id)?.count ?? 0;
    const fired = flushToolDeltaForSession({
      ctx,
      session,
      pluginRegistry: fakeReg as never,
    });
    expect(fired).toBe(false);
    const after = ctx.db
      .prepare<[string], { count: number }>(
        `SELECT count(*) as count FROM messages WHERE session_id = ?`,
      )
      .get(session.id)?.count ?? 0;
    expect(after).toBe(before); // no notification appended

    // But the stamp was claimed to currentVersion so we don't keep
    // re-checking it.
    const stamp = ctx.db
      .prepare<[string], { v: string | null }>(
        `SELECT created_under_app_version as v FROM sessions WHERE id = ?`,
      )
      .get(session.id)?.v;
    expect(stamp).toBe(getPackageVersion());
  });

  it("skips worker sessions entirely", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    // Hand-make a kind='worker' session so we don't go through
    // ensureActiveSession (which only creates kind='user').
    const id = `session_worker_test`;
    ctx.db
      .prepare(
        `INSERT INTO sessions (id, user_id, status, kind, created_at, created_under_app_version)
         VALUES (?, ?, 'active', 'worker', ?, '0.1.0')`,
      )
      .run(id, DEV_USER_ID, Date.now());

    const fakeReg = fakeRegistry([
      {
        toolName: "anything",
        pluginId: "p",
        since: getPackageVersion()!,
      },
    ]);
    const fired = flushToolDeltaForSession({
      ctx,
      session: {
        id,
        userId: DEV_USER_ID,
        parentId: null,
        status: "active",
        kind: "worker",
        title: null,
        createdAt: Date.now(),
      },
      pluginRegistry: fakeReg as never,
    });
    expect(fired).toBe(false);

    // No message appended, no stamp change.
    const messageCount = ctx.db
      .prepare<[string], { count: number }>(
        `SELECT count(*) as count FROM messages WHERE session_id = ?`,
      )
      .get(id)?.count ?? 0;
    expect(messageCount).toBe(0);
    const stamp = ctx.db
      .prepare<[string], { v: string | null }>(
        `SELECT created_under_app_version as v FROM sessions WHERE id = ?`,
      )
      .get(id)?.v;
    expect(stamp).toBe("0.1.0");
  });

  it("new user sessions get stamped at the current version on creation", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const session = ensureActiveSession(ctx, DEV_USER_ID);
    const stamp = ctx.db
      .prepare<[string], { v: string | null }>(
        `SELECT created_under_app_version as v FROM sessions WHERE id = ?`,
      )
      .get(session.id)?.v;
    expect(stamp).toBe(getPackageVersion());
  });
});
