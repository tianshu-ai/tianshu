/**
 * Thin animated gradient bar below the header.
 * Visible only when the agent is streaming / working.
 */
import { useChatStore } from "../stores/chat-store";

export default function StreamingProgressBar() {
  const isStreaming = useChatStore((s) => s.isStreaming);
  const awaiting = useChatStore((s) => s._awaitingResponse);
  const isCompacting = useChatStore((s) => s.isCompacting);
  const active = isStreaming || awaiting || isCompacting;

  if (!active) return null;

  return (
    <div className="relative h-[2px] w-full overflow-hidden">
      <div className="streaming-bar-gradient absolute inset-0" />
    </div>
  );
}
