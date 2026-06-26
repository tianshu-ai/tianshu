// MicroSandbox plugin — client side.
//
// Surfaces:
//   - MicroSandboxAdminPage  — Sandboxfile editor + builds list +
//                              use / reset, rendered in the chat
//                              shell's `/admin` surface
//                              (adminPages contribution, ADR-0004 §12).
//   - BrowserViewportPanel   — noVNC iframe inlined in the chat
//                              shell's right column so the user can
//                              watch the agent drive the browser
//                              without leaving the conversation.
//
// (We used to ship two more surfaces: a SandboxStatusPanel right-
// column widget and a separate BrowserAdminPage. Both went away —
// the Sandbox admin page covers status, and the chat-shell
// BrowserViewportPanel is the only place the live VNC view needs
// to live; admin Browser would have been a third copy of the same
// iframe.)
//
// We bundle every component into one client entry because manifests
// carry one `client.entry` per plugin. Tree-shaking keeps the
// admin-only paths cheap when the chat shell is the only thing open.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Globe,
  Hammer,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Terminal,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import type {
  AdminPageProps,
  PanelProps,
  PluginClientExports,
} from "@tianshu-ai/plugin-sdk/client";
import { PluginConfigForm } from "@tianshu-ai/plugin-sdk/client";

// ─── shared types + helpers ────────────────────────────────────

interface SandboxStatusPayload {
  state: "starting" | "ready" | "running" | "error" | "stopped";
  uptimeMs: number;
  lastError?: string;
  meta?: Record<string, unknown>;
  ready: boolean;
  runner: "microsandbox" | "nullable";
  /** Snapshot of /proc/meminfo from inside the live VM. Probed
   *  by the host's status route (only when state==="ready"), so
   *  null on a stopped or starting sandbox. */
  liveMemory: {
    totalKb: number;
    availableKb: number;
    usedKb: number;
  } | null;
}

// Mirrors `BrowserStatusPayload` from
// plugins/microsandbox/src/admin/browser-routes.ts. Duplicated here
// because the client bundle can't pull from the server's TS source
// directly; if we add a third surface that needs this we'll factor
// it out into a shared shapes module.
interface BrowserStatusPayload {
  ready: boolean;
  ports: { cdp: number | null; mcp: number | null; vnc: number | null };
  lastViewport: { width: number; height: number } | null;
  hint?: string;
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
  /** Legacy field == roles.browser, kept for back-compat. */
  published: boolean;
  /** Optional because an older server build may still respond with
   *  the pre-roles shape; we fall back to `published` (= browser
   *  role) below when this is missing. */
  roles?: { browser: boolean; task: boolean };
  /** When set, this build layered on top of an existing snapshot
   *  rather than pulling its Sandboxfile's image: from the
   *  registry. UI uses it to render a parent-build chain. */
  basedOnSnapshot?: string;
}

interface PointerEntry {
  snapshotName: string;
  baseImage: string;
  publishedAt: string;
}

interface BuildsPayload {
  builds: BuildEntry[];
  /** Legacy single pointer (== pointers.browser). Kept on the wire
   *  for older clients; new code reads `pointers`. */
  published: PointerEntry | null;
  pointers: { browser: PointerEntry | null; task: PointerEntry | null };
}

type SandboxRole = "browser" | "task";

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

/** Render kB values from /proc/meminfo as a compact human
 *  string ("1.2 GiB" / "864 MiB"). meminfo's "kB" is actually
 *  KiB (1024-based) so we use 1024 throughout. */
function formatKb(kb: number): string {
  if (!Number.isFinite(kb) || kb < 0) return "—";
  if (kb < 1024) return `${kb} KiB`;
  const mib = kb / 1024;
  if (mib < 1024) return `${Math.round(mib)} MiB`;
  const gib = mib / 1024;
  // 0.1 GiB precision; "1.2 GiB" is more readable than "1234 MiB".
  return `${gib.toFixed(1)} GiB`;
}

function extractMetaString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!meta) return null;
  const v = meta[key];
  return typeof v === "string" ? v : null;
}


function MicroSandboxAdminPage(_props: AdminPageProps) {
  // Bumping this counter signals "something changed in the sandbox
  // lifecycle; sections that fetch derived state should re-fetch."
  // BuildsSection bumps it after switching the in-use build
  // (with or without reset). ResetSection listens and re-fetches
  // status whenever it changes.
  const [refreshTick, setRefreshTick] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 text-fg-default">
      <header className="mb-6 border-b border-border-subtle pb-4">
        <h1 className="text-lg font-semibold text-fg-default">MicroSandbox</h1>
        <p className="mt-1 text-[12px] leading-relaxed text-fg-faint">
          Edit your Sandboxfile, build a new image, and switch this
          tenant to use it. Sanity-check a fresh build via the shell's
          preview target (“does my apt package show up on PATH?”)
          before flipping the tenant to it.
        </p>
      </header>

      <SandboxfileSection />
      <div className="my-6 border-t border-border-subtle" />
      <BuildsSection onMutate={bumpRefresh} />
      <div className="my-6 border-t border-border-subtle" />
      <TaskPoolSection refreshTick={refreshTick} />
      <div className="my-6 border-t border-border-subtle" />
      <ShellSection />
      <div className="my-6 border-t border-border-subtle" />
      <ResetSection refreshTick={refreshTick} onMutate={bumpRefresh} />
    </div>
  );
}

interface SandboxfileTemplate {
  id: string;
  displayName: string;
  description: string;
  content: string;
}

