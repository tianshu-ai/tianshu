// OpenShell plugin — client side.
//
// One admin page (`/admin/openshell/policy`) that appears when the
// openshell plugin is active. Two read-only panels:
//   1. Recent DENIED network requests (last N minutes) — from the
//      sandbox policy log via GET /api/p/openshell/policy/denials.
//   2. Allowed policy (the current effective allow-list) — from
//      GET /api/p/openshell/policy/allowed.
//
// Design follows McpServersPage (host tailwind tokens + lucide).
// Data-source shapes were verified on-box 2026-07-09:
//   denials: {denials:[{at,severity,binary,host,port,policy,engine,
//                       reason,raw}], logAvailable}
//   allowed: {policy:<parsed JSON|null>, raw:<CLI text>}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminPageProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import {
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Clock,
  Ban,
} from "lucide-react";

interface Denial {
  at?: string;
  severity?: string;
  binary?: string;
  host?: string;
  port?: number;
  policy?: string;
  engine?: string;
  reason?: string;
  raw: string;
}

interface DenialsResponse {
  minutes: number;
  denials: Denial[];
  logAvailable: boolean;
  error?: string;
}

interface AllowedResponse {
  policy: unknown;
  raw: string;
  error?: string;
}

const WINDOW_OPTIONS = [
  { label: "5 min", value: 5 },
  { label: "15 min", value: 15 },
  { label: "60 min", value: 60 },
  { label: "6 hr", value: 360 },
  { label: "24 hr", value: 1440 },
];

