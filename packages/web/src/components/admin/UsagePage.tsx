import { useCallback, useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { useT } from "../../hooks/useT";
import { useChatStore } from "../../stores/chat-store";

interface UserUsage {
  userId: string;
  input: number;
  output: number;
  total: number;
  messages: number;
}

interface UsageData {
  tenantId: string;
  days: number;
  byUser: UserUsage[];
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; messageCount: number };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function UsagePage() {
  const t = useT();
  const me = useChatStore((s) => s.me);
  const [data, setData] = useState<UsageData | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/usage?days=${days}`, { credentials: "include" });
      if (res.ok) { setData(await res.json()); setError(null); }
      else { const d = await res.json().catch(() => ({})); setError(d.error || `HTTP ${res.status}`); }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const maxTokens = data?.byUser.reduce((m, u) => Math.max(m, u.total), 0) ?? 1;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
            <BarChart3 size={18} className="text-link" />
            {t("usage.title")}
          </h1>
          <p className="mt-1 text-[12px] text-fg-faint">
            {t("usage.subtitle")} · {me?.tenantId}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-xs text-fg-default"
          >
            <option value={7}>{t("usage.days7")}</option>
            <option value={30}>{t("usage.days30")}</option>
            <option value={90}>{t("usage.days90")}</option>
            <option value={365}>{t("usage.days365")}</option>
          </select>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md border border-border-default px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-hover disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-sm text-danger">{error}</div>
      )}

      {/* Totals */}
      {data && (
        <div className="mb-6 grid grid-cols-4 gap-3">
          {[
            { label: t("usage.totalTokens"), value: formatTokens(data.totals.totalTokens) },
            { label: t("usage.inputTokens"), value: formatTokens(data.totals.inputTokens) },
            { label: t("usage.outputTokens"), value: formatTokens(data.totals.outputTokens) },
            { label: t("usage.messages"), value: String(data.totals.messageCount) },
          ].map((s) => (
            <div key={s.label} className="rounded-md border border-border-subtle bg-bg-surface px-4 py-3">
              <div className="text-xl font-semibold text-fg-default">{s.value}</div>
              <div className="text-[11px] text-fg-faint mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Per-user breakdown */}
      {data && data.byUser.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs text-fg-faint mb-2">{t("usage.perUser")}</div>
          {data.byUser.map((u) => (
            <div key={u.userId} className="flex items-center gap-4 rounded-md border border-border-subtle bg-bg-surface px-4 py-3">
              <div className="w-40 min-w-0">
                <div className="text-sm font-medium text-fg-default truncate font-mono">{u.userId.slice(0, 12)}…</div>
                <div className="text-[10px] text-fg-faint">{u.messages} {t("usage.msgs")}</div>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-bg-raised overflow-hidden">
                    <div
                      className="h-full bg-link rounded-full transition-all"
                      style={{ width: `${Math.round((u.total / maxTokens) * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-fg-muted w-16 text-right">{formatTokens(u.total)}</span>
                </div>
                <div className="flex gap-4 mt-1 text-[10px] text-fg-faint">
                  <span>{t("usage.in")}: {formatTokens(u.input)}</span>
                  <span>{t("usage.out")}: {formatTokens(u.output)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : !loading ? (
        <div className="rounded-md border border-dashed border-border-subtle px-4 py-6 text-center text-[12px] text-fg-fainter">
          {t("usage.noData")}
        </div>
      ) : null}
    </div>
  );
}
