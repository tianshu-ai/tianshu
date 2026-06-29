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
  Package,
  AlertTriangle,
} from "lucide-react";
import type {
  AdminPageProps,
  PluginClientExports,
} from "@tianshu-ai/plugin-sdk/client";

// ─── wire shapes (mirror server types via duck-typing) ──────────

type Origin = "core" | "builtin-plugin" | "tenant-plugin";
type BlockOrigin = Origin | "host" | "tenant" | "workspace";
type BlockKind =
  | "brand"
  | "runtime-context"
  | "execution-bias"
  | "workspace-context"
  | "reply-style"
  | "plugin-fragment"
  | "available-skills"
  | "user-onboarding"
  | "tenant-prompt"
  | "worker-soul"
  | "worker-context";

interface PromptBlock {
  kind: BlockKind;
  title: string;
  source: string;
  origin: BlockOrigin;
  editable: boolean;
  text: string;
  note?: string;
}

interface ToolEntry {
  name: string;
  description: string;
  pluginId: string;
  since: string | null;
  parameters: unknown;
  origin: Origin;
}
interface SkillEntry {
  name: string;
  description: string;
  pluginId: string;
  scope?: "main" | "worker";
  relativePath: string;
  body: string;
  origin: Origin;
}
interface PluginInfo {
  id: string;
  displayName: string;
  version: string;
  description: string;
  origin: "builtin-plugin" | "tenant-plugin";
  state: "active" | "failed" | "disabled" | "loading";
  failureReason: string | null;
  toolCount: number;
  skillCount: number;
}
interface MainAgent {
  brandName: string;
  defaultModelId: string | null;
  blocks: PromptBlock[];
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
  blocks: PromptBlock[];
  systemPrompt: string;
  tools: ToolEntry[];
  skills: SkillEntry[];
}
interface Snapshot {
  tenantId: string;
  userId: string;
  generatedAt: number;
  tianshuVersion: string;
  plugins: PluginInfo[];
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
          <PluginsPanel plugins={snapshot.plugins} />
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
              {snapshot.plugins.length} plugins ·{" "}
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

// Coloured pill that tells the operator where a tool / skill /
// plugin came from. Picking distinct hues per bucket so a long
// list is visually scannable; the labels are kept tiny because
// they appear on every row.
function OriginBadge({ origin }: { origin: Origin }): ReactElement {
  const { label, className } = originStyle(origin);
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${className}`}
      title={originTitle(origin)}
    >
      {label}
    </span>
  );
}

function originStyle(origin: Origin): { label: string; className: string } {
  if (origin === "core") {
    return {
      label: "core",
      className: "bg-info-fg/10 text-info-fg",
    };
  }
  if (origin === "builtin-plugin") {
    return {
      label: "built-in",
      className: "bg-success-fg/10 text-success-fg",
    };
  }
  // tenant-plugin
  return {
    label: "tenant",
    className: "bg-warning-fg/10 text-warning-fg",
  };
}

function originTitle(origin: Origin): string {
  if (origin === "core")
    return "Provided by the host (no plugin involved).";
  if (origin === "builtin-plugin")
    return "From a plugin shipped with this Tianshu install.";
  return "From a plugin installed per-tenant.";
}

// ─── plugins ────────────────────────────────────────────────────

function PluginsPanel({
  plugins,
}: {
  plugins: PluginInfo[];
}): ReactElement {
  return (
    <section className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <Package className="size-4 text-fg-muted" />
        <h2 className="text-sm font-semibold">Plugins</h2>
        <span className="ml-2 text-xs text-fg-muted">
          {plugins.length} in this solution
        </span>
        <span
          className="ml-1 text-[10px] text-fg-muted"
          title="Every plugin currently activated for this tenant. Tools, skills and prompt fragments come from these."
        >
          (active = contributing to the agent right now)
        </span>
      </div>
      {plugins.length === 0 ? (
        <div className="px-4 py-6 text-sm text-fg-muted">
          No plugins discovered for this tenant.
        </div>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {plugins.map((p) => (
            <li key={p.id} className="px-4 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.displayName}</span>
                <code className="text-fg-muted">{p.id}</code>
                <span className="text-fg-muted">v{p.version}</span>
                <OriginBadge origin={p.origin} />
                <PluginStateBadge
                  state={p.state}
                  failureReason={p.failureReason}
                />
                <span className="ml-auto text-fg-muted">
                  <Wrench className="mr-1 inline size-3" />
                  {p.toolCount}
                  <Book className="ml-2 mr-1 inline size-3" />
                  {p.skillCount}
                </span>
              </div>
              {p.description ? (
                <div className="mt-1 text-[11px] text-fg-muted">
                  {p.description}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PluginStateBadge({
  state,
  failureReason,
}: {
  state: PluginInfo["state"];
  failureReason: string | null;
}): ReactElement | null {
  if (state === "active") return null;
  const cls =
    state === "failed"
      ? "bg-danger-fg/10 text-danger-fg"
      : "bg-fg-muted/10";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
      title={failureReason ?? undefined}
    >
      {state}
    </span>
  );
}

// ─── main agent ─────────────────────────────────────────────────

function MainAgentPanel({ main }: { main: MainAgent }): ReactElement {
  const [view, setView] = useState<"develop" | "rendered">("develop");
  return (
    <section className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-3">
        <Bot className="size-4 text-fg-muted" />
        <h2 className="text-sm font-semibold">Main agent</h2>
        <span className="ml-2 text-xs text-fg-muted">
          {main.brandName} · default model{" "}
          <code className="font-mono">{main.defaultModelId ?? "—"}</code>
        </span>
        <ViewSwitch value={view} onChange={setView} />
      </div>
      {view === "develop" ? (
        <div className="flex flex-col gap-4 p-4">
          <PromptBlocks blocks={main.blocks} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
        </div>
      ) : (
        <div className="p-4">
          <div className="mb-2 text-xs text-fg-muted">
            Rendered prompt the model would receive on its next turn (
            {formatBytes(main.systemPrompt.length)}).
          </div>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-base p-3 font-mono text-[11px] leading-snug">
            {main.systemPrompt}
          </pre>
        </div>
      )}
    </section>
  );
}

function ViewSwitch({
  value,
  onChange,
}: {
  value: "develop" | "rendered";
  onChange: (next: "develop" | "rendered") => void;
}): ReactElement {
  return (
    <div className="ml-auto inline-flex overflow-hidden rounded-md border border-border-subtle text-xs">
      <button
        type="button"
        onClick={() => onChange("develop")}
        className={
          value === "develop"
            ? "bg-fg-default px-3 py-1 text-bg-base"
            : "bg-bg-base px-3 py-1 hover:bg-bg-raised"
        }
      >
        Blocks
      </button>
      <button
        type="button"
        onClick={() => onChange("rendered")}
        className={
          value === "rendered"
            ? "bg-fg-default px-3 py-1 text-bg-base"
            : "bg-bg-base px-3 py-1 hover:bg-bg-raised"
        }
      >
        Rendered
      </button>
    </div>
  );
}

// Render every block as a collapsible card with a coloured
// origin / editability badge. Non-editable blocks have a faint
// "lock" border to make the affordance obvious before the user
// clicks.
function PromptBlocks({ blocks }: { blocks: PromptBlock[] }): ReactElement {
  if (blocks.length === 0) {
    return (
      <div className="text-xs text-fg-muted">No prompt blocks reported.</div>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {blocks.map((b, idx) => (
        <BlockCard key={`${b.kind}-${idx}`} block={b} index={idx + 1} />
      ))}
    </ol>
  );
}

function BlockCard({
  block,
  index,
}: {
  block: PromptBlock;
  index: number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const borderTone = block.editable
    ? "border-border-subtle"
    : "border-border-subtle/60 border-dashed";
  return (
    <li className={`rounded-md border bg-bg-base ${borderTone}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-fg-muted" />
        ) : (
          <ChevronRight className="size-3.5 text-fg-muted" />
        )}
        <span className="text-[10px] text-fg-muted">#{index}</span>
        <span className="font-medium">{block.title}</span>
        <BlockOriginBadge origin={block.origin} />
        <span
          className={
            block.editable
              ? "rounded bg-success-fg/10 px-1.5 py-0.5 text-[10px] font-medium text-success-fg"
              : "rounded bg-fg-muted/15 px-1.5 py-0.5 text-[10px] font-medium"
          }
          title={
            block.editable
              ? "You can edit the underlying source."
              : "Managed by the host or a plugin — not editable."
          }
        >
          {block.editable ? "editable" : "read-only"}
        </span>
        <span className="ml-auto text-[10px] text-fg-muted">
          {block.source}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border-subtle px-3 py-2">
          {block.note ? (
            <div className="mb-2 text-[11px] text-fg-muted">{block.note}</div>
          ) : null}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-elevated p-2 font-mono text-[11px] leading-snug">
            {block.text}
          </pre>
        </div>
      ) : null}
    </li>
  );
}