function OpenShellPolicyPage(_props: AdminPageProps) {
  const [minutes, setMinutes] = useState(60);
  const [denials, setDenials] = useState<Denial[] | null>(null);
  const [logAvailable, setLogAvailable] = useState(true);
  const [denialsErr, setDenialsErr] = useState<string | null>(null);
  const [denialsLoading, setDenialsLoading] = useState(false);

  const [allowedRaw, setAllowedRaw] = useState<string | null>(null);
  const [allowedErr, setAllowedErr] = useState<string | null>(null);
  const [allowedLoading, setAllowedLoading] = useState(false);

  const fetchDenials = useCallback(async (mins: number) => {
    setDenialsLoading(true);
    setDenialsErr(null);
    try {
      const r = await fetch(
        `/api/p/openshell/policy/denials?minutes=${mins}&last=500`,
        { credentials: "include" },
      );
      const j = (await r.json()) as DenialsResponse;
      if (!r.ok || j.error) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setDenials(j.denials ?? []);
      setLogAvailable(j.logAvailable !== false);
    } catch (err) {
      setDenialsErr(err instanceof Error ? err.message : String(err));
    } finally {
      setDenialsLoading(false);
    }
  }, []);

  const fetchAllowed = useCallback(async () => {
    setAllowedLoading(true);
    setAllowedErr(null);
    try {
      const r = await fetch("/api/p/openshell/policy/allowed", {
        credentials: "include",
      });
      const j = (await r.json()) as AllowedResponse;
      if (!r.ok || j.error) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      // Prefer pretty-printed parsed JSON, else the raw CLI text.
      setAllowedRaw(
        j.policy != null ? JSON.stringify(j.policy, null, 2) : j.raw ?? "",
      );
    } catch (err) {
      setAllowedErr(err instanceof Error ? err.message : String(err));
    } finally {
      setAllowedLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDenials(minutes);
  }, [fetchDenials, minutes]);

  useEffect(() => {
    void fetchAllowed();
  }, [fetchAllowed]);

  const refreshAll = useCallback(() => {
    void fetchDenials(minutes);
    void fetchAllowed();
  }, [fetchDenials, fetchAllowed, minutes]);

  const denialCount = denials?.length ?? 0;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
            <ShieldCheck size={18} className="text-brand-400" />
            Sandbox Network Policy
          </h1>
          <p className="mt-1 text-[12px] text-fg-faint">
            Egress policy for the OpenShell sandbox. Below: outbound requests
            that were <strong>denied</strong> in the selected time window, and
            the current <strong>allow-list</strong> of endpoints in force.
            Read-only — rules change when the agent proposes egress via the
            policy advisor or a task grants it.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={refreshAll}
            disabled={denialsLoading || allowedLoading}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border-default px-3 py-1.5 text-[12px] text-fg-muted hover:bg-bg-raised/50 disabled:opacity-50"
          >
            <RefreshCw
              size={12}
              className={
                denialsLoading || allowedLoading ? "animate-spin" : undefined
              }
            />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Denials panel ─────────────────────────────────────── */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg-default">
            <ShieldAlert size={15} className="text-red-400" />
            Denied requests
            <span className="rounded-full bg-bg-raised px-2 py-0.5 text-[11px] text-fg-muted">
              {denialCount}
            </span>
          </h2>
          <div className="flex items-center gap-1.5">
            <Clock size={12} className="text-fg-faint" />
            {WINDOW_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setMinutes(o.value)}
                className={`rounded-md px-2 py-1 text-[11px] ${
                  minutes === o.value
                    ? "bg-brand-500/20 text-brand-300"
                    : "text-fg-muted hover:bg-bg-raised/50"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {denialsErr && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {denialsErr}
          </div>
        )}
        {!denialsErr && !logAvailable && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
            The sandbox reports no denial log is available (policy logging may
            be off).
          </div>
        )}
        {!denialsErr && denials && denialCount === 0 && (
          <div className="rounded-md border border-border-default bg-bg-raised/30 px-3 py-6 text-center text-[12px] text-fg-faint">
            <Ban size={20} className="mx-auto mb-2 text-fg-faint/60" />
            No denied requests in the last{" "}
            {WINDOW_OPTIONS.find((o) => o.value === minutes)?.label ??
              `${minutes} min`}
            .
          </div>
        )}
        {!denialsErr && denialCount > 0 && (
          <div className="overflow-hidden rounded-md border border-border-default">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-bg-raised/60 text-fg-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Host:Port</th>
                  <th className="px-3 py-2 font-medium">Engine</th>
                  <th className="px-3 py-2 font-medium">Binary</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {denials!.map((d, i) => (
                  <tr
                    key={`${d.at ?? i}-${i}`}
                    className="border-t border-border-default/60 align-top"
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-fg-faint">
                      {d.at ? new Date(d.at).toLocaleTimeString() : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-fg-default">
                      {d.host ? `${d.host}:${d.port ?? "?"}` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span className="rounded bg-bg-raised px-1.5 py-0.5 text-[11px] text-fg-muted">
                        {d.engine ?? "?"}
                      </span>
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2 font-mono text-[11px] text-fg-faint">
                      {shortBinary(d.binary)}
                    </td>
                    <td className="max-w-[260px] px-3 py-2 text-[11px] text-fg-muted">
                      {d.reason ?? d.raw}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Allowed policy panel ──────────────────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg-default">
          <ShieldCheck size={15} className="text-green-400" />
          Allowed policy (effective allow-list)
        </h2>
        {allowedErr && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {allowedErr}
          </div>
        )}
        {!allowedErr && allowedLoading && !allowedRaw && (
          <div className="rounded-md border border-border-default bg-bg-raised/30 px-3 py-6 text-center text-[12px] text-fg-faint">
            Loading policy…
          </div>
        )}
        {!allowedErr && allowedRaw != null && (
          <pre className="max-h-[420px] overflow-auto rounded-md border border-border-default bg-bg-raised/40 p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
            {allowedRaw || "(empty policy)"}
          </pre>
        )}
      </section>
    </div>
  );
}

/** Shorten a long absolute binary path (+pid) to just the basename. */
function shortBinary(bin?: string): string {
  if (!bin) return "—";
  const m = bin.match(/([^/]+)$/);
  return m ? m[1] : bin;
}

// silence unused-in-some-builds warning without dropping the export.
void useMemo;

const clientExports: PluginClientExports = {
  components: {
    OpenShellPolicyPage:
      OpenShellPolicyPage as PluginClientExports["components"][string],
  },
};

export const components = clientExports.components;
export default clientExports;
