// Messenger — Agent Bluetooth relay client
//
// Connects to an Agent Bluetooth server via WebSocket.
// Registers AgentCard, receives proxied A2A requests,
// forwards them to the local A2A handler.

import WebSocket from "ws";
import { hostname } from "node:os";
import { createHash } from "node:crypto";

export interface PairRequest {
  fromOrgId: string;
  fromAgentId: string;
  fromName: string;
  fromCard?: Record<string, unknown>;
  fromToken: string;
  fromEndpoint: string;
  requestId: string;
}

export interface PairResult {
  success: boolean;
  token?: string;
  name?: string;
  card?: Record<string, unknown>;
  endpoint?: string;
  error?: string;
}

export interface RelayClientOpts {
  relayUrl: string;
  tenantId: string;
  agentCard: Record<string, unknown>;
  discoverable: boolean;
  log: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void };
  /** Handle proxied A2A request from relay */
  onRequest: (req: { method: string; path: string; headers: Record<string, string>; body: string }) =>
    Promise<{ status: number; headers: Record<string, string>; body: string }>;
  /** Handle incoming pair request — return token + card to accept */
  onPairRequest?: (req: PairRequest) => Promise<{ accept: boolean; token?: string; name?: string; card?: Record<string, unknown> }>;
  /** Called when relay server expires our discoverable status */
  onDiscoverableExpired?: () => void;
}

function generateOrgId(tenantId: string): string {
  return createHash("sha256")
    .update(`${hostname()}\0${tenantId}`)
    .digest("hex")
    .slice(0, 16);
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private _orgId: string;
  private agentId: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private _publicUrl = "";

  constructor(private opts: RelayClientOpts) {
    this._orgId = generateOrgId(opts.tenantId);
    this.agentId = (opts.agentCard.name as string || "default")
      .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 32);
  }

  private _discoverable = false;

  get isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  get publicUrl(): string { return this._publicUrl; }
  get discoverable(): boolean { return this._discoverable; }
  get orgId(): string { return this._orgId; }

  /** Initiate pairing with a discovered agent */
  async pair(targetOrgId: string, targetAgentId: string, opts: { name: string; token: string; card?: Record<string, unknown> }): Promise<PairResult> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve({ success: false, error: "not_connected" });
        return;
      }
      const handler = (raw: WebSocket.Data) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === "pair_response") {
            this.ws?.removeListener("message", handler);
            resolve(msg);
          }
        } catch { /* ignore */ }
      };
      this.ws.on("message", handler);
      // Timeout after 30s
      setTimeout(() => { this.ws?.removeListener("message", handler); resolve({ success: false, error: "timeout" }); }, 30000);
      this.ws.send(JSON.stringify({
        type: "pair_request",
        targetOrgId,
        targetAgentId,
        name: opts.name,
        token: opts.token,
        card: opts.card,
      }));
    });
  }

  setDiscoverable(value: boolean, pairToken?: string) {
    this._discoverable = value;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "set_discoverable", discoverable: value, pairToken: value ? pairToken : undefined }));
    }
  }

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
        orgId: this._orgId,
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
        if (typeof msg.discoverable === "boolean") this._discoverable = msg.discoverable;
        log.info?.("relay registered", { publicUrl: this._publicUrl, discoverable: this._discoverable });
      }

      if (msg.type === "discoverable_expired") {
        this._discoverable = false;
        log.info?.("relay discoverable expired");
        this.opts.onDiscoverableExpired?.();
      }

      if (msg.type === "pair_request" && msg.requestId && this.opts.onPairRequest) {
        this.opts.onPairRequest(msg as PairRequest).then((resp) => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: "pair_accept",
              requestId: msg.requestId,
              ...resp,
            }));
          }
        }).catch((err) => log.warn?.("pair_request handler error", { error: err }));
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
