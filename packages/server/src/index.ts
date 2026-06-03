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
  loadGlobalConfig,
  tenantMiddleware,
} from "./core/index.js";

// Default ports differ from the closed-source predecessor (3100/5173) so
// both projects can run side-by-side on the same dev machine without
// fighting over ports. Override via env if you need 3100 / 5173.
const PORT = Number.parseInt(process.env.PORT ?? "3110", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5183";

const globalOps = new GlobalOps();

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
  res.json({
    tenantId: tenant.tenantId,
    userId,
    config: { branding: tenant.config.branding ?? null },
    devTenant: tenant.tenantId === DEV_TENANT_ID && userId === DEV_USER_ID,
  });
});

const server = createServer(app);

// Tiny WebSocket scaffold so the web client has something to connect to.
// Real agent streaming + tenant binding arrives in a later PR.
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "connected", t: Date.now() }));
  socket.on("message", (raw) => {
    socket.send(JSON.stringify({ type: "echo", payload: raw.toString() }));
  });
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
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
