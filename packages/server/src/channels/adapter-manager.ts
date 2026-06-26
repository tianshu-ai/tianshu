// Adapter lifecycle manager.
//
// Owns the binding-row → adapter-instance mapping. The hub holds
// adapters by binding id; THIS module is what actually constructs,
// starts, stops, and re-registers them.
//
// Inputs:
//   - the persisted `channel_bindings` rows (via bindings.ts)
//   - per-channel factories contributed by plugins
//     (PluginRegistry: `manifest.contributes.channels[]` +
//     `exports.channels[module]`)
//
// Wiring:
//   - at boot, enumerate enabled bindings → for each, look up the
//     factory in the plugin registry → call the factory → register
//     the adapter under the binding id → start the adapter →
//     update the binding's status column.
//   - admin "Add binding" / "Remove binding" routes (TODO) call
//     `startBinding(id)` / `stopBinding(id)` directly so changes
//     take effect without a server restart.
//   - on adapter error: `setBindingStatus(... "error", detail)` and
//     keep the entry in the hub so manual restart paths can later
//     replace it; the agent simply stops receiving inbound traffic
//     for that binding until the admin acts.

import fs from "node:fs";
import path from "node:path";
import { channelHub } from "./hub.js";
import {
  getBinding,
  listEnabledBindings,
  setBindingStatus,
} from "./bindings.js";
import type { ChannelAdapter, ChannelAdapterFactory } from "./types.js";
import type { GlobalOps } from "../core/global-ops.js";

export interface AdapterManagerDeps {
  globalOps: GlobalOps;
  /** Resolve the adapter factory for a (plugin, module) pair. The
   *  host's plugin registry implements this once the
   *  manifest.contributes.channels[] surface is wired up.  */
  resolveFactory: (pluginId: string, module: string) =>
    | { factory: ChannelAdapterFactory; channelId: string; displayName: string }
    | null;
  /** State-dir root the manager creates per-binding subdirs under.
   *  Channel adapters that need to persist tokens / sync buffers
   *  receive the per-binding path through `ChannelAdapterContext.stateDir`. */
  stateRoot: string;
}

export class ChannelAdapterManager {
  // bindingId -> adapter instance currently registered in the hub.
  private active = new Map<string, ChannelAdapter>();

  constructor(private deps: AdapterManagerDeps) {}

  /** Boot-time pass: walk every tenant DB and start adapters for
   *  enabled bindings. Failures don't abort the pass — each binding
   *  fails independently. */
  async bootAll(): Promise<void> {
    // For v0 we assume the host already opens the tenant pool early.
    // We iterate `globalOps.tenantIds()` and per-tenant DB read.
    const tenantIds = this.deps.globalOps.list();
    for (const tenantId of tenantIds) {
      const ctx = this.deps.globalOps.open(tenantId);
      const enabled = listEnabledBindings(ctx.db).filter(
        (b) => b.tenantId === tenantId,
      );
      for (const binding of enabled) {
        await this.startBinding(binding.id).catch((err) => {
          console.warn(
            `[channel-mgr] boot start failed for ${binding.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }
  }

  /** Start a single binding's adapter. Looks up its row, resolves
   *  the plugin factory, registers + starts. Persists status. */
  async startBinding(bindingId: string): Promise<void> {
    const binding = this.lookup(bindingId);
    if (!binding) {
      throw new Error(`[channel-mgr] binding ${bindingId} not found`);
    }
    if (this.active.has(bindingId)) {
      // Already running — treat as no-op for idempotency.
      return;
    }
    const ctx = this.deps.globalOps.open(binding.tenantId);
    setBindingStatus(ctx.db, bindingId, "starting", null);

    // Resolve factory through the registry. We use plugin id +
    // module from the binding row so two plugins can both expose a
    // channel with the same id (unlikely in practice but harmless).
    const found = this.deps.resolveFactory(binding.pluginId, binding.channelId);
    if (!found) {
      const msg = `no factory registered for plugin ${binding.pluginId} channel ${binding.channelId}`;
      setBindingStatus(ctx.db, bindingId, "error", msg);
      throw new Error(`[channel-mgr] ${msg}`);
    }

    const stateDir = path.join(this.deps.stateRoot, "channels", binding.tenantId, bindingId);
    fs.mkdirSync(stateDir, { recursive: true });

    let adapter: ChannelAdapter;
    try {
      adapter = await found.factory({
        bindingId: binding.id,
        tenantId: binding.tenantId,
        config: binding.config,
        stateDir,
        log: {
          info: (msg, meta) => console.info(`[channel:${binding.id}] ${msg}`, meta ?? ""),
          warn: (msg, meta) => console.warn(`[channel:${binding.id}] ${msg}`, meta ?? ""),
          error: (msg, meta) => console.error(`[channel:${binding.id}] ${msg}`, meta ?? ""),
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setBindingStatus(ctx.db, bindingId, "error", `factory threw: ${detail}`);
      throw err;
    }

    channelHub.register(binding.id, binding.tenantId, adapter);
    this.active.set(binding.id, adapter);
    try {
      await adapter.start();
      setBindingStatus(ctx.db, bindingId, "running", null);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      channelHub.unregister(binding.id);
      this.active.delete(binding.id);
      setBindingStatus(ctx.db, bindingId, "error", `start failed: ${detail}`);
      throw err;
    }
  }

  /** Stop a single binding's adapter and remove it from the hub.
   *  Persists status as "stopped" (a clean shutdown, distinct from
   *  "error"). Safe to call when the binding isn't running. */
  async stopBinding(bindingId: string): Promise<void> {
    const adapter = this.active.get(bindingId);
    if (!adapter) return;
    try {
      await adapter.stop();
    } catch (err) {
      console.warn(
        `[channel-mgr] stop threw for ${bindingId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    channelHub.unregister(bindingId);
    this.active.delete(bindingId);
    const binding = this.lookup(bindingId);
    if (binding) {
      const ctx = this.deps.globalOps.open(binding.tenantId);
      setBindingStatus(ctx.db, bindingId, "stopped", null);
    }
  }

  /** Shut down every active adapter. Called on server stop /
   *  before process exit. */
  async shutdownAll(): Promise<void> {
    const bindingIds = Array.from(this.active.keys());
    await Promise.allSettled(
      bindingIds.map((id) => this.stopBinding(id)),
    );
  }

  /** Helper — look a binding up across tenants. The manager doesn't
   *  cache tenant ids, so we scan; the row counts are small. */
  private lookup(
    bindingId: string,
  ): ReturnType<typeof getBinding> | null {
    for (const tenantId of this.deps.globalOps.list()) {
      const ctx = this.deps.globalOps.open(tenantId);
      const b = getBinding(ctx.db, bindingId);
      if (b) return b;
    }
    return null;
  }
}
