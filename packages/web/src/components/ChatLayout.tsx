import { useEffect } from "react";
import { useChatStore } from "../stores/chat-store";
import { usePluginStore } from "../stores/plugin-store";
import Sidebar from "./Sidebar";
import ChatArea from "./ChatArea";
import PluginRightPanel from "./PluginRightPanel";

/**
 * Three-column layout: sidebar | chat | optional plugin right panel.
 * The right column appears only when a plugin's top-bar button is
 * toggled on (per ADR-0003 manifest contributions).
 */
export default function ChatLayout() {
  const init = useChatStore((s) => s.init);
  const sidebarOpen = useChatStore((s) => s.sidebarOpen);
  const meError = useChatStore((s) => s.meError);
  const loadPlugins = usePluginStore((s) => s.load);

  useEffect(() => {
    init();
    void loadPlugins();
  }, [init, loadPlugins]);

  return (
    <div className="flex h-screen overflow-hidden bg-bg-base text-fg-default">
      {sidebarOpen && <Sidebar />}
      <ChatArea />
      <PluginRightPanel />
      {meError && (
        <div className="fixed right-4 top-4 max-w-sm rounded-md border border-rose-700/50 bg-rose-950/90 px-3 py-2 text-sm text-danger shadow-lg">
          <strong className="mr-1">/api/me failed:</strong>
          {meError}
        </div>
      )}
    </div>
  );
}