function BlockOriginBadge({
  origin,
}: {
  origin: BlockOrigin;
}): ReactElement {
  // Map block origins to the same buckets the tool/skill badge
  // uses. "host" / "workspace" / "tenant" don't have direct
  // tool-style equivalents; we colour them distinctly so the
  // origin column scans cleanly.
  const map: Record<BlockOrigin, { label: string; className: string }> = {
    core: { label: "core", className: "bg-info-fg/10 text-info-fg" },
    "builtin-plugin": {
      label: "built-in",
      className: "bg-success-fg/10 text-success-fg",
    },
    "tenant-plugin": {
      label: "tenant plugin",
      className: "bg-warning-fg/10 text-warning-fg",
    },
    host: { label: "host", className: "bg-info-fg/10 text-info-fg" },
    workspace: {
      label: "workspace",
      className: "bg-warning-fg/10 text-warning-fg",
    },
    tenant: {
      label: "tenant",
      className: "bg-warning-fg/10 text-warning-fg",
    },
  };
  const { label, className } = map[origin];
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${className}`}
    >
      {label}
    </span>
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
        <WorkerDetail worker={worker} />
      ) : null}
    </li>
  );
}

function WorkerDetail({
  worker,
}: {
  worker: WorkerAgent;
}): ReactElement {
  const [view, setView] = useState<"develop" | "rendered">("develop");
  return (
    <div className="mt-3 flex flex-col gap-3 pl-6">
      <div className="flex items-center text-xs">
        <span className="text-fg-muted">System prompt</span>
        <ViewSwitch value={view} onChange={setView} />
      </div>
      {view === "develop" ? (
        <PromptBlocks blocks={worker.blocks} />
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-base p-3 font-mono text-[11px] leading-snug">
          {worker.systemPrompt.trim() || "<empty>"}
        </pre>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
    </div>
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
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-[11px]">{t.name}</code>
            <OriginBadge origin={t.origin} />
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
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-[11px]">{s.name}</code>
            <OriginBadge origin={s.origin} />
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
