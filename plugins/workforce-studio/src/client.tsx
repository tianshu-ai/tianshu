// Workforce Studio — client side (Phase 1).
//
// One admin page: WorkforceStudioPage. It fetches the snapshot
// from the server route (host route prefix is `/api/p/workforce-
// studio/snapshot`), renders three panels:
//
//   - Header (tenant / version / counts / "Download bundle")
//   - Main agent (system prompt + tools + skills)
//   - Workers list (click a row → detail panel)
//
// Editing UIs land in later phases. We deliberately keep the
// component flat (no nested routes) so the read-only path stays
// trivial to maintain — once editing comes in we'll split.

import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  Wrench,
  Book,
  Bot,
  Users,
  AlertTriangle,
} from "lucide-react";
import type {
  AdminPageProps,
  PluginClientExports,
} from "@tianshu-ai/plugin-sdk/client";

// ─── wire shapes (mirror server types via duck-typing) ──────────

interface ToolEntry {
  name: string;
  description: string;
  pluginId: string;
  since: string | null;
  parameters: unknown;
}
interface SkillEntry {
  name: string;
  description: string;
  pluginId: string;
  scope?: "main" | "worker";
  relativePath: string;
  body: string;
}
interface MainAgent {
  brandName: string;
  defaultModelId: string | null;
  systemPrompt: string;
  tools: ToolEntry[];
  skills: SkillEntry[];
}
interface WorkerAgent {
  slug: string;
  name: string;
  description: string | null;
  kind: string;
  source: "builtin" | "user";
  enabled: boolean;
  modelId: string | null;
  systemPrompt: string;
  tools: ToolEntry[];
  skills: SkillEntry[];
}
interface Snapshot {
  tenantId: string;
  userId: string;
  generatedAt: number;
  tianshuVersion: string;
  main: MainAgent;
  workers: WorkerAgent[];
}
interface SnapshotResponse {
  ok: boolean;
  snapshot?: Snapshot;
  error?: string;
}

// ─── helpers ────────────────────────────────────────────────────

const API_BASE = "/api/p/workforce-studio";

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch(`${API_BASE}/snapshot`, { credentials: "include" });
  const body = (await res.json()) as SnapshotResponse;
  if (!body.ok || !body.snapshot) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body.snapshot;
}

function downloadZip(): void {
  // Use a real anchor so the browser honours Content-Disposition
  // (vs. a fetch + saveAs blob roundtrip which loses the
  // server-suggested filename on some browsers).
  const a = document.createElement("a");
  a.href = `${API_BASE}/snapshot/zip`;
  a.rel = "noopener";
  a.click();
}

// ─── main page ──────────────────────────────────────────────────

function WorkforceStudioPage(_props: AdminPageProps): ReactElement {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchSnapshot();
      setSnapshot(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-6">
      <Header
        snapshot={snapshot}
        loading={loading}
        onRefresh={() => void refresh()}
      />
      {error ? (
        <div className="rounded-md border border-danger-fg/40 bg-danger-fg/5 p-4 text-sm text-danger-fg">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" />
            Failed to load snapshot
          </div>
          <div className="mt-1 font-mono text-xs opacity-80">{error}</div>
        </div>
      ) : null}
      {snapshot ? (
        <>
          <MainAgentPanel main={snapshot.main} />
          <WorkersPanel workers={snapshot.workers} />
        </>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="size-4 animate-spin" /> Loading snapshot…
        </div>
      ) : null}
    </div>
  );
}

