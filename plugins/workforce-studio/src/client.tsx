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
import { usePluginT } from "@tianshu-ai/plugin-sdk/client";
import { SolutionView } from "./solution-view.js";

/** Translator function returned by usePluginT — passed to helpers. */
type Translator = (key: string, params?: Record<string, string | number>) => string;

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
  | "custom-fragment"
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
  // Top-level view per ADR-0008: Solution (designtime) vs Reality
  // (runtime). Default to Reality so the first thing an operator
  // sees is what's actually running.
  const t = usePluginT("workforce-studio");
  const [topView, setTopView] = useState<"reality" | "solution">("reality");
  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-3">
        <div>
          <h1 className="text-xl font-semibold">{t("page.title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            {t("page.intro.lead")}{" "}
            <strong>{t("page.intro.solution")}</strong> {t("page.intro.mid")}{" "}
            <strong>{t("page.intro.reality")}</strong> {t("page.intro.tail")}
          </p>
        </div>
        <TopViewSwitch value={topView} onChange={setTopView} t={t} />
      </div>
      {topView === "reality" ? <RealityView /> : <SolutionView />}
    </div>
  );
}

function TopViewSwitch({
  value,
  onChange,
  t,
}: {
  value: "reality" | "solution";
  onChange: (next: "reality" | "solution") => void;
  t: Translator;
}): ReactElement {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border-subtle text-sm">
      <button
        type="button"
        onClick={() => onChange("solution")}
        className={
          value === "solution"
            ? "bg-fg-default px-4 py-1.5 font-medium text-bg-base"
            : "bg-bg-base px-4 py-1.5 hover:bg-bg-raised"
        }
      >
        {t("switch.solution")}
      </button>
      <button
        type="button"
        onClick={() => onChange("reality")}
        className={
          value === "reality"
            ? "bg-fg-default px-4 py-1.5 font-medium text-bg-base"
            : "bg-bg-base px-4 py-1.5 hover:bg-bg-raised"
        }
      >
        {t("switch.reality")}
      </button>
    </div>
  );
}

// ─── reality view (the former page body) ────────────────────────

function RealityView(): ReactElement {
  const t = usePluginT("workforce-studio");
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
    <div className="flex flex-col gap-4">
      <Header
        snapshot={snapshot}
        loading={loading}
        onRefresh={() => void refresh()}
        t={t}
      />
      {error ? (
        <div className="rounded-md border border-danger-fg/40 bg-danger-fg/5 p-4 text-sm text-danger-fg">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" />
            {t("reality.loadFailed")}
          </div>
          <div className="mt-1 font-mono text-xs opacity-80">{error}</div>
        </div>
      ) : null}
      {snapshot ? (
        <>
          <PluginsPanel plugins={snapshot.plugins} t={t} />
          <MainAgentPanel main={snapshot.main} t={t} />
          <WorkersPanel workers={snapshot.workers} t={t} />
        </>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="size-4 animate-spin" /> {t("reality.loading")}
        </div>
      ) : null}
    </div>
  );
}

