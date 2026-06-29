// Solution view (ADR-0008 Phase 2) — the designtime half of the
// studio. Lists named solutions + the reserved `current` mirror,
// lets the operator extract reality into a new named solution,
// inspect a solution's declared config, edit basic metadata +
// allow-lists, delete, and diff against reality.
//
// No Apply in Phase 2: saving writes solution.json to disk but
// has no runtime effect. The UI says so explicitly so nobody
// expects a saved solution to change behaviour.

import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  GitCompare,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";

// ─── wire shapes (mirror SDK solution.ts via duck-typing) ───────

interface SolutionSummary {
  slug: string;
  name: string;
  description: string;
  updatedAt: number;
  workerCount: number;
  pluginCount: number;
  isCurrent: boolean;
  kind: "extracted" | "authored";
}
interface SolutionWorker {
  slug: string;
  kind: string;
  name: string;
  description: string | null;
  modelId: string | null;
  enabled: boolean;
  systemPromptPath: string | null;
  toolsAllow: string[] | null;
  skillsAllow: string[] | null;
  source: "builtin" | "user";
}
interface SolutionSpec {
  schema: string;
  slug: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  extractedFrom: {
    tenantId: string;
    tianshuVersion: string;
    extractedAt: number;
  } | null;
  plugins: { enabled: string[] };
  mainAgent: {
    tenantPromptPath: string | null;
    skillsAllow: string[] | null;
    skillsDeny: string[];
    toolsAllow: string[] | null;
  };
  workers: SolutionWorker[];
}
interface SolutionDetail {
  spec: SolutionSpec;
  tenantPrompt: string | null;
  workerPrompts: Record<string, string>;
  isCurrent: boolean;
}
interface DiffEntry {
  path: string;
  op: "add" | "remove" | "change";
  before: string | null;
  after: string | null;
}
interface SolutionDiff {
  baseLabel: string;
  targetLabel: string;
  entries: DiffEntry[];
}

const API_BASE = "/api/p/workforce-studio";

