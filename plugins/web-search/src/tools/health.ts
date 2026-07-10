// Provider health cache.
//
// Why we need it: a worker that triggers `web_search` ten times in
// a row shouldn't pay the latency of trying Tavily first every
// time when Tavily's key has been wrong since the operator last
// saved config. The cache is in-memory, scoped per
// (tenantId, pluginId), and gets cleared automatically when the
// plugin re-activates (config change) or when the operator clicks
// the "Reset cache" button in the admin panel.
//
// Two failure shapes get treated differently:
//
//   - Auth (401 / 403)         → mark dead permanently (until
//                                 manual reset). The key is wrong;
//                                 retrying every search is just
//                                 spam.
//   - Server / network / 429   → NOT cached. These are usually
//                                 transient; we want the next call
//                                 to retry as if nothing happened.
//                                 Logging stays in the per-call
//                                 errors array so the operator can
//                                 see the trail if they look.
//
// "Empty results" is not a health concern — a working API can
// legitimately return zero hits for an obscure query.

export type { ProviderName } from "./providers.js";
import type { ProviderName } from "./providers.js";

export interface DeadProviderEntry {
  /** HTTP status that flagged it dead. 401 / 403 are the only
   *  values that get persisted today. */
  status: number;
  /** Truncated provider message; surfaced in the next call's
   *  error text so the operator knows why it's parked. */
  message: string;
  /** ms timestamp when we marked it dead. Used by the admin UI to
   *  show "dead since 5m ago". */
  deadSince: number;
}

export class ProviderHealth {
  private dead = new Map<ProviderName, DeadProviderEntry>();

  isDead(name: ProviderName): DeadProviderEntry | null {
    return this.dead.get(name) ?? null;
  }

  markDead(name: ProviderName, status: number, message: string): void {
    this.dead.set(name, {
      status,
      message: message.slice(0, 200),
      deadSince: Date.now(),
    });
  }

  /** Clear ALL provider entries. Used by the admin "Reset cache"
   *  button. */
  reset(): void {
    this.dead.clear();
  }

  /** Clear one provider — useful after the operator updates a
   *  specific key. We don't auto-detect config changes per-key
   *  (the plugin re-activates on any config write, which builds a
   *  fresh ProviderHealth instance), but the primitive is here
   *  for a future per-field clear button. */
  resetOne(name: ProviderName): void {
    this.dead.delete(name);
  }

  /** Snapshot for the admin endpoint. */
  snapshot(): Array<{ provider: ProviderName } & DeadProviderEntry> {
    return [...this.dead.entries()].map(([provider, e]) => ({
      provider,
      ...e,
    }));
  }
}
