// MicroSandbox plugin — client side.
//
// Two surfaces today:
//   1. SandboxStatusPanel  — minimal liveness panel rendered in the
//                            chat shell's right column (rightPanels).
//   2. MicroSandboxAdminPage — Sandboxfile editor + builds list +
//                              publish / reset, rendered in the
//                              chat shell's `/admin` surface
//                              (adminPages contribution, ADR-0004 §12).
//
// We bundle both into one client entry because manifests carry one
// `client.entry` per plugin. Tree-shaking keeps the panel-only path
// cheap when the admin shell isn't open.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Hammer,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Terminal,
  Trash2,
  UploadCloud,
} from "lucide-react";
import type {
  AdminPageProps,
  PanelProps,
  PluginClientExports,
} from "@tianshu/plugin-sdk/client";

// ─── shared types + helpers ────────────────────────────────────

interface SandboxStatusPayload {
  state: "starting" | "ready" | "running" | "error" | "stopped";
  uptimeMs: number;
  lastError?: string;
  meta?: Record<string, unknown>;
  ready: boolean;
  runner: "microsandbox" | "nullable";
}

interface SandboxfilePayload {
  content: string;
  exists: boolean;
  path: string;
}

interface BuildEntry {
  buildId: string;
  snapshotName: string;
  baseImage: string;
  builtAt: string;
  durationMs: number;
  logTail: string;
  sandboxfilePath: string;
  published: boolean;
}

interface BuildsPayload {
  builds: BuildEntry[];
  published: { snapshotName: string; baseImage: string; publishedAt: string } | null;
}

const ROUTE_BASE = "/api/p/microsandbox";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...init });
  const text = await r.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
  }
  if (!r.ok) {
    const detail =
      (parsed as { error?: string; message?: string } | null)?.message ??
      (parsed as { error?: string } | null)?.error ??
      `HTTP ${r.status}`;
    throw new Error(detail);
  }
  return parsed as T;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
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

function extractMetaString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!meta) return null;
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

// ─── right-panel: SandboxStatusPanel ───────────────────────────

function SandboxStatusPanel(_props: PanelProps) {
  const [status, setStatus] = useState<SandboxStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const r = await fetchJson<SandboxStatusPayload>(`${ROUTE_BASE}/status`);
      setStatus(r);
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
        <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
          For Sandboxfile editing, builds, and publish/reset open the
          <a className="ml-1 text-brand-400 hover:underline" href="/admin/microsandbox/main">
            admin page
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function StatusBody({ status }: { status: SandboxStatusPayload }) {
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
    </div>
  );
}

function StateIcon({ state }: { state: SandboxStatusPayload["state"] }) {
  if (state === "ready" || state === "running") {
    return <CheckCircle2 size={14} className="text-emerald-400" />;
  }
  if (state === "error") return <AlertTriangle size={14} className="text-rose-400" />;
  return <Loader2 size={14} className="animate-spin text-gray-500" />;
}

// ─── admin page: MicroSandboxAdminPage ─────────────────────────

function MicroSandboxAdminPage(_props: AdminPageProps) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-6 text-gray-200">
      <header className="mb-6 border-b border-gray-800 pb-4">
        <h1 className="text-lg font-semibold text-gray-100">MicroSandbox</h1>
        <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
          Edit your Sandboxfile, build a new image, and publish it as
          this tenant's active sandbox. Use the shell to sanity-check
          the running VM (“does my apt package show up on PATH?”)
          before publishing.
        </p>
      </header>

      <SandboxfileSection />
      <div className="my-6 border-t border-gray-800" />
      <BuildsSection />
      <div className="my-6 border-t border-gray-800" />
      <ShellSection />
      <div className="my-6 border-t border-gray-800" />
      <ResetSection />
    </div>
  );
}

