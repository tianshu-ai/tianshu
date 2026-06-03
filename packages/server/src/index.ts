// Tianshu server entrypoint — minimal Express + WebSocket bootstrap.
//
// This file deliberately stays small. Feature wiring (agent runtime,
// browser sidecar, channels, etc.) lands in follow-up PRs as the project
// grows in public. See ROADMAP.md / DEV_LOG for what's next.

import "dotenv/config";

import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT ?? "3100", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";

const app = express();
app.use(
  cors({
    origin: CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "tianshu",
    version: "0.1.0",
    uptimeSec: Math.round(process.uptime()),
  });
});

const server = createServer(app);

// Tiny WebSocket scaffold so the web client has something to connect to
// during local dev. Full agent streaming arrives in a later PR.
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "connected", t: Date.now() }));
  socket.on("message", (raw) => {
    // Echo for now; replace with real protocol later.
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
  server.close(() => process.exit(0));
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