function Header({
  snapshot,
  loading,
  onRefresh,
  t,
}: {
  snapshot: Snapshot | null;
  loading: boolean;
  onRefresh: () => void;
  t: Translator;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        {snapshot ? (
          <div className="flex flex-wrap gap-3 text-xs text-fg-muted">
            <Badge>
              {t("header.badge.tenant")}{" "}
              <code className="font-mono">{snapshot.tenantId}</code>
            </Badge>
            <Badge>
              {t("header.badge.user")}{" "}
              <code className="font-mono">{snapshot.userId}</code>
            </Badge>
            <Badge>v{snapshot.tianshuVersion}</Badge>
            <Badge>
              {t("header.badge.counts", {
                plugins: snapshot.plugins.length,
                tools: snapshot.main.tools.length,
                skills: snapshot.main.skills.length,
                workers: snapshot.workers.length,
              })}
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
          {t("header.refresh")}
        </button>
        <button
          type="button"
          onClick={downloadZip}
          disabled={!snapshot}
          className="inline-flex items-center gap-1 rounded-md bg-fg-default px-3 py-1.5 text-sm font-medium text-bg-base hover:opacity-90 disabled:opacity-50"
        >
          <Download className="size-4" />
          {t("header.downloadBundle")}
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
function OriginBadge({ origin, t }: { origin: Origin; t: Translator }): ReactElement {
  const { label, className } = originStyle(origin, t);
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${className}`}
      title={originTitle(origin, t)}
    >
      {label}
    </span>
  );
}

function originStyle(
  origin: Origin,
  t: Translator,
): { label: string; className: string } {
  if (origin === "core") {
    return {
      label: t("origin.core.label"),
      className: "bg-info-fg/10 text-info-fg",
    };
  }
  if (origin === "builtin-plugin") {
    return {
      label: t("origin.builtin.label"),
      className: "bg-success-fg/10 text-success-fg",
    };
  }
  // tenant-plugin
  return {
    label: t("origin.tenant.label"),
    className: "bg-warning-fg/10 text-warning-fg",
  };
}

function originTitle(origin: Origin, t: Translator): string {
  if (origin === "core") return t("origin.core.title");
  if (origin === "builtin-plugin") return t("origin.builtin.title");
  return t("origin.tenant.title");
}

// ─── plugins ────────────────────────────────────────────────────

function PluginsPanel({
  plugins,
  t,
}: {
  plugins: PluginInfo[];
  t: Translator;
}): ReactElement {
  return (
    <section className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <Package className="size-4 text-fg-muted" />
        <h2 className="text-sm font-semibold">{t("plugins.title")}</h2>
        <span className="ml-2 text-xs text-fg-muted">
          {t("plugins.count", { n: plugins.length })}
        </span>
        <span
          className="ml-1 text-[10px] text-fg-muted"
          title={t("plugins.activeHintTitle")}
        >
          {t("plugins.activeHint")}
        </span>
      </div>
      {plugins.length === 0 ? (
        <div className="px-4 py-6 text-sm text-fg-muted">
          {t("plugins.empty")}
        </div>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {plugins.map((p) => (
            <li key={p.id} className="px-4 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.displayName}</span>
                <code className="text-fg-muted">{p.id}</code>
                <span className="text-fg-muted">v{p.version}</span>
                <OriginBadge origin={p.origin} t={t} />
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

function MainAgentPanel({ main, t }: { main: MainAgent; t: Translator }): ReactElement {
  const [view, setView] = useState<"develop" | "rendered">("develop");
  return (
    <section className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-3">
        <Bot className="size-4 text-fg-muted" />
        <h2 className="text-sm font-semibold">{t("mainAgent.title")}</h2>
        <span className="ml-2 text-xs text-fg-muted">
          {main.brandName} · {t("mainAgent.defaultModel")}{" "}
          <code className="font-mono">{main.defaultModelId ?? "—"}</code>
        </span>
        <ViewSwitch value={view} onChange={setView} t={t} />
      </div>
      {view === "develop" ? (
        <div className="flex flex-col gap-4 p-4">
          <PromptBlocks blocks={main.blocks} t={t} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <CollapsibleBlock
              title={t("tools.title", { n: main.tools.length })}
              initiallyOpen={false}
              icon={<Wrench className="size-4" />}
            >
              <ToolsList tools={main.tools} t={t} />
            </CollapsibleBlock>
            <CollapsibleBlock
              title={t("skills.title", { n: main.skills.length })}
              initiallyOpen={false}
              icon={<Book className="size-4" />}
            >
              <SkillsList skills={main.skills} t={t} />
            </CollapsibleBlock>
          </div>
        </div>
      ) : (
        <div className="p-4">
          <div className="mb-2 text-xs text-fg-muted">
            {t("mainAgent.rendered.hint", {
              size: formatBytes(main.systemPrompt.length),
            })}
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
  t,
}: {
  value: "develop" | "rendered";
  onChange: (next: "develop" | "rendered") => void;
  t: Translator;
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
        {t("view.blocks")}
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
        {t("view.rendered")}
      </button>
    </div>
  );
}

// Render every block as a collapsible card with a coloured
// origin / editability badge. Non-editable blocks have a faint
// "lock" border to make the affordance obvious before the user
// clicks.
function PromptBlocks({ blocks, t }: { blocks: PromptBlock[]; t: Translator }): ReactElement {
  if (blocks.length === 0) {
    return (
      <div className="text-xs text-fg-muted">{t("blocks.empty")}</div>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {blocks.map((b, idx) => (
        <BlockCard key={`${b.kind}-${idx}`} block={b} index={idx + 1} t={t} />
      ))}
    </ol>
  );
}

function BlockCard({
  block,
  index,
  t,
}: {
  block: PromptBlock;
  index: number;
  t: Translator;
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
        <BlockOriginBadge origin={block.origin} t={t} />
        <span
          className={
            block.editable
              ? "rounded bg-success-fg/10 px-1.5 py-0.5 text-[10px] font-medium text-success-fg"
              : "rounded bg-fg-muted/15 px-1.5 py-0.5 text-[10px] font-medium"
          }
          title={
            block.editable
              ? t("block.editable.title")
              : t("block.readOnly.title")
          }
        >
          {block.editable ? t("block.editable") : t("block.readOnly")}
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
  t,
}: {
  origin: BlockOrigin;
  t: Translator;
}): ReactElement {
  // Map block origins to the same buckets the tool/skill badge
  // uses. "host" / "workspace" / "tenant" don't have direct
  // tool-style equivalents; we colour them distinctly so the
  // origin column scans cleanly.
  const map: Record<BlockOrigin, { label: string; className: string }> = {
    core: { label: t("blockOrigin.core"), className: "bg-info-fg/10 text-info-fg" },
    "builtin-plugin": {
      label: t("blockOrigin.builtin"),
      className: "bg-success-fg/10 text-success-fg",
    },
    "tenant-plugin": {
      label: t("blockOrigin.tenantPlugin"),
      className: "bg-warning-fg/10 text-warning-fg",
    },
    host: { label: t("blockOrigin.host"), className: "bg-info-fg/10 text-info-fg" },
    workspace: {
      label: t("blockOrigin.workspace"),
      className: "bg-warning-fg/10 text-warning-fg",
    },
    tenant: {
      label: t("blockOrigin.tenant"),
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
  t,
}: {
  workers: WorkerAgent[];
  t: Translator;
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
        <h2 className="text-sm font-semibold">{t("workers.title")}</h2>
        <span className="ml-2 text-xs text-fg-muted">{sorted.length}</span>
      </div>
      {sorted.length === 0 ? (
        <div className="px-4 py-6 text-sm text-fg-muted">
          {t("workers.empty")}
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
              t={t}
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
  t,
}: {
  worker: WorkerAgent;
  open: boolean;
  onToggle: () => void;
  t: Translator;
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
            <span>{t("worker.defaultModel")}</span>
          )}
          <span
            className={
              worker.enabled
                ? "rounded bg-success-fg/10 px-1.5 py-0.5 text-success-fg"
                : "rounded bg-fg-muted/10 px-1.5 py-0.5"
            }
          >
            {worker.enabled ? t("worker.enabled") : t("worker.disabled")}
          </span>
          <span className="rounded bg-fg-muted/10 px-1.5 py-0.5">
            {worker.source}
          </span>
        </span>
      </button>
      {open ? (
        <WorkerDetail worker={worker} t={t} />
      ) : null}
    </li>
  );
}

function WorkerDetail({
  worker,
  t,
}: {
  worker: WorkerAgent;
  t: Translator;
}): ReactElement {
  const [view, setView] = useState<"develop" | "rendered">("develop");
  return (
    <div className="mt-3 flex flex-col gap-3 pl-6">
      <div className="flex items-center text-xs">
        <span className="text-fg-muted">{t("worker.systemPrompt")}</span>
        <ViewSwitch value={view} onChange={setView} t={t} />
      </div>
      {view === "develop" ? (
        <PromptBlocks blocks={worker.blocks} t={t} />
      ) : (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-base p-3 font-mono text-[11px] leading-snug">
          {worker.systemPrompt.trim() || t("worker.emptyPrompt")}
        </pre>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <CollapsibleBlock
          title={t("tools.title", { n: worker.tools.length })}
          initiallyOpen={false}
          icon={<Wrench className="size-4" />}
        >
          <ToolsList tools={worker.tools} t={t} />
        </CollapsibleBlock>
        <CollapsibleBlock
          title={t("skills.title", { n: worker.skills.length })}
          initiallyOpen={false}
          icon={<Book className="size-4" />}
        >
          <SkillsList skills={worker.skills} t={t} />
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

function ToolsList({ tools, t }: { tools: ToolEntry[]; t: Translator }): ReactElement {
  if (tools.length === 0) {
    return <div className="text-xs text-fg-muted">{t("tools.none")}</div>;
  }
  return (
    <ul className="max-h-72 space-y-1 overflow-auto text-xs">
      {tools.map((tool) => (
        <li
          key={tool.name}
          className="rounded border border-border-subtle bg-bg-elevated px-2 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-[11px]">{tool.name}</code>
            <OriginBadge origin={tool.origin} t={t} />
            <span className="rounded bg-fg-muted/10 px-1 text-[10px]">
              {tool.pluginId}
            </span>
            {tool.since ? (
              <span className="text-[10px] text-fg-muted">
                {t("tools.since", { v: tool.since })}
              </span>
            ) : null}
          </div>
          {tool.description ? (
            <div className="mt-0.5 text-[11px] text-fg-muted">
              {tool.description}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SkillsList({ skills, t }: { skills: SkillEntry[]; t: Translator }): ReactElement {
  if (skills.length === 0) {
    return <div className="text-xs text-fg-muted">{t("skills.none")}</div>;
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
            <OriginBadge origin={s.origin} t={t} />
            <span className="rounded bg-fg-muted/10 px-1 text-[10px]">
              {s.pluginId}
            </span>
            {s.scope ? (
              <span className="rounded bg-info-fg/10 px-1 text-[10px] text-info-fg">
                {t("skills.scopeOnly", { scope: s.scope })}
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
