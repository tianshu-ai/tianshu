import { useEffect, useState } from "react";
import { RefreshCw, ChevronDown, ChevronUp, X, Loader2 } from "lucide-react";
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
  open: boolean;
  onClose: () => void;
}

export default function RecompactPicker({ open, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionChainEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [recompacting, setRecompacting] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    tianshuWs.send({ type: "session_chain" });

    const offChain = tianshuWs.on("session_chain", (msg) => {
      setSessions(msg.sessions);
      setLoading(false);
    });
    const offCompacted = tianshuWs.on("history_compacted", () => {
      setRecompacting(null);
      // Chain will be refreshed by the server sending session_chain after recompact
    });

    return () => { offChain(); offCompacted(); };
  }, [open]);

  if (!open) return null;

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const handleRecompact = (sessionId: string) => {
    setRecompacting(sessionId);
    tianshuWs.send({ type: "recompact", targetSessionId: sessionId });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[70vh] overflow-hidden rounded-xl border border-border-default bg-bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div className="flex items-center gap-2">
            <RefreshCw size={16} className="text-fg-muted" />
            <h2 className="text-sm font-semibold text-fg-default">Re-compact Session History</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-fg-muted hover:bg-bg-hover hover:text-fg-default"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-4" style={{ maxHeight: "calc(70vh - 56px)" }}>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-fg-muted" />
              <span className="ml-2 text-sm text-fg-muted">Loading session chain...</span>
            </div>
          ) : sessions.length === 0 ? (
            <div className="py-8 text-center text-sm text-fg-faint">
              No compacted parent sessions found.
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map((s, i) => {
                const isExpanded = expandedId === s.id;
                const isRecompacting = recompacting === s.id;
                return (
                  <div
                    key={s.id}
                    className="rounded-lg border border-border-subtle bg-bg-elevated overflow-hidden"
                  >
                    {/* Session header row */}
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-fg-faint">#{sessions.length - i}</span>
                          <span className="text-fg-muted">{formatDate(s.createdAt)}</span>
                          {s.endedAt && (
                            <span className="text-fg-faint">→ {formatDate(s.endedAt)}</span>
                          )}
                          <span className="rounded bg-bg-hover px-1.5 py-0.5 text-[10px] text-fg-faint">
                            {s.messageCount} msgs
                          </span>
                        </div>
                        {/* Summary preview */}
                        {s.summaryPreview && (
                          <div
                            className={`mt-1.5 text-xs text-fg-muted leading-relaxed ${
                              isExpanded ? "" : "line-clamp-3"
                            }`}
                          >
                            {isExpanded ? s.summaryFull : s.summaryPreview}
                          </div>
                        )}
                        {!s.summaryPreview && (
                          <div className="mt-1.5 text-xs text-fg-faint italic">
                            No summary available
                          </div>
                        )}
                      </div>
                      {/* Actions */}
                      <div className="flex flex-shrink-0 items-center gap-1">
                        {s.summaryFull && s.summaryFull.length > 500 && (
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExpanded ? null : s.id)}
                            className="rounded-md p-1 text-fg-faint hover:bg-bg-hover hover:text-fg-muted"
                            title={isExpanded ? "Collapse" : "Expand full summary"}
                          >
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRecompact(s.id)}
                          disabled={isRecompacting || recompacting !== null}
                          className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                            isRecompacting
                              ? "bg-accent/10 text-accent cursor-wait"
                              : recompacting !== null
                                ? "text-fg-faint cursor-not-allowed opacity-50"
                                : "text-fg-muted hover:bg-accent/10 hover:text-accent"
                          }`}
                          title="Re-generate summary for this session"
                        >
                          {isRecompacting ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <RefreshCw size={12} />
                          )}
                          {isRecompacting ? "Running..." : "Recompact"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
