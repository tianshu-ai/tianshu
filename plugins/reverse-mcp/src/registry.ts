// In-memory registry of dialed-in bridge connections, scoped to one
// tenant (the plugin activates per tenant, closing over ctx.tenantId).
//
// A connection is identified by (userId, deviceId). Each holds the live
// WebSocket, the advertised tool list, and a map of in-flight JSON-RPC
// calls awaiting their reply. Everything is best-effort and self-heals:
// a dropped socket removes the connection; a timed-out call rejects.

import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import { MSG, type McpToolDescriptor, type RequestMsg } from "./protocol.js";

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeConn {
  userId: string;
  deviceId: string;
  label: string;
  socket: WebSocket;
  tools: McpToolDescriptor[];
  connectedAt: number;
  pending: Map<string, Pending>;
}

const CALL_TIMEOUT_MS = 60_000;

/** Persisted bridge registration — survives server restarts. */
interface PersistedBridge {
  userId: string;
  deviceId: string;
  label: string;
  tools: McpToolDescriptor[];
  savedAt: number;
}

export class BridgeRegistry {
  // key = `${userId}\u0000${deviceId}`
  private readonly conns = new Map<string, BridgeConn>();
  private seq = 0;
  private persistPath: string | null = null;

  /** Enable persistence: load last known bridges and save on changes. */
  enablePersistence(filePath: string): void {
    this.persistPath = filePath;
    this.loadPersistedBridges();
  }

