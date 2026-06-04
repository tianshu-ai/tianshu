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

interface PluginState {
  plugins: PluginListEntry[] | null;
  error: string | null;
  /** id of the currently-open right panel (e.g. "files.main"), or null. */
  openPanel: string | null;

  load(): Promise<void>;
  setPlugins(list: PluginListEntry[]): void;
  setOpenPanel(id: string | null): void;
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: null,
  error: null,
  openPanel: null,

  async load() {
    if (get().plugins !== null) return;
    try {
      const r = await api.plugins();
      set({ plugins: r.plugins, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
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
  },
}));
