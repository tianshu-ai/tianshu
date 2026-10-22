import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, Send, Pencil, Trash2, X, Check } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { translate } from "../lib/i18n";

/**
 * Pending message queue with pointer-event–driven drag-and-drop.
 * Cards move in real time as you drag; releasing snaps into place.
 */
export function MessageQueue() {
  const queue = useChatStore((s) => s.pendingQueue);
  const removeFromQueue = useChatStore((s) => s.removeFromQueue);
  const sendQueuedNow = useChatStore((s) => s.sendQueuedNow);
  const editQueued = useChatStore((s) => s.editQueued);
  const reorderQueue = useChatStore((s) => s.reorderQueue);

  // ── Drag state ──────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<{
    fromIdx: number;
    currentIdx: number;
    offsetY: number; // pointer offset within the card
    pointerY: number; // absolute pointer Y
    cardH: number; // card height for calculating position
  } | null>(null);

  // Reorder preview: items shifted to make room for the dragged card
  const getDisplayOrder = useCallback((): number[] => {
    const order = queue.map((_, i) => i);
    if (!dragState) return order;
    const { fromIdx, currentIdx } = dragState;
    if (fromIdx === currentIdx) return order;
    // Remove dragged item and insert at currentIdx
    order.splice(fromIdx, 1);
    order.splice(currentIdx, 0, fromIdx);
    return order;
  }, [queue, dragState]);

  const displayOrder = getDisplayOrder();

  // ── Pointer handlers ────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent, idx: number) => {
    // Only start drag from the grip handle area
    const grip = (e.target as HTMLElement).closest("[data-grip]");
    if (!grip) return;

    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const container = containerRef.current;
    if (!container) return;
    const cards = container.querySelectorAll<HTMLElement>("[data-queue-card]");
    const card = cards[idx];
    if (!card) return;

    const rect = card.getBoundingClientRect();
    setDragState({
      fromIdx: idx,
      currentIdx: idx,
      offsetY: e.clientY - rect.top,
      pointerY: e.clientY,
      cardH: rect.height,
    });
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState) return;
    e.preventDefault();

    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const relY = e.clientY - containerRect.top - dragState.offsetY;
    const newIdx = Math.max(0, Math.min(queue.length - 1,
      Math.round(relY / dragState.cardH)
    ));

    setDragState((s) => s ? { ...s, pointerY: e.clientY, currentIdx: newIdx } : null);
  }, [dragState, queue.length]);

  const handlePointerUp = useCallback(() => {
    if (!dragState) return;
    const { fromIdx, currentIdx } = dragState;
    if (fromIdx !== currentIdx) {
      const ids = queue.map((e) => e.id);
      const [moved] = ids.splice(fromIdx, 1);
      ids.splice(currentIdx, 0, moved);
      reorderQueue(ids);
    }
    setDragState(null);
  }, [dragState, queue, reorderQueue]);

  // Cancel on Escape
  useEffect(() => {
    if (!dragState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDragState(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragState]);

  if (queue.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="flex flex-col relative"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{ touchAction: "none" }}
    >
      {displayOrder.map((origIdx, displayIdx) => {
        const entry = queue[origIdx];
        const isDragging = dragState?.fromIdx === origIdx;

        // When dragging, the dragged card follows the pointer.
        // Other cards slide into their new positions with transition.
        let style: React.CSSProperties | undefined;
        if (dragState) {
          if (isDragging) {
            // Dragged card follows pointer
            const container = containerRef.current;
            const containerTop = container?.getBoundingClientRect().top ?? 0;
            const y = dragState.pointerY - containerTop - dragState.offsetY;
            style = {
              transform: `translateY(${y - displayIdx * dragState.cardH}px)`,
              zIndex: 50,
              transition: "none",
              position: "relative",
            };
          } else {
            // Other cards slide smoothly
            style = {
              transition: "transform 200ms ease",
              position: "relative",
            };
          }
        }

        return (
          <div key={entry.id} data-queue-card style={style}>
            <QueueCard
              entry={entry}
              isLast={displayIdx === queue.length - 1}
              isDragging={!!isDragging}
              onSendNow={sendQueuedNow}
              onRemove={removeFromQueue}
              onEdit={editQueued}
              onPointerDown={(e) => handlePointerDown(e, origIdx)}
            />
          </div>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

interface QueueCardProps {
  entry: { id: string; content: string; createdAt: number; source?: { type: string; contactName?: string; contactId?: string } };
  isLast: boolean;
  isDragging: boolean;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit?: (id: string, content: string) => void;
  onPointerDown: (e: React.PointerEvent) => void;
}

function QueueCard({
  entry, isLast, isDragging,
  onSendNow, onRemove, onEdit, onPointerDown,
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
      className={`group flex items-center gap-2 px-1 py-2 rounded-md ${
        isLast ? "border-b border-border-subtle mb-1" : "border-b border-border-subtle/50"
      } ${isDragging
          ? "bg-bg-surface shadow-lg ring-1 ring-accent/30 scale-[1.01]"
          : "hover:bg-bg-hover/30"
      }`}
    >
      {/* Drag handle */}
      <div
        data-grip
        onPointerDown={onPointerDown}
        className={`p-0.5 -ml-0.5 rounded transition-colors select-none ${
          isDragging ? "cursor-grabbing" : "cursor-grab hover:bg-bg-hover"
        }`}
      >
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
        <div className="flex-1 min-w-0 select-none">
          {entry.source && (
            <span className="text-xs text-fg-faint mr-1">
              {entry.source.type === "wechat" ? "💬" : entry.source.type === "a2a" ? "🤖" : "📨"}
              {entry.source.contactName && ` ${entry.source.contactName}`}
              {" · "}
            </span>
          )}
          <span className="text-sm text-fg-default truncate">
            {entry.content}
          </span>
        </div>
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
