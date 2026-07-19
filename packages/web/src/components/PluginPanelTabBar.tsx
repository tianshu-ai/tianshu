// Tab bar that lives at the top of the open right panel.
//
// Mirrors the closed-source repo's PanelTabBar: 48-px high, segmented
// row of icons contributed by every active plugin, the active tab
// shows its label, and there's a close button on the far right.
//
// The active panel and toggle behaviour live in `usePluginStore`, so
// this component is purely presentational.

import { Puzzle, X } from "lucide-react";
import { ICONS_BY_NAME } from "../lib/plugin-icons";
import { usePluginStore } from "../stores/plugin-store";
import { useT } from "../hooks/useT";

interface ContributesTopBarButton {
  id: string;
  icon: string;
  tooltip?: string;
  opensPanel?: string;
  order?: number;
}

interface ContributesShape {
  topBarButtons?: ContributesTopBarButton[];
  rightPanels?: { id: string; displayName: string; component: string }[];
}

export default function PluginPanelTabBar() {
  const t = useT();
  const plugins = usePluginStore((s) => s.plugins);
  const openPanel = usePluginStore((s) => s.openPanel);
  const setOpenPanel = usePluginStore((s) => s.setOpenPanel);

  if (!plugins) return null;

  // Flatten every active plugin's topBarButtons into one ordered list.
  // We deliberately reuse the same contribution that drives the chat
  // shell's top bar — one source of truth for "which panels exist".
  type FlatTab = ContributesTopBarButton & { pluginId: string; panelId: string | null };
  const tabs: FlatTab[] = [];
  for (const p of plugins) {
    if (p.state !== "active") continue;
    const c = (p.contributes as ContributesShape).topBarButtons ?? [];
    for (const b of c) {
      const panelId = b.opensPanel
        ? b.opensPanel.includes(".")
          ? b.opensPanel
          : `${p.id}.${b.opensPanel}`
        : null;
      tabs.push({ ...b, pluginId: p.id, panelId });
    }
  }
  tabs.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  return (
    <div className="flex h-12 items-center gap-1 border-b border-border-subtle bg-bg-base/40 px-2">
      <div className="flex flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = ICONS_BY_NAME[tab.icon] ?? Puzzle;
          const active = tab.panelId !== null && tab.panelId === openPanel;
          const label = tab.tooltip ?? tab.pluginId;
          return (
            <button
              key={`${tab.pluginId}.${tab.id}`}
              type="button"
              onClick={() => {
                if (!tab.panelId) return;
                setOpenPanel(active ? null : tab.panelId);
              }}
              title={label}
              aria-label={label}
              aria-pressed={active}
              className={[
                "group relative flex shrink-0 items-center gap-1.5 rounded-md text-xs transition-all",
                active
                  ? "bg-bg-hover px-2.5 py-1 font-medium text-fg-default"
                  : "px-2 py-1 text-fg-faint hover:bg-bg-hover/60 hover:text-fg-default",
              ].join(" ")}
            >
              <Icon size={14} />
              {active ? <span>{label}</span> : <span className="sr-only">{label}</span>}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setOpenPanel(null)}
        title={t("panel.tab.close")}
        aria-label={t("panel.tab.close")}
        className="ml-1 rounded-md p-1 text-fg-faint hover:bg-bg-raised/60 hover:text-fg-muted"
      >
        <X size={16} />
      </button>
    </div>
  );
}
