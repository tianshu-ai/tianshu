// Integration tests for the channel system.
//
// Covers:
//   - Migration 010 actually runs and the new sessions columns +
//     channel_bindings table exist
//   - bindings.ts CRUD round trip (create → get → update →
//     setStatus → delete)
//   - hub fan-out: a registered adapter's onMessage call lands in
//     hub subscribers tagged with envelope metadata
//   - ensureChannelSession: idempotent lookup + create

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  createBinding,
  deleteBinding,
  getBinding,
  listBindingsForTenant,
  listEnabledBindings,
  setBindingStatus,
  updateBinding,
} from "./bindings.js";
import { ChannelHub } from "./hub.js";
import { ensureChannelSession } from "./sessions.js";
import type {
  ChannelAdapter,
  InboundChannelMessage,
  OutboundChannelMessage,
} from "./types.js";

let home: string;
let prevHome: string | undefined;
let ops: GlobalOps;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-channels-"));
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

describe("migration 010 — channels", () => {
  it("adds the channel columns to sessions", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const cols = ctx.db
      .prepare(`PRAGMA table_info(sessions)`)
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("channel_id");
    expect(names).toContain("channel_chat_id");
    expect(names).toContain("channel_binding_id");
  });

  it("creates the channel_bindings table", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const cols = ctx.db
      .prepare(`PRAGMA table_info(channel_bindings)`)
      .all() as Array<{ name: string }>;
    expect(cols.length).toBeGreaterThan(0);
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "tenant_id",
        "channel_id",
        "plugin_id",
        "display_name",
        "config",
        "enabled",
        "status",
        "status_detail",
        "created_at",
        "updated_at",
      ]),
    );
  });
});

describe("bindings CRUD", () => {
  it("create → get round trip", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const created = createBinding(ctx.db, {
      tenantId: DEV_TENANT_ID,
      ownerUserId: DEV_USER_ID,
      channelId: "echo",
      pluginId: "plugin-echo",
      displayName: "Echo Demo",
      config: { token: "xyz" },
    });
    expect(created.id).toMatch(/^cb_/);
    expect(created.status).toBe("idle");
    expect(created.enabled).toBe(true);
    expect(created.config.token).toBe("xyz");

    const reloaded = getBinding(ctx.db, created.id);
    expect(reloaded).toBeTruthy();
    expect(reloaded?.displayName).toBe("Echo Demo");
  });

  it("listEnabled vs listForTenant filtering", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const enabled = createBinding(ctx.db, {
      tenantId: DEV_TENANT_ID,
      ownerUserId: DEV_USER_ID,
      channelId: "echo",
      pluginId: "p1",
      config: {},
      enabled: true,
    });
    createBinding(ctx.db, {
      tenantId: DEV_TENANT_ID,
      ownerUserId: DEV_USER_ID,
      // Distinct channel id — unique index `(tenant, owner, channel)`
      // (migration 012) forbids two bindings on the same triple.
      channelId: "echo2",
      pluginId: "p1",
      config: {},
      enabled: false,
    });
    const all = listBindingsForTenant(ctx.db, DEV_TENANT_ID);
    expect(all).toHaveLength(2);
    const onlyEnabled = listEnabledBindings(ctx.db);
    expect(onlyEnabled).toHaveLength(1);
    expect(onlyEnabled[0]!.id).toBe(enabled.id);
  });

  it("updateBinding patches only specified fields", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const c = createBinding(ctx.db, {
      tenantId: DEV_TENANT_ID,
      ownerUserId: DEV_USER_ID,
      channelId: "echo",
      pluginId: "p1",
      displayName: "Original",
      config: { a: 1 },
    });
    updateBinding(ctx.db, c.id, { displayName: "Renamed" });
    const after = getBinding(ctx.db, c.id);
    expect(after?.displayName).toBe("Renamed");
    expect(after?.config.a).toBe(1);
    expect(after?.enabled).toBe(true);
  });

  it("setBindingStatus updates status + detail", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const c = createBinding(ctx.db, {
      tenantId: DEV_TENANT_ID,
      ownerUserId: DEV_USER_ID,
      channelId: "echo",
      pluginId: "p1",
      config: {},
    });
    setBindingStatus(ctx.db, c.id, "error", "boom");
    const after = getBinding(ctx.db, c.id);
    expect(after?.status).toBe("error");
    expect(after?.statusDetail).toBe("boom");
  });

  it("deleteBinding removes the row", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const c = createBinding(ctx.db, {
      tenantId: DEV_TENANT_ID,
      ownerUserId: DEV_USER_ID,
      channelId: "echo",
      pluginId: "p1",
      config: {},
    });
    deleteBinding(ctx.db, c.id);
    expect(getBinding(ctx.db, c.id)).toBeNull();
  });
});

