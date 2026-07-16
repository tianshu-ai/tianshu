// Cron plugin — client side.
//
// A mini month calendar + selected-day agenda, ported from the
// closed-source Tianshu CalendarPanel. Reads GET /api/p/cron/schedules,
// subscribes to the `cron:schedule_changed` WS event for live refresh,
// and deletes via DELETE /schedules/:id.
//
// Cron-day matching is done client-side (day-of-month / month /
// day-of-week only — the time-of-day fields don't affect *which day*
// a dot appears on). This is deliberately a lighter matcher than the
// server's `croner`-backed next-run computation; the panel only needs
// "does this job fire on this calendar day".

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Repeat,
  Trash2,
} from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/cron";

type ScheduleType = "once" | "cron";
type ActionType = "message" | "task";

interface ScheduledJob {
  id: string;
  title: string;
  scheduleType: ScheduleType;
  cronExpr: string | null;
  tz: string | null;
  runAt: number | null;
  actionType: ActionType;
  payload: Record<string, unknown>;
  enabled: boolean;
  lastRun: number | null;
  nextRun: number | null;
  createdAt: number;
  updatedAt: number;
}

// ─── cron day matching (client-side, day-granularity only) ──────

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (!step) continue;
      if (range === "*") {
        if (value % step === 0) return true;
      } else {
        const start = parseInt(range, 10);
        if (value >= start && (value - start) % step === 0) return true;
      }
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map((n) => parseInt(n, 10));
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

function matchesCronDay(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [, , dom, mon, dow] = parts;
  return (
    matchField(dom, date.getDate()) &&
    matchField(mon, date.getMonth() + 1) &&
    matchField(dow, date.getDay())
  );
}

function cronTimeLabel(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 2) return "";
  const min = parts[0] === "*" ? "00" : parts[0].padStart(2, "0");
  const hour = parts[1] === "*" ? "" : parts[1].padStart(2, "0");
  return hour ? `${hour}:${min}` : `:${min}`;
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sameDay(a: Date, y: number, m: number, d: number): boolean {
  return a.getFullYear() === y && a.getMonth() === m && a.getDate() === d;
}

// ─── panel ──────────────────────────────────────────────────────

