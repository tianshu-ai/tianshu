import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import { useT } from "../../hooks/useT";
import { useChatStore } from "../../stores/chat-store";

// ── Types ──────────────────────────────────────────────────────────
// Daily data is pivoted: { day, totalTokens, [model1]: number, [model2]: number, ... }
type DailyUsage = Record<string, number | string>;
interface ModelUsage { model: string; totalTokens: number; messageCount: number }
interface UserUsage { userId: string; input: number; output: number; total: number; messages: number }
interface UserModelUsage { userId: string; model: string; totalTokens: number; messageCount: number }
interface UsageData {
  tenantId: string; days: number;
  daily: DailyUsage[]; models: string[]; byModel: ModelUsage[]; byUser: UserUsage[];
  byUserModel: UserModelUsage[];
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; messageCount: number };
}

// ── Helpers ────────────────────────────────────────────────────────
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const COLORS = ["#4263eb", "#12b886", "#f59f00", "#ae3ec9", "#fa5252", "#20c997", "#e64980", "#4c6ef5"];

// ── Component ──────────────────────────────────────────────────────
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

  // Fill missing days
  const filledDaily = useMemo(() => {
    if (!data?.daily.length) return [];
    const map = new Map(data.daily.map((d) => [String(d.day), d]));
    const result: DailyUsage[] = [];
    const sorted = [...data.daily].sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const endDate = new Date(String(sorted[sorted.length - 1].day) + "T12:00:00Z");
    const startDate = new Date(endDate.getTime() - (data.days - 1) * 86400_000);
    const actualStart = new Date(Math.min(new Date(String(sorted[0].day) + "T12:00:00Z").getTime(), startDate.getTime()));
    // Build a zero-entry with all models set to 0
    const zeroEntry = (): DailyUsage => {
      const e: DailyUsage = { day: "", totalTokens: 0 };
      for (const m of data.models ?? []) e[m] = 0;
      return e;
    };
    for (let d = new Date(actualStart); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      result.push(map.get(key) ?? { ...zeroEntry(), day: key });
    }
    return result;
  }, [data]);

  // Build model→color map (shared between pie chart and bar chart)
  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    (data?.models ?? []).forEach((m, i) => map.set(m, COLORS[i % COLORS.length]));
    return map;
  }, [data]);

  const userMax = data?.byUser.reduce((m, u) => Math.max(m, u.total), 0) ?? 1;

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

          {/* Daily trend — Recharts BarChart */}
          {filledDaily.length > 0 && (
            <div className="mb-6 rounded-md border border-border-subtle bg-bg-surface p-4">
              <div className="text-xs text-fg-faint mb-3">{t("usage.dailyTrend")}</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={filledDaily} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle, #333)" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: "var(--color-fg-faint, #888)" }}
                    tickFormatter={(v: string) => v.slice(5)} // "MM-DD"
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "var(--color-fg-faint, #888)" }}
                    tickFormatter={(v: number) => fmt(v)}
                    width={50}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--color-bg-surface, #1a1a2e)",
                      border: "1px solid var(--color-border-default, #444)",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "var(--color-fg-default, #fff)", fontWeight: 600 }}
                    formatter={(value) => [fmt(Number(value)), "Tokens"]}
                  />
                  {(data?.models ?? []).map((model, i, arr) => (
                    <Bar
                      key={model}
                      dataKey={model}
                      stackId="a"
                      fill={modelColorMap.get(model) ?? "#4263eb"}
                      radius={i === arr.length - 1 ? [3, 3, 0, 0] : 0}
                    />
                  ))}
                  <Legend formatter={(value: string) => <span style={{ fontSize: 11 }}>{value}</span>} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Model + User panels */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            {/* Model breakdown — PieChart */}
            {data.byModel.length > 0 && (
              <div className="rounded-md border border-border-subtle bg-bg-surface p-4">
                <div className="text-xs text-fg-faint mb-3">{t("usage.byModel")}</div>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={data.byModel}
                      dataKey="totalTokens"
                      nameKey="model"
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={75}
                      paddingAngle={2}
                    >
                      {data.byModel.map((m) => (
                        <Cell key={m.model} fill={modelColorMap.get(m.model) ?? COLORS[0]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--color-bg-surface, #1a1a2e)",
                        border: "1px solid var(--color-border-default, #444)",
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                      formatter={(value) => [fmt(Number(value)), "Tokens"]}
                    />
                    <Legend
                      formatter={(value: string) => <span style={{ fontSize: 11 }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* User breakdown — stacked bar per model */}
            {data.byUser.length > 0 && (
              <div className="rounded-md border border-border-subtle bg-bg-surface p-4">
                <div className="text-xs text-fg-faint mb-3">{t("usage.perUser")}</div>
                <div className="space-y-3">
                  {data.byUser.map((u) => {
                    const userModels = (data.byUserModel ?? []).filter((um) => um.userId === u.userId);
                    return (
                      <div key={u.userId}>
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-fg-default font-mono truncate">{u.userId.slice(0, 16)}</span>
                          <span className="text-fg-muted shrink-0 ml-2">{fmt(u.total)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-bg-raised overflow-hidden flex">
                          {userModels.map((um) => (
                            <div
                              key={um.model}
                              className="h-full first:rounded-l-full last:rounded-r-full transition-all"
                              style={{
                                width: `${(um.totalTokens / userMax) * 100}%`,
                                backgroundColor: modelColorMap.get(um.model) ?? COLORS[0],
                              }}
                              title={`${um.model}: ${fmt(um.totalTokens)}`}
                            />
                          ))}
                        </div>
                        <div className="flex gap-2 mt-0.5 flex-wrap">
                          {userModels.map((um) => (
                            <span key={um.model} className="text-[9px] text-fg-fainter flex items-center gap-1">
                              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: modelColorMap.get(um.model) ?? COLORS[0] }} />
                              {um.model}: {fmt(um.totalTokens)}
                            </span>
                          ))}
                          <span className="text-[9px] text-fg-fainter">{u.messages} {t("usage.msgs")}</span>
                        </div>
                      </div>
                    );
                  })}
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
