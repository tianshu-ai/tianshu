import { useCallback, useState } from "react";
import { GripVertical, Play, Pencil, Trash2, X, Check } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { translate } from "../lib/i18n";

/**
 * Pending message queue — shown above the chat input when messages are
 * waiting to be sent to the agent after the current turn completes.
 *
 * Visual style mirrors the OpenClaw queued-message card:
 *   ⠿ drag handle │ message text │ ▶ send-now  ✎ edit  🗑 delete
 *
 * Each entry can be:
 *  - Sent immediately (interrupts current turn via follow_up)
 *  - Edited in-place before it reaches the agent
 *  - Deleted from the queue
 */
export function MessageQueue() {
  const queue = useChatStore((s) => s.pendingQueue);
  const removeFromQueue = useChatStore((s) => s.removeFromQueue);
  const sendQueuedNow = useChatStore((s) => s.sendQueuedNow);
  const editQueued = useChatStore((s) => s.editQueued);

  if (queue.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 mb-2">
      <div className="flex items-center gap-1.5 px-1">
        <span className="text-[11px] font-medium text-fg-faint tracking-wide uppercase">
          {translate("chat.queueTitle", { count: queue.length })}
        </span>
        <div className="flex-1 h-px bg-border-subtle" />
      </div>
      {queue.map((entry) => (
        <QueueCard
          key={entry.id}
          entry={entry}
          onSendNow={sendQueuedNow}
          onRemove={removeFromQueue}
          onEdit={editQueued}
        />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

interface QueueCardProps {
  entry: { id: string; content: string; createdAt: number };
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit?: (id: string, content: string) => void;
}

function QueueCard({ entry, onSendNow, onRemove, onEdit }: QueueCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);

  const startEdit = useCallback(() => {
    setDraft(entry.content);
    setEditing(true);
  }, [entry.content]);

  const cancelEdit = useCallback(() => setEditing(false), []);

  const confirmEdit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== entry.content) {
      onEdit?.(entry.id, trimmed);
    }
    setEditing(false);
  }, [draft, entry.content, entry.id, onEdit]);

  return (
    <div className="group flex items-center gap-1 rounded-lg border border-border-default bg-bg-surface px-2 py-1.5 transition-colors hover:border-border-strong">
      {/* Drag handle (visual only for now; DnD can be added later) */}
      <GripVertical className="w-3.5 h-3.5 text-fg-fainter shrink-0 cursor-grab" />

      {/* Content */}
      {editing ? (
        <input
          className="flex-1 min-w-0 bg-transparent text-sm text-fg-default outline-none border-b border-accent py-0.5"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmEdit();
            if (e.key === "Escape") cancelEdit();
          }}
          autoFocus
        />
      ) : (
        <span className="flex-1 min-w-0 truncate text-sm text-fg-default">
          {entry.content}
        </span>
      )}

      {/* Actions */}
      <div className="flex items-center gap-0.5 shrink-0 ml-1">
        {editing ? (
          <>
            <IconBtn
              onClick={confirmEdit}
              title={translate("chat.queueEditConfirm")}
              className="text-success hover:bg-success/10"
            >
              <Check className="w-3.5 h-3.5" />
            </IconBtn>
            <IconBtn
              onClick={cancelEdit}
              title={translate("chat.queueEditCancel")}
              className="text-fg-faint hover:bg-bg-hover"
            >
              <X className="w-3.5 h-3.5" />
            </IconBtn>
          </>
        ) : (
          <>
            <IconBtn
              onClick={() => onSendNow(entry.id)}
              title={translate("chat.queueSendNow")}
              className="text-accent hover:bg-accent-faint"
            >
              <Play className="w-3.5 h-3.5" />
            </IconBtn>
            {onEdit && (
              <IconBtn
                onClick={startEdit}
                title={translate("chat.queueEdit")}
                className="text-fg-faint hover:bg-bg-hover"
              >
                <Pencil className="w-3.5 h-3.5" />
              </IconBtn>
            )}
            <IconBtn
              onClick={() => onRemove(entry.id)}
              title={translate("chat.queueRemove")}
              className="text-fg-faint hover:text-danger hover:bg-danger/10"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </IconBtn>
          </>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

function IconBtn({
  children,
  onClick,
  title,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1 rounded transition-colors ${className}`}
    >
      {children}
    </button>
  );
}
