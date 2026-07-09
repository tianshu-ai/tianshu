// Single WebSocket connection to /ws shared across the app.
//
// We auto-reconnect with exponential backoff so a server restart
// (`npm run dev` reload) doesn't strand the UI. Subscribers register a
// listener with `on(type, handler)` and get back an `off()` function.

import type { WireMessage } from "../types/chat";

export type ServerEvent =
  | { type: "connected"; tenantId: string; userId: string }
  | { type: "history"; messages: WireMessage[]; hasMore: boolean }
  | {
      type: "history_page";
      messages: WireMessage[];
      hasMore: boolean;
      before: string;
    }
  | { type: "message_added"; message: WireMessage; sessionId?: string }
  | { type: "stream_start" }
  | { type: "stream_delta"; delta: string }
  | { type: "stream_end"; message: WireMessage }
  | { type: "stream_error"; reason: string }
  /**
   * A transient LLM call failure is being retried (rate limit /
   * network / expired token). Emitted once per retry attempt so the
   * UI can show a small "retrying…" notice. Informational only: the
   * stream continues on success, or ends with `stream_error` if all
   * attempts are exhausted.
   */
  | {
      type: "model_retry";
      attempt: number;
      maxAttempts: number;
      kind: string;
      delayMs: number;
      rateLimited: boolean;
      message: string;
      sessionId?: string;
    }
  | { type: "tool_call"; callId: string; name: string; arguments: Record<string, unknown>; sessionId?: string }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; text: string; sessionId?: string }
  | {
      type: "history_compacted";
      reason: "auto" | "manual";
      oldSessionId: string;
      newSessionId: string;
      summarisedCount: number;
      keptCount: number;
      durationMs: number;
    }
  | {
      type: "plugins_changed";
      enabled: PluginsChangedDelta[];
      disabled: PluginsChangedDelta[];
    }
  /**
   * A channel produced a new inbound message (or removed a
   * session). Plugin sidebar sections subscribed to this event
   * re-poll their session lists so newly-arrived threads pop
   * in immediately rather than waiting for the 30s polling
   * fallback.
   */
  | { type: "channel_session_changed"; channelId: string }
  /**
   * The host's tool catalog drifted vs. the version this user's
   * active session was last stamped under — typically because
   * the server was upgraded while the tab was closed. Fired once
   * at WS connect time when there's anything to surface.
   */
  | {
      type: "tool_catalog_changed";
      fromVersion: string | null;
      toVersion: string;
      newTools: ReadonlyArray<{ name: string; pluginId: string }>;
    }
  /**
   * Generic passthrough for a plugin's `ctx.broadcast(type, payload)`,
   * wrapped host-side. `event` is `<pluginId>:<type>` (e.g.
   * "workboard:workboard.task"); plugin frontends filter on it and
   * read `payload`. Lets plugin UIs react to server pushes instead of
   * polling on a timer.
   */
  | { type: "plugin_event"; event: string; payload: unknown };

export interface PluginsChangedDelta {
  pluginId: string;
  displayName: string;
  tools: string[];
  toolsets: string[];
}

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
