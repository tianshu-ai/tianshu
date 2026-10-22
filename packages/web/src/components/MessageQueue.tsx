import { useChatStore } from "../stores/chat-store";
import { translate } from "../lib/i18n";

/**
 * Pending message queue — shown above the chat input when
 * messages are waiting to be sent to the agent after the
 * current turn completes. Each entry can be deleted or
 * force-sent as an immediate follow-up.
 */
export function MessageQueue() {
  const queue = useChatStore((s) => s.pendingQueue);
  const removeFromQueue = useChatStore((s) => s.removeFromQueue);
  const sendQueuedNow = useChatStore((s) => s.sendQueuedNow);
  if (queue.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 px-3 py-2 mb-2">
      <div className="text-xs text-text-secondary font-medium">
        {translate("chat.queueTitle", { count: queue.length })}
      </div>
      {queue.map((entry) => (
        <div
          key={entry.id}
          className="flex items-center gap-2 rounded-lg bg-bg-surface px-3 py-1.5 text-sm group"
        >
          <span className="flex-1 truncate text-text-primary">
            {entry.content}
          </span>
          <button
            onClick={() => sendQueuedNow(entry.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-accent-primary hover:text-accent-primary-hover px-1.5 py-0.5 rounded hover:bg-bg-elevated"
            title={translate("chat.queueSendNow")}
          >
            ⚡
          </button>
          <button
            onClick={() => removeFromQueue(entry.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-text-tertiary hover:text-danger px-1.5 py-0.5 rounded hover:bg-bg-elevated"
            title={translate("chat.queueRemove")}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
