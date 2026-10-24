// Renders top-bar buttons contributed by active plugins, **only when
// no right panel is open**. The open panel has its own PluginPanelTabBar
// (per the closed-source predecessor's UX) which exposes the same
// icons; showing them in both places at once would be duplicate noise.

import { MoreHorizontal, Puzzle } from "lucide-react";
import { useSyncExternalStore, useState, useRef, useEffect } from "react";
import { ICONS_BY_NAME } from "../lib/plugin-icons";
import { usePluginStore } from "../stores/plugin-store";
import { getLocale, subscribeLocale } from "../lib/i18n";
import { manifestLabelFor } from "../lib/plugin-manifest-labels";

interface ContributesTopBarButton {
  id: string;
  icon: string;
  tooltip?: string;
  opensPanel?: string;
  order?: number;
}

interface ContributesShape {
  topBarButtons?: ContributesTopBarButton[];
}

type FlatButton = ContributesTopBarButton & { pluginId: string };

export default function PluginTopBarButtons() {
  const plugins = usePluginStore((s) => s.plugins);
  const openPanel = usePluginStore((s) => s.openPanel);
  const setOpenPanel = usePluginStore((s) => s.setOpenPanel);
  const badges = usePluginStore((s) => s.badges);
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // Hide once a right panel is open AND the panel can actually render.
  if (openPanel !== null && plugins) {
    const dot = openPanel.indexOf(".");
    if (dot > 0) {
      const pluginId = openPanel.slice(0, dot);
      const localId = openPanel.slice(dot + 1);
      const owner = plugins.find((p) => p.id === pluginId && p.state === "active");
      const panels = (owner?.contributes as { rightPanels?: { id: string }[] } | undefined)?.rightPanels;
      if (panels?.some((p) => p.id === localId)) {
        return null; // panel will render, PanelTabBar takes over
      }
    }
    setOpenPanel(null);
  }
  if (!plugins) return null;

  const buttons: FlatButton[] = [];
  for (const p of plugins) {
    if (p.state !== "active") continue;
    const c = (p.contributes as ContributesShape).topBarButtons ?? [];
    for (const b of c) buttons.push({ ...b, pluginId: p.id });
  }
  buttons.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  if (buttons.length === 0) return null;

  const MAX_VISIBLE = 5;
  const visible = buttons.slice(0, MAX_VISIBLE);
  const overflow = buttons.slice(MAX_VISIBLE);

  const renderButton = (b: FlatButton, compact = false) => {
    const fullId = `${b.pluginId}.${b.id}`;
    const panelTarget = b.opensPanel
      ? b.opensPanel.includes(".")
        ? b.opensPanel
        : `${b.pluginId}.${b.opensPanel}`
      : null;
    const Icon = ICONS_BY_NAME[b.icon] ?? Puzzle;
    const label = manifestLabelFor(
      locale,
      b.pluginId,
      "topBarButtons",
      b.id,
      b.tooltip ?? b.pluginId,
    );
    if (compact) {
      return (
        <button
          key={fullId}
          type="button"
          title={label}
          onClick={() => {
            if (!panelTarget) return;
            setOpenPanel(panelTarget);
            setMenuOpen(false);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-default"
        >
          <Icon size={14} />
          <span className="truncate">{label}</span>
        </button>
      );
    }
    return (
      <button
        key={fullId}
        type="button"
        title={label}
        aria-label={label}
        onClick={() => {
          if (!panelTarget) return;
          setOpenPanel(panelTarget);
        }}
        className="relative rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
      >
        <Icon size={16} />
        {(badges[fullId] ?? 0) > 0 && (
          <span className="absolute top-0 right-0 -translate-y-1/3 translate-x-1/3 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold leading-none text-white">
            {badges[fullId]}
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      {visible.map((b) => renderButton(b))}
      {overflow.length > 0 && (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            title="More plugins"
            onClick={() => setMenuOpen((v) => !v)}
            className="relative rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
          >
            <MoreHorizontal size={16} />
            {overflow.some((b) => (badges[`${b.pluginId}.${b.id}`] ?? 0) > 0) && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500" />
            )}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-lg border border-border-default bg-bg-surface p-1 shadow-lg">
              {overflow.map((b) => renderButton(b, true))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
