// Zustand store for the per-tenant plugin manifest list.
//
// One source of truth shared by:
//   - ChatArea top bar (renders topBarButtons of active plugins)
//   - ChatArea right column (renders rightPanels of active plugins)
//   - PluginManager modal (lists everything, toggles enabled)
//
// On any mutation (PATCH /api/plugins/:id) the modal calls
// `setPlugins(fresh)` and every consumer re-renders.

import { create } from "zustand";
import { api, type PluginListEntry } from "../lib/api";

// Global badge event listener — fires once, stays alive for the app lifetime.
let badgeListenerInstalled = false;
function installBadgeListener(setBadge: (id: string, count: number) => void) {
  if (badgeListenerInstalled) return;
  badgeListenerInstalled = true;
  window.addEventListener("tianshu:topbar:badge", (e: Event) => {
    const { buttonId, count } = (e as CustomEvent<{ buttonId: string; count: number }>).detail ?? {};
    if (buttonId && typeof count === "number") setBadge(buttonId, count);
  });
}

interface PluginState {
  plugins: PluginListEntry[] | null;
  error: string | null;
  /** id of the currently-open right panel (e.g. "files.main"), or null. */
  openPanel: string | null;
  /** True while a refresh request is in flight; UI uses this to spin
   *  the Refresh button. */
  refreshing: boolean;
  /** Badge counts keyed by topBarButton fullId (e.g. "workboard.toggle"). */
  badges: Record<string, number>;

  load(): Promise<void>;
  /** ADR-0004 §16: explicit re-discovery of on-disk plugins. */
  refresh(): Promise<void>;
  setPlugins(list: PluginListEntry[]): void;
  setOpenPanel(id: string | null): void;
  /** Set a badge count for a topBarButton. 0 or negative hides the badge. */
  setBadge(buttonFullId: string, count: number): void;
  /** @internal Install global badge event listener. */
  _initBadgeListener(): void;
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: null,
  error: null,
  openPanel: null,
  refreshing: false,
  badges: {},

  setBadge(buttonFullId: string, count: number) {
    const prev = get().badges;
    if (count > 0) {
      if (prev[buttonFullId] === count) return;
      set({ badges: { ...prev, [buttonFullId]: count } });
    } else {
      if (!(buttonFullId in prev)) return;
      const next = { ...prev };
      delete next[buttonFullId];
      set({ badges: next });
    }
  },

  // Install the global badge listener on first load
  _initBadgeListener() {
    installBadgeListener(get().setBadge);
  },

  async load() {
    get()._initBadgeListener();
    if (get().plugins !== null) return;
    try {
      const r = await api.plugins();
      set({ plugins: r.plugins, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
    // Restore persisted panel selection
    try {
      const r = await fetch("/api/preferences/ui.openPanel", { credentials: "include" });
      const j = await r.json() as { value?: string | null };
      if (j.value) set({ openPanel: j.value });
    } catch { /* ignore */ }
  },

  async refresh() {
    if (get().refreshing) return;
    set({ refreshing: true });
    try {
      const r = await api.refreshPlugins();
      // Reuse setPlugins so the openPanel is reconciled if a panel's
      // plugin disappeared / went disabled after the refresh.
      get().setPlugins(r.plugins);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ refreshing: false });
    }
  },

  setPlugins(list) {
    set((s) => {
      // If the previously-open panel belongs to a plugin that's no
      // longer active, close it.
      let nextOpen = s.openPanel;
      if (nextOpen) {
        const pluginId = nextOpen.split(".")[0];
        const owner = list.find((p) => p.id === pluginId);
        if (!owner || owner.state !== "active") nextOpen = null;
      }
      return { plugins: list, error: null, openPanel: nextOpen };
    });
  },

  setOpenPanel(id) {
    set({ openPanel: id });
    // Persist to server
    fetch("/api/preferences/ui.openPanel", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: id }),
    }).catch(() => {});
  },
}));