function SandboxfileSection() {
  const [payload, setPayload] = useState<SandboxfilePayload | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchJson<SandboxfilePayload>(`${ROUTE_BASE}/sandboxfile`);
      setPayload(r);
      setDraft(r.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = payload != null && draft !== payload.content;

  async function save() {
    setSaving(true);
    setError(null);
    setParseError(null);
    try {
      const r = await fetchJson<{ ok: true; path: string; parseError: string | null }>(
        `${ROUTE_BASE}/sandboxfile`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: draft }),
        },
      );
      setPayload({ content: draft, exists: true, path: r.path });
      setParseError(r.parseError);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <SectionHeader
        title="Sandboxfile"
        description={
          payload?.exists === false
            ? "No Sandboxfile yet. Edit and save to create one."
            : payload?.path
              ? `Saved at ${payload.path}`
              : ""
        }
        actions={
          <>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-gray-400"
              title="Reload from disk"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              Reload
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
            >
              {saving ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Save size={12} />
              )}
              Save
            </button>
          </>
        }
      />

      {error && <Banner kind="error" text={error} />}
      {parseError && (
        <Banner
          kind="warn"
          text={`Saved, but the file does not parse: ${parseError}`}
        />
      )}
      {!error && !parseError && savedAt && Date.now() - savedAt < 4000 && (
        <Banner kind="ok" text="Saved." />
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="mt-2 h-64 w-full resize-y rounded-md border border-gray-800 bg-gray-950 px-3 py-2 font-mono text-[12px] leading-relaxed text-gray-200 outline-none focus:border-blue-700"
        placeholder="image: python:3.12-slim&#10;cpus: 4&#10;memory_mib: 4096"
      />
      <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
        Path: <code className="rounded bg-gray-800 px-1">{payload?.path ?? "…"}</code>.
        v0 grammar: <code className="rounded bg-gray-800 px-1">image:</code>,{" "}
        <code className="rounded bg-gray-800 px-1">cpus:</code>,{" "}
        <code className="rounded bg-gray-800 px-1">memory_mib:</code>, and the lists{" "}
        <code className="rounded bg-gray-800 px-1">apt</code>,{" "}
        <code className="rounded bg-gray-800 px-1">pip</code>,{" "}
        <code className="rounded bg-gray-800 px-1">npm</code>,{" "}
        <code className="rounded bg-gray-800 px-1">exec</code>.
      </p>
    </section>
  );
}