describe("ChannelHub fan-out", () => {
  it("tags inbound messages with binding + tenant and fans to subscribers", () => {
    const hub = new ChannelHub();
    const fakeAdapter = makeFakeAdapter("echo");
    hub.register("cb_test", "tenantA", fakeAdapter);

    const received: unknown[] = [];
    hub.onMessage((m) => received.push(m));

    fakeAdapter._emit({
      channelId: "echo",
      chatId: "u1",
      isDirect: true,
      senderId: "u1",
      text: "hi",
      messageId: "m1",
      timestamp: 1,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      bindingId: "cb_test",
      tenantId: "tenantA",
      channelId: "echo",
      chatId: "u1",
      text: "hi",
    });
  });

  it("rejects duplicate binding ids", () => {
    const hub = new ChannelHub();
    hub.register("cb1", "t", makeFakeAdapter("a"));
    expect(() => hub.register("cb1", "t", makeFakeAdapter("a"))).toThrow(
      /Duplicate binding id/,
    );
  });

  it("send() routes through the right adapter", async () => {
    const hub = new ChannelHub();
    const fake = makeFakeAdapter("echo");
    hub.register("cb1", "t", fake);
    await hub.send("cb1", { target: "u1", text: "hello" });
    expect(fake._sent).toEqual([{ target: "u1", text: "hello" }]);
  });

  it("send() throws for unknown bindings", async () => {
    const hub = new ChannelHub();
    await expect(hub.send("missing", { target: "x", text: "y" })).rejects.toThrow(
      /Unknown binding id/,
    );
  });
});

describe("ensureChannelSession", () => {
  it("creates a session row on first call, reuses on second", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const first = ensureChannelSession(ctx, {
      bindingId: "cb_x",
      channelId: "echo",
      chatId: "user_42",
      isDirect: true,
      senderName: "Alice",
    });
    expect(first.id).toMatch(/^session_/);
    expect(first.title).toBe("echo:dm:Alice");

    const second = ensureChannelSession(ctx, {
      bindingId: "cb_x",
      channelId: "echo",
      chatId: "user_42",
      isDirect: true,
      senderName: "Alice",
    });
    expect(second.id).toBe(first.id);
  });

  it("creates distinct sessions for different chat ids", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const a = ensureChannelSession(ctx, {
      bindingId: "cb_x",
      channelId: "echo",
      chatId: "u1",
      isDirect: true,
    });
    const b = ensureChannelSession(ctx, {
      bindingId: "cb_x",
      channelId: "echo",
      chatId: "u2",
      isDirect: true,
    });
    expect(a.id).not.toBe(b.id);
  });

  it("scopes by binding — same chat_id from two bindings creates two sessions", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const a = ensureChannelSession(ctx, {
      bindingId: "cb_a",
      channelId: "echo",
      chatId: "u1",
      isDirect: true,
    });
    const b = ensureChannelSession(ctx, {
      bindingId: "cb_b",
      channelId: "echo",
      chatId: "u1",
      isDirect: true,
    });
    expect(a.id).not.toBe(b.id);
  });

  it("uses chat id when senderName is absent", () => {
    const ctx = ops.open(DEV_TENANT_ID);
    const s = ensureChannelSession(ctx, {
      bindingId: "cb_x",
      channelId: "telegram",
      chatId: "12345",
      isDirect: false,
    });
    expect(s.title).toBe("telegram:group:12345");
  });
});

// ─── helpers ───────────────────────────────────────────────────

interface FakeAdapter extends ChannelAdapter {
  _emit: (msg: InboundChannelMessage) => void;
  _sent: OutboundChannelMessage[];
}

function makeFakeAdapter(id: string): FakeAdapter {
  const onMsg: Array<(m: InboundChannelMessage) => void> = [];
  const sent: OutboundChannelMessage[] = [];
  const adapter: FakeAdapter = {
    id,
    displayName: id,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async (m: OutboundChannelMessage) => {
      sent.push(m);
    }),
    onMessage: (handler) => {
      onMsg.push(handler);
    },
    onError: () => {},
    _emit: (m) => onMsg.forEach((h) => h(m)),
    _sent: sent,
  };
  return adapter;
}
