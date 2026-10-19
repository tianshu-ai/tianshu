// Messenger — Agent Bluetooth relay client
//
// Connects to an Agent Bluetooth server via WebSocket.
// Registers AgentCards for multiple users, receives proxied A2A requests,
// forwards them to the local A2A handler.

import WebSocket from "ws";


export interface PairRequest {
  fromOrgId: string;
  fromAgentId: string;
  fromUserId?: string;
  fromName: string;
  fromCard?: Record<string, unknown>;
  fromEndpoint: string;
  requestId: string;
}

export interface PairResult {
  success: boolean;
  status?: "pending" | "accepted" | "rejected";
  requestId?: string;
  token?: string;
  name?: string;
  card?: Record<string, unknown>;
  endpoint?: string;
  error?: string;
}

export interface AgentRegistration {
  userId: string;
  card: Record<string, unknown>;
  discoverable: boolean;
}

export interface RelayClientOpts {
  relayUrl: string;
  token: string;
  tenantId: string;
  /** Initial agent registrations (one per user with a card) */
  agents?: AgentRegistration[];
  /** @deprecated Use agents[] instead */
  userId?: string;
  /** @deprecated Use agents[] instead */
  agentCard?: Record<string, unknown>;
  /** @deprecated Use agents[] instead */
  discoverable?: boolean;
  log: { info?(...a: unknown[]): void; warn?(...a: unknown[]): void };
  /** Handle proxied A2A request from relay */
  onRequest: (req: { method: string; path: string; headers: Record<string, string>; body: string }) =>
    Promise<{ status: number; headers: Record<string, string>; body: string }>;
  /** Handle incoming pair request — return token + card to accept */
  onPairRequest?: (req: PairRequest) => Promise<{ accept: boolean; token?: string; name?: string; card?: Record<string, unknown> }>;
  /** Called when relay server expires our discoverable status */
  onDiscoverableExpired?: () => void;
  onPairAccepted?: (msg: { requestId: string; fromOrgId: string; fromAgentId: string; fromName: string; fromCard?: Record<string, unknown>; fromToken: string; fromEndpoint: string }) => void;
  onPairRejected?: (msg: { requestId: string; fromOrgId: string; fromAgentId: string }) => void;
  onPairCompleted?: (msg: { requestId: string; fromOrgId: string; fromAgentId: string; fromName: string; fromCard?: Record<string, unknown>; fromToken: string; fromEndpoint: string }) => void;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private _orgId = "";
  private agentId: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private _publicUrl = "";
  private _discoverable = false;

  /** All agents to register on this connection */
  private registeredAgents: Map<string, AgentRegistration> = new Map();

  constructor(private opts: RelayClientOpts) {
    this.agentId = opts.tenantId || "default";

    // Build initial agent list
    if (opts.agents && opts.agents.length > 0) {
      for (const a of opts.agents) {
        this.registeredAgents.set(a.userId, a);
      }
    } else if (opts.userId || opts.agentCard) {
      // Legacy single-agent mode
      this.registeredAgents.set(opts.userId || "", {
        userId: opts.userId || "",
        card: opts.agentCard || {},
        discoverable: opts.discoverable ?? false,
      });
    }
  }

  get isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  get publicUrl(): string { return this._publicUrl; }
  get discoverable(): boolean { return this._discoverable; }
  get orgId(): string { return this._orgId; }
  get agentIdentifier(): string { return this.agentId; }
  get agentCount(): number { return this.registeredAgents.size; }

