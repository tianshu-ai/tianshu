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
import { usePluginT } from "@tianshu-ai/plugin-sdk/client";
import {
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Clock,
  Ban,
  Check,
  Loader2,
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

/** A best-effort flattened "allowed endpoint" pulled out of the
 *  policy JSON, whatever nesting openshell uses. */
interface AllowedRule {
  name?: string;
  host?: string;
  port?: number;
  protocol?: string;
  enforcement?: string;
  binaries?: string[];
}

const WINDOW_OPTIONS = [
  { key: "window.5min", value: 5 },
  { key: "window.15min", value: 15 },
  { key: "window.60min", value: 60 },
  { key: "window.6hr", value: 360 },
  { key: "window.24hr", value: 1440 },
];

function OpenShellPolicyPage(_props: AdminPageProps) {
  const t = usePluginT("openshell");
  const [minutes, setMinutes] = useState(60);
  const [denials, setDenials] = useState<Denial[] | null>(null);
  const [logAvailable, setLogAvailable] = useState(true);
  const [denialsErr, setDenialsErr] = useState<string | null>(null);
  const [denialsLoading, setDenialsLoading] = useState(false);

  const [allowedRules, setAllowedRules] = useState<AllowedRule[] | null>(null);
  const [allowedRaw, setAllowedRaw] = useState<string | null>(null);
  const [allowedErr, setAllowedErr] = useState<string | null>(null);
  const [allowedLoading, setAllowedLoading] = useState(false);

  // Per-denial "Allow" button state, keyed by host:port.
  const [allowing, setAllowing] = useState<Record<string, boolean>>({});
  const [allowErr, setAllowErr] = useState<string | null>(null);

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
      setAllowedRules(flattenPolicy(j.policy));
      setAllowedRaw(
        j.policy != null ? JSON.stringify(j.policy, null, 2) : j.raw ?? "",
      );
    } catch (err) {
      setAllowedErr(err instanceof Error ? err.message : String(err));
    } finally {
      setAllowedLoading(false);
    }
  }, []);

  const allowDenial = useCallback(
    async (d: Denial) => {
      if (!d.host || !d.port) return;
      const key = `${d.host}:${d.port}`;
      setAllowing((m) => ({ ...m, [key]: true }));
      setAllowErr(null);
      try {
        const r = await fetch("/api/p/openshell/policy/allow", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            host: d.host,
            port: d.port,
            protocol: d.port === 443 ? "https" : undefined,
            binary: d.binary,
          }),
        });
        const j = (await r.json()) as { ok?: boolean; error?: string };
        if (!r.ok || j.error) {
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        // Refresh both panels: the denial should stop recurring and
        // the new rule should appear in the allow-list.
        void fetchAllowed();
        void fetchDenials(minutes);
      } catch (err) {
        setAllowErr(err instanceof Error ? err.message : String(err));
      } finally {
        setAllowing((m) => ({ ...m, [key]: false }));
      }
    },
    [fetchAllowed, fetchDenials, minutes],
  );

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

  // Set of "host:port" that the effective policy already allows, so a
  // denial whose endpoint is now permitted can be shown as resolved
  // (struck through, Allow disabled). We match on host+port; a rule
  // with no explicit port is treated as covering any port for that
  // host.
  const allowedSet = useMemo(() => {
    const exact = new Set<string>();
    const hostWildcard = new Set<string>();
    for (const r of allowedRules ?? []) {
      if (!r.host) continue;
      if (typeof r.port === "number") exact.add(`${r.host}:${r.port}`);
      else hostWildcard.add(r.host);
    }
    return { exact, hostWildcard };
  }, [allowedRules]);

  const isAllowed = useCallback(
    (d: Denial): boolean => {
      if (!d.host) return false;
      if (d.port != null && allowedSet.exact.has(`${d.host}:${d.port}`))
        return true;
      return allowedSet.hostWildcard.has(d.host);
    },
    [allowedSet],
  );

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
            <ShieldCheck size={18} className="text-brand-400" />
            {t("page.title")}
          </h1>
          <p className="mt-1 text-[12px] text-fg-faint">
            {t("page.description")}
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
            {t("page.refresh")}
          </button>
        </div>
      </div>

      {/* ── Denials panel ─────────────────────────────────────── */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg-default">
            <ShieldAlert size={15} className="text-red-400" />
            {t("denials.title")}
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
                {t(o.key)}
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
            {t("denials.logUnavailable")}
          </div>
        )}
        {!denialsErr && denials && denialCount === 0 && (
          <div className="rounded-md border border-border-default bg-bg-raised/30 px-3 py-6 text-center text-[12px] text-fg-faint">
            <Ban size={20} className="mx-auto mb-2 text-fg-faint/60" />
            {t("denials.emptyPre")}
            {(() => {
              const o = WINDOW_OPTIONS.find((o) => o.value === minutes);
              return o ? t(o.key) : `${minutes} min`;
            })()}
            {t("denials.emptyPost")}
          </div>
        )}
        {!denialsErr && denialCount > 0 && (
          <div className="overflow-hidden rounded-md border border-border-default">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-bg-raised/60 text-fg-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("denials.col.time")}</th>
                  <th className="px-3 py-2 font-medium">{t("denials.col.hostPort")}</th>
                  <th className="px-3 py-2 font-medium">{t("denials.col.engine")}</th>
                  <th className="px-3 py-2 font-medium">{t("denials.col.binary")}</th>
                  <th className="px-3 py-2 font-medium">{t("denials.col.reason")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("denials.col.action")}</th>
                </tr>
              </thead>
              <tbody>
                {denials!.map((d, i) => {
                  const key = d.host ? `${d.host}:${d.port}` : "";
                  const busy = key ? allowing[key] === true : false;
                  // Already covered by the effective policy? Then this
                  // denial is historical — strike it through and disable
                  // Allow, but keep the row so the past block is visible.
                  const resolved = isAllowed(d);
                  return (
                    <tr
                      key={`${d.at ?? i}-${i}`}
                      className={`border-t border-border-default/60 align-top ${
                        resolved ? "opacity-55" : ""
                      }`}
                    >
                      <td
                        className={`whitespace-nowrap px-3 py-2 font-mono text-fg-faint ${
                          resolved ? "line-through" : ""
                        }`}
                      >
                        {d.at ? new Date(d.at).toLocaleTimeString() : "—"}
                      </td>
                      <td
                        className={`px-3 py-2 font-mono text-fg-default ${
                          resolved ? "line-through" : ""
                        }`}
                      >
                        {d.host ? `${d.host}:${d.port ?? "?"}` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span className="rounded bg-bg-raised px-1.5 py-0.5 text-[11px] text-fg-muted">
                          {d.engine ?? "?"}
                        </span>
                      </td>
                      <td
                        className={`max-w-[180px] truncate px-3 py-2 font-mono text-[11px] text-fg-faint ${
                          resolved ? "line-through" : ""
                        }`}
                      >
                        {shortBinary(d.binary)}
                      </td>
                      <td
                        className={`max-w-[240px] px-3 py-2 text-[11px] text-fg-muted ${
                          resolved ? "line-through" : ""
                        }`}
                      >
                        {d.reason ?? d.raw}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {resolved ? (
                          <span className="inline-flex items-center gap-1 rounded-md border border-green-500/30 bg-green-500/10 px-2 py-1 text-[11px] text-green-300">
                            <Check size={11} />
                            {t("denials.allowed")}
                          </span>
                        ) : d.host && d.port ? (
                          <button
                            type="button"
                            onClick={() => allowDenial(d)}
                            disabled={busy}
                            title={t("denials.allowTitle", { host: d.host, port: d.port })}
                            className="inline-flex items-center gap-1 rounded-md border border-green-500/40 px-2 py-1 text-[11px] text-green-300 hover:bg-green-500/10 disabled:opacity-50"
                          >
                            {busy ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <Check size={11} />
                            )}
                            {t("denials.allow")}
                          </button>
                        ) : (
                          <span className="text-[11px] text-fg-faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Allowed policy panel ──────────────────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg-default">
          <ShieldCheck size={15} className="text-green-400" />
          {t("allowed.title")}
        </h2>
        {allowErr && (
          <div className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {t("allowed.allowFailed", { error: allowErr })}
          </div>
        )}
        {allowedErr && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {allowedErr}
          </div>
        )}
        {!allowedErr && allowedLoading && !allowedRaw && (
          <div className="rounded-md border border-border-default bg-bg-raised/30 px-3 py-6 text-center text-[12px] text-fg-faint">
            {t("allowed.loading")}
          </div>
        )}
        {!allowedErr && allowedRules && allowedRules.length > 0 && (
          <div className="mb-3 overflow-hidden rounded-md border border-border-default">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-bg-raised/60 text-fg-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("allowed.col.rule")}</th>
                  <th className="px-3 py-2 font-medium">{t("allowed.col.hostPort")}</th>
                  <th className="px-3 py-2 font-medium">{t("allowed.col.proto")}</th>
                  <th className="px-3 py-2 font-medium">{t("allowed.col.enforce")}</th>
                  <th className="px-3 py-2 font-medium">{t("allowed.col.binaries")}</th>
                </tr>
              </thead>
              <tbody>
                {allowedRules.map((r, i) => (
                  <tr
                    key={`${r.name ?? r.host ?? i}-${i}`}
                    className="border-t border-border-default/60 align-top"
                  >
                    <td className="px-3 py-2 text-fg-muted">{r.name ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-fg-default">
                      {r.host ? `${r.host}:${r.port ?? "*"}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">{r.protocol ?? "—"}</td>
                    <td className="px-3 py-2 text-fg-muted">
                      {r.enforcement ?? "—"}
                    </td>
                    <td className="max-w-[240px] px-3 py-2 font-mono text-[11px] text-fg-faint">
                      {r.binaries && r.binaries.length
                        ? r.binaries.map(shortBinary).join(", ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!allowedErr &&
          allowedRules &&
          allowedRules.length === 0 &&
          allowedRaw != null && (
            <details className="rounded-md border border-border-default bg-bg-raised/40">
              <summary className="cursor-pointer px-3 py-2 text-[12px] text-fg-muted">
                {t("allowed.noneParsed")}
              </summary>
              <pre className="max-h-[420px] overflow-auto border-t border-border-default p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
                {allowedRaw || t("allowed.emptyPolicy")}
              </pre>
            </details>
          )}
      </section>
    </div>
  );
}

/** Shorten a long absolute binary path (+pid) to just the basename. */
function shortBinary(bin?: string): string {
  if (!bin) return "—";
  const m = bin.replace(/\(\d+\)\s*$/, "").match(/([^/]+)$/);
  return m ? m[1] : bin;
}

/**
 * Flatten the `policy get --output json --full` body into a list of
 * allowed endpoints. Verified shape (2026-07-09):
 *   policy.network_policies.<ruleName> = {
 *     name, binaries: [{path}], endpoints: [{host,port,protocol,
 *     access,enforcement}]
 *   }
 * A rule can have multiple endpoints; binaries are per-rule, so each
 * endpoint inherits the rule's binaries. One table row per endpoint.
 * Falls back to [] (UI shows raw JSON) if the shape is unexpected.
 */
function flattenPolicy(policy: unknown): AllowedRule[] {
  const out: AllowedRule[] = [];
  const root =
    policy && typeof policy === "object"
      ? ((policy as Record<string, unknown>).policy as
          | Record<string, unknown>
          | undefined) ?? (policy as Record<string, unknown>)
      : undefined;
  const net =
    root && typeof root === "object"
      ? (root.network_policies as Record<string, unknown> | undefined)
      : undefined;
  if (!net || typeof net !== "object") return out;

  for (const [ruleKey, ruleVal] of Object.entries(net)) {
    if (!ruleVal || typeof ruleVal !== "object") continue;
    const rule = ruleVal as Record<string, unknown>;
    const name = typeof rule.name === "string" ? rule.name : ruleKey;
    const binaries = Array.isArray(rule.binaries)
      ? (rule.binaries as unknown[])
          .map((b) =>
            b && typeof b === "object" &&
            typeof (b as { path?: unknown }).path === "string"
              ? (b as { path: string }).path
              : typeof b === "string"
                ? b
                : undefined,
          )
          .filter((b): b is string => typeof b === "string")
      : undefined;
    const endpoints = Array.isArray(rule.endpoints)
      ? (rule.endpoints as unknown[])
      : [];
    if (endpoints.length === 0) {
      // Rule with no endpoints — still list it so it's visible.
      out.push({ name, binaries });
      continue;
    }
    for (const epVal of endpoints) {
      if (!epVal || typeof epVal !== "object") continue;
      const ep = epVal as Record<string, unknown>;
      out.push({
        name,
        host: typeof ep.host === "string" ? ep.host : undefined,
        port:
          typeof ep.port === "number"
            ? ep.port
            : typeof ep.port === "string"
              ? Number.parseInt(ep.port, 10)
              : undefined,
        protocol: typeof ep.protocol === "string" ? ep.protocol : undefined,
        enforcement:
          typeof ep.enforcement === "string" ? ep.enforcement : undefined,
        binaries,
      });
    }
  }
  return out;
}


const clientExports: PluginClientExports = {
  components: {
    OpenShellPolicyPage:
      OpenShellPolicyPage as PluginClientExports["components"][string],
  },
};

export const components = clientExports.components;
export default clientExports;
