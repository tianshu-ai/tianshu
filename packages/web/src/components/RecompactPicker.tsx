/**
 * Recompact session chain picker.
 *
 * Follows the same UI pattern as AtMentionPopup — a floating popup
 * anchored to the composer, keyboard-navigable, closes on Escape
 * or outside click.
 */
import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronDown, ChevronUp, Loader2, MessageSquare, RefreshCw } from "lucide-react";
import { tianshuWs } from "../lib/ws";
import { MarkdownBlock } from "./ui/MarkdownBlock";
import { useT } from "../hooks/useT";
import type { TranslationKey } from "../lib/i18n";
import { useChatStore } from "../stores/chat-store";

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
  /** Called after sending recompact — parent should close picker. */
  onRecompact?: () => void;
}

function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function RecompactPicker({ active, onClose, anchorRef, onRecompact }: Props) {
  const t = useT();
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
    return () => { offChain(); };
  }, [active]);

  const doRecompact = (sessionId: string) => {
    setRecompacting(sessionId);
    // Set isCompacting so the main UI shows the compacting spinner
    useChatStore.setState({ isCompacting: true });
    tianshuWs.send({ type: "recompact", targetSessionId: sessionId });
    // Close picker — the compact notice banner handles the rest
    onClose();
    onRecompact?.();
  };

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
          doRecompact(s.id);
        }
        return;
      }
      // ArrowRight: expand summary; ArrowLeft: collapse
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const s = sessions[highlight];
        if (s) setExpandedId(s.id);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setExpandedId(null);
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
      style={{ bottom: "calc(100% + 8px)", maxHeight: "min(420px, calc(100vh - 120px))" }}
      className="absolute left-0 right-0 z-50 flex flex-col overflow-hidden rounded-xl border border-border-default bg-bg-surface shadow-lg"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <RefreshCw size={13} className="text-fg-faint" />
        <span className="text-xs font-medium text-fg-muted">
          {t("recompact.title" as TranslationKey)}
        </span>
        <span className="ml-auto text-[10px] text-fg-fainter whitespace-nowrap">
          {t("recompact.hints" as TranslationKey)}
        </span>
      </div>

      {/* List */}
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-6 text-xs text-fg-faint">
            <Loader2 size={14} className="animate-spin mr-1.5" />
            {t("recompact.loading" as TranslationKey)}
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-6 text-center text-xs text-fg-faint">
            {t("recompact.empty" as TranslationKey)}
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
                  if (!recompacting) doRecompact(s.id);
                }}
              >
                {/* Meta row */}
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-fg-fainter">#{sessions.length - i}</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-bg-hover px-2 py-0.5 text-[10px] text-fg-muted">
                    <Calendar size={10} className="text-fg-faint" />
                    {formatDateTime(s.createdAt)}
                    {s.endedAt ? (
                      <>
                        <span className="inline-block w-3 h-px bg-fg-faint/40" />
                        {formatDateTime(s.endedAt)}
                      </>
                    ) : null}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-bg-hover px-1.5 py-0.5 text-[10px] text-fg-faint">
                    <MessageSquare size={9} />
                    {s.messageCount}
                  </span>
                  {isRecompacting && (
                    <span className="flex items-center gap-1 text-accent">
                      <Loader2 size={10} className="animate-spin" />
                      <span className="text-[10px]">{t("recompact.running" as TranslationKey)}</span>
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
                    className={`mt-1 text-[11px] leading-relaxed text-fg-muted prose prose-invert prose-xs max-w-none ${
                      isExpanded ? "" : "line-clamp-3"
                    }`}
                  >
                    <MarkdownBlock>{isExpanded ? (s.summaryFull ?? "") : s.summaryPreview}</MarkdownBlock>
                  </div>
                ) : (
                  <div className="mt-1 text-[11px] text-fg-faint italic">{t("recompact.noSummary" as TranslationKey)}</div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