function SandboxfileSection() {
  const [payload, setPayload] = useState<SandboxfilePayload | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [templates, setTemplates] = useState<SandboxfileTemplate[]>([]);

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

  // Templates are server-static; fetch once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchJson<{ templates: SandboxfileTemplate[] }>(
          `${ROUTE_BASE}/sandboxfile/templates`,
        );
        if (!cancelled) setTemplates(r.templates);
      } catch {
        // Non-fatal: leave the dropdown empty so users can still
        // author from scratch.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = payload != null && draft !== payload.content;

  function loadTemplate(id: string) {
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (
      payload &&
      draft !== payload.content &&
      !window.confirm(
        `You have unsaved changes. Replace the editor with the "${t.displayName}" template?`,
      )
    ) {
      return;
    }
    setDraft(t.content);
  }

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
            {templates.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  loadTemplate(e.target.value);
                  e.target.value = "";
                }}
                className="rounded-md border border-border-subtle bg-bg-elevated px-2 py-1 text-[11px] text-fg-muted hover:border-border-default focus:border-blue-700 focus:outline-none"
                title="Replace the editor contents with a starting template"
              >
                <option value="">Load template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id} title={t.description}>
                    {t.displayName}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-muted"
              title="Reload from disk"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              Reload
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-faint"
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
        className="mt-2 h-64 w-full resize-y rounded-md border border-border-subtle bg-bg-base px-3 py-2 font-mono text-[12px] leading-relaxed text-fg-default outline-none focus:border-blue-700"
        placeholder="image: python:3.12-slim&#10;cpus: 4&#10;memory_mib: 4096"
      />
      <p className="mt-2 text-[11px] leading-relaxed text-fg-faint">
        Path: <code className="rounded bg-bg-raised px-1">{payload?.path ?? "…"}</code>.
        v0 grammar: <code className="rounded bg-bg-raised px-1">image:</code>,{" "}
        <code className="rounded bg-bg-raised px-1">cpus:</code>,{" "}
        <code className="rounded bg-bg-raised px-1">memory_mib:</code>, and the lists{" "}
        <code className="rounded bg-bg-raised px-1">apt</code>,{" "}
        <code className="rounded bg-bg-raised px-1">pip</code>,{" "}
        <code className="rounded bg-bg-raised px-1">npm</code>,{" "}
        <code className="rounded bg-bg-raised px-1">exec</code>.
      </p>
    </section>
  );
}