function BuildsSection() {
  const [data, setData] = useState<BuildsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [buildLog, setBuildLog] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchJson<BuildsPayload>(`${ROUTE_BASE}/builds`);
      setData(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function build() {
    setBuilding(true);
    setError(null);
    setBuildLog(null);
    try {
      const r = await fetchJson<{ ok: true; build: BuildEntry }>(
        `${ROUTE_BASE}/builds`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      setBuildLog(r.build.logTail);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  }

  async function publish(buildId: string) {
    setPublishingId(buildId);
    setError(null);
    try {
      await fetchJson(
        `${ROUTE_BASE}/builds/publish?build_id=${encodeURIComponent(buildId)}`,
        { method: "POST" },
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishingId(null);
    }
  }

  return (
    <section>
      <SectionHeader
        title="Builds"
        description={
          data?.published
            ? `Published: ${data.published.snapshotName}`
            : "Nothing published yet — the runner uses the configured default image."
        }
        actions={
          <>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-gray-400"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void build()}
              disabled={building}
              className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
              title="Run apt/pip/npm/exec from your saved Sandboxfile and capture a snapshot"
            >
              {building ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Hammer size={12} />
              )}
              Build
            </button>
          </>
        }
      />

      {error && <Banner kind="error" text={error} />}
      {building && (
        <Banner
          kind="info"
          text="Building… this typically takes 10-30s for a slim base image plus a few apt/pip layers. The request blocks until the snapshot is captured."
        />
      )}
      {buildLog && (
        <details className="mb-3 rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-[11px]">
          <summary className="cursor-pointer text-gray-400">Last build log tail</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-gray-300">
            {buildLog}
          </pre>
        </details>
      )}

      {data && data.builds.length === 0 && !building && (
        <p className="rounded-md border border-dashed border-gray-800 px-3 py-6 text-center text-[12px] text-gray-500">
          No builds yet. Click <strong>Build</strong> to create one from your saved Sandboxfile.
        </p>
      )}

      {data && data.builds.length > 0 && (
        <ul className="space-y-2">
          {data.builds.map((b) => (
            <li
              key={b.buildId}
              className="rounded-md border border-gray-800 bg-gray-900/50 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-100">
                      {b.buildId}
                    </code>
                    {b.published && (
                      <span className="flex items-center gap-1 rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] uppercase text-emerald-300">
                        <CheckCircle2 size={10} /> published
                      </span>
                    )}
                    <span className="text-[11px] text-gray-400">{b.baseImage}</span>
                    <span className="text-[10px] text-gray-600">
                      {(b.durationMs / 1000).toFixed(1)}s · {formatRelative(b.builtAt)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[11px] text-gray-500">
                    snapshot:{" "}
                    <code className="rounded bg-gray-800 px-1 text-gray-400">
                      {b.snapshotName}
                    </code>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void publish(b.buildId)}
                  disabled={publishingId === b.buildId || b.published}
                  className="flex items-center gap-1 rounded-md border border-gray-800 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    b.published
                      ? "Already the active snapshot"
                      : "Make this build the tenant's active sandbox image"
                  }
                >
                  {publishingId === b.buildId ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <UploadCloud size={11} />
                  )}
                  {b.published ? "Active" : "Publish"}
                </button>
              </div>
              {b.logTail && (
                <details className="mt-1.5 text-[11px]">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-400">
                    Log tail
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-950 px-2 py-1 text-[11px] leading-relaxed text-gray-400">
                    {b.logTail}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Shell (live exec inside the running sandbox) ──────────────

interface ExecRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface ShellEntry {
  id: number;
  command: string;
  workdir: string;
  startedAt: number;
  /** null while still running. */
  result: ExecRunResult | null;
  /** Only set when the request itself blew up (network / 500). */
  transportError: string | null;
}

function ShellSection() {
  const [command, setCommand] = useState("");
  const [workdir, setWorkdir] = useState("/workspace");
  const [history, setHistory] = useState<ShellEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const idCounter = useRef(0);

  const recentCommands = history.map((h) => h.command);

  async function run() {
    const cmd = command.trim();
    if (!cmd || running) return;
    const id = ++idCounter.current;
    const wd = workdir.trim() || "/workspace";
    const entry: ShellEntry = {
      id,
      command: cmd,
      workdir: wd,
      startedAt: Date.now(),
      result: null,
      transportError: null,
    };
    setHistory((h) => [...h, entry]);
    setCommand("");
    setHistoryIdx(null);
    setRunning(true);
    try {
      const r = await fetchJson<ExecRunResult>(`${ROUTE_BASE}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, workdir: wd }),
      });
      setHistory((h) =>
        h.map((e) => (e.id === id ? { ...e, result: r } : e)),
      );
    } catch (err) {
      setHistory((h) =>
        h.map((e) =>
          e.id === id
            ? {
                ...e,
                transportError: err instanceof Error ? err.message : String(err),
              }
            : e,
        ),
      );
    } finally {
      setRunning(false);
      // Refocus so the user can type the next command without
      // chasing the cursor.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function clear() {
    setHistory([]);
    idCounter.current = 0;
  }

  function recall(direction: 1 | -1) {
    if (recentCommands.length === 0) return;
    let next: number;
    if (direction === -1) {
      // ↑ — walk backwards through history.
      if (historyIdx === null) {
        next = recentCommands.length - 1;
      } else if (historyIdx === 0) {
        return;
      } else {
        next = historyIdx - 1;
      }
    } else {
      // ↓ — walk forward, exit history at the bottom.
      if (historyIdx === null) return;
      if (historyIdx >= recentCommands.length - 1) {
        setHistoryIdx(null);
        setCommand("");
        return;
      }
      next = historyIdx + 1;
    }
    setHistoryIdx(next);
    setCommand(recentCommands[next] ?? "");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void run();
      return;
    }
    // Recall when the textarea is single-line; multi-line composition
    // (Shift+Enter) keeps native arrow-key navigation.
    const isSingleLine = !command.includes("\n");
    if (e.key === "ArrowUp" && isSingleLine) {
      e.preventDefault();
      recall(-1);
    } else if (e.key === "ArrowDown" && isSingleLine) {
      e.preventDefault();
      recall(1);
    }
  }

  return (
    <section>
      <SectionHeader
        title="Shell"
        description="Run a one-shot command inside the running sandbox. Defaults to bash semantics; equivalent to the agent's exec tool."
        actions={
          <button
            type="button"
            onClick={clear}
            disabled={history.length === 0}
            className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-gray-400 disabled:opacity-50"
            title="Clear command history (does not affect the sandbox)"
          >
            <Trash2 size={12} />
            Clear
          </button>
        }
      />

      {history.length === 0 && (
        <p className="mb-2 rounded-md border border-dashed border-gray-800 px-3 py-3 text-center text-[11px] text-gray-500">
          Try{" "}
          <code className="rounded bg-gray-800 px-1 text-gray-300">ls /workspace</code>
          {" · "}
          <code className="rounded bg-gray-800 px-1 text-gray-300">python3 --version</code>
          {" · "}
          <code className="rounded bg-gray-800 px-1 text-gray-300">which libreoffice</code>
          {"."}
        </p>
      )}

      <div className="mb-2 max-h-[420px] space-y-2 overflow-y-auto">
        {history.map((e) => (
          <ShellEntryView key={e.id} entry={e} />
        ))}
      </div>

      <div className="rounded-md border border-gray-800 bg-gray-950 p-2">
        <div className="mb-1.5 flex items-center gap-2 text-[10px] text-gray-500">
          <Terminal size={11} className="text-emerald-400" />
          <span>workdir:</span>
          <input
            type="text"
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            spellCheck={false}
            className="flex-1 rounded border border-gray-800 bg-gray-900 px-2 py-0.5 font-mono text-[11px] text-gray-200 outline-none focus:border-blue-700"
          />
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              setHistoryIdx(null);
            }}
            onKeyDown={onKeyDown}
            disabled={running}
            spellCheck={false}
            placeholder="echo hello"
            rows={2}
            className="flex-1 resize-y rounded border border-gray-800 bg-gray-900 px-2 py-1 font-mono text-[12px] leading-relaxed text-gray-100 outline-none placeholder:text-gray-600 focus:border-blue-700 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || command.trim().length === 0}
            className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
          >
            {running ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Terminal size={12} />
            )}
            Run
          </button>
        </div>
        <p className="mt-1 text-[10px] text-gray-600">
          Enter to run · Shift+Enter for a newline · ↑/↓ to walk
          history. Per-call timeout 60s (max 5 min); this surface is
          for sanity checks, not long-running jobs.
        </p>
      </div>
    </section>
  );
}

function ShellEntryView({ entry }: { entry: ShellEntry }) {
  const { result, transportError } = entry;
  const running = result === null && transportError === null;
  const ok = result?.ok === true;
  const failed = (result && !result.ok) || transportError != null;

  return (
    <div className="rounded-md border border-gray-800 bg-gray-900/50 px-3 py-2 font-mono text-[11px] leading-relaxed">
      <div className="mb-1 flex items-center gap-2">
        {running ? (
          <Loader2 size={11} className="animate-spin text-gray-400" />
        ) : ok ? (
          <CheckCircle2 size={11} className="text-emerald-400" />
        ) : (
          <AlertTriangle size={11} className="text-rose-400" />
        )}
        <code className="flex-1 break-all text-gray-200">{entry.command}</code>
        <span className="text-[9px] text-gray-600">cwd:{entry.workdir}</span>
        {result && (
          <span
            className={
              ok
                ? "rounded bg-emerald-900/40 px-1.5 py-0.5 text-[9px] text-emerald-300"
                : "rounded bg-rose-900/40 px-1.5 py-0.5 text-[9px] text-rose-300"
            }
          >
            exit {result.exitCode}
            {result.timedOut && " · timed out"}
            {" · "}
            {(result.durationMs / 1000).toFixed(2)}s
          </span>
        )}
      </div>
      {transportError && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-rose-950/40 px-2 py-1 text-[11px] text-rose-200">
          {transportError}
        </pre>
      )}
      {result && (result.stdout || result.stderr) && (
        <div className="space-y-1">
          {result.stdout && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-gray-950 px-2 py-1 text-[11px] text-gray-200">
              {result.stdout}
            </pre>
          )}
          {result.stderr && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200">
              {result.stderr}
            </pre>
          )}
        </div>
      )}
      {result && !result.stdout && !result.stderr && !failed && (
        <p className="text-[10px] italic text-gray-500">(no output)</p>
      )}
    </div>
  );
}

function ResetSection() {
  const [resetting, setResetting] = useState(false);
  const [status, setStatus] = useState<SandboxStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetchJson<SandboxStatusPayload>(`${ROUTE_BASE}/status`);
      setStatus(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function reset() {
    setResetting(true);
    setError(null);
    try {
      const r = await fetchJson<{ ok: true; status: SandboxStatusPayload }>(
        `${ROUTE_BASE}/reset`,
        { method: "POST" },
      );
      setStatus(r.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  }

  return (
    <section>
      <SectionHeader
        title="Live sandbox"
        description="Reset the running VM. After publishing a new build, reset to make it live."
        actions={
          <>
            <button
              type="button"
              onClick={() => void loadStatus()}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-gray-400"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void reset()}
              disabled={resetting}
              className="flex items-center gap-1.5 rounded-md border border-rose-700/60 bg-rose-950/40 px-3 py-1.5 text-[11px] font-medium text-rose-200 hover:bg-rose-900/40 disabled:cursor-not-allowed disabled:opacity-50"
              title="Stop and rebuild the VM from the published snapshot (or default image)"
            >
              {resetting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RotateCcw size={12} />
              )}
              Reset sandbox
            </button>
          </>
        }
      />

      {error && <Banner kind="error" text={error} />}
      {status && (
        <dl className="grid grid-cols-3 gap-x-4 gap-y-1.5 rounded-md border border-gray-800 bg-gray-900/40 p-3 text-[11px]">
          <Field label="State">
            {status.runner === "nullable" ? "not running" : status.state}
          </Field>
          <Field label="Runner">{status.runner}</Field>
          <Field label="Uptime">{formatUptime(status.uptimeMs)}</Field>
          {extractMetaString(status.meta, "sandboxName") && (
            <Field label="Sandbox">
              <code className="rounded bg-gray-800 px-1">
                {extractMetaString(status.meta, "sandboxName")}
              </code>
            </Field>
          )}
          {extractMetaString(status.meta, "image") && (
            <Field label="Image">
              <code className="rounded bg-gray-800 px-1">
                {extractMetaString(status.meta, "image")}
              </code>
            </Field>
          )}
          {status.lastError && (
            <Field label="Last error">
              <span className="text-rose-300">{status.lastError}</span>
            </Field>
          )}
        </dl>
      )}
    </section>
  );
}

// ─── shared layout helpers ─────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="col-span-1 text-gray-500">{label}</dt>
      <dd className="col-span-2 text-gray-300">{children}</dd>
    </>
  );
}

function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
        {description && (
          <p className="mt-0.5 text-[11px] text-gray-500">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}

function Banner({
  kind,
  text,
}: {
  kind: "ok" | "warn" | "error" | "info";
  text: string;
}) {
  const cls =
    kind === "ok"
      ? "border-emerald-700/40 bg-emerald-950/40 text-emerald-300"
      : kind === "warn"
        ? "border-amber-700/40 bg-amber-950/40 text-amber-200"
        : kind === "error"
          ? "border-rose-700/50 bg-rose-950/40 text-rose-300"
          : "border-blue-700/40 bg-blue-950/40 text-blue-200";
  const Icon =
    kind === "ok"
      ? CheckCircle2
      : kind === "info"
        ? Loader2
        : AlertTriangle;
  return (
    <div className={`mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] ${cls}`}>
      <Icon
        size={12}
        className={kind === "info" ? "mt-0.5 animate-spin" : "mt-0.5 flex-shrink-0"}
      />
      <span className="break-words">{text}</span>
    </div>
  );
}

// ─── exports ───────────────────────────────────────────────────

const clientExports: PluginClientExports = {
  components: {
    SandboxStatusPanel: SandboxStatusPanel as PluginClientExports["components"][string],
    MicroSandboxAdminPage:
      MicroSandboxAdminPage as PluginClientExports["components"][string],
  },
};

export const components = clientExports.components;
export default clientExports;
