// MicroSandbox plugin — client side (v0 status panel).
//
// This is the minimal cut: just a "what is this thing doing?" status
// surface so an operator can tell whether the sandbox is alive, why
// it isn't if it isn't, and where artifacts live. The full
// shell-panel terminal + browser noVNC viewport land in a follow-up
// PR (ADR-0004 N+3) along with the agent-tool wiring.
//
// We intentionally avoid pulling in any chart / xterm / codemirror
// dependency for v0 — the file-scan loader inlines this bundle into
// the host's vite build, so every byte counts when the plugin's
// real runtime UI hasn't shipped yet.

import { useCallback, useEffect, useState } from "react";
import { Box, RefreshCw, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu/plugin-sdk/client";

interface StatusPayload {
  state: "starting" | "ready" | "running" | "error" | "stopped";
  uptimeMs: number;
  lastError?: string;
  meta?: Record<string, unknown>;
  ready: boolean;
  runner: "microsandbox" | "nullable";
}

function SandboxStatusPanel(_props: PanelProps) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const r = await fetch("/api/p/microsandbox/status", {
        credentials: "include",
      });
      if (!r.ok) {
        throw new Error(`/api/p/microsandbox/status → ${r.status}`);
      }
      const json = (await r.json()) as StatusPayload;
      setStatus(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-200">
          <Box size={14} className="text-brand-400" />
          MicroSandbox
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="btn-ghost flex items-center gap-1 px-2 py-1 text-[11px] text-gray-400"
          title="Re-fetch status"
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 text-xs text-gray-300">
        {error && (
          <div className="mb-3 flex items-start gap-1.5 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-rose-300">
            <AlertTriangle size={12} className="mt-px flex-shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
        {!status && !error && (
          <div className="flex items-center gap-2 py-6 text-gray-500">
            <Loader2 size={12} className="animate-spin" />
            Loading…
          </div>
        )}
        {status && <StatusBody status={status} />}
      </div>
    </div>
  );
}

function StatusBody({ status }: { status: StatusPayload }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <StateIcon state={status.state} />
        <span className="font-medium">
          {status.runner === "nullable" ? "Not running" : status.state}
        </span>
        <span className="ml-auto rounded bg-gray-800 px-1.5 py-0.5 text-[10px] uppercase text-gray-400">
          {status.runner}
        </span>
      </div>
      {status.runner === "nullable" && status.lastError && (
        <div className="rounded-md border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
          {status.lastError}
        </div>
      )}
      <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-[11px]">
        <Field label="Uptime">{formatUptime(status.uptimeMs)}</Field>
        {extractMetaString(status.meta, "binaryPath") && (
          <Field label="Binary">
            <code className="break-all rounded bg-gray-800 px-1 text-gray-300">
              {extractMetaString(status.meta, "binaryPath")}
            </code>
          </Field>
        )}
        {extractMetaString(status.meta, "projectDir") && (
          <Field label="Project">
            <code className="break-all rounded bg-gray-800 px-1 text-gray-300">
              {extractMetaString(status.meta, "projectDir")}
            </code>
          </Field>
        )}
        {extractMetaString(status.meta, "sandboxName") && (
          <Field label="Sandbox">
            <code className="rounded bg-gray-800 px-1 text-gray-300">
              {extractMetaString(status.meta, "sandboxName")}
            </code>
          </Field>
        )}
      </dl>
      <p className="text-[11px] leading-relaxed text-gray-500">
        Interactive shell panel + browser viewport land in a follow-up
        PR (ADR-0004 §10/§9). For now this surface only reports
        liveness so you can tell whether the sandbox is reachable.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="col-span-1 text-gray-500">{label}</dt>
      <dd className="col-span-2 text-gray-300">{children}</dd>
    </>
  );
}

function StateIcon({ state }: { state: StatusPayload["state"] }) {
  if (state === "ready" || state === "running") {
    return <CheckCircle2 size={14} className="text-emerald-400" />;
  }
  if (state === "error") return <AlertTriangle size={14} className="text-rose-400" />;
  return <Loader2 size={14} className="animate-spin text-gray-500" />;
}

function extractMetaString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!meta) return null;
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

function formatUptime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const clientExports: PluginClientExports = {
  components: {
    SandboxStatusPanel: SandboxStatusPanel as PluginClientExports["components"][string],
  },
};

export const components = clientExports.components;
export default clientExports;
