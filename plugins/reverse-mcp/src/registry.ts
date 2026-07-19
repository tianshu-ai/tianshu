// In-memory registry of dialed-in bridge connections, scoped to one
// tenant (the plugin activates per tenant, closing over ctx.tenantId).
//
// A connection is identified by (userId, deviceId). Each holds the live
// WebSocket, the advertised tool list, and a map of in-flight JSON-RPC
// calls awaiting their reply. Everything is best-effort and self-heals:
// a dropped socket removes the connection; a timed-out call rejects.

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

export class BridgeRegistry {
  // key = `${userId}\u0000${deviceId}`
  private readonly conns = new Map<string, BridgeConn>();
  private seq = 0;

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
    if (existing && existing.socket !== args.socket) {
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
    return conn;
  }

  /** Remove whatever connection owns this socket (on close/unregister). */
  removeBySocket(socket: WebSocket): void {
    for (const [k, c] of this.conns) {
      if (c.socket === socket) {
        this.dropPending(c, "connection closed");
        this.conns.delete(k);
      }
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
    return [...this.conns.values()].filter((c) => c.userId === userId);
  }

  /** Every connection in this (tenant-scoped) registry. */
  all(): BridgeConn[] {
    return [...this.conns.values()];
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
  call(conn: BridgeConn, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = `${Date.now()}-${++this.seq}`;
    const req: RequestMsg = { type: MSG.request, id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`bridge call timed out after ${CALL_TIMEOUT_MS}ms (${method})`));
      }, CALL_TIMEOUT_MS);
      conn.pending.set(id, { resolve, reject, timer });
      try {
        conn.socket.send(JSON.stringify(req));
      } catch (err) {
        conn.pending.delete(id);
        clearTimeout(timer);
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