async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = (await res.json()) as { ok: boolean; error?: string } & Record<
    string,
    unknown
  >;
  if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as unknown as T;
}

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
      // Default selection: current mirror if nothing selected.
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
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="rounded-md border border-danger-fg/40 bg-danger-fg/5 p-3 text-sm text-danger-fg">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" />
            Solution error
          </div>
          <div className="mt-1 font-mono text-xs opacity-80">{error}</div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
        <SolutionList
          summaries={summaries}
          selected={selected}
          onSelect={setSelected}
          onExtract={onExtract}
          onRefresh={() => void refreshList()}
        />
        <div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 className="size-4 animate-spin" /> Loading solution…
            </div>
          ) : detail ? (
            <SolutionDetailPanel
              detail={detail}
              onDelete={onDelete}
              onSaved={async () => {
                await refreshList();
                if (selected) await loadDetail(selected);
              }}
            />
          ) : (
            <div className="text-sm text-fg-muted">
              Select a solution to inspect.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SolutionList({
  summaries,
  selected,
  onSelect,
  onExtract,
  onRefresh,
}: {
  summaries: SolutionSummary[] | null;
  selected: string | null;
  onSelect: (slug: string) => void;
  onExtract: () => void;
  onRefresh: () => void;
}): ReactElement {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Layers className="size-4 text-fg-muted" />
        <span className="text-sm font-semibold">Solutions</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded p-1 hover:bg-bg-raised"
            title="Refresh"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onExtract}
            className="inline-flex items-center gap-1 rounded bg-fg-default px-2 py-1 text-xs font-medium text-bg-base hover:opacity-90"
            title="Extract current reality into a new named solution"
          >
            <Plus className="size-3.5" /> Extract
          </button>
        </div>
      </div>
      {summaries === null ? (
        <div className="p-3 text-xs text-fg-muted">Loading…</div>
      ) : (
        <ul className="max-h-[70vh] overflow-auto">
          {summaries.map((s) => (
            <li key={s.slug}>
              <button
                type="button"
                onClick={() => onSelect(s.slug)}
                className={`flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-3 py-2 text-left text-xs hover:bg-bg-raised ${
                  selected === s.slug ? "bg-bg-raised" : ""
                }`}
              >
                <div className="flex w-full items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  {s.isCurrent ? (
                    <span className="rounded bg-info-fg/10 px-1 text-[10px] text-info-fg">
                      live
                    </span>
                  ) : (
                    <span className="rounded bg-fg-muted/10 px-1 text-[10px]">
                      {s.kind}
                    </span>
                  )}
                </div>
                <code className="text-[10px] text-fg-muted">{s.slug}</code>
                <span className="text-[10px] text-fg-muted">
                  {s.workerCount} workers · {s.pluginCount} plugins
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SolutionDetailPanel({
  detail,
  onDelete,
  onSaved,
}: {
  detail: SolutionDetail;
  onDelete: (slug: string) => void;
  onSaved: () => void;
}): ReactElement {
  const { spec, isCurrent } = detail;
  const [diff, setDiff] = useState<SolutionDiff | null>(null);
  const [busy, setBusy] = useState(false);

  // Editable fields (named solutions only). Phase 2 surface:
  // name, description, the main-agent tenant-prompt override,
  // and the main-agent skill/tool allow + skill deny lists
  // (edited as comma/newline-separated text, parsed on save).
  const [name, setName] = useState(spec.name);
  const [description, setDescription] = useState(spec.description);
  const [tenantPrompt, setTenantPrompt] = useState(detail.tenantPrompt ?? "");
  const [skillsAllow, setSkillsAllow] = useState(
    listToText(spec.mainAgent.skillsAllow),
  );
  const [skillsDeny, setSkillsDeny] = useState(
    listToText(spec.mainAgent.skillsDeny),
  );
  const [toolsAllow, setToolsAllow] = useState(
    listToText(spec.mainAgent.toolsAllow),
  );
  useEffect(() => {
    setName(spec.name);
    setDescription(spec.description);
    setTenantPrompt(detail.tenantPrompt ?? "");
    setSkillsAllow(listToText(spec.mainAgent.skillsAllow));
    setSkillsDeny(listToText(spec.mainAgent.skillsDeny));
    setToolsAllow(listToText(spec.mainAgent.toolsAllow));
    setDiff(null);
  }, [
    spec.slug,
    spec.name,
    spec.description,
    detail.tenantPrompt,
    spec.mainAgent.skillsAllow,
    spec.mainAgent.skillsDeny,
    spec.mainAgent.toolsAllow,
  ]);

  const runDiff = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api<{ diff: SolutionDiff }>(
        `/solutions/${encodeURIComponent(spec.slug)}/diff?against=reality`,
      );
      setDiff(r.diff);
    } finally {
      setBusy(false);
    }
  }, [spec.slug]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      // Round-trip the spec back through save(), swapping in the
      // edited metadata + inlining the prompt bodies the host
      // expects on the write path.
      const input = {
        slug: spec.slug,
        name,
        description,
        plugins: spec.plugins,
        mainAgent: {
          tenantPrompt: tenantPrompt.trim().length > 0 ? tenantPrompt : null,
          // Empty input parses to null (= no restriction); a
          // non-empty list narrows the surface.
          skillsAllow: textToListOrNull(skillsAllow),
          skillsDeny: textToList(skillsDeny),
          toolsAllow: textToListOrNull(toolsAllow),
        },
        workers: spec.workers.map((w) => ({
          slug: w.slug,
          kind: w.kind,
          name: w.name,
          description: w.description,
          modelId: w.modelId,
          enabled: w.enabled,
          systemPrompt: detail.workerPrompts[w.slug] ?? null,
          toolsAllow: w.toolsAllow,
          skillsAllow: w.skillsAllow,
          source: w.source,
        })),
      };
      await api("/solutions/save", {
        method: "POST",
        body: JSON.stringify(input),
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }, [spec, name, description, detail, onSaved]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border-subtle bg-bg-elevated p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Layers className="size-4 text-fg-muted" />
          <h3 className="text-sm font-semibold">{spec.name}</h3>
          <code className="text-xs text-fg-muted">{spec.slug}</code>
          {isCurrent ? (
            <span className="rounded bg-info-fg/10 px-1.5 py-0.5 text-[10px] text-info-fg">
              live mirror · read-only
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void runDiff()}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs hover:bg-bg-raised disabled:opacity-50"
            >
              <GitCompare className="size-3.5" /> Diff vs reality
            </button>
            {!isCurrent ? (
              <>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded bg-fg-default px-2 py-1 text-xs font-medium text-bg-base hover:opacity-90 disabled:opacity-50"
                >
                  <Save className="size-3.5" /> Save
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

        {spec.extractedFrom ? (
          <div className="mt-2 text-[11px] text-fg-muted">
            Extracted from tenant{" "}
            <code>{spec.extractedFrom.tenantId}</code> · v
            {spec.extractedFrom.tianshuVersion} ·{" "}
            {new Date(spec.extractedFrom.extractedAt).toLocaleString()}
          </div>
        ) : (
          <div className="mt-2 text-[11px] text-fg-muted">
            Hand-authored solution.
          </div>
        )}

        {/* Editable metadata (named solutions only) */}
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Name">
            <input
              value={name}
              disabled={isCurrent}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs disabled:opacity-60"
            />
          </Field>
          <Field label="Description">
            <input
              value={description}
              disabled={isCurrent}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs disabled:opacity-60"
            />
          </Field>
        </div>

        <div className="mt-3 rounded border border-warning-fg/30 bg-warning-fg/5 px-3 py-2 text-[11px] text-warning-fg">
          Phase 2: saving writes the solution to disk but does
          <strong> not </strong>
          change the running system. Apply lands in a later phase.
        </div>
      </div>

      {/* Main agent */}
      <Section title="Main agent">
        <div className="flex flex-col gap-3">
          <Field label="Tenant prompt override">
            <textarea
              value={tenantPrompt}
              disabled={isCurrent}
              onChange={(e) => setTenantPrompt(e.target.value)}
              rows={6}
              placeholder={
                isCurrent
                  ? ""
                  : "Extra system-prompt text injected for the main agent. Leave empty for none."
              }
              className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
            />
          </Field>
          {isCurrent ? (
            <div className="text-[11px] text-fg-muted">
              For the live mirror this shows the extracted workspace
              context (AGENTS / SOUL / MEMORY / USER). Edit a named
              solution to set an explicit override.
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Skills allow (one per line; empty = all)">
              <textarea
                value={skillsAllow}
                disabled={isCurrent}
                onChange={(e) => setSkillsAllow(e.target.value)}
                rows={4}
                className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 font-mono text-[11px] disabled:opacity-60"
              />
            </Field>
            <Field label="Skills deny (one per line)">
              <textarea
                value={skillsDeny}
                disabled={isCurrent}
                onChange={(e) => setSkillsDeny(e.target.value)}
                rows={4}
                className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 font-mono text-[11px] disabled:opacity-60"
              />
            </Field>
            <Field label="Tools allow (one per line; empty = all)">
              <textarea
                value={toolsAllow}
                disabled={isCurrent}
                onChange={(e) => setToolsAllow(e.target.value)}
                rows={4}
                className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 font-mono text-[11px] disabled:opacity-60"
              />
            </Field>
          </div>
        </div>
      </Section>

      {/* Plugins */}
      <Section title={`Plugins (${spec.plugins.enabled.length})`}>
        <div className="flex flex-wrap gap-1">
          {spec.plugins.enabled.map((p) => (
            <code
              key={p}
              className="rounded bg-bg-base px-1.5 py-0.5 text-[11px]"
            >
              {p}
            </code>
          ))}
        </div>
      </Section>

      {/* Workers */}
      <Section title={`Workers (${spec.workers.length})`}>
        <ul className="flex flex-col gap-2">
          {spec.workers.map((w) => (
            <li
              key={w.slug}
              className="rounded border border-border-subtle bg-bg-base px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{w.name}</span>
                <code className="text-[10px] text-fg-muted">{w.slug}</code>
                <span className="text-[10px] text-fg-muted">{w.kind}</span>
                {w.modelId ? (
                  <code className="text-[10px] text-fg-muted">
                    {w.modelId}
                  </code>
                ) : (
                  <span className="text-[10px] text-fg-muted">
                    default model
                  </span>
                )}
                <span className="ml-auto text-[10px] text-fg-muted">
                  {w.toolsAllow?.length ?? "∗"} tools ·{" "}
                  {w.skillsAllow?.length ?? "∗"} skills
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {diff ? <DiffPanel diff={diff} /> : null}
    </div>
  );
}

function DiffPanel({ diff }: { diff: SolutionDiff }): ReactElement {
  return (
    <Section
      title={`Diff: ${diff.baseLabel} vs ${diff.targetLabel} (${diff.entries.length})`}
    >
      {diff.entries.length === 0 ? (
        <div className="text-xs text-fg-muted">
          No differences — solution matches reality.
        </div>
      ) : (
        <ul className="flex flex-col gap-1 text-[11px]">
          {diff.entries.map((e) => (
            <li
              key={e.path}
              className="rounded border border-border-subtle bg-bg-base px-2 py-1"
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    e.op === "add"
                      ? "rounded bg-success-fg/10 px-1 text-success-fg"
                      : e.op === "remove"
                      ? "rounded bg-danger-fg/10 px-1 text-danger-fg"
                      : "rounded bg-warning-fg/10 px-1 text-warning-fg"
                  }
                >
                  {e.op}
                </span>
                <code className="font-mono">{e.path}</code>
              </div>
              <div className="mt-0.5 grid grid-cols-2 gap-2 font-mono text-fg-muted">
                <span className="truncate">base: {e.before ?? "—"}</span>
                <span className="truncate">target: {e.after ?? "—"}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="rounded-lg border border-border-subtle bg-bg-elevated">
      <div className="border-b border-border-subtle px-4 py-2 text-sm font-semibold">
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-fg-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

// ─── allow-list <-> textarea helpers ────────────────────────────
// We render allow/deny lists as newline-separated text so the
// operator can edit them without JSON. `null` means "no
// restriction" and renders as an empty box; an empty box parses
// back to null (for allow/tool lists) or [] (for deny lists,
// where empty genuinely means "deny nothing").

function listToText(list: string[] | null): string {
  return list ? list.join("\n") : "";
}

function textToList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function textToListOrNull(text: string): string[] | null {
  const list = textToList(text);
  return list.length > 0 ? list : null;
}
