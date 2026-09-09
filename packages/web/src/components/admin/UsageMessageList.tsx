import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Clock, User, Cpu, MessageSquare, ChevronRight } from "lucide-react";
import { useT } from "../../hooks/useT";

interface MessageRow {
  messageId: string; sessionId: string; userId: string;
  createdAt: number; model: string;
  inputTokens: number; outputTokens: number; totalTokens: number;
  cacheRead: number; cacheWrite: number; contentBytes: number;
}

interface ContextEntry {
  id: string; role: string; createdAt: number;
  contentBytes: number; totalTokens: number | null;
  preview: string; isCurrent: boolean;
}

interface MessageDetail {
  messageId: string; sessionId: string; userId: string;
  createdAt: number; contentBytes: number;
  usage: { input: number; output: number; totalTokens: number; cacheRead: number; cacheWrite: number; reasoning?: number } | null;
  context: ContextEntry[];
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function ts(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const ROLE_COLORS: Record<string, string> = {
  user: "text-emerald-400",
  assistant: "text-blue-400",
  tool: "text-amber-400",
  system: "text-purple-400",
};

export default function UsageMessageList({ day, onBack }: { day: string; onBack: () => void }) {
  const t = useT();
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/usage/messages?day=${day}`, { credentials: "include" });
      if (res.ok) setMessages((await res.json()).messages ?? []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [day]);

  const loadDetail = useCallback(async (messageId: string) => {
    try {
      const res = await fetch(`/api/admin/usage/message/${messageId}`, { credentials: "include" });
      if (res.ok) setDetail(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (detail) {
    return (
      <div>
        <button onClick={() => setDetail(null)}
          className="flex items-center gap-1 text-xs text-link hover:underline mb-4">
          <ArrowLeft size={12} /> {t("usage.backToMessages")}
        </button>
        <div className="rounded-md border border-border-subtle bg-bg-surface p-4 mb-4">
          <div className="text-sm font-semibold text-fg-default mb-2">{t("usage.messageDetail")}</div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="text-fg-faint">Session</div>
            <div className="text-fg-default font-mono truncate">{detail.sessionId.slice(0, 20)}</div>
            <div className="text-fg-faint">User</div>
            <div className="text-fg-default font-mono">{detail.userId.slice(0, 16)}</div>
            <div className="text-fg-faint">Time</div>
            <div className="text-fg-default">{new Date(detail.createdAt).toLocaleString()}</div>
            <div className="text-fg-faint">Content size</div>
            <div className="text-fg-default">{fmt(detail.contentBytes)} bytes</div>
          </div>
          {detail.usage && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                { label: "Input", value: fmt(detail.usage.input) },
                { label: "Output", value: fmt(detail.usage.output) },
                { label: "Total", value: fmt(detail.usage.totalTokens) },
                { label: "Cache read", value: fmt(detail.usage.cacheRead) },
                { label: "Cache write", value: fmt(detail.usage.cacheWrite) },
                ...(detail.usage.reasoning ? [{ label: "Reasoning", value: fmt(detail.usage.reasoning) }] : []),
              ].map((s) => (
                <div key={s.label} className="rounded bg-bg-raised px-2 py-1.5">
                  <div className="text-sm font-semibold text-fg-default">{s.value}</div>
                  <div className="text-[9px] text-fg-faint">{s.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Surrounding context */}
        <div className="rounded-md border border-border-subtle bg-bg-surface p-4">
          <div className="text-xs text-fg-faint mb-2">{t("usage.surroundingContext")}</div>
          <div className="space-y-1">
            {detail.context.map((c) => (
              <div key={c.id}
                className={`flex items-center gap-2 text-[11px] px-2 py-1 rounded ${c.isCurrent ? "bg-link/10 border border-link/30" : ""}`}>
                <span className={`w-14 shrink-0 font-mono ${ROLE_COLORS[c.role] ?? "text-fg-faint"}`}>{c.role}</span>
                <span className="text-fg-fainter w-16 shrink-0">{ts(c.createdAt)}</span>
                <span className="text-fg-muted w-12 shrink-0 text-right">{fmt(c.contentBytes)}B</span>
                {c.totalTokens != null && (
                  <span className="text-fg-muted w-14 shrink-0 text-right">{fmt(c.totalTokens)} tok</span>
                )}
                <span className="text-fg-faint truncate flex-1">{c.preview?.slice(0, 80)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack}
        className="flex items-center gap-1 text-xs text-link hover:underline mb-4">
        <ArrowLeft size={12} /> {t("usage.backToOverview")}
      </button>
      <div className="text-sm font-semibold text-fg-default mb-1">
        <Clock size={14} className="inline mr-1" />{day}
      </div>
      <div className="text-[11px] text-fg-faint mb-3">
        {messages.length} {t("usage.msgs")} · {fmt(messages.reduce((s, m) => s + m.totalTokens, 0))} tokens
      </div>

      {loading ? (
        <div className="text-[11px] text-fg-fainter py-4 text-center">Loading...</div>
      ) : messages.length === 0 ? (
        <div className="text-[11px] text-fg-fainter py-4 text-center">{t("usage.noData")}</div>
      ) : (
        <div className="space-y-1">
          {messages.map((m) => (
            <button key={m.messageId} onClick={() => void loadDetail(m.messageId)}
              className="w-full flex items-center gap-3 text-left rounded-md border border-border-subtle bg-bg-surface px-3 py-2 hover:bg-bg-hover transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-[11px]">
                  <User size={11} className="text-fg-faint shrink-0" />
                  <span className="font-mono text-fg-default truncate">{m.userId.slice(0, 12)}</span>
                  <Cpu size={11} className="text-fg-faint shrink-0 ml-1" />
                  <span className="text-fg-muted">{m.model}</span>
                  <MessageSquare size={11} className="text-fg-faint shrink-0 ml-1" />
                  <span className="text-fg-fainter">{ts(m.createdAt)}</span>
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-[10px] text-fg-faint">
                  <span>In: {fmt(m.inputTokens)}</span>
                  <span>Out: {fmt(m.outputTokens)}</span>
                  <span className="font-semibold text-fg-muted">Total: {fmt(m.totalTokens)}</span>
                  {m.cacheRead > 0 && <span>Cache: {fmt(m.cacheRead)}</span>}
                </div>
              </div>
              <ChevronRight size={14} className="text-fg-fainter shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
