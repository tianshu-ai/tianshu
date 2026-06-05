// Single WebSocket connection to /ws shared across the app.
//
// We auto-reconnect with exponential backoff so a server restart
// (`npm run dev` reload) doesn't strand the UI. Subscribers register a
// listener with `on(type, handler)` and get back an `off()` function.

import type { WireMessage } from "../types/chat";

export type ServerEvent =
  | { type: "connected"; tenantId: string; userId: string }
  | { type: "history"; messages: WireMessage[] }
  | { type: "message_added"; message: WireMessage }
  | { type: "stream_start" }
  | { type: "stream_delta"; delta: string }
  | { type: "stream_end"; message: WireMessage }
  | { type: "stream_error"; reason: string }
  | { type: "tool_call"; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; text: string }
  | {
      type: "history_compacted";
      reason: "auto" | "manual";
      oldSessionId: string;
      newSessionId: string;
      summarisedCount: number;
      keptCount: number;
      durationMs: number;
    };

type EventType = ServerEvent["type"];
type Handler<T extends EventType> = (msg: Extract<ServerEvent, { type: T }>) => void;
// Internal storage type — use a generic-erased handler so the Map can
// hold mixed-type handler sets without per-Set generics gymnastics.
type AnyHandler = (msg: ServerEvent) => void;

class TianshuWs {
  private ws: WebSocket | null = null;
  private listeners = new Map<EventType, Set<AnyHandler>>();
  private connectAttempts = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private outgoingQueue: string[] = [];

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.connectAttempts = 0;
      const queued = this.outgoingQueue.splice(0);
      for (const m of queued) ws.send(m);
    });
    ws.addEventListener("message", (ev) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(ev.data as string) as ServerEvent;
      } catch {
        return;
      }
      const subs = this.listeners.get(parsed.type);
      if (!subs) return;
      for (const h of subs) h(parsed);
    });
    ws.addEventListener("close", () => {
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // close handler will trigger reconnect; nothing to do here.
    });
  }

  private scheduleReconnect(): void {
    if (this.connectTimer) return;
    this.connectAttempts += 1;
    const delay = Math.min(15000, 500 * 2 ** Math.min(5, this.connectAttempts));
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, delay);
  }

  send(payload: { type: string; [k: string]: unknown }): void {
    const data = JSON.stringify(payload);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.outgoingQueue.push(data);
      this.connect();
      return;
    }
    this.ws.send(data);
  }

  on<T extends EventType>(type: T, h: Handler<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const erased = h as unknown as AnyHandler;
    set.add(erased);
    return () => {
      set!.delete(erased);
    };
  }
}

export const tianshuWs = new TianshuWs();
