// Agent Relay — Client mode
//
// Connects to a remote relay server via WebSocket.
// Registers AgentCard, receives proxied A2A requests.

import WebSocket from "ws";
import type { TenantDbHandle } from "@tianshu-ai/plugin-sdk";
import { ensureClientSchema, generateOrgId } from "./schema.js";
import { hostname } from "node:os";
import { createHash } from "node:crypto";

type Db = TenantDbHandle;

export interface RelayClientOpts {
  db: Db;
  relayUrl: string;
  apiKey?: string;
  tenantId: string;
  agentCard: Record<string, unknown>;
  discoverable: boolean;
  log: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void };
  onRequest: (req: { method: string; path: string; headers: Record<string, string>; body: string }) =>
    Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private orgId: string;
  private agentId: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private _publicUrl = "";

  constructor(private opts: RelayClientOpts) {
    ensureClientSchema(opts.db);
    const machineId = createHash("sha256").update(hostname()).digest("hex").slice(0, 8);
    this.orgId = generateOrgId(machineId, hostname(), opts.tenantId);
    this.agentId = (opts.agentCard.name as string || "default").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32);
  }

  get isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  get relayPublicUrl(): string { return this._publicUrl; }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.ws?.close(1000, "client stopping");
    this.ws = null;
  }

  private connect() {
    if (this.stopped) return;
    const { relayUrl, log } = this.opts;
    try { this.ws = new WebSocket(relayUrl); } catch { this.scheduleReconnect(); return; }

    this.ws.on("open", () => {
      log.info?.(`Connected to relay: ${relayUrl}`);
      this.ws!.send(JSON.stringify({
        type: "register", orgId: this.orgId, agentId: this.agentId,
        card: this.opts.agentCard, discoverable: this.opts.discoverable,
        ...(this.opts.apiKey ? { token: this.opts.apiKey } : {}),
      }));
      this.startHeartbeat();
    });

    this.ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (msg.type === "registered") {
        this._publicUrl = msg.publicUrl || "";
        log.info?.(`Registered on relay: ${this._publicUrl}`);
        this.opts.db.prepare(
          `INSERT INTO relay_connection (id, relay_url, org_id, agent_id, public_url, connected, updated_at)
           VALUES ('default', ?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET relay_url=excluded.relay_url, org_id=excluded.org_id,
             agent_id=excluded.agent_id, public_url=excluded.public_url, connected=1, last_error='', updated_at=excluded.updated_at`,
        ).run(this.opts.relayUrl, this.orgId, this.agentId, this._publicUrl, Date.now());
      }

      if (msg.type === "request" && msg.requestId) {
        this.handleRequest(msg).catch((err) => log.warn?.("relay request error", { error: err }));
      }
    });

    this.ws.on("close", () => { this.ws = null; this.updateState(false); this.scheduleReconnect(); });
    this.ws.on("error", (err) => { this.opts.log.warn?.("relay ws error", { error: err.message }); this.updateState(false, err.message); });
  }

  private async handleRequest(msg: { requestId: string; method: string; path: string; headers: Record<string, string>; body: string }) {
    try {
      const result = await this.opts.onRequest({ method: msg.method, path: msg.path, headers: msg.headers, body: msg.body });
      this.ws?.send(JSON.stringify({ type: "response", requestId: msg.requestId, ...result }));
    } catch (err) {
      this.ws?.send(JSON.stringify({ type: "response", requestId: msg.requestId, status: 500, headers: {}, body: JSON.stringify({ error: String(err) }) }));
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    const tick = () => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('{"type":"ping"}');
      this.heartbeatTimer = setTimeout(tick, 30000);
    };
    this.heartbeatTimer = setTimeout(tick, 30000);
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, 5000);
  }

  private updateState(connected: boolean, error?: string) {
    this.opts.db.prepare("UPDATE relay_connection SET connected=?, last_error=?, updated_at=? WHERE id='default'").run(connected ? 1 : 0, error || "", Date.now());
  }
}
