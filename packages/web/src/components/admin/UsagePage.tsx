import { useCallback, useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { useT } from "../../hooks/useT";
import { useChatStore } from "../../stores/chat-store";

interface DailyUsage { day: string; inputTokens: number; outputTokens: number; totalTokens: number; messageCount: number }
interface ModelUsage { model: string; totalTokens: number; messageCount: number }
interface UserUsage { userId: string; input: number; output: number; total: number; messages: number }
interface UsageData {
  tenantId: string; days: number;
  daily: DailyUsage[]; byModel: ModelUsage[]; byUser: UserUsage[];
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; messageCount: number };
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const MODEL_COLORS = [
  "bg-blue-500", "bg-emerald-500", "bg-amber-500", "bg-purple-500",
  "bg-rose-500", "bg-cyan-500", "bg-pink-500", "bg-indigo-500",
];

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

  // Fill in missing days with zeros so the chart has no gaps.
  // Use the actual date range from the API data to avoid timezone mismatches.
  const filledDaily = (() => {
    if (!data?.daily.length) return [];
    const map = new Map(data.daily.map((d) => [d.day, d]));
    const result: DailyUsage[] = [];
    // Derive range from the API's first/last day, then extend to cover full period
    const sorted = [...data.daily].sort((a, b) => a.day.localeCompare(b.day));
    const firstDay = sorted[0].day;
    const lastDay = sorted[sorted.length - 1].day;
    // Walk from (lastDay - days) to lastDay using simple string date math
    const endDate = new Date(lastDay + "T12:00:00Z"); // noon UTC to avoid DST issues
    const startDate = new Date(endDate.getTime() - (data.days - 1) * 86400_000);
    // Use the earlier of API first day and computed start
    const actualStart = new Date(Math.min(new Date(firstDay + "T12:00:00Z").getTime(), startDate.getTime()));
    for (let d = new Date(actualStart); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      result.push(map.get(key) ?? { day: key, inputTokens: 0, outputTokens: 0, totalTokens: 0, messageCount: 0 });
    }
    return result;
  })();
  const dailyMax = filledDaily.reduce((m, d) => Math.max(m, d.totalTokens), 0) || 1;
  const userMax = data?.byUser.reduce((m, u) => Math.max(m, u.total), 0) ?? 1;
  const modelTotal = data?.byModel.reduce((s, m) => s + m.totalTokens, 0) ?? 1;

  return (
    <div className="mx-auto max-w-5xl p-6">
      {/* Header */}
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
          <button onClick={() => void load()} disabled={loading}
            className="flex items-center gap-1.5 rounded-md border border-border-default px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-hover disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-sm text-danger">{error}</div>
      )}

      {data && (
        <>
          {/* Stat cards */}
          <div className="mb-6 grid grid-cols-3 gap-3">
            {[
              { label: t("usage.totalTokens"), value: fmt(data.totals.totalTokens) },
              { label: t("usage.messages"), value: String(data.totals.messageCount) },
              { label: t("usage.avgPerMsg"), value: `~${fmt(Math.round(data.totals.totalTokens / Math.max(data.totals.messageCount, 1)))}` },
            ].map((s) => (
              <div key={s.label} className="rounded-md border border-border-subtle bg-bg-surface px-4 py-3">
                <div className="text-xl font-semibold text-fg-default">{s.value}</div>
                <div className="text-[11px] text-fg-faint mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Daily trend chart */}
          {filledDaily.length > 0 && (
            <div className="mb-6 rounded-md border border-border-subtle bg-bg-surface p-4">
              <div className="text-xs text-fg-faint mb-3">{t("usage.dailyTrend")}</div>
              <div className="flex items-end gap-[2px] h-32">
                {filledDaily.map((d) => {
                  // Use sqrt scale so small days aren't invisible next to large spikes
                  const ratio = dailyMax > 0 ? d.totalTokens / dailyMax : 0;
                  const pct = Math.sqrt(ratio) * 100;
                  return (
                    <div key={d.day} className="flex-1 flex flex-col justify-end group relative min-h-full">
                      <div className={`rounded-t-sm ${d.totalTokens > 0 ? 'bg-link' : ''}`} style={{ height: d.totalTokens > 0 ? `${Math.max(pct, 4)}%` : '0%' }} />
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-bg-surface border border-border-default rounded px-2 py-1 text-[10px] text-fg-default whitespace-nowrap shadow-lg z-10">
                        <div className="font-medium">{d.day}</div>
                        <div>{fmt(d.totalTokens)} tokens</div>
                        <div className="text-fg-faint">{d.messageCount} {t("usage.msgs")}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-1 text-[9px] text-fg-fainter">
                <span>{filledDaily[0]?.day}</span>
                <span>{filledDaily[filledDaily.length - 1]?.day}</span>
              </div>
            </div>
          )}

          {/* Model breakdown + User breakdown side by side */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            {/* Model breakdown */}
            {data.byModel.length > 0 && (
              <div className="rounded-md border border-border-subtle bg-bg-surface p-4">
                <div className="text-xs text-fg-faint mb-3">{t("usage.byModel")}</div>
                {/* Donut-style horizontal bar */}
                <div className="h-3 rounded-full bg-bg-raised overflow-hidden flex mb-3">
                  {data.byModel.map((m, i) => (
                    <div
                      key={m.model}
                      className={`${MODEL_COLORS[i % MODEL_COLORS.length]} first:rounded-l-full last:rounded-r-full`}
                      style={{ width: `${(m.totalTokens / modelTotal) * 100}%` }}
                      title={`${m.model}: ${fmt(m.totalTokens)}`}
                    />
                  ))}
                </div>
                <div className="space-y-1.5">
                  {data.byModel.map((m, i) => (
                    <div key={m.model} className="flex items-center gap-2 text-[11px]">
                      <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${MODEL_COLORS[i % MODEL_COLORS.length]}`} />
                      <span className="text-fg-default truncate flex-1">{m.model}</span>
                      <span className="text-fg-muted shrink-0">{fmt(m.totalTokens)}</span>
                      <span className="text-fg-fainter shrink-0 w-10 text-right">{Math.round(m.totalTokens / modelTotal * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* User breakdown */}
            {data.byUser.length > 0 && (
              <div className="rounded-md border border-border-subtle bg-bg-surface p-4">
                <div className="text-xs text-fg-faint mb-3">{t("usage.perUser")}</div>
                <div className="space-y-2">
                  {data.byUser.map((u) => (
                    <div key={u.userId}>
                      <div className="flex items-center justify-between text-[11px] mb-0.5">
                        <span className="text-fg-default font-mono truncate">{u.userId.slice(0, 16)}</span>
                        <span className="text-fg-muted shrink-0 ml-2">{fmt(u.total)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-bg-raised overflow-hidden">
                        <div className="h-full bg-link rounded-full" style={{ width: `${(u.total / userMax) * 100}%` }} />
                      </div>
                      <div className="text-[9px] text-fg-fainter mt-0.5">{u.messages} {t("usage.msgs")}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {!loading && !data && !error && (
        <div className="rounded-md border border-dashed border-border-subtle px-4 py-6 text-center text-[12px] text-fg-fainter">
          {t("usage.noData")}
        </div>
      )}
    </div>
  );
}
