// Integration test for the host-owned tool_catalog_refresh.
//
// We exercise it against a real bootstrapped dev tenant + a fake
// PluginRegistry-shaped stub returning a controlled catalog.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DbPool } from "../../core/db-pool.js";
import { GlobalOps } from "../../core/global-ops.js";
import {
  bootstrapDevTenantIfNeeded,
  DEV_TENANT_ID,
  DEV_USER_ID,
} from "../../core/dev-mode.js";
import { ensureActiveSession } from "../messages.js";
import {
  buildToolCatalogRefreshTool,
  TOOL_CATALOG_REFRESH_NAME,
} from "./tool-catalog-refresh.js";
import type { AgentToolContext } from "@tianshu-ai/plugin-sdk";

// Stub for `deps.registry()` — only `toolCatalogForTenant` is read.
function fakeRegistryGetter(catalog: Array<{
  toolName: string;
  pluginId: string;
  since?: string | null;
  description?: string;
}>) {
  return () =>
    ({
      toolCatalogForTenant: () => catalog,
    }) as never;
}

function makeCtx(sessionId: string, tenantId = DEV_TENANT_ID): AgentToolContext {
  return {
    pluginId: "core",
    tenantId,
    userId: DEV_USER_ID,
    capabilities: {
      get: () => undefined,
      has: () => false,
    },
    userHomeDir: "/tmp",
    tenantHomeDir: "/tmp",
    agentScope: { kind: "main" },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    sessionId,
  } as AgentToolContext;
}

let home: string;
let prevHome: string | undefined;
let ops: GlobalOps;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-cat-refresh-"));
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

