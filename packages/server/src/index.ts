// Tianshu server entrypoint.
//
// PR #20 wires up the tenant infrastructure: every API request is
// attached to a TenantContext via middleware, the dev tenant is
// auto-created on first boot, and there's a tiny /api/me endpoint so
// you can see "yes, you really are inside a tenant" in the UI.
//
// Agent runtime, sandbox, and channels are still out of scope.

import "dotenv/config";

import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import {
  bootstrapDevTenantIfNeeded,
  DEV_TENANT_ID,
  DEV_USER_ID,
  GlobalOps,
  getDefaultModel,
  listModels,
  loadGlobalConfig,
  tenantMiddleware,
} from "./core/index.js";
import { buildBuiltinResolver, PluginRegistry } from "./core/plugins/index.js";
import { buildPluginsRouter } from "./plugins-routes.js";
import { CatalogClient } from "./catalog.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachChatHandler } from "./chat/handler.js";

// Default ports differ from the closed-source predecessor (3100/5173) so
// both projects can run side-by-side on the same dev machine without
// fighting over ports. Override via env if you need 3100 / 5173.
const PORT = Number.parseInt(process.env.PORT ?? "3110", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5183";

const globalOps = new GlobalOps();

// Plugin registry. ADR-0004 §15: builtin server modules are
// discovered by scanning the top-level `plugins/` directory rather
// than hand-imported here. Adding a new builtin = drop a directory
// with `manifest.json` + `dist/server.js`, no edit to this file.
//
// Tenant plugins (v1+) will be loaded via dynamic import in the
// resolver alongside the builtins.
const here = path.dirname(fileURLToPath(import.meta.url));
// `dist/index.js` → ../../../plugins, mirroring the convention used
// by the manifest discovery step in core/plugins/discovery.ts.
const defaultPluginsRoot = path.resolve(here, "..", "..", "..", "plugins");
const pluginsRoot = process.env.TIANSHU_PLUGINS_DIR
  ? path.resolve(process.env.TIANSHU_PLUGINS_DIR)
  : defaultPluginsRoot;

const pluginRegistry = new PluginRegistry({
  resolver: await buildBuiltinResolver({ pluginsRoot }),
});

// Catalog client — fetches the list of installable plugins from the
// `tianshu-ai/plugin-registry` repo. Override URL via
// TIANSHU_CATALOG_URL for self-hosted catalogs.
const catalogClient = new CatalogClient();

// Create the dev tenant + dev user on first boot if global config allows.
const bootstrap = bootstrapDevTenantIfNeeded(globalOps, loadGlobalConfig());
if (bootstrap.created) {
  // eslint-disable-next-line no-console
  console.log(
    `[tianshu] bootstrapped dev tenant "${bootstrap.tenantId}" with user "${bootstrap.userId}"`,
  );
} else {
  // eslint-disable-next-line no-console
  console.log(`[tianshu] tenants found: [${globalOps.list().join(", ")}]`);
}

const app = express();
app.use(
  cors({
    origin: CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

// /api/health is intentionally outside the tenant middleware so that a
// container orchestrator can liveness-check us before any tenant exists.
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "tianshu",
    version: "0.2.0",
    uptimeSec: Math.round(process.uptime()),
    tenants: globalOps.list().length,
  });
});

// Everything below /api/* needs a tenant context. Default resolver in
// dev mode pins to the bootstrap tenant + user; JWT mode will replace
// this resolver in a later PR.
app.use(
  "/api",
  tenantMiddleware({ ops: globalOps }),
);

app.get("/api/me", (req, res) => {
  if (!req.ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const { tenant, userId } = req.ctx;
  const def = getDefaultModel(tenant.config);
  res.json({
    tenantId: tenant.tenantId,
    userId,
    config: { branding: tenant.config.branding ?? null },
    defaultModel: def ? { id: def.id, name: def.name, provider: def.providerId } : null,
    devTenant: tenant.tenantId === DEV_TENANT_ID && userId === DEV_USER_ID,
  });
});

app.get("/api/models", (req, res) => {
  if (!req.ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const list = listModels(req.ctx.tenant.config).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.providerId,
    group: m.group ?? null,
    contextWindow: m.contextWindow,
    reasoning: m.reasoning,
  }));
  res.json({ models: list, defaultModel: req.ctx.tenant.config.defaultModel ?? null });
});

// /api/plugins (GET + PATCH) — see ./plugins-routes.ts.
//
// ADR-0003 §8 originally reserved `PATCH /api/plugins/:id` for v1; we
// ship it in v0 so the bundled Plugin Manager UI can flip
// enable/disable without asking the user to hand-edit
// `<tenant>/config.json`.
app.use(
  "/api",
  buildPluginsRouter({
    registry: pluginRegistry,
    ops: globalOps,
    catalog: catalogClient,
  }),
);

const server = createServer(app);

// Chat over WebSocket. Dev mode pins to the bootstrap tenant + user;
// JWT-mode auth lands in a later PR and will replace the resolver.
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  // Resolve identity. Today: dev tenant + dev user.
  const tenantId = DEV_TENANT_ID;
  const userId = DEV_USER_ID;
  let ctx;
  try {
    ctx = globalOps.open(tenantId);
  } catch (err) {
    socket.send(
      JSON.stringify({
        type: "stream_error",
        reason: `tenant ${tenantId} unavailable: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    socket.close();
    return;
  }
  attachChatHandler({ ctx, userId, socket });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[tianshu] server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[tianshu] websocket at ws://localhost:${PORT}/ws`);
});

const shutdown = (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`[tianshu] received ${signal}, shutting down`);
  wss.close();
  server.close(() => {
    globalOps.closePool();
    // Plugin caches die with the process; nothing to clean up here.
    void pluginRegistry;
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
