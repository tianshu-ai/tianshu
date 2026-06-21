// Right column hosting the currently-open plugin panel.
//
// Layout mirrors the closed-source predecessor:
//   <aside>
//     <resize-handle />
//     <PluginPanelTabBar />     ← icons + active label + close
//     <plugin component />
//   </aside>
//
// Width is persisted in localStorage so the user's preferred size
// survives reloads. Drag the left edge to resize; double-click to
// reset.

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat-store";
import { usePluginStore } from "../stores/plugin-store";
import { resolveComponent } from "../lib/plugin-registry";
import PluginPanelTabBar from "./PluginPanelTabBar";
import type { PanelProps } from "@tianshu-ai/plugin-sdk/client";

interface ContributesPanel {
  id: string;
  displayName: string;
  component: string;
}

const WIDTH_STORAGE_KEY = "tianshu:rightPanelWidth";
const DEFAULT_WIDTH = 384;
const MIN_WIDTH = 280;
const MAX_WIDTH = 900;

function loadStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    const n = raw ? parseFloat(raw) : NaN;
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return Math.min(Math.max(n, MIN_WIDTH), MAX_WIDTH);
  } catch {
    return DEFAULT_WIDTH;
  }
}

export default function PluginRightPanel() {
  const me = useChatStore((s) => s.me);
  const openPanel = usePluginStore((s) => s.openPanel);
  const plugins = usePluginStore((s) => s.plugins);

  const [width, setWidth] = useState<number>(() => loadStoredWidth());
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const persistWidth = useCallback((w: number) => {
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(w));
    } catch {
      /* swallow — quota etc. */
    }
  }, []);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };
      setIsResizing(true);

      let pending = width;
      let raf = 0;
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // Dragging the left edge: moving left widens the panel.
        const delta = dragRef.current.startX - ev.clientX;
        pending = Math.min(
          Math.max(dragRef.current.startWidth + delta, MIN_WIDTH),
          MAX_WIDTH,
        );
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            setWidth(pending);
          });
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (raf) cancelAnimationFrame(raf);
        window.getSelection?.()?.removeAllRanges();
        dragRef.current = null;
        setIsResizing(false);
        persistWidth(pending);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, persistWidth],
  );

  const onResizeDoubleClick = useCallback(() => {
    setWidth(DEFAULT_WIDTH);
    persistWidth(DEFAULT_WIDTH);
  }, [persistWidth]);

  // ESC closes the panel — extra QoL, matches the closed-source repo.
  const setOpenPanel = usePluginStore((s) => s.setOpenPanel);
  useEffect(() => {
    if (!openPanel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPanel, setOpenPanel]);

  if (!openPanel || !plugins) return null;
  const dot = openPanel.indexOf(".");
  if (dot < 0) return null;
  const pluginId = openPanel.slice(0, dot);
  const localId = openPanel.slice(dot + 1);

  const plugin = plugins.find((p) => p.id === pluginId);
  if (!plugin || plugin.state !== "active") return null;

  const panels = (plugin.contributes as { rightPanels?: ContributesPanel[] }).rightPanels;
  const panelDef = panels?.find((p) => p.id === localId);
  if (!panelDef) return null;

  const Component = resolveComponent(plugin.clientEntry, panelDef.component);
  if (!Component) return null;

  const props: PanelProps = {
    tenantId: me?.tenantId ?? "",
    userId: me?.userId ?? "",
    plugin: {
      id: plugin.id,
      version: plugin.version,
      displayName: plugin.displayName,
    },
  };

  return (
    <aside
      className="relative flex h-full flex-shrink-0 flex-col border-l border-gray-800 bg-gray-950"
      style={{ width }}
    >
      {/* Drag handle: 6 px hit area, 1 px visible line on hover/active. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right panel"
        title="Drag to resize (double-click to reset)"
        onMouseDown={onResizeStart}
        onDoubleClick={onResizeDoubleClick}
        className={[
          "group absolute -left-[3px] top-0 bottom-0 z-10 flex w-[6px] cursor-col-resize items-center justify-center",
          isResizing ? "bg-blue-500/20" : "hover:bg-blue-500/10",
        ].join(" ")}
      >
        <span
          aria-hidden
          className={[
            "h-full w-px",
            isResizing ? "bg-blue-400" : "bg-transparent group-hover:bg-blue-400/60",
          ].join(" ")}
        />
      </div>

      <PluginPanelTabBar />

      <div className="relative flex-1 overflow-hidden">
        {isResizing && <div className="absolute inset-0 z-10" />}
        <Component {...props} />
      </div>
    </aside>
  );
}
