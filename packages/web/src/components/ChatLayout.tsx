import { useEffect } from "react";
import { useChatStore } from "../stores/chat-store";
import Sidebar from "./Sidebar";
import ChatArea from "./ChatArea";

/**
 * Three-column layout — sidebar | chat | (future right panel).
 * The right-side panel (files / browser / task board / …) ships in a
 * later PR; for now we render only the first two columns, matching the
 * closed-source repo's ChatLayout when no panel is open.
 */
export default function ChatLayout() {
  const init = useChatStore((s) => s.init);
  const sidebarOpen = useChatStore((s) => s.sidebarOpen);
  const meError = useChatStore((s) => s.meError);

  useEffect(() => {
    init();
  }, [init]);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950 text-gray-100">
      {sidebarOpen && <Sidebar />}
      <ChatArea />
      {meError && (
        <div className="fixed right-4 top-4 max-w-sm rounded-md border border-rose-700/50 bg-rose-950/90 px-3 py-2 text-sm text-rose-200 shadow-lg">
          <strong className="mr-1">/api/me failed:</strong>
          {meError}
        </div>
      )}
    </div>
  );
}