function Header({
  snapshot,
  loading,
  onRefresh,
}: {
  snapshot: Snapshot | null;
  loading: boolean;
  onRefresh: () => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle pb-4">
      <div>
        <h1 className="text-xl font-semibold">Workforce Studio</h1>
        <p className="mt-1 max-w-2xl text-sm text-fg-muted">
          Inspect the main agent + every worker agent — their
          composed prompts, allowed tools, and skills. Download a
          bundle for sharing or offline review. Editing lands in a
          later phase.
        </p>
        {snapshot ? (
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-fg-muted">
            <Badge>
              tenant <code className="font-mono">{snapshot.tenantId}</code>
            </Badge>
            <Badge>
              user <code className="font-mono">{snapshot.userId}</code>
            </Badge>
            <Badge>v{snapshot.tianshuVersion}</Badge>
            <Badge>
              {snapshot.main.tools.length} tools ·{" "}
              {snapshot.main.skills.length} skills ·{" "}
              {snapshot.workers.length} workers
            </Badge>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-elevated px-3 py-1.5 text-sm hover:bg-bg-raised disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Refresh
        </button>
        <button
          type="button"
          onClick={downloadZip}
          disabled={!snapshot}
          className="inline-flex items-center gap-1 rounded-md bg-fg-default px-3 py-1.5 text-sm font-medium text-bg-base hover:opacity-90 disabled:opacity-50"
        >
          <Download className="size-4" />
          Download bundle
        </button>
      </div>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="rounded-md border border-border-subtle bg-bg-elevated px-2 py-0.5">
      {children}
    </span>
  );
}

// ─── main agent ─────────────────────────────────────────────────

function MainAgentPanel({ main }: { main: MainAgent }): ReactElement {
  return (
    <section className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <Bot className="size-4 text-fg-muted" />
        <h2 className="text-sm font-semibold">Main agent</h2>
        <span className="ml-2 text-xs text-fg-muted">
          {main.brandName} · default model{" "}
          <code className="font-mono">{main.defaultModelId ?? "—"}</code>
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
        <CollapsibleBlock
          title={`System prompt (${formatBytes(main.systemPrompt.length)})`}
          initiallyOpen={false}
          icon={<Bot className="size-4" />}
        >
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-base p-3 font-mono text-[11px] leading-snug">
            {main.systemPrompt}
          </pre>
        </CollapsibleBlock>
        <CollapsibleBlock
          title={`Tools (${main.tools.length})`}
          initiallyOpen={false}
          icon={<Wrench className="size-4" />}
        >
          <ToolsList tools={main.tools} />
        </CollapsibleBlock>
        <CollapsibleBlock
          title={`Skills (${main.skills.length})`}
          initiallyOpen={false}
          icon={<Book className="size-4" />}
        >
          <SkillsList skills={main.skills} />
        </CollapsibleBlock>
      </div>
    </section>
  );
}

// ─── workers ────────────────────────────────────────────────────

function WorkersPanel({
  workers,
}: {
  workers: WorkerAgent[];
}): ReactElement {
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const sorted = useMemo(
    () => [...workers].sort((a, b) => a.slug.localeCompare(b.slug)),
    [workers],
  );
  return (
    <section className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <Users className="size-4 text-fg-muted" />
        <h2 className="text-sm font-semibold">Workers</h2>
        <span className="ml-2 text-xs text-fg-muted">{sorted.length}</span>
      </div>
      {sorted.length === 0 ? (
        <div className="px-4 py-6 text-sm text-fg-muted">
          No worker agents configured yet.
        </div>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {sorted.map((w) => (
            <WorkerRow
              key={w.slug}
              worker={w}
              open={openSlug === w.slug}
              onToggle={() =>
                setOpenSlug((cur) => (cur === w.slug ? null : w.slug))
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkerRow({
  worker,
  open,
  onToggle,
}: {
  worker: WorkerAgent;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <li className="px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="size-4 text-fg-muted" />
        ) : (
          <ChevronRight className="size-4 text-fg-muted" />
        )}
        <span className="font-medium">{worker.name}</span>
        <code className="text-xs text-fg-muted">{worker.slug}</code>
        <span className="text-xs text-fg-muted">· {worker.kind}</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
          {worker.modelId ? (
            <code className="font-mono">{worker.modelId}</code>
          ) : (
            <span>default model</span>
          )}
          <span
            className={
              worker.enabled
                ? "rounded bg-success-fg/10 px-1.5 py-0.5 text-success-fg"
                : "rounded bg-fg-muted/10 px-1.5 py-0.5"
            }
          >
            {worker.enabled ? "enabled" : "disabled"}
          </span>
          <span className="rounded bg-fg-muted/10 px-1.5 py-0.5">
            {worker.source}
          </span>
        </span>
      </button>
      {open ? (
        <div className="mt-3 grid grid-cols-1 gap-3 pl-6 md:grid-cols-3">
          <CollapsibleBlock
            title={`SOUL / system prompt (${formatBytes(
              worker.systemPrompt.length,
            )})`}
            initiallyOpen
            icon={<Bot className="size-4" />}
          >
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-base p-3 font-mono text-[11px] leading-snug">
              {worker.systemPrompt.trim() || "<empty>"}
            </pre>
          </CollapsibleBlock>
          <CollapsibleBlock
            title={`Tools (${worker.tools.length})`}
            initiallyOpen={false}
            icon={<Wrench className="size-4" />}
          >
            <ToolsList tools={worker.tools} />
          </CollapsibleBlock>
          <CollapsibleBlock
            title={`Skills (${worker.skills.length})`}
            initiallyOpen={false}
            icon={<Book className="size-4" />}
          >
            <SkillsList skills={worker.skills} />
          </CollapsibleBlock>
        </div>
      ) : null}
    </li>
  );
}

// ─── shared sub-views ──────────────────────────────────────────

function CollapsibleBlock({
  title,
  icon,
  initiallyOpen,
  children,
}: {
  title: string;
  icon?: ReactNode;
  initiallyOpen: boolean;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="rounded-md border border-border-subtle bg-bg-base">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-fg-muted" />
        ) : (
          <ChevronRight className="size-3.5 text-fg-muted" />
        )}
        {icon}
        <span>{title}</span>
      </button>
      {open ? <div className="border-t border-border-subtle p-2">{children}</div> : null}
    </div>
  );
}

function ToolsList({ tools }: { tools: ToolEntry[] }): ReactElement {
  if (tools.length === 0) {
    return <div className="text-xs text-fg-muted">None</div>;
  }
  return (
    <ul className="max-h-72 space-y-1 overflow-auto text-xs">
      {tools.map((t) => (
        <li
          key={t.name}
          className="rounded border border-border-subtle bg-bg-elevated px-2 py-1.5"
        >
          <div className="flex items-center gap-2">
            <code className="font-mono text-[11px]">{t.name}</code>
            <span className="rounded bg-fg-muted/10 px-1 text-[10px]">
              {t.pluginId}
            </span>
            {t.since ? (
              <span className="text-[10px] text-fg-muted">since {t.since}</span>
            ) : null}
          </div>
          {t.description ? (
            <div className="mt-0.5 text-[11px] text-fg-muted">
              {t.description}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SkillsList({ skills }: { skills: SkillEntry[] }): ReactElement {
  if (skills.length === 0) {
    return <div className="text-xs text-fg-muted">None</div>;
  }
  return (
    <ul className="max-h-72 space-y-1 overflow-auto text-xs">
      {skills.map((s) => (
        <li
          key={`${s.pluginId}/${s.name}`}
          className="rounded border border-border-subtle bg-bg-elevated px-2 py-1.5"
        >
          <div className="flex items-center gap-2">
            <code className="font-mono text-[11px]">{s.name}</code>
            <span className="rounded bg-fg-muted/10 px-1 text-[10px]">
              {s.pluginId}
            </span>
            {s.scope ? (
              <span className="rounded bg-info-fg/10 px-1 text-[10px] text-info-fg">
                {s.scope}-only
              </span>
            ) : null}
            <span className="ml-auto text-[10px] text-fg-muted">
              {formatBytes(s.body.length)}
            </span>
          </div>
          {s.description ? (
            <div className="mt-0.5 text-[11px] text-fg-muted">
              {s.description}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 100) return `${kb.toFixed(1)} KB`;
  return `${Math.round(kb)} KB`;
}

// ─── plugin export ──────────────────────────────────────────────

const clientExports: PluginClientExports = {
  components: {
    WorkforceStudioPage:
      WorkforceStudioPage as PluginClientExports["components"][string],
  },
};

export const components = clientExports.components;
export default clientExports;