function CalendarPanel(_props: PanelProps) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [selected, setSelected] = useState(() => new Date());
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });

  const fetchJobs = useCallback(() => {
    fetch(`${API_BASE}/schedules`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res: { jobs: ScheduledJob[] }) => setJobs(res.jobs ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchJobs();
    // The host wraps every plugin broadcast as a top-level
    // `plugin_event` whose `event` is `<pluginId>:<type>`. So we
    // subscribe to "plugin_event" and filter on the event name —
    // subscribing to "cron:schedule_changed" directly never fires
    // (that string is never a top-level ws message type).
    return subscribeToWsEvent<{ type: string; event?: string }>(
      "plugin_event",
      (ev) => {
        if (ev.event === "cron:schedule_changed") fetchJobs();
      },
    );
  }, [fetchJobs]);

  const y = month.getFullYear();
  const m = month.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const firstDow = new Date(y, m, 1).getDay();

  const cells = useMemo(() => {
    const out: (number | null)[] = [];
    for (let i = 0; i < firstDow; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(d);
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [firstDow, daysInMonth]);

  const jobsForDate = useCallback(
    (date: Date): ScheduledJob[] =>
      jobs.filter((j) => {
        if (j.scheduleType === "once") {
          const ts = j.runAt ?? j.lastRun;
          if (!ts) return false;
          const r = new Date(ts);
          return sameDay(r, date.getFullYear(), date.getMonth(), date.getDate());
        }
        if (j.scheduleType === "cron" && j.cronExpr) {
          return matchesCronDay(j.cronExpr, date);
        }
        return false;
      }),
    [jobs],
  );

  const today = new Date();
  const selectedJobs = jobsForDate(selected);

  const handleDelete = async (id: string) => {
    try {
      await fetch(`${API_BASE}/schedules/${id}`, { method: "DELETE" });
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } catch {
      /* ws refresh will reconcile */
    }
  };

  const goToday = () => {
    const n = new Date();
    setSelected(n);
    setMonth(new Date(n.getFullYear(), n.getMonth(), 1));
  };

  const isPast = (j: ScheduledJob) =>
    j.scheduleType === "once" && !!j.lastRun && !j.nextRun;

  return (
    <div className="flex flex-col h-full overflow-hidden text-fg-default">
      {/* month header */}
      <div className="flex-shrink-0 px-3 pt-3 pb-2 bg-bg-elevated rounded-lg mx-2 w-full max-w-xl self-center">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setMonth(new Date(y, m - 1, 1))}
            className="p-1 rounded hover:bg-bg-hover text-fg-faint hover:text-fg-default"
            aria-label="Previous month"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs font-medium text-fg-muted">
            {new Date(y, m, 1).toLocaleString("en-US", {
              month: "long",
              year: "numeric",
            })}
          </span>
          <button
            onClick={() => setMonth(new Date(y, m + 1, 1))}
            className="p-1 rounded hover:bg-bg-hover text-fg-faint hover:text-fg-default"
            aria-label="Next month"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="grid grid-cols-7 mb-0.5">
          {SHORT_DAYS.map((d) => (
            <div key={d} className="text-center text-[10px] text-fg-fainter py-0.5">
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((day, i) => {
            if (day === null) {
              return <div key={`e-${i}`} className="aspect-square" style={{ maxHeight: 44 }} />;
            }
            const isSel = sameDay(selected, y, m, day);
            const isToday = sameDay(today, y, m, day);
            const date = new Date(y, m, day);
            const dayJobs = jobsForDate(date);
            return (
              <button
                key={day}
                onClick={() => setSelected(new Date(y, m, day))}
                style={{ maxHeight: 44 }}
                className={`aspect-square w-full rounded-md text-[11px] relative transition-colors flex items-center justify-center ${
                  isSel
                    ? "bg-accent text-fg-on-accent font-semibold"
                    : isToday
                      ? "text-accent font-semibold ring-1 ring-inset ring-accent/50 hover:bg-bg-hover"
                      : "text-fg-muted hover:bg-bg-hover"
                }`}
              >
                {day}
                {dayJobs.length > 0 && (
                  <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1">
                    {(() => {
                      // A cell is tiny, so on busy days we don't paint
                      // one dot per job. Instead group by state:
                      //   ● N  pending jobs (solid dot + count)
                      //   ○ N  fired  jobs (hollow ring + count)
                      // Each group shows a single representative dot
                      // plus its count (count only when > 1). This keeps
                      // both "how many still to run" and "how many ran"
                      // visible regardless of total volume.
                      const pending = dayJobs.filter((j) => !isPast(j));
                      const past = dayJobs.filter((j) => isPast(j));
                      const countCls = isSel ? "text-fg-on-accent" : "text-fg-faint";
                      const Group = ({
                        n,
                        dot,
                      }: {
                        n: number;
                        dot: React.ReactNode;
                      }) =>
                        n === 0 ? null : (
                          <span className="flex items-center gap-0.5">
                            {dot}
                            {n > 1 && (
                              <span
                                className={`text-[8px] leading-none font-medium ${countCls}`}
                              >
                                {n}
                              </span>
                            )}
                          </span>
                        );
                      // Pending dot: solid. On the selected (accent)
                      // cell it's white; otherwise the type colour of
                      // the first pending job (task amber / message
                      // accent).
                      const pendingDot = isSel ? (
                        <span className="w-1 h-1 rounded-full bg-fg-on-accent" />
                      ) : (
                        <span
                          className={`w-1 h-1 rounded-full ${
                            pending[0]?.actionType === "task"
                              ? "bg-amber-500"
                              : "bg-accent"
                          }`}
                        />
                      );
                      // Fired dot: hollow ring (white on selected cell).
                      const pastDot = (
                        <span
                          className={`w-1 h-1 rounded-full border bg-transparent ${
                            isSel ? "border-fg-on-accent" : "border-fg-faint"
                          }`}
                        />
                      );
                      return (
                        <>
                          <Group n={pending.length} dot={pendingDot} />
                          <Group n={past.length} dot={pastDot} />
                        </>
                      );
                    })()}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* selected-day header */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-2.5 border-t border-border-subtle self-stretch">
        <div>
          <div className="text-[13px] font-semibold text-fg-default">
            {selected.toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </div>
          <div className="text-[10px] text-fg-faint mt-0.5">
            {selectedJobs.length > 0
              ? `${selectedJobs.length} job${selectedJobs.length > 1 ? "s" : ""}`
              : "No jobs"}
          </div>
        </div>
        {!sameDay(today, selected.getFullYear(), selected.getMonth(), selected.getDate()) && (
          <button
            onClick={goToday}
            className="text-[11px] text-fg-muted hover:text-accent px-2.5 py-1 rounded-md ring-1 ring-inset ring-border-default hover:ring-accent/50 transition-colors"
          >
            Today
          </button>
        )}
      </div>

      {/* agenda */}
      <div className="flex-1 overflow-y-auto border-t border-border-subtle self-stretch">
        {selectedJobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-fg-fainter">
            <Calendar size={28} className="mb-2 opacity-30" />
            <span className="text-xs">Nothing scheduled</span>
          </div>
        ) : (
          <div className="py-2">
            {selectedJobs.map((j) => {
              const time =
                j.scheduleType === "cron" && j.cronExpr
                  ? cronTimeLabel(j.cronExpr)
                  : j.runAt
                    ? new Date(j.runAt).toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "";
              const msg = (j.payload?.message ?? j.payload?.title) as string | undefined;
              return (
                <div
                  key={j.id}
                  className={`flex items-start gap-3 px-6 py-2.5 group hover:bg-bg-hover ${
                    isPast(j) ? "opacity-80" : ""
                  }`}
                >
                  <div className="flex-shrink-0 w-12 text-right">
                    <span className="text-[11px] font-mono text-fg-muted">{time}</span>
                  </div>
                  <div
                    className={`w-0.5 self-stretch rounded-full flex-shrink-0 ${
                      j.actionType === "task" ? "bg-amber-500" : "bg-accent"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div
                      className={`text-xs font-medium ${
                        isPast(j)
                          ? "text-fg-muted line-through decoration-2 decoration-fg-default"
                          : "text-fg-default"
                      }`}
                    >
                      {j.title}
                    </div>
                    <div className="text-[10px] text-fg-faint flex items-center gap-1 mt-0.5 flex-wrap">
                      {j.scheduleType === "cron" ? <Repeat size={9} /> : <Clock size={9} />}
                      <span>{j.scheduleType === "cron" ? "Recurring" : "One-time"}</span>
                      <span className="text-fg-fainter">·</span>
                      <span
                        className={
                          j.actionType === "task" ? "text-amber-500" : "text-accent"
                        }
                      >
                        {j.actionType === "task" ? "Task" : "Message"}
                      </span>
                      {j.tz && (
                        <>
                          <span className="text-fg-fainter">·</span>
                          <span>{j.tz}</span>
                        </>
                      )}
                      {!j.enabled && (
                        <>
                          <span className="text-fg-fainter">·</span>
                          <span>⏸️ disabled</span>
                        </>
                      )}
                      {isPast(j) && (
                        <>
                          <span className="text-fg-fainter">·</span>
                          <span>executed</span>
                        </>
                      )}
                    </div>
                    {msg && (
                      <div className="text-[10px] text-fg-faint mt-1 truncate">“{msg}”</div>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(j.id)}
                    className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-danger p-1 rounded flex-shrink-0"
                    aria-label="Delete job"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const exports: PluginClientExports = {
  components: { CalendarPanel },
};

export default exports;
