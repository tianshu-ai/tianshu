// Agent Relay — Server mode
//
// Accepts WS connections from remote tianshu agents.
// Proxies incoming A2A HTTP requests to agents via WS.

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TenantDbHandle } from "@tianshu-ai/plugin-sdk";
import { createServer } from "node:http";
import { upsertAgent, setAgentOffline, setAgentOnline, listDiscoverableAgents, getAgent, ensureServerSchema } from "./schema.js";

type Db = TenantDbHandle;

interface AgentSession {
  ws: WebSocket;
  orgId: string;
  agentId: string;
  id: string;
}

interface PendingRequest {
  resolve: (data: { status: number; headers: Record<string, string>; body: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RelayServerOpts {
  db: Db;
  port: number;
  publicUrl: string;
  log: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void };
}

export class RelayServer {
  private sessions = new Map<string, AgentSession>();
  private pending = new Map<string, PendingRequest>();
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;

  constructor(private opts: RelayServerOpts) {
    ensureServerSchema(opts.db);
  }

  start() {
    const { port, log } = this.opts;
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => this.handleWsConnection(ws, req));
    this.httpServer.listen(port, () => {
      log.info?.(`Agent Relay server listening on port ${port}`);
    });
  }

  stop() {
    for (const [, s] of this.sessions) s.ws.close(1001, "server shutting down");
    this.sessions.clear();
    this.wss?.close();
    this.httpServer?.close();
  }

  private handleWsConnection(ws: WebSocket, _req: IncomingMessage) {
    const { log, db } = this.opts;
    let session: AgentSession | null = null;

    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (msg.type === "register" && msg.orgId && msg.agentId) {
        const id = `${msg.orgId}/${msg.agentId}`;
        session = { ws, orgId: msg.orgId, agentId: msg.agentId, id };
        this.sessions.set(id, session);

        upsertAgent(db, {
          orgId: msg.orgId, agentId: msg.agentId,
          displayName: msg.card?.name || msg.agentId,
          description: msg.card?.description || "",
          cardJson: JSON.stringify(msg.card || {}),
          apiKeyHash: "", discoverable: msg.discoverable ?? false,
        });

        ws.send(JSON.stringify({
          type: "registered",
          publicUrl: `${this.opts.publicUrl}/u/${msg.orgId}/${msg.agentId}`,
          agentPath: `${msg.orgId}/${msg.agentId}`,
        }));
        log.info?.(`Agent registered: ${id}`);
      }

      if (msg.type === "response" && msg.requestId) {
        const p = this.pending.get(msg.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.requestId);
          p.resolve({ status: msg.status || 200, headers: msg.headers || {}, body: msg.body || "" });
        }
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        if (session) setAgentOnline(db, session.id);
      }
    });

    ws.on("close", () => {
      if (session) { this.sessions.delete(session.id); setAgentOffline(db, session.id); log.info?.(`Agent disconnected: ${session.id}`); }
    });
    ws.on("error", () => {
      if (session) { this.sessions.delete(session.id); setAgentOffline(db, session.id); }
    });
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = req.url || "/";
    const method = req.method || "GET";

    // Discovery
    if (url.startsWith("/discovery")) {
      const agents = listDiscoverableAgents(this.opts.db);
      const cards = agents.map((a) => ({
        orgId: a.orgId, agentId: a.agentId, name: a.displayName,
        description: a.description, online: a.online,
        url: `${this.opts.publicUrl}/u/${a.orgId}/${a.agentId}`,
        card: JSON.parse(a.cardJson),
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agents: cards }));
      return;
    }

    // Agent Card
    const cardMatch = url.match(/^\/u\/([^/]+)\/([^/]+)\/\.well-known\/agent-card\.json$/);
    if (cardMatch && method === "GET") {
      const agent = getAgent(this.opts.db, cardMatch[1], cardMatch[2]);
      if (!agent) { res.writeHead(404); res.end('{"error":"not_found"}'); return; }
      const card = JSON.parse(agent.cardJson);
      card.url = `${this.opts.publicUrl}/u/${agent.orgId}/${agent.agentId}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(card));
      return;
    }

    // A2A proxy
    const proxyMatch = url.match(/^\/u\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (proxyMatch) {
      const [, orgId, agentId, subPath] = proxyMatch;
      const id = `${orgId}/${agentId}`;
      const session = this.sessions.get(id);
      if (!session || session.ws.readyState !== WebSocket.OPEN) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end('{"error":"agent_offline"}');
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf-8");

      const requestId = crypto.randomUUID();
      const responsePromise = new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(requestId); resolve({ status: 504, headers: {}, body: '{"error":"gateway_timeout"}' }); }, 5 * 60 * 1000);
        this.pending.set(requestId, { resolve, timer });
      });

      session.ws.send(JSON.stringify({
        type: "request", requestId, method, path: subPath || "/",
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "upgrade"].includes(k))),
        body,
      }));

      const resp = await responsePromise;
      res.writeHead(resp.status, { "Content-Type": "application/json", ...resp.headers });
      res.end(resp.body);
      return;
    }

    if (url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end('{"error":"not_found"}');
  }
}