  private loadPersistedBridges(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const data = JSON.parse(fs.readFileSync(this.persistPath, "utf8")) as PersistedBridge[];
      const maxAge = 24 * 60 * 60 * 1000; // 24h
      for (const entry of data) {
        if (Date.now() - entry.savedAt > maxAge) continue;
        const k = this.key(entry.userId, entry.deviceId);
        if (this.conns.has(k)) continue; // already connected
        // Create a ghost connection (no socket) so tools appear in listTools().
        // The execute retry will wait for bridge to reconnect.
        const ghost: BridgeConn = {
          userId: entry.userId,
          deviceId: entry.deviceId,
          label: entry.label,
          socket: null as unknown as WebSocket, // no live socket
          tools: entry.tools,
          connectedAt: entry.savedAt,
          pending: new Map(),
        };
        (ghost as any)._ghost = true;
        this.conns.set(k, ghost);
      }
      const count = [...this.conns.values()].filter((c) => (c as any)._ghost).length;
      if (count > 0) {
        console.log(`[BridgeRegistry] loaded ${count} persisted bridge(s) as ghost connections`);
      }
    } catch (err) {
      console.warn(`[BridgeRegistry] failed to load persisted bridges: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private persistBridges(): void {
    if (!this.persistPath) return;
    try {
      const entries: PersistedBridge[] = [...this.conns.values()]
        .filter((c) => !(c as any)._stale)
        .map((c) => ({
          userId: c.userId,
          deviceId: c.deviceId,
          label: c.label,
          tools: c.tools,
          savedAt: Date.now(),
        }));
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(entries, null, 2));
    } catch (err) {
      console.warn(`[BridgeRegistry] failed to persist bridges: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private key(userId: string, deviceId: string): string {
    return `${userId}\u0000${deviceId}`;
  }

  /** Register (or replace) a connection for a device. If the same
   *  (user, device) reconnects, the old socket's pending calls are
   *  rejected and it is replaced. */
  register(args: {
    userId: string;
    deviceId: string;
    label?: string;
    socket: WebSocket;
    tools: McpToolDescriptor[];
  }): BridgeConn {
    const k = this.key(args.userId, args.deviceId);
    const existing = this.conns.get(k);
    // Cancel any pending grace-period removal for this key —
    // the bridge reconnected in time.
    const graceTimer = this.pendingRemoval.get(k);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this.pendingRemoval.delete(k);
    }
    // Only drop pending calls if the socket truly changed AND the
    // old conn isn't stale (grace-period). Stale conns' pending
    // calls should be inherited by the new connection so in-flight
    // tool calls survive a brief reconnect.
    if (existing && existing.socket !== args.socket && !(existing as any)._stale) {
      this.dropPending(existing, "replaced by a new connection");
    }
    const conn: BridgeConn = {
      userId: args.userId,
      deviceId: args.deviceId,
      label: args.label || args.deviceId,
      socket: args.socket,
      tools: args.tools,
      connectedAt: Date.now(),
      pending: existing?.pending ?? new Map(),
    };
    this.conns.set(k, conn);
    // Clear ghost flag if this was a ghost that just reconnected
    delete (conn as any)._ghost;
    console.log(`[BridgeRegistry] register() called for ${args.userId}/${args.deviceId} tools=${args.tools.length} persistPath=${this.persistPath}`);
    this.persistBridges();
    return conn;
  }

  /** Grace period before fully removing a disconnected bridge.
   *  If the bridge reconnects within this window (same user+device),
   *  the new connection inherits the pending calls and tools stay
   *  available without a gap. */
  private static REMOVE_GRACE_MS = 5000;
  private pendingRemoval = new Map<string, ReturnType<typeof setTimeout>>();

  /** Schedule removal of the connection that owns this socket.
   *  A 5s grace period lets the bridge reconnect and re-register
   *  before tools disappear and in-flight calls are dropped. */
  removeBySocket(socket: WebSocket): void {
    for (const [k, c] of this.conns) {
      if (c.socket !== socket) continue;
      // Mark the conn as stale so new tool calls won't use it,
      // but keep it in the map so a re-register can inherit pending.
      (c as any)._stale = true;
      // Cancel any earlier grace timer for this key.
      const prev = this.pendingRemoval.get(k);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(() => {
        this.pendingRemoval.delete(k);
        // Only remove if the conn is still the stale one (not replaced
        // by a fresh re-register).
        const current = this.conns.get(k);
        if (current === c) {
          this.dropPending(c, "connection closed (grace period expired)");
          this.conns.delete(k);
        }
      }, BridgeRegistry.REMOVE_GRACE_MS);
      this.pendingRemoval.set(k, timer);
    }
  }

  remove(userId: string, deviceId: string): void {
    const k = this.key(userId, deviceId);
    const c = this.conns.get(k);
    if (c) {
      this.dropPending(c, "unregistered");
      this.conns.delete(k);
    }
  }

  /** All connections for a user (a user may run several devices). */
  forUser(userId: string): BridgeConn[] {
    return [...this.conns.values()].filter((c) => c.userId === userId && !(c as any)._stale);
  }

  /** Like forUser but includes ghost (offline) connections so tools
   *  remain visible in the toolset after a server restart. */
  forUserIncludingGhosts(userId: string): BridgeConn[] {
    return [...this.conns.values()].filter(
      (c) => c.userId === userId && (!(c as any)._stale || (c as any)._ghost),
    );
  }

  /** Every connection in this (tenant-scoped) registry. */
  all(): BridgeConn[] {
    return [...this.conns.values()].filter((c) => !(c as any)._stale);
  }

  /** All connections including ghosts (for toolset listing). */
  allIncludingGhosts(): BridgeConn[] {
    return [...this.conns.values()].filter((c) => !(c as any)._stale || (c as any)._ghost);
  }

  /** Resolve a pending JSON-RPC reply arriving from a bridge. */
  settle(socket: WebSocket, id: string, result: unknown, error?: { message: string }): void {
    for (const c of this.conns.values()) {
      if (c.socket !== socket) continue;
      const p = c.pending.get(id);
      if (!p) return;
      c.pending.delete(id);
      clearTimeout(p.timer);
      if (error) p.reject(new Error(error.message));
      else p.resolve(result);
      return;
    }
  }

  /** Send a JSON-RPC request to a specific connection and await the
   *  reply (or timeout). */
  call(
    conn: BridgeConn,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = `${Date.now()}-${++this.seq}`;
    const req: RequestMsg = { type: MSG.request, id, method, params };
    const timeout = timeoutMs ?? CALL_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`bridge call timed out after ${timeout}ms (${method})`));
      }, timeout);

      // Abort signal: cancel the pending call and send a cancel
      // notification to the bridge so it can kill the process.
      const onAbort = () => {
        conn.pending.delete(id);
        clearTimeout(timer);
        // Best-effort cancel notification to bridge
        try {
          conn.socket.send(JSON.stringify({
            type: MSG.request,
            id: `${id}-cancel`,
            method: "$/cancel",
            params: { requestId: id },
          }));
        } catch { /* socket may be gone */ }
        reject(new Error("bridge call aborted by user"));
      };
      if (signal?.aborted) {
        reject(new Error("bridge call aborted by user"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      conn.pending.set(id, {
        resolve: (v) => { signal?.removeEventListener("abort", onAbort); resolve(v); },
        reject: (e) => { signal?.removeEventListener("abort", onAbort); reject(e); },
        timer,
      });
      try {
        conn.socket.send(JSON.stringify(req));
      } catch (err) {
        conn.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private dropPending(conn: BridgeConn, reason: string): void {
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`bridge ${reason}`));
    }
    conn.pending.clear();
  }
}
