/**
 * Shows what the agent is currently doing, right above the composer.
 * "天枢正在思考..." / "正在调用 web_search..." / "正在整理上下文..."
 * + a prominent stop button.
 */
import { Loader2, Square } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { useT } from "../hooks/useT";

export default function AgentWorkStatus() {
  const t = useT();
  const isStreaming = useChatStore((s) => s.isStreaming);
  const awaiting = useChatStore((s) => s._awaitingResponse);
  const isCompacting = useChatStore((s) => s.isCompacting);
  const activeInteraction = useChatStore((s) => s.activeInteraction);
  const messages = useChatStore((s) => s.messages);
  const abort = useChatStore((s) => s.abort);

  // Don't show when ask_user interaction is active (user needs to respond)
  if (activeInteraction) return null;

  const effectiveActive = isStreaming || awaiting || isCompacting;
  if (!effectiveActive) return null;

  // Determine what the agent is doing by looking at the last message
  let statusText = "天枢正在思考...";
  let statusDetail = "";

  if (isCompacting) {
    statusText = "正在整理上下文...";
  } else if (awaiting && !isStreaming) {
    statusText = "正在连接...";
  } else {
    // Check last message for pending tool calls
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant" && lastMsg.toolCalls?.length) {
      const lastTool = lastMsg.toolCalls[lastMsg.toolCalls.length - 1];
      if (lastTool._pending) {
        statusText = "正在调用工具";
        statusDetail = lastTool.name;
      }
    }
    // Check for tool results being processed
    if (lastMsg?.role === "tool") {
      statusText = "正在分析结果...";
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-1 py-1.5">
      <div className="flex items-center gap-2 text-xs text-fg-faint">
        <Loader2 size={12} className="animate-spin text-accent" />
        <span>{statusText}</span>
        {statusDetail && (
          <code className="rounded bg-bg-surface/60 px-1.5 py-0.5 text-[10px] font-mono text-fg-fainter">
            {statusDetail}
          </code>
        )}
      </div>
      {/* Stop button lives in ChatInput; no duplicate here */}
    </div>
  );
}
