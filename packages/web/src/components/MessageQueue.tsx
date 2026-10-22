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
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const dragIdxRef = useRef<number | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    dragIdxRef.current = idx;
    setDragIdx(idx);
    // Custom drag image: clone the card with slight opacity
    const el = e.currentTarget as HTMLElement;
    const clone = el.cloneNode(true) as HTMLElement;
    clone.style.width = `${el.offsetWidth}px`;
    clone.style.opacity = "0.85";
    clone.style.transform = "scale(1.02)";
    clone.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
    clone.style.borderRadius = "8px";
    clone.style.position = "absolute";
    clone.style.top = "-9999px";
    document.body.appendChild(clone);
    e.dataTransfer.setDragImage(clone, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    e.dataTransfer.effectAllowed = "move";
    // Clean up clone after drag starts
    requestAnimationFrame(() => document.body.removeChild(clone));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOverIdx(idx);
  }, []);

  const handleDrop = useCallback((targetIdx: number) => {
    const sourceIdx = dragIdxRef.current;
    if (sourceIdx === null || sourceIdx === targetIdx) {
      setDragIdx(null);
      setOverIdx(null);
      return;
    }
    const ids = queue.map((e) => e.id);
    const [moved] = ids.splice(sourceIdx, 1);
    ids.splice(targetIdx, 0, moved);
    reorderQueue(ids);
    setDragIdx(null);
    setOverIdx(null);
  }, [queue, reorderQueue]);

  const handleDragEnd = useCallback(() => {
    setDragIdx(null);
    setOverIdx(null);
    dragIdxRef.current = null;
  }, []);

  if (queue.length === 0) return null;

  return (
    <div className="flex flex-col">
      {queue.map((entry, i) => {
        const showDropAbove = overIdx === i && dragIdx !== null && dragIdx > i;
        const showDropBelow = overIdx === i && dragIdx !== null && dragIdx < i;
        return (
          <QueueCard
            key={entry.id}
            entry={entry}
            index={i}
            isLast={i === queue.length - 1}
            isDragging={dragIdx === i}
            showDropAbove={showDropAbove}
            showDropBelow={showDropBelow}
            onSendNow={sendQueuedNow}
            onRemove={removeFromQueue}
            onEdit={editQueued}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

interface QueueCardProps {
  entry: { id: string; content: string; createdAt: number };
  index: number;
  isLast: boolean;
  isDragging: boolean;
  showDropAbove: boolean;
  showDropBelow: boolean;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit?: (id: string, content: string) => void;
  onDragStart: (e: React.DragEvent, idx: number) => void;
  onDragOver: (e: React.DragEvent, idx: number) => void;
  onDrop: (idx: number) => void;
  onDragEnd: () => void;
}

function QueueCard({
  entry, index, isLast, isDragging, showDropAbove, showDropBelow,
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
    <div className="relative">
      {/* Drop indicator above */}
      {showDropAbove && (
        <div className="absolute -top-px left-2 right-2 h-0.5 bg-accent rounded-full z-10" />
      )}
      <div
        draggable={!editing}
        onDragStart={(e) => onDragStart(e, index)}
        onDragOver={(e) => onDragOver(e, index)}
        onDrop={() => onDrop(index)}
        onDragEnd={onDragEnd}
        className={`group flex items-center gap-2 px-1 py-2 rounded-md transition-all duration-150 ${
          isLast ? "border-b border-border-subtle mb-1" : "border-b border-border-subtle/50"
        } ${isDragging ? "opacity-20 scale-[0.98]" : "opacity-100"} ${
          !isDragging && (showDropAbove || showDropBelow) ? "translate-y-0.5" : ""
        }`}
      >
        {/* Drag handle */}
        <div className="cursor-grab active:cursor-grabbing p-0.5 -ml-0.5 rounded hover:bg-bg-hover transition-colors">
          <GripVertical className="w-4 h-4 text-fg-fainter" />
        </div>

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
          <span className="flex-1 min-w-0 truncate text-sm text-fg-default select-none">
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
      {/* Drop indicator below */}
      {showDropBelow && (
        <div className="absolute -bottom-px left-2 right-2 h-0.5 bg-accent rounded-full z-10" />
      )}
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
