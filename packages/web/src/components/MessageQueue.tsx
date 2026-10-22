import { useCallback, useRef, useState } from "react";
import { GripVertical, Send, Pencil, Trash2, X, Check } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { translate } from "../lib/i18n";

/**
 * Pending message queue — renders INSIDE the composer container,
 * above the textarea. Supports drag-and-drop reordering.
 */
export function MessageQueue() {
  const queue = useChatStore((s) => s.pendingQueue);
  const removeFromQueue = useChatStore((s) => s.removeFromQueue);
  const sendQueuedNow = useChatStore((s) => s.sendQueuedNow);
  const editQueued = useChatStore((s) => s.editQueued);
  const reorderQueue = useChatStore((s) => s.reorderQueue);

  // Drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  const handleDragStart = useCallback((id: string) => {
    dragIdRef.current = id;
    setDragId(id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOverId(id);
  }, []);

  const handleDrop = useCallback((targetId: string) => {
    const sourceId = dragIdRef.current;
    if (!sourceId || sourceId === targetId) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const ids = queue.map((e) => e.id);
    const fromIdx = ids.indexOf(sourceId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, sourceId);
    reorderQueue(ids);
    setDragId(null);
    setOverId(null);
  }, [queue, reorderQueue]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setOverId(null);
    dragIdRef.current = null;
  }, []);

  if (queue.length === 0) return null;

  return (
    <div className="flex flex-col">
      {queue.map((entry, i) => (
        <QueueCard
          key={entry.id}
          entry={entry}
          isLast={i === queue.length - 1}
          isDragging={dragId === entry.id}
          isOver={overId === entry.id && dragId !== entry.id}
          onSendNow={sendQueuedNow}
          onRemove={removeFromQueue}
          onEdit={editQueued}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
        />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

interface QueueCardProps {
  entry: { id: string; content: string; createdAt: number };
  isLast: boolean;
  isDragging: boolean;
  isOver: boolean;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit?: (id: string, content: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (id: string) => void;
  onDragEnd: () => void;
}

function QueueCard({
  entry, isLast, isDragging, isOver,
  onSendNow, onRemove, onEdit,
  onDragStart, onDragOver, onDrop, onDragEnd,
}: QueueCardProps) {
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
    <div
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart(entry.id);
      }}
      onDragOver={(e) => onDragOver(e, entry.id)}
      onDrop={() => onDrop(entry.id)}
      onDragEnd={onDragEnd}
      className={`group flex items-center gap-2 px-1 py-2 transition-all ${
        isLast ? "border-b border-border-subtle mb-1" : "border-b border-border-subtle/50"
      } ${isDragging ? "opacity-30" : ""} ${
        isOver ? "border-t-2 border-t-accent" : ""
      }`}
    >
      {/* Drag handle */}
      <GripVertical className="w-4 h-4 text-fg-fainter shrink-0 cursor-grab active:cursor-grabbing" />

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
      <div className="flex items-center gap-0.5 shrink-0">
        {editing ? (
          <>
            <IconBtn
              onClick={confirmEdit}
              title={translate("chat.queueEditConfirm")}
              className="text-success hover:bg-success/10"
            >
              <Check className="w-4 h-4" />
            </IconBtn>
            <IconBtn
              onClick={cancelEdit}
              title={translate("chat.queueEditCancel")}
              className="text-fg-faint hover:bg-bg-hover"
            >
              <X className="w-4 h-4" />
            </IconBtn>
          </>
        ) : (
          <>
            <IconBtn
              onClick={() => onSendNow(entry.id)}
              title={translate("chat.queueSendNow")}
              className="text-fg-faint hover:text-accent"
            >
              <Send className="w-4 h-4" />
            </IconBtn>
            {onEdit && (
              <IconBtn
                onClick={startEdit}
                title={translate("chat.queueEdit")}
                className="text-fg-faint hover:text-fg-default"
              >
                <Pencil className="w-4 h-4" />
              </IconBtn>
            )}
            <IconBtn
              onClick={() => onRemove(entry.id)}
              title={translate("chat.queueRemove")}
              className="text-fg-faint hover:text-danger"
            >
              <Trash2 className="w-4 h-4" />
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
      className={`p-1.5 rounded-md transition-colors ${className}`}
    >
      {children}
    </button>
  );
}
