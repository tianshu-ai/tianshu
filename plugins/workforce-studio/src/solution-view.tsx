// Solution view (ADR-0008 Phase 2/3) — the designtime half of
// the studio, reworked into a three-pane IDE layout
// (studio-ide-rework-plan.md):
//
//   topbar:  [solution picker] [diff badge]  Diff / Save / Apply / Delete
//   ┌ ① Explorer ┬ ② Editor (focused object) ┬ ③ Inspector ┐
//
// Pure front-end rework. All data + server logic is unchanged
// (Phases 1–3, shipped 0.4.4). The edit state + save() payload
// shape live in solution-state.ts and are reused verbatim, so the
// `/solutions/save` + `/solutions/:slug/apply` contracts don't
// change. The `current` mirror stays read-only.

import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  GitCompare,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Trash2,
} from "lucide-react";

import {
  api,
  useSolutionEdits,
  type SolutionDetail,
  type SolutionSummary,
} from "./solution-state.js";
import {
  SolutionTree,
  expandableIds,
  type NodeId,
} from "./solution-tree.js";
import { SolutionEditor } from "./solution-editors.js";
import { SolutionInspector } from "./solution-inspector.js";

// ─── main solution view ─────────────────────────────────────────

export function SolutionView(): ReactElement {
  const [summaries, setSummaries] = useState<SolutionSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SolutionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ solutions: SolutionSummary[] }>("/solutions");
      setSummaries(r.solutions);
      setSelected((cur) => cur ?? r.solutions[0]?.slug ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadDetail = useCallback(async (slug: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ solution: SolutionDetail }>(
        `/solutions/${encodeURIComponent(slug)}`,
      );
      setDetail(r.solution);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);
  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  const onExtract = useCallback(async () => {
    const slug = window.prompt(
      "New solution slug (lowercase, digits, - or _):",
      "",
    );
    if (!slug) return;
    setError(null);
    try {
      const name = window.prompt("Display name:", slug) || slug;
      await api("/solutions/extract", {
        method: "POST",
        body: JSON.stringify({ slug, name }),
      });
      await refreshList();
      setSelected(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshList]);

  const onDelete = useCallback(
    async (slug: string) => {
      if (!window.confirm(`Delete solution "${slug}"? This cannot be undone.`))
        return;
      try {
        await api(`/solutions/${encodeURIComponent(slug)}`, {
          method: "DELETE",
        });
        setSelected(null);
        setDetail(null);
        await refreshList();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshList],
  );

  return (
    <div className="flex min-h-[70vh] flex-col gap-3">
      {error ? (
        <div className="rounded-md border border-danger-fg/40 bg-danger-fg/5 p-3 text-sm text-danger-fg">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" />
            Solution error
          </div>
          <div className="mt-1 font-mono text-xs opacity-80">{error}</div>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="size-4 animate-spin" /> Loading solution…
        </div>
      ) : detail ? (
        <SolutionIDE
          key={detail.spec.slug}
          summaries={summaries}
          selectedSlug={selected}
          onSelectSlug={setSelected}
          onExtract={onExtract}
          onRefresh={() => void refreshList()}
          detail={detail}
          onDelete={onDelete}
          onSaved={async () => {
            await refreshList();
            if (selected) await loadDetail(selected);
          }}
        />
      ) : (
        <div className="text-sm text-fg-muted">
          No solution selected.{" "}
          <button
            type="button"
            onClick={() => void onExtract()}
            className="underline"
          >
            Extract one
          </button>{" "}
          from reality.
        </div>
      )}
    </div>
  );
}

// ─── the IDE shell (topbar + 3 panes) ───────────────────────────

function SolutionIDE({
  summaries,
  selectedSlug,
  onSelectSlug,
  onExtract,
  onRefresh,
  detail,
  onDelete,
  onSaved,
}: {
  summaries: SolutionSummary[] | null;
  selectedSlug: string | null;
  onSelectSlug: (slug: string) => void;
  onExtract: () => void;
  onRefresh: () => void;
  detail: SolutionDetail;
  onDelete: (slug: string) => void;
  onSaved: () => void;
}): ReactElement {
  const { spec, isCurrent } = detail;
  const edits = useSolutionEdits(detail, onSaved);

  // Tree expansion + focused-node selection. Default selection:
  // the Plugins node (matches the mockup). Workers group starts
  // expanded so the tree reads as a full outline.
  const [selectedNode, setSelectedNode] = useState<NodeId>("plugins");
  const [expanded, setExpanded] = useState<Set<NodeId>>(
    () => new Set<NodeId>(["main", "workers"]),
  );
  // Reset selection when switching solutions.
  useEffect(() => {
    setSelectedNode("plugins");
    setExpanded(new Set<NodeId>(["main", "workers"]));
  }, [spec.slug]);

  const expandable = useMemo(() => expandableIds(detail), [detail]);
  const toggleExpand = useCallback(
    (id: NodeId) => {
      if (!expandable.has(id)) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [expandable],
  );

  const driftCount = edits.diff?.entries.length ?? null;

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-base">
      {/* topbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-bg-elevated px-3 py-2">
        <Layers className="size-4 text-fg-muted" />
        <select
          value={selectedSlug ?? ""}
          onChange={(e) => onSelectSlug(e.target.value)}
          className="rounded-md border border-border-subtle bg-bg-raised px-2 py-1 text-xs"
        >
          {(summaries ?? []).map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.isCurrent ? "● " : "📦 "}
              {s.name}
              {s.isCurrent ? " (live mirror)" : ""}
            </option>
          ))}
        </select>
        {isCurrent ? (
          <span className="rounded bg-info-fg/10 px-1.5 py-0.5 text-[10px] text-info-fg">
            live mirror · read-only
          </span>
        ) : null}
        {driftCount !== null ? (
          driftCount > 0 ? (
            <span className="text-[11px] text-warning-fg">
              ⚠ differs from reality ({driftCount} change
              {driftCount === 1 ? "" : "s"})
            </span>
          ) : (
            <span className="text-[11px] text-success-fg">
              ✓ matches reality
            </span>
          )
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded p-1 hover:bg-bg-raised"
            title="Refresh solutions"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onExtract}
            className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs hover:bg-bg-raised"
            title="Extract current reality into a new named solution"
          >
            <Plus className="size-3.5" /> Extract
          </button>
          <button
            type="button"
            onClick={() => void edits.runDiff()}
            disabled={edits.busy}
            className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs hover:bg-bg-raised disabled:opacity-50"
          >
            <GitCompare className="size-3.5" /> Diff
          </button>
          {!isCurrent ? (
            <>
              <button
                type="button"
                onClick={() => void edits.save()}
                disabled={edits.busy}
                className="inline-flex items-center gap-1 rounded bg-fg-default px-2 py-1 text-xs font-medium text-bg-base hover:opacity-90 disabled:opacity-50"
              >
                <Save className="size-3.5" /> Save
              </button>
              <button
                type="button"
                onClick={() => void edits.apply()}
                disabled={edits.busy}
                className="inline-flex items-center gap-1 rounded border border-success-fg bg-success-fg/15 px-2 py-1 text-xs font-semibold text-success-fg hover:bg-success-fg/25 disabled:opacity-50"
                title="Write this solution into the running system (main agent + workers). Plugins unchanged in this phase."
              >
                <Rocket className="size-3.5" /> Apply
              </button>
              <button
                type="button"
                onClick={() => onDelete(spec.slug)}
                className="inline-flex items-center gap-1 rounded border border-danger-fg/40 px-2 py-1 text-xs text-danger-fg hover:bg-danger-fg/5"
              >
                <Trash2 className="size-3.5" /> Delete
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* 3-pane body */}
      <div className="grid min-h-0 grid-cols-1 md:grid-cols-[260px_1fr_300px]">
        <div className="max-h-[72vh] overflow-y-auto border-b border-border-subtle bg-bg-elevated md:border-b-0 md:border-r">
          <SolutionTree
            detail={detail}
            edits={edits}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            selected={selectedNode}
            onSelect={setSelectedNode}
          />
        </div>
        <div className="max-h-[72vh] overflow-y-auto bg-bg-base p-4 md:p-5">
          <SolutionEditor
            selected={selectedNode}
            detail={detail}
            edits={edits}
            onSelect={setSelectedNode}
          />
        </div>
        <div className="max-h-[72vh] overflow-y-auto border-t border-border-subtle bg-bg-elevated md:border-l md:border-t-0">
          <SolutionInspector
            selected={selectedNode}
            detail={detail}
            edits={edits}
          />
        </div>
      </div>
    </div>
  );
}
