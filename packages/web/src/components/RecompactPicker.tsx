/**
 * Recompact session chain picker.
 *
 * Follows the same UI pattern as AtMentionPopup — a floating popup
 * anchored to the composer, keyboard-navigable, closes on Escape
 * or outside click.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCw } from "lucide-react";
import { tianshuWs } from "../lib/ws";

interface SessionChainEntry {
  id: string;
  status: string;
  createdAt: number;
  endedAt: number | null;
  summaryPreview: string | null;
  summaryFull: string | null;
  messageCount: number;
}

interface Props {
  active: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 0) return "just now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function RecompactPicker({ active, onClose, anchorRef }: Props) {
  const [sessions, setSessions] = useState<SessionChainEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [recompacting, setRecompacting] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Fetch chain on open
  useEffect(() => {
    if (!active) return;
    setLoading(true);
    setHighlight(0);
    setExpandedId(null);
    setRecompacting(null);
    tianshuWs.send({ type: "session_chain" });

    const offChain = tianshuWs.on("session_chain", (msg) => {
      setSessions(msg.sessions);
      setLoading(false);
    });
    const offCompacted = tianshuWs.on("history_compacted", () => {
      setRecompacting(null);
    });
    return () => { offChain(); offCompacted(); };
  }, [active]);

  // Keyboard navigation
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => h >= sessions.length - 1 ? 0 : h + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => h <= 0 ? sessions.length - 1 : h - 1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const s = sessions[highlight];
        if (s && !recompacting) {
          setRecompacting(s.id);
          tianshuWs.send({ type: "recompact", targetSessionId: s.id });
        }
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        // Toggle expand/collapse
        const s = sessions[highlight];
        if (s?.summaryFull && s.summaryFull.length > 500) {
          setExpandedId((prev) => prev === s.id ? null : s.id);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, highlight, sessions, recompacting, onClose]);

  // Scroll highlighted into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const el = container.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Close on outside click
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [active, onClose]);

  if (!active) return null;

  return (
    <div
      ref={popupRef}
      style={{ backgroundColor: "#0f1117" }}
      className="absolute bottom-full left-0 z-50 mb-2 w-96 max-h-80 overflow-hidden rounded-xl border border-border-default shadow-lg"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <RefreshCw size={13} className="text-fg-faint" />
        <span className="text-xs font-medium text-fg-muted">
          Recompact — select a session
        </span>
        <span className="ml-auto text-[10px] text-fg-fainter">
          ↑↓ navigate · Enter recompact · Tab expand · Esc close
        </span>
      </div>

      {/* List */}
      <div ref={listRef} className="overflow-y-auto max-h-72">
        {loading ? (
          <div className="flex items-center justify-center py-6 text-xs text-fg-faint">
            <Loader2 size={14} className="animate-spin mr-1.5" />
            Loading session chain…
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-6 text-center text-xs text-fg-faint">
            No compacted parent sessions found.
          </div>
        ) : (
          sessions.map((s, i) => {
            const isExpanded = expandedId === s.id;
            const isRecompacting = recompacting === s.id;
            return (
              <div
                key={s.id}
                className={`px-3 py-2.5 transition-colors cursor-pointer ${
                  i === highlight ? "bg-accent/10" : "hover:bg-bg-hover"
                } ${i > 0 ? "border-t border-border-subtle" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => {
                  if (!recompacting) {
                    setRecompacting(s.id);
                    tianshuWs.send({ type: "recompact", targetSessionId: s.id });
                  }
                }}
              >
                {/* Meta row */}
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-fg-fainter">#{sessions.length - i}</span>
                  <span className="text-fg-muted">{relativeTime(s.createdAt)}</span>
                  <span className="rounded bg-bg-hover px-1 py-0.5 text-[10px] text-fg-faint">
                    {s.messageCount} msgs
                  </span>
                  {isRecompacting && (
                    <span className="flex items-center gap-1 text-accent">
                      <Loader2 size={10} className="animate-spin" />
                      <span className="text-[10px]">running…</span>
                    </span>
                  )}
                  {/* Expand toggle */}
                  {s.summaryFull && s.summaryFull.length > 500 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedId(isExpanded ? null : s.id);
                      }}
                      className="ml-auto text-fg-fainter hover:text-fg-muted"
                    >
                      {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                  )}
                </div>
                {/* Summary */}
                {s.summaryPreview ? (
                  <div
                    className={`mt-1 text-[11px] leading-relaxed text-fg-muted ${
                      isExpanded ? "whitespace-pre-wrap" : "line-clamp-3"
                    }`}
                  >
                    {isExpanded ? s.summaryFull : s.summaryPreview}
                  </div>
                ) : (
                  <div className="mt-1 text-[11px] text-fg-faint italic">No summary</div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
