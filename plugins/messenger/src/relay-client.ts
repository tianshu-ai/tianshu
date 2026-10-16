// Messenger — Agent Bluetooth relay client
//
// Connects to an Agent Bluetooth server via WebSocket.
// Registers AgentCard, receives proxied A2A requests,
// forwards them to the local A2A handler.

import WebSocket from "ws";
import { hostname } from "node:os";
import { createHash } from "node:crypto";

export interface RelayClientOpts {
  relayUrl: string;
  tenantId: string;
  agentCard: Record<string, unknown>;
  discoverable: boolean;
  log: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void };
  /** Handle proxied A2A request from relay */
  onRequest: (req: { method: string; path: string; headers: Record<string, string>; body: string }) =>
    Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

function generateOrgId(tenantId: string): string {
  return createHash("sha256")
    .update(`${hostname()}\0${tenantId}`)
    .digest("hex")
    .slice(0, 16);
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
    this.orgId = generateOrgId(opts.tenantId);
    this.agentId = (opts.agentCard.name as string || "default")
      .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 32);
  }

  get isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  get publicUrl(): string { return this._publicUrl; }

  start() { this.stopped = false; this.connect(); }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.ws?.close(1000, "stopping");
    this.ws = null;
  }

  private connect() {
    if (this.stopped) return;
    const { relayUrl, log } = this.opts;
    try { this.ws = new WebSocket(relayUrl); } catch { this.scheduleReconnect(); return; }

    this.ws.on("open", () => {
      log.info?.("relay connected", { url: relayUrl });
      this.ws!.send(JSON.stringify({
        type: "register",
        orgId: this.orgId,
        agentId: this.agentId,
        card: this.opts.agentCard,
        discoverable: this.opts.discoverable,
      }));
      this.startHeartbeat();
    });

    this.ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (msg.type === "registered") {
        this._publicUrl = msg.publicUrl || "";
        log.info?.("relay registered", { publicUrl: this._publicUrl });
      }

      if (msg.type === "request" && msg.requestId) {
        this.handleRequest(msg).catch((err) => log.warn?.("relay request error", { error: err }));
      }
    });

    this.ws.on("close", () => { this.ws = null; this.scheduleReconnect(); });
    this.ws.on("error", (err) => { log.warn?.("relay ws error", { error: err.message }); });
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
      if (!this.stopped) this.heartbeatTimer = setTimeout(tick, 30000);
    };
    this.heartbeatTimer = setTimeout(tick, 30000);
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, 5000);
  }
}