  /** Register an additional agent (user) on this connection */
  registerAgent(reg: AgentRegistration) {
    this.registeredAgents.set(reg.userId, reg);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendRegister(reg);
    }
  }

  /** Unregister a user's agent from this connection */
  unregisterAgent(userId: string) {
    this.registeredAgents.delete(userId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "unregister", agentId: this.agentId, userId }));
    }
  }

  /** Initiate pairing with a discovered agent */
  async pair(targetOrgId: string, targetAgentId: string, opts: { name: string; token?: string; card?: Record<string, unknown>; userId?: string; targetUserId?: string }): Promise<PairResult> {
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
      setTimeout(() => { this.ws?.removeListener("message", handler); resolve({ success: false, error: "timeout" }); }, 30000);
      this.ws.send(JSON.stringify({
        type: "pair_request",
        targetOrgId,
        targetAgentId,
        targetUserId: opts.targetUserId,
        fromAgentId: this.agentId,
        fromUserId: opts.userId,
        name: opts.name,
        card: opts.card,
      }));
    });
  }

  acceptPair(targetOrgId: string, targetAgentId: string, requestId: string, opts: { name: string; token: string; card?: Record<string, unknown>; userId?: string; targetUserId?: string }) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "pair_accept", targetOrgId, targetAgentId, targetUserId: opts.targetUserId, requestId, name: opts.name, token: opts.token, card: opts.card, fromAgentId: this.agentId, fromUserId: opts.userId }));
    }
  }

  rejectPair(targetOrgId: string, targetAgentId: string, requestId: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "pair_reject", targetOrgId, targetAgentId, requestId }));
    }
  }

  completePair(targetOrgId: string, targetAgentId: string, requestId: string, opts: { name: string; token: string; card?: Record<string, unknown>; userId?: string; targetUserId?: string }) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "pair_complete", targetOrgId, targetAgentId, targetUserId: opts.targetUserId, requestId, name: opts.name, token: opts.token, card: opts.card, fromAgentId: this.agentId, fromUserId: opts.userId }));
    }
  }

  setDiscoverable(value: boolean, pairToken?: string, userId?: string) {
    this._discoverable = value;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "set_discoverable",
        agentId: this.agentId,
        userId: userId || "",
        discoverable: value,
        pairToken: value ? pairToken : undefined,
      }));
    }
  }

  /** Push updated agent card to the relay server */
  updateCard(card: { name: string; description: string; skills?: unknown[]; version?: string; provider?: string }, userId?: string) {
    // Update local cache
    const reg = this.registeredAgents.get(userId || "");
    if (reg) reg.card = card;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "update_card", agentId: this.agentId, userId: userId || "", card }));
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

  private sendRegister(reg: AgentRegistration) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: "register",
      token: this.opts.token,
      agentId: this.agentId,
      userId: reg.userId,
      card: reg.card,
      discoverable: reg.discoverable,
    }));
  }

  private connect() {
    if (this.stopped) return;
    const { relayUrl, log } = this.opts;
    try { this.ws = new WebSocket(relayUrl); } catch { this.scheduleReconnect(); return; }

    this.ws.on("open", () => {
      log.info?.("relay connected", { url: relayUrl, agents: this.registeredAgents.size });
      // Register all agents on this connection
      for (const reg of this.registeredAgents.values()) {
        this.sendRegister(reg);
      }
      this.startHeartbeat();
    });

    this.ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (msg.type === "registered") {
        this._publicUrl = msg.publicUrl || "";
        if (msg.orgId) this._orgId = msg.orgId;
        if (typeof msg.discoverable === "boolean") this._discoverable = msg.discoverable;
        log.info?.("relay registered", { orgId: this._orgId, agentId: msg.agentId, userId: msg.userId, publicUrl: this._publicUrl, discoverable: this._discoverable });
      }

      if (msg.type === "error") {
        log.warn?.("relay error", { error: msg.error });
        this.ws?.close();
        return;
      }

      if (msg.type === "discoverable_expired") {
        this._discoverable = false;
        log.info?.("relay discoverable expired");
        this.opts.onDiscoverableExpired?.();
      }

      if (msg.type === "pair_accepted" && msg.requestId && this.opts.onPairAccepted) {
        this.opts.onPairAccepted(msg);
      }

      if (msg.type === "pair_rejected" && msg.requestId && this.opts.onPairRejected) {
        this.opts.onPairRejected(msg);
      }

      if (msg.type === "pair_completed" && msg.requestId && this.opts.onPairCompleted) {
        this.opts.onPairCompleted(msg);
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