function BuildsSection({ onMutate }: { onMutate: () => void }) {
  const [data, setData] = useState<BuildsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [usingId, setUsingId] = useState<string | null>(null);
  /** When set, the next build will layer on top of this snapshot
   *  instead of pulling the Sandboxfile's `image:`. UI surfaces
   *  the picker as a dropdown next to the Build button. */
  const [basedOnSnapshot, setBasedOnSnapshot] = useState<string>("");
  /** Live log lines for the in-progress build (or the most recent
   *  one if it just finished). Cleared when a new build starts. */
  const [buildLog, setBuildLog] = useState<string[]>([]);
  /** When set, the current build is in the start → done/error window. */
  const [buildStartedAt, setBuildStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const logRef = useRef<HTMLPreElement | null>(null);

  // Tick the elapsed counter so the spinner doesn't feel frozen even
  // when the SDK goes quiet for many seconds (e.g. while it pulls a
  // base image).
  useEffect(() => {
    if (buildStartedAt === null) return;
    const i = window.setInterval(
      () => setElapsedMs(Date.now() - buildStartedAt),
      250,
    );
    return () => window.clearInterval(i);
  }, [buildStartedAt]);

  // Auto-scroll the log pane on every new line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buildLog]);

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
    setBuildLog([]);
    setBuildStartedAt(Date.now());
    setElapsedMs(0);
    try {
      const params = new URLSearchParams({ stream: "1" });
      if (basedOnSnapshot) params.set("from_snapshot", basedOnSnapshot);
      const r = await fetch(`${ROUTE_BASE}/builds?${params.toString()}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!r.ok || !r.body) {
        throw new Error(
          `build request failed: HTTP ${r.status}${r.statusText ? " " + r.statusText : ""}`,
        );
      }
      // Read NDJSON: one JSON object per "\n"-terminated line.
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finalError: string | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        // eslint-disable-next-line no-cond-assign
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          let evt: { type: string; [k: string]: unknown };
          try {
            evt = JSON.parse(raw);
          } catch {
            // Treat malformed lines as raw log so we don't lose them.
            setBuildLog((prev) => [...prev, raw]);
            continue;
          }
          if (evt.type === "log" && typeof evt.line === "string") {
            const line = evt.line;
            setBuildLog((prev) => [...prev, line]);
          } else if (evt.type === "start") {
            setBuildLog((prev) => [
              ...prev,
              `[stream] build ${String(evt.buildId ?? "?")} started (image=${String(evt.image ?? "?")})`,
            ]);
          } else if (evt.type === "done") {
            // The list reload below will surface the new entry; we
            // don't need to do anything else here.
          } else if (evt.type === "error") {
            finalError = String(evt.message ?? "build failed");
            const stderr =
              typeof evt.stderr === "string" && evt.stderr.length > 0
                ? `\n${evt.stderr}`
                : "";
            setBuildLog((prev) => [...prev, `[error] ${finalError}${stderr}`]);
          }
        }
      }
      // Drain any trailing partial line.
      const tail = buf.trim();
      if (tail) {
        try {
          const evt = JSON.parse(tail);
          if (evt.type === "log" && typeof evt.line === "string") {
            setBuildLog((prev) => [...prev, evt.line]);
          }
        } catch {
          /* swallow */
        }
      }
      if (finalError) {
        setError(finalError);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
      setBuildStartedAt(null);
    }
  }

  /**
   * Pin a build to a role.
   *
   * @param role  "browser" updates the live long-lived sandbox pointer
   *              (resets the VM when `reset=true`); "task" updates the
   *              per-task pool pointer (no live VM today, so reset is
   *              ignored on the wire); "both" matches the legacy
   *              behaviour where one snapshot served everything.
   */
  async function useBuild(
    buildId: string,
    role: SandboxRole | "both",
    reset: boolean,
  ) {
    setUsingId(buildId);
    setError(null);
    try {
      const params = new URLSearchParams({ build_id: buildId, role });
      if (reset) params.set("reset", "1");
      const url = `${ROUTE_BASE}/builds/use?${params.toString()}`;
      const r = await fetchJson<{
        ok: true;
        reset: "skipped" | "ok" | { failed: string };
      }>(url, { method: "POST" });
      if (
        reset &&
        typeof r.reset === "object" &&
        r.reset !== null &&
        "failed" in r.reset
      ) {
        setError(`Switched, but reset failed: ${r.reset.failed}`);
      }
      await load();
      // Tell sibling sections (Live sandbox status panel) the
      // sandbox lifecycle changed so they can re-fetch.
      onMutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUsingId(null);
    }
  }

  return (
    <section>
      <SectionHeader
        title="Builds"
        description={(() => {
          const b = data?.pointers?.browser;
          const t = data?.pointers?.task;
          if (!b && !t) {
            return "No build selected — the runner uses the configured default image.";
          }
          if (b && t && b.snapshotName === t.snapshotName) {
            return `In use (Browser + Task): ${b.snapshotName}`;
          }
          const parts: string[] = [];
          if (b) parts.push(`Browser: ${b.snapshotName}`);
          if (t) parts.push(`Task: ${t.snapshotName}`);
          return parts.join(" · ");
        })()}
        actions={
          <>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-muted"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
            <select
              value={basedOnSnapshot}
              onChange={(e) => setBasedOnSnapshot(e.target.value)}
              disabled={building}
              className="rounded border border-border-default bg-bg-elevated px-2 py-1 text-[11px] text-fg-default disabled:cursor-not-allowed disabled:opacity-50"
              title="Optional: layer this build on top of an existing snapshot. Leave as 'fresh image' to use the Sandboxfile's image: line."
            >
              <option value="">based on: fresh image</option>
              {(data?.builds ?? []).map((b) => (
                <option key={b.snapshotName} value={b.snapshotName}>
                  based on: {b.buildId}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void build()}
              disabled={building}
              className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-faint"
              title={
                basedOnSnapshot
                  ? `Build on top of ${basedOnSnapshot}`
                  : "Run apt/pip/npm/exec from your saved Sandboxfile and capture a snapshot"
              }
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
      {building && buildLog.length === 0 && (
        <Banner
          kind="info"
          text={
            "Building… this typically takes 10-30s for a slim base image plus a few apt/pip layers. " +
            (elapsedMs > 0
              ? `(${(elapsedMs / 1000).toFixed(0)}s elapsed)`
              : "")
          }
        />
      )}
      {(building || buildLog.length > 0) && (
        <div className="mb-3 overflow-hidden rounded-md border border-border-subtle bg-bg-base">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5">
            <div className="flex items-center gap-2 text-[11px] text-fg-muted">
              {building ? (
                <Loader2 size={11} className="animate-spin text-success" />
              ) : (
                <CheckCircle2 size={11} className="text-success" />
              )}
              <span>
                {building ? "Build in progress" : "Last build log"}
              </span>
              {building && elapsedMs > 0 && (
                <span className="text-[10px] text-fg-faint">
                  {(elapsedMs / 1000).toFixed(0)}s
                </span>
              )}
              <span className="text-[10px] text-fg-fainter">
                {buildLog.length} line{buildLog.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <pre
            ref={logRef}
            className="max-h-72 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-muted"
          >
            {buildLog.length > 0
              ? buildLog.join("\n")
              : "… waiting for first log line …"}
          </pre>
        </div>
      )}

      {data && data.builds.length === 0 && !building && (
        <p className="rounded-md border border-dashed border-border-subtle px-3 py-6 text-center text-[12px] text-fg-faint">
          No builds yet. Click <strong>Build</strong> to create one from your saved Sandboxfile.
        </p>
      )}

      {data && data.builds.length > 0 && (
        <ul className="space-y-2">
          {data.builds.map((b) => (
            <li
              key={b.buildId}
              className="rounded-md border border-border-subtle bg-bg-elevated/50 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-bg-raised px-1.5 py-0.5 text-[11px] text-fg-default">
                      {b.buildId}
                    </code>
                    {(b.roles?.browser ?? b.published) && (
                      <span className="flex items-center gap-1 rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] uppercase text-success">
                        <CheckCircle2 size={10} /> Browser
                      </span>
                    )}
                    {b.roles?.task && (
                      <span className="flex items-center gap-1 rounded bg-sky-900/40 px-1.5 py-0.5 text-[10px] uppercase text-sky-300">
                        <CheckCircle2 size={10} /> Task
                      </span>
                    )}
                    <span className="text-[11px] text-fg-muted" title={b.basedOnSnapshot ? `layered on snapshot ${b.basedOnSnapshot}` : `image: ${b.baseImage}`}>{b.basedOnSnapshot ? `↳ ${b.basedOnSnapshot.split('-build-').pop() ?? b.basedOnSnapshot}` : b.baseImage}</span>
                    <span className="text-[10px] text-fg-fainter">
                      {(b.durationMs / 1000).toFixed(1)}s · {formatRelative(b.builtAt)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[11px] text-fg-faint">
                    snapshot:{" "}
                    <code className="rounded bg-bg-raised px-1 text-fg-muted">
                      {b.snapshotName}
                    </code>
                  </p>
                </div>
                {(() => {
                  // Defensive read: an older server (pre-roles) only
                  // sends `b.published` for the browser role and no
                  // task field at all. Fall back so the UI keeps
                  // rendering during a partial deploy.
                  const browserActive = b.roles?.browser ?? b.published;
                  const taskActive = b.roles?.task ?? false;
                  return (
                    <div className="flex flex-shrink-0 flex-col items-stretch gap-1">
                      {/* Browser-role row: pin + optional reset of live VM */}
                      <div className="flex items-stretch gap-px overflow-hidden rounded-md border border-border-subtle">
                        <button
                          type="button"
                          onClick={() => void useBuild(b.buildId, "browser", false)}
                          disabled={usingId === b.buildId || browserActive}
                          className="flex items-center gap-1 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-900/30 disabled:cursor-not-allowed disabled:opacity-40"
                          title={
                            browserActive
                              ? "This build is already the active Browser snapshot."
                              : "Pin this build as the long-lived Browser sandbox snapshot. The live VM keeps running its current snapshot until you reset."
                          }
                        >
                          {usingId === b.buildId ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <UploadCloud size={11} />
                          )}
                          {browserActive ? "Browser \u2713" : "Use as Browser"}
                        </button>
                        {!browserActive && (
                          <button
                            type="button"
                            onClick={() => void useBuild(b.buildId, "browser", true)}
                            disabled={usingId === b.buildId}
                            className="flex items-center gap-1 border-l border-border-subtle px-2 py-1 text-[11px] text-success hover:bg-emerald-900/30 disabled:cursor-not-allowed disabled:opacity-40"
                            title="Pin as Browser + reset the live VM so the new snapshot takes effect immediately. Adds ~10-20s for the reset."
                          >
                            <RotateCcw size={11} />
                            &amp; Reset
                          </button>
                        )}
                      </div>
                      {/* Task-role row: separate pointer; no live VM to reset today. */}
                      <button
                        type="button"
                        onClick={() => void useBuild(b.buildId, "task", false)}
                        disabled={usingId === b.buildId || taskActive}
                        className="flex items-center justify-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-900/30 disabled:cursor-not-allowed disabled:opacity-40"
                        title={
                          taskActive
                            ? "This build is already the active Task snapshot."
                            : "Pin this build as the per-task sandbox snapshot. Future per-task sandboxes will boot from it; takes effect on the next task acquire."
                        }
                      >
                        {usingId === b.buildId ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <UploadCloud size={11} />
                        )}
                        {taskActive ? "Task \u2713" : "Use as Task"}
                      </button>
                    </div>
                  );
                })()}
              </div>
              {b.logTail && (
                <details className="mt-1.5 text-[11px]">
                  <summary className="cursor-pointer text-fg-faint hover:text-fg-muted">
                    Log tail
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-bg-base px-2 py-1 text-[11px] leading-relaxed text-fg-muted">
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
  target?: { kind: "live" } | { kind: "build"; buildId: string; snapshotName: string };
}

interface ShellEntry {
  id: number;
  command: string;
  workdir: string;
  /** "live" or a buildId; mirrors what we sent on the wire. */
  target: string;
  startedAt: number;
  /** null while still running. */
  result: ExecRunResult | null;
  /** Only set when the request itself blew up (network / 500). */
  transportError: string | null;
}

function ShellSection() {
  const [command, setCommand] = useState("");
  const [workdir, setWorkdir] = useState("/workspace");
  const [target, setTarget] = useState<string>("live");
  const [history, setHistory] = useState<ShellEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [builds, setBuilds] = useState<BuildEntry[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const idCounter = useRef(0);
  /** AbortController for the in-flight /exec request; lets the user
   *  bail out of a hanging command without waiting for the server
   *  timeout. */
  const abortRef = useRef<AbortController | null>(null);

  const recentCommands = history.map((h) => h.command);

  // Pull the build list (newest first) so the user can pick a target.
  // We re-fetch on focus to pick up freshly-built snapshots without
  // a full page reload.
  const loadBuilds = useCallback(async () => {
    try {
      const r = await fetchJson<BuildsPayload>(`${ROUTE_BASE}/builds`);
      setBuilds(r.builds);
    } catch {
      /* non-fatal: just leave the dropdown without build entries */
    }
  }, []);
  useEffect(() => {
    void loadBuilds();
  }, [loadBuilds]);

  async function run() {
    const cmd = command.trim();
    if (!cmd || running) return;
    const id = ++idCounter.current;
    const wd = workdir.trim() || "/workspace";
    const targetSnapshot = target;
    const entry: ShellEntry = {
      id,
      command: cmd,
      workdir: wd,
      target: targetSnapshot,
      startedAt: Date.now(),
      result: null,
      transportError: null,
    };
    setHistory((h) => [...h, entry]);
    setCommand("");
    setHistoryIdx(null);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const payload: Record<string, unknown> = { command: cmd, workdir: wd };
      if (targetSnapshot !== "live") {
        payload.build_id = targetSnapshot;
      }
      const r = await fetchJson<ExecRunResult>(`${ROUTE_BASE}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      setHistory((h) =>
        h.map((e) => (e.id === id ? { ...e, result: r } : e)),
      );
    } catch (err) {
      const aborted =
        err instanceof DOMException && err.name === "AbortError";
      const message = aborted
        ? "Cancelled by user. The server-side timeout (60s default) will eventually tear the preview VM down."
        : err instanceof Error
          ? err.message
          : String(err);
      setHistory((h) =>
        h.map((e) =>
          e.id === id ? { ...e, transportError: message } : e,
        ),
      );
    } finally {
      setRunning(false);
      abortRef.current = null;
      // Refocus so the user can type the next command without
      // chasing the cursor.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function cancel() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
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

  const targetLabel =
    target === "live"
      ? "Live sandbox"
      : `Preview build ${target}`;

  return (
    <section>
      <SectionHeader
        title="Shell"
        description={
          target === "live"
            ? "Run a one-shot command inside the running sandbox. Defaults to bash semantics; equivalent to the agent's exec tool."
            : "Boot a throwaway VM from the selected build's snapshot, run the command, then tear it down. Lets you sanity-check a build before switching the tenant to it. The live sandbox is not touched."
        }
        actions={
          <>
            <button
              type="button"
              onClick={() => void loadBuilds()}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-muted"
              title="Refresh build list"
            >
              <RefreshCw size={11} />
              Reload builds
            </button>
            <button
              type="button"
              onClick={clear}
              disabled={history.length === 0}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-muted disabled:opacity-50"
              title="Clear command history (does not affect the sandbox)"
            >
              <Trash2 size={12} />
              Clear
            </button>
          </>
        }
      />

      {history.length === 0 && (
        <p className="mb-2 rounded-md border border-dashed border-border-subtle px-3 py-3 text-center text-[11px] text-fg-faint">
          Try{" "}
          <code className="rounded bg-bg-raised px-1 text-fg-muted">ls /workspace</code>
          {" · "}
          <code className="rounded bg-bg-raised px-1 text-fg-muted">python3 --version</code>
          {" · "}
          <code className="rounded bg-bg-raised px-1 text-fg-muted">which libreoffice</code>
          {"."}
        </p>
      )}

      <div className="mb-2 max-h-[420px] space-y-2 overflow-y-auto">
        {history.map((e) => (
          <ShellEntryView key={e.id} entry={e} />
        ))}
      </div>

      <div className="rounded-md border border-border-subtle bg-bg-base p-2">
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px] text-fg-faint">
          <span>target:</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={`rounded border px-2 py-0.5 font-mono text-[11px] text-fg-default outline-none focus:border-blue-700 ${
              target === "live"
                ? "border-emerald-700/40 bg-bg-elevated"
                : "border-amber-700/40 bg-amber-950/30"
            }`}
            title="Run against the live sandbox or boot a throwaway preview VM from a build"
          >
            <option value="live">Live sandbox</option>
            {builds.length > 0 && (
              <optgroup label="Preview build…">
                {builds.map((b) => (
                  <option key={b.buildId} value={b.buildId}>
                    {b.buildId} · {b.baseImage}
                    {b.published ? " (in use)" : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <span className="text-fg-fainter">·</span>
          <span>workdir:</span>
          <input
            type="text"
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            spellCheck={false}
            className="flex-1 rounded border border-border-subtle bg-bg-elevated px-2 py-0.5 font-mono text-[11px] text-fg-default outline-none focus:border-blue-700"
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
            className="flex-1 resize-y rounded border border-border-subtle bg-bg-elevated px-2 py-1 font-mono text-[12px] leading-relaxed text-fg-default outline-none placeholder:text-fg-fainter focus:border-blue-700 disabled:opacity-60"
          />
          {running ? (
            <button
              type="button"
              onClick={cancel}
              className="flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-rose-500"
              title="Abort the in-flight request. The preview VM is also torn down server-side after a server-enforced timeout (60s default)."
            >
              <X size={12} />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={command.trim().length === 0}
              className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-faint"
            >
              <Terminal size={12} />
              Run
            </button>
          )}
        </div>
        <p className="mt-1 text-[10px] text-fg-fainter">
          Target: <strong className="text-fg-muted">{targetLabel}</strong>{" · "}
          Enter to run · Shift+Enter for a newline · ↑/↓ to walk
          history. Per-call timeout 60s (max 5 min). Preview boots add
          ~5-10s on top of the command time.
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
    <div className="rounded-md border border-border-subtle bg-bg-elevated/50 px-3 py-2 font-mono text-[11px] leading-relaxed">
      <div className="mb-1 flex items-center gap-2">
        {running ? (
          <Loader2 size={11} className="animate-spin text-fg-muted" />
        ) : ok ? (
          <CheckCircle2 size={11} className="text-success" />
        ) : (
          <AlertTriangle size={11} className="text-danger" />
        )}
        <code className="flex-1 break-all text-fg-default">{entry.command}</code>
        <span
          className={`rounded px-1 py-0.5 text-[9px] uppercase tracking-wide ${
            entry.target === "live"
              ? "bg-emerald-900/40 text-success"
              : "bg-amber-900/40 text-warning"
          }`}
          title={
            entry.target === "live"
              ? "Ran against the tenant's live sandbox"
              : `Ran against build ${entry.target}'s snapshot in a throwaway preview VM`
          }
        >
          {entry.target === "live" ? "live" : `preview ${entry.target}`}
        </span>
        <span className="text-[9px] text-fg-fainter">cwd:{entry.workdir}</span>
        {result && (
          <span
            className={
              ok
                ? "rounded bg-emerald-900/40 px-1.5 py-0.5 text-[9px] text-success"
                : "rounded bg-rose-900/40 px-1.5 py-0.5 text-[9px] text-danger"
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
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-rose-950/40 px-2 py-1 text-[11px] text-danger">
          {transportError}
        </pre>
      )}
      {result && (result.stdout || result.stderr) && (
        <div className="space-y-1">
          {result.stdout && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-bg-base px-2 py-1 text-[11px] text-fg-default">
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
        <p className="text-[10px] italic text-fg-faint">(no output)</p>
      )}
    </div>
  );
}

function ResetSection({
  refreshTick,
  onMutate,
}: {
  refreshTick: number;
  onMutate: () => void;
}) {
  const [resetting, setResetting] = useState(false);
  const [status, setStatus] = useState<SandboxStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

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

  // Re-fetch status whenever a sibling section signals the sandbox
  // lifecycle changed (e.g. publish + reset, or a build was deleted).
  // Skip on the initial render because loadStatus already ran above.
  const firstTick = useRef(refreshTick);
  useEffect(() => {
    if (refreshTick === firstTick.current) return;
    void loadStatus();
  }, [refreshTick, loadStatus]);

  // Live ticker: poll status while the VM is in a transient state
  // (starting / stopping). Stops once we see a steady state so we
  // don't hammer the runner forever.
  useEffect(() => {
    if (!status) return;
    const transient =
      status.state === "starting" || status.state === "stopped";
    if (!transient) return;
    const id = window.setInterval(() => void loadStatus(), 2000);
    return () => window.clearInterval(id);
  }, [status, loadStatus]);

  async function reset() {
    setResetting(true);
    setError(null);
    try {
      const r = await fetchJson<{ ok: true; status: SandboxStatusPayload }>(
        `${ROUTE_BASE}/reset`,
        { method: "POST" },
      );
      setStatus(r.status);
      // Reset returns immediately after the runner promises to
      // restart, but the VM may still be transitioning through
      // “starting”. The transient-state ticker above will follow it
      // until it settles on “ready”.
      onMutate();
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
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-muted"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setConfigOpen(true)}
              className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-muted"
              title="Edit cpu / memory / timeout for both Browser and Task sandboxes"
            >
              <Settings size={12} />
              Configure
            </button>
            <button
              type="button"
              onClick={() => void reset()}
              disabled={resetting}
              className="flex items-center gap-1.5 rounded-md border border-rose-700/60 bg-rose-950/40 px-3 py-1.5 text-[11px] font-medium text-danger hover:bg-rose-900/40 disabled:cursor-not-allowed disabled:opacity-50"
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
      <div className="rounded-md border border-border-subtle bg-bg-elevated/40">
        {status && (
        <dl className="grid grid-cols-3 gap-x-4 gap-y-1.5 p-3 text-[11px]">
          <Field label="State">
            {status.runner === "nullable" ? "not running" : status.state}
          </Field>
          <Field label="Runner">{status.runner}</Field>
          <Field label="Uptime">{formatUptime(status.uptimeMs)}</Field>
          {extractMetaString(status.meta, "sandboxName") && (
            <Field label="Sandbox">
              <code className="rounded bg-bg-raised px-1">
                {extractMetaString(status.meta, "sandboxName")}
              </code>
            </Field>
          )}
          {extractMetaString(status.meta, "activeSnapshot") ? (
            <Field label="Booted from">
              <code className="rounded bg-emerald-900/40 px-1 text-emerald-200">
                snapshot · {extractMetaString(status.meta, "activeSnapshot")}
              </code>
            </Field>
          ) : extractMetaString(status.meta, "image") ? (
            <Field label="Booted from">
              <code className="rounded bg-bg-raised px-1">
                image · {extractMetaString(status.meta, "image")}
              </code>
            </Field>
          ) : null}
          {extractMetaString(status.meta, "image") &&
            extractMetaString(status.meta, "activeSnapshot") && (
              <Field label="Default image">
                <code className="rounded bg-bg-raised px-1 text-fg-muted">
                  {extractMetaString(status.meta, "image")}
                </code>
              </Field>
            )}
          {status.liveMemory && (
            <Field label="Memory">
              <span title={`${formatKb(status.liveMemory.usedKb)} used · ${formatKb(status.liveMemory.availableKb)} available · ${formatKb(status.liveMemory.totalKb)} total`}>
                {formatKb(status.liveMemory.usedKb)}
                <span className="text-fg-faint">
                  {" / "}
                  {formatKb(status.liveMemory.totalKb)} ({" "}
                  {Math.round((status.liveMemory.usedKb / status.liveMemory.totalKb) * 100)}
                  %)
                </span>
              </span>
            </Field>
          )}
          {status.lastError && (
            <Field label="Last error">
              <span className="text-danger">{status.lastError}</span>
            </Field>
          )}
        </dl>
        )}
        {/* Runtime parameters used to live inline here; with the
            split into Browser-role and Task-role budgets the form
            grew to seven fields, which made the surface feel busy
            even when the operator just wants to glance at
            sandbox state. Moved into a modal dialog reachable
            from the section header ("Configure" button). */}
      </div>
      <ConfigureSandboxDialog
        open={configOpen}
        onClose={() => setConfigOpen(false)}
      />
    </section>
  );
}

// Wire shape returned by GET /api/p/microsandbox/task-pool. Mirrors
// the merged-entry type the admin route builds out of the in-memory
// SandboxPool plus microsandbox SDK's persistent sandbox index.
interface TaskPoolEntry {
  taskId: string;
  sandboxName: string;
  /** "running" | "stopped" | "starting" | "error" | "orphan".
   *  "orphan" means the SDK still has the VM on disk but the
   *  pool's in-memory map doesn't know about it (typical after a
   *  process restart — we left the VMs around so disk state
   *  survives). The "Forget" button reclaims them. */
  poolState: string;
  sdkStatus: string | null;
  createdAt: string | null;
  startError: string | null;
}

function TaskPoolSection({ refreshTick }: { refreshTick: number }) {
  const [entries, setEntries] = useState<TaskPoolEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [destroying, setDestroying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchJson<{ entries: TaskPoolEntry[] }>(
        `${ROUTE_BASE}/task-pool`,
      );
      setEntries(r.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  // Cheap auto-refresh: poll every 5s while the page is open.
  // Sandbox state changes off-channel (a worker pickup spawns a
  // VM, a finally hook stops it) and there's no event we can
  // subscribe to, so the polling loop keeps the panel honest.
  useEffect(() => {
    const t = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(t);
  }, [load]);

  async function destroy(name: string) {
    setDestroying(name);
    setError(null);
    try {
      const url = `${ROUTE_BASE}/task-pool/destroy?sandbox_name=${encodeURIComponent(name)}`;
      await fetchJson<{ ok: true }>(url, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDestroying(null);
    }
  }

  const running =
    entries?.filter((e) => e.poolState === "running").length ?? 0;
  const total = entries?.length ?? 0;

  return (
    <section>
      <SectionHeader
        title="Per-task sandbox pool"
        description={
          total === 0
            ? "No per-task sandboxes yet. The pool spawns one when a workboard task is picked up by a worker."
            : `${total} sandbox${total === 1 ? "" : "es"} (${running} running)`
        }
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="btn-ghost flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-muted"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        }
      />

      {error && <Banner kind="error" text={error} />}

      {entries !== null && entries.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border-subtle">
          <table className="w-full text-[11px]">
            <thead className="bg-bg-elevated/60 text-[10px] uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-3 py-1.5 text-left">State</th>
                <th className="px-3 py-1.5 text-left">Sandbox</th>
                <th className="px-3 py-1.5 text-left">Task</th>
                <th className="px-3 py-1.5 text-left">Created</th>
                <th className="px-3 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {entries.map((e) => (
                <tr key={e.sandboxName} className="text-fg-muted">
                  <td className="px-3 py-1.5">
                    <PoolStateChip state={e.poolState} />
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-fg-muted">
                    <code
                      className="cursor-pointer hover:text-fg-default"
                      title="Click to copy"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(e.sandboxName)
                          .catch(() => {});
                      }}
                    >
                      {e.sandboxName}
                    </code>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-fg-faint">
                    {e.taskId.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-1.5 text-[10px] text-fg-faint">
                    {e.createdAt
                      ? formatRelative(e.createdAt)
                      : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => void destroy(e.sandboxName)}
                      disabled={destroying === e.sandboxName}
                      className="flex items-center gap-1 rounded border border-border-subtle px-2 py-0.5 text-[10px] text-danger hover:bg-rose-950/40 disabled:cursor-not-allowed disabled:opacity-40"
                      title={
                        e.poolState === "running"
                          ? "Stop and remove this sandbox (also kills the running task)"
                          : "Remove the sandbox image from disk"
                      }
                    >
                      {destroying === e.sandboxName ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Trash2 size={10} />
                      )}
                      {e.poolState === "orphan" ? "Forget" : "Destroy"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PoolStateChip({ state }: { state: string }) {
  const className =
    state === "running"
      ? "bg-emerald-900/40 text-emerald-200 border-emerald-700/50"
      : state === "starting"
        ? "bg-amber-900/40 text-amber-200 border-amber-700/50"
        : state === "error"
          ? "bg-rose-900/40 text-danger border-rose-700/50"
          : state === "orphan"
            ? "bg-bg-elevated/40 text-fg-muted border-border-default/50"
            : "bg-bg-elevated/30 text-fg-muted border-border-subtle";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${className}`}
    >
      {state}
    </span>
  );
}

/**
 * Modal wrapper around the auto-generated PluginConfigForm. The
 * form surface is large (7 numeric fields after the role split),
 * so we keep it out of the always-visible Live sandbox card and
 * surface it on demand.
 */
function ConfigureSandboxDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      {/* Dialog is a flex column. Header is shrink-0 so it always
          shows. The form body scrolls inside a flex-1 area, BUT
          we use a CSS arbitrary-selector trick to grab the form's
          own action row (the last direct child div with the
          Reset/Save buttons — see PluginConfigForm.tsx:176, marked
          with `border-t border-border-subtle pt-3`) and pin it to the
          bottom via `position: sticky`. Keeps Save reachable
          without scrolling for any reasonable schema length, and
          breaks gracefully (becomes scrolled-to-end) if the form
          shape changes. */}
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-3">
          <div>
            <div className="text-sm font-medium text-fg-default">
              Sandbox runtime parameters
            </div>
            <div className="mt-0.5 text-[11px] text-fg-faint">
              Browser sandbox changes take effect on the next
              Reset; Task sandbox changes take effect on the next
              task acquire.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-fg-muted hover:bg-bg-raised hover:text-fg-default"
            aria-label="Close configure dialog"
          >
            <X size={14} />
          </button>
        </div>
        {/* DOM is: scroll-div > PluginConfigFormById-wrapper >
            PluginConfigForm-root (.space-y-5) > [fields, error?,
            actions (.border-t pt-3)]. Pin the actions row via the
            4-deep last-child position so Save stays in view while
            the fields scroll.

            The scroll container deliberately has NO bottom padding
            (px-4 pt-3 only). If it had py-3, sticky bottom-0 would
            stop at the content edge with the padding-bottom strip
            still visible — fields scrolling up would peek through
            below the sticky row. By moving the bottom "breathing
            room" into the sticky row itself (pb-3) we get an opaque
            background that fully covers the scroll viewport. */}
        <div className="flex-1 overflow-y-auto px-4 pt-3 [&>div>div>div:last-child]:sticky [&>div>div>div:last-child]:bottom-0 [&>div>div>div:last-child]:bg-bg-base [&>div>div>div:last-child]:pt-3 [&>div>div>div:last-child]:pb-3">
          <PluginConfigForm pluginId="microsandbox" />
        </div>
      </div>
    </div>
  );
}

// ─── shared layout helpers ─────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="col-span-1 text-fg-faint">{label}</dt>
      <dd className="col-span-2 text-fg-muted">{children}</dd>
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
        <h2 className="text-sm font-semibold text-fg-default">{title}</h2>
        {description && (
          <p className="mt-0.5 text-[11px] text-fg-faint">{description}</p>
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
      ? "border-emerald-700/40 bg-emerald-950/40 text-success"
      : kind === "warn"
        ? "border-amber-700/40 bg-amber-950/40 text-amber-200"
        : kind === "error"
          ? "border-rose-700/50 bg-rose-950/40 text-danger"
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

// ─── right-panel: BrowserViewportPanel ───────────────────────
//
// Embeds the per-tenant noVNC viewport in the chat shell's right
// column so the user can watch what the agent's browser tools are
// doing without leaving the conversation. This is the only
// surface for the live browser view today — the prior
// /admin/microsandbox/browser admin page was redundant once the
// in-chat panel handled both viewing and the dynamic resize loop,
// so it was retired.
//
// Wiring: the BrowserSidecar reports the host port that supervisor's
// websockify is forwarded to. We poll /browser/status for it (same
// shape as the admin page uses) and slot it into an iframe pointing
// at noVNC's `vnc.html?autoconnect=true&resize=scale&reconnect=true`.
// When the browser stack isn't running yet, the panel shows an empty
// state with a deep link to the admin Browser page.
//
// `resize=scale` (not `remote`): the closed-source predecessor's
// BrowserPanel ran the same way and copying that decision pays off
// because it is the more forgiving combination. Logic, briefly:
//
//   - We drive the *real* Xvfb framebuffer from the host with
//     `xrandr --fb` to match the iframe's pixel size, so chromium
//     gets a 1:1 viewport and page content reflows correctly.
//   - noVNC's client-side `scale` then becomes a no-op in the
//     happy path; when the framebuffer and iframe drift by a few
//     pixels (during a drag, after a layout settle), scaling
//     keeps the canvas stretched edge-to-edge with no black bars
//     or right-side cropping. `resize=remote` would instead ask
//     the noVNC server to RandR-resize, but our Xvfb only has the
//     initial 2400x1800 framebuffer mode — the request would either
//     no-op or fight the host-driven xrandr.
//   - `reconnect=true` so the iframe auto-recovers when a sandbox
//     reset / supervisord restart drops websockify.
//   - We use the full `vnc.html` (not the lite variant) because
//     it ships the toolbar / settings / clipboard helpers users
//     occasionally need; toolbar collapses to a thin strip.
//
// Why three resize layers — see browser-routes.ts postBrowserResize.
// In short: xrandr keeps Xvfb sized to the iframe so chromium
// fills it; wmctrl re-fits the chrome window inside the new
// framebuffer; Playwright MCP's browser_resize tells chromium to
// re-layout the *page viewport* (which is what makes pages reflow
// to fit the new width — X11 alone won't do that).

function BrowserViewportPanel(_props: PanelProps) {
  const [data, setData] = useState<BrowserStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetchJson<BrowserStatusPayload>(
        `${ROUTE_BASE}/browser/status`,
      );
      setData(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-poll while the stack isn't ready so the iframe pops in the
  // moment supervisord finishes booting. Stops polling once ready
  // — the iframe handles its own connection lifecycle from there.
  useEffect(() => {
    if (data?.ready) return;
    const id = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(id);
  }, [data?.ready, load]);

  // Drive the server-side three-layer resize from this panel's
  // actual rendered size. We keep this self-contained instead of
  // wiring through the chat shell because the panel is the only
  // consumer that cares about pixel-perfect viewport sync, and the
  // chat shell already throttles its own layout work elsewhere.
  useDebouncedViewportSync({
    container: containerRef,
    enabled: !!(data?.ready && data.ports.vnc),
    onDraggingChange: setDragging,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-fg-default">
          <Globe size={14} className="text-brand-400" />
          Browser
        </div>
      </div>

      {error && (
        <div className="m-3 flex items-start gap-1.5 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-[11px] text-danger">
          <AlertTriangle size={12} className="mt-px flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 bg-bg-base"
      >
        {data?.ready && data.ports.vnc ? (
          <iframe
            title="Browser viewport"
            src={`http://localhost:${data.ports.vnc}/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=1000`}
            // Disable iframe pointer events while the user drags
            // the chat-shell panel divider — otherwise noVNC swallows
            // the cursor and the resize feels stuck.
            style={{ pointerEvents: dragging ? "none" : undefined }}
            className="absolute inset-0 h-full w-full bg-bg-base"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-fg-faint">
            {data
              ? data.hint ?? "Browser stack not running."
              : "Loading…"}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Watches a container's box, debounces resize events, and POSTs the
 * latest size to `/browser/resize` once the user stops dragging.
 *
 * Implementation notes copied from the closed-source tianshu
 * BrowserPanel:
 *  - We listen to BOTH pointer and mouse events because the chat-shell
 *    panel divider uses mousedown/move/up while pinch-zoom uses
 *    pointer events.
 *  - While a button is down we record the latest size but never send
 *    it; on release we wait QUIET_MS for layout to settle, then send
 *    once. This avoids hammering the backend (xrandr + wmctrl +
 *    Playwright MCP ≈ 200ms each per call) during a continuous drag.
 *  - We cap DPR at 2 because retina + a wide panel can balloon to
 *    framebuffer sizes Xvfb's `-screen` ceiling will silently
 *    truncate.
 */
function useDebouncedViewportSync(opts: {
  container: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onDraggingChange: (b: boolean) => void;
}): void {
  const { container, enabled, onDraggingChange } = opts;
  useEffect(() => {
    if (!enabled) return;
    const el = container.current;
    if (!el) return;

    const QUIET_MS = 300;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dragging = false;
    let pending: { w: number; h: number } | null = null;
    let lastSent = { w: 0, h: 0 };

    const post = (w: number, h: number) => {
      void fetch(`${ROUTE_BASE}/browser/resize`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width: w, height: h }),
      }).catch(() => {
        // Best-effort — a resize that doesn't reach the server
        // just means the viewport stays at its last value, which
        // noVNC's client-side scaling renders fine.
      });
    };

    const flush = () => {
      if (!pending) return;
      const { w, h } = pending;
      if (w < 320 || h < 240) return; // panel hidden / collapsed
      if (
        Math.abs(w - lastSent.w) < 8 &&
        Math.abs(h - lastSent.h) < 8
      ) {
        return;
      }
      lastSent = { w, h };
      pending = null;
      post(w, h);
    };

    const scheduleFlush = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (dragging) return; // still dragging — wait for release
        flush();
      }, QUIET_MS);
    };

    const onResize = (entries: ResizeObserverEntry[]) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.round(entry.contentRect.width * dpr);
      const h = Math.round(entry.contentRect.height * dpr);
      pending = { w, h };
      scheduleFlush();
    };

    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    const setDragging = (v: boolean) => {
      dragging = v;
      onDraggingChange(v);
      if (!v) scheduleFlush();
    };
    const onDown = () => setDragging(true);
    const onUp = () => setDragging(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [container, enabled, onDraggingChange]);
}

const clientExports: PluginClientExports = {
  components: {
    BrowserViewportPanel:
      BrowserViewportPanel as PluginClientExports["components"][string],
    MicroSandboxAdminPage:
      MicroSandboxAdminPage as PluginClientExports["components"][string],
  },
};

export const components = clientExports.components;
export default clientExports;