describe("tool_catalog_refresh", () => {
  it("has the expected schema name", () => {
    expect(TOOL_CATALOG_REFRESH_NAME).toBe("tool_catalog_refresh");
    const tool = buildToolCatalogRefreshTool({
      openTenant: (id) => ops.open(id),
      registry: fakeRegistryGetter([]),
    });
    expect(tool.schema.name).toBe(TOOL_CATALOG_REFRESH_NAME);
  });

  it("mode=full lists every tool that has a since", () => {
    const ctx0 = ops.open(DEV_TENANT_ID);
    const session = ensureActiveSession(ctx0, DEV_USER_ID);
    const tool = buildToolCatalogRefreshTool({
      openTenant: (id) => ops.open(id),
      registry: fakeRegistryGetter([
        { toolName: "a", pluginId: "p", since: "0.1.0", description: "Alpha." },
        { toolName: "b", pluginId: "p", since: "0.2.0", description: "Beta." },
        { toolName: "c", pluginId: "p", description: "No since." },
      ]),
    });
    const res = tool.execute({ mode: "full" }, makeCtx(session.id)) as {
      ok: boolean;
      text: string;
      data?: { tools?: Array<{ toolName: string }> };
    };
    expect(res.ok).toBe(true);
    const names = (res.data?.tools ?? []).map((t) => t.toolName).sort();
    // 'c' has no since → not advertised. 'a' + 'b' are.
    expect(names).toEqual(["a", "b"]);

    // The system note actually got appended to the session.
    const last = ctx0.db
      .prepare<[string], { role: string; content: string }>(
        `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(session.id);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("a");
    expect(last?.content).toContain("b");
    expect(last?.content).not.toContain("`c`"); // no since → skipped
  });

  it("mode=since lists only tools newer than since_version", () => {
    const ctx0 = ops.open(DEV_TENANT_ID);
    const session = ensureActiveSession(ctx0, DEV_USER_ID);
    const tool = buildToolCatalogRefreshTool({
      openTenant: (id) => ops.open(id),
      registry: fakeRegistryGetter([
        { toolName: "ancient", pluginId: "p", since: "0.0.1" },
        { toolName: "mid", pluginId: "p", since: "0.2.5" },
        { toolName: "recent", pluginId: "p", since: "0.3.20" },
      ]),
    });
    const res = tool.execute(
      { mode: "since", since_version: "0.2.0" },
      makeCtx(session.id),
    ) as {
      ok: boolean;
      data?: { tools?: Array<{ toolName: string }> };
    };
    expect(res.ok).toBe(true);
    const names = (res.data?.tools ?? []).map((t) => t.toolName).sort();
    // ancient @ 0.0.1 < 0.2.0 → not included
    // mid @ 0.2.5 > 0.2.0 → included
    // recent @ 0.3.20 > 0.2.0 → included
    expect(names).toEqual(["mid", "recent"]);
  });

  it("mode=since rejects missing since_version", () => {
    const ctx0 = ops.open(DEV_TENANT_ID);
    const session = ensureActiveSession(ctx0, DEV_USER_ID);
    const tool = buildToolCatalogRefreshTool({
      openTenant: (id) => ops.open(id),
      registry: fakeRegistryGetter([
        { toolName: "x", pluginId: "p", since: "0.1.0" },
      ]),
    });
    const res = tool.execute({ mode: "since" }, makeCtx(session.id)) as {
      ok: boolean;
      text: string;
    };
    expect(res.ok).toBe(false);
    expect(res.text).toContain("since_version");
  });

  it("rejects when no chat session is in context", () => {
    const tool = buildToolCatalogRefreshTool({
      openTenant: (id) => ops.open(id),
      registry: fakeRegistryGetter([
        { toolName: "x", pluginId: "p", since: "0.1.0" },
      ]),
    });
    const res = tool.execute(
      { mode: "full" },
      { ...makeCtx("placeholder"), sessionId: undefined },
    ) as { ok: boolean; text: string };
    expect(res.ok).toBe(false);
    expect(res.text).toContain("chat session");
  });

  it("rejects when no tools are registered", () => {
    const ctx0 = ops.open(DEV_TENANT_ID);
    const session = ensureActiveSession(ctx0, DEV_USER_ID);
    const tool = buildToolCatalogRefreshTool({
      openTenant: (id) => ops.open(id),
      registry: fakeRegistryGetter([]),
    });
    const res = tool.execute({ mode: "full" }, makeCtx(session.id)) as {
      ok: boolean;
      text: string;
    };
    expect(res.ok).toBe(false);
    expect(res.text).toContain("no tools");
  });

  it("rejects when session id doesn't exist in the tenant", () => {
    const tool = buildToolCatalogRefreshTool({
      openTenant: (id) => ops.open(id),
      registry: fakeRegistryGetter([
        { toolName: "x", pluginId: "p", since: "0.1.0" },
      ]),
    });
    const res = tool.execute(
      { mode: "full" },
      makeCtx("session_does_not_exist"),
    ) as { ok: boolean; text: string };
    expect(res.ok).toBe(false);
    expect(res.text).toContain("not found");
  });

  it("is unavailable on worker scope", () => {
    const tool = buildToolCatalogRefreshTool({
      openTenant: (id) => ops.open(id),
      registry: fakeRegistryGetter([]),
    });
    expect(
      tool.available?.({
        ...makeCtx("s"),
        agentScope: { kind: "worker", workerKind: "echo" },
      }),
    ).toBe(false);
    expect(tool.available?.(makeCtx("s"))).toBe(true);
  });

  it("renders a useful note when no tools are newer than since_version", () => {
    const ctx0 = ops.open(DEV_TENANT_ID);
    const session = ensureActiveSession(ctx0, DEV_USER_ID);
    const tool = buildToolCatalogRefreshTool({
      openTenant: (id) => ops.open(id),
      registry: fakeRegistryGetter([
        { toolName: "old", pluginId: "p", since: "0.1.0" },
      ]),
    });
    const res = tool.execute(
      { mode: "since", since_version: "0.5.0" },
      makeCtx(session.id),
    ) as { ok: boolean; text: string };
    expect(res.ok).toBe(true);
    expect(res.text).toContain("0.5.0");
    // No system note was appended (empty delta).
    const count = ctx0.db
      .prepare<[string], { c: number }>(
        `SELECT count(*) as c FROM messages WHERE session_id = ?`,
      )
      .get(session.id)?.c ?? 0;
    expect(count).toBe(0);
  });
});
