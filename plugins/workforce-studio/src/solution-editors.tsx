// Solution view — pane ② Editor (focused object).
//
// Renders exactly one object at a time, keyed off the selected
// tree node id. Every editor here is a refactor of an editor that
// already existed inline in the old SolutionDetailPanel /
// WorkerEditor / SolutionBlockCard / ResourcePicker /
// NewFragmentCard. The edit *state* is unchanged — these just
// read/write through the shared `useSolutionEdits()` hook.

import type { ReactElement, ReactNode } from "react";
import { Lock } from "lucide-react";
import type {
  BlockOrigin,
  OverrideKey,
  ResourceOption,
  SolutionDetail,
  SolutionEdits,
  SolutionPromptBlock,
  WorkerEdit,
} from "./solution-state.js";
import { toggleInSet } from "./solution-state.js";

/** Translator function returned by usePluginT — passed to helpers. */
type Translator = (key: string, params?: Record<string, string | number>) => string;

const OVERRIDE_TITLE_KEY: Record<OverrideKey, string> = {
  executionBias: "editor.override.executionBias",
  replyStyle: "editor.override.replyStyle",
  userOnboarding: "editor.override.userOnboarding",
};

/** Dispatch the selected node id to the matching editor. */
export function SolutionEditor({
  selected,
  detail,
  edits,
  onSelect,
  t,
}: {
  selected: string;
  detail: SolutionDetail;
  edits: SolutionEdits;
  onSelect: (id: string) => void;
  t: Translator;
}): ReactElement {
  const isCurrent = detail.isCurrent;

  if (selected === "root" || selected === "main") {
    return <MetadataEditor detail={detail} edits={edits} onSelect={onSelect} t={t} />;
  }
  if (selected === "plugins") {
    return <PluginsEditor detail={detail} edits={edits} t={t} />;
  }
  if (selected === "main:tenant-prompt") {
    return <TenantPromptEditor edits={edits} isCurrent={isCurrent} t={t} />;
  }
  if (selected.startsWith("main:override:")) {
    const key = selected.slice("main:override:".length) as OverrideKey;
    return (
      <OverrideEditor
        okey={key}
        detail={detail}
        edits={edits}
        isCurrent={isCurrent}
        t={t}
      />
    );
  }
  if (selected.startsWith("main:fragment:")) {
    const id = selected.slice("main:fragment:".length);
    return <FragmentEditor fragmentId={id} edits={edits} isCurrent={isCurrent} t={t} />;
  }
  if (selected === "main:tools") {
    return (
      <EditorShell title={t("editor.mainTools.title")} sub={t("editor.mainTools.sub")}>
        <ResourcePicker
          title={t("tree.node.tools")}
          options={detail.availableTools}
          excluded={edits.toolsDeny}
          disabled={isCurrent}
          onToggle={(n) => edits.setToolsDeny((p) => toggleInSet(p, n))}
          t={t}
        />
      </EditorShell>
    );
  }
  if (selected === "main:skills") {
    return (
      <EditorShell title={t("editor.mainSkills.title")} sub={t("editor.mainSkills.sub")}>
        <ResourcePicker
          title={t("tree.node.skills")}
          options={detail.availableSkills}
          excluded={edits.skillsDeny}
          disabled={isCurrent}
          onToggle={(n) => edits.setSkillsDeny((p) => toggleInSet(p, n))}
          t={t}
        />
      </EditorShell>
    );
  }
  if (selected === "workers") {
    return <WorkersOverview detail={detail} edits={edits} t={t} />;
  }
  if (selected.startsWith("worker:")) {
    return (
      <WorkerNodeEditor selected={selected} detail={detail} edits={edits} t={t} />
    );
  }
  return (
    <EditorShell title={t("editor.none.title")} sub={t("editor.none.sub")}>
      <div className="text-xs text-fg-muted">{t("editor.none.body")}</div>
    </EditorShell>
  );
}

// ─── shell ──────────────────────────────────────────────────────

function EditorShell({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {sub ? <div className="mb-4 mt-1 text-xs text-fg-muted">{sub}</div> : null}
      <div className="flex flex-col gap-3">{children}</div>
    </div>
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

// ─── metadata (root / main agent overview) ──────────────────────

function MetadataEditor({
  detail,
  edits,
  onSelect,
  t,
}: {
  detail: SolutionDetail;
  edits: SolutionEdits;
  onSelect: (id: string) => void;
  t: Translator;
}): ReactElement {
  const { spec, isCurrent } = detail;
  const addFragment = () => {
    const id = `frag-${Date.now()}`;
    edits.setFragments((prev) => [
      ...prev,
      { id, title: t("editor.metadata.fragmentTitle"), body: "" },
    ]);
    onSelect(`main:fragment:${id}`);
  };
  return (
    <EditorShell
      title={`📦 ${edits.name || spec.name}`}
      sub={
        spec.extractedFrom
          ? t("editor.metadata.extractedFrom", {
              tenantId: spec.extractedFrom.tenantId,
              version: spec.extractedFrom.tianshuVersion,
            })
          : t("editor.metadata.handAuthored")
      }
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t("editor.field.name")}>
          <input
            value={edits.name}
            disabled={isCurrent}
            onChange={(e) => edits.setName(e.target.value)}
            className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs disabled:opacity-60"
          />
        </Field>
        <Field label={t("editor.field.description")}>
          <input
            value={edits.description}
            disabled={isCurrent}
            onChange={(e) => edits.setDescription(e.target.value)}
            className="w-full rounded border border-border-subtle bg-bg-base px-2 py-1 text-xs disabled:opacity-60"
          />
        </Field>
      </div>
      <div className="rounded border border-info-fg/30 bg-info-fg/5 px-3 py-2 text-[11px] text-info-fg">
        <strong>{t("editor.metadata.save")}</strong>{" "}
        {t("editor.metadata.saveApplyHint")}{" "}
        <strong>{t("editor.metadata.apply")}</strong>{" "}
        {t("editor.metadata.applyHint")}
      </div>
      {!isCurrent ? (
        <button
          type="button"
          onClick={addFragment}
          className="self-start rounded-md border border-dashed border-border-subtle px-3 py-1.5 text-xs text-fg-muted hover:border-fg-muted hover:text-fg-default"
        >
          {t("editor.metadata.addFragment")}
        </button>
      ) : null}
      {isCurrent ? (
        <div className="rounded border border-info-fg/30 bg-info-fg/5 px-3 py-2 text-[11px] text-info-fg">
          {t("editor.metadata.currentMirror.lead")}{" "}
          <strong>{t("editor.metadata.currentMirror.current")}</strong>{" "}
          {t("editor.metadata.currentMirror.mid")}{" "}
          <strong>{t("editor.metadata.currentMirror.extract")}</strong>{" "}
          {t("editor.metadata.currentMirror.tail")}
        </div>
      ) : null}
    </EditorShell>
  );
}

// ─── plugins ────────────────────────────────────────────────────

function PluginsEditor({
  detail,
  edits,
  t,
}: {
  detail: SolutionDetail;
  edits: SolutionEdits;
  t: Translator;
}): ReactElement {
  const isCurrent = detail.isCurrent;
  return (
    <EditorShell
      title={t("editor.plugins.title")}
      sub={t("editor.plugins.sub")}
    >
      <ul className="flex flex-col gap-1">
        {detail.availablePlugins.map((p) => {
          const enabled = edits.pluginsEnabled.has(p.id);
          return (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-2 rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 text-xs"
            >
              <span
                className={
                  enabled ? "font-medium" : "text-fg-muted line-through"
                }
              >
                {p.displayName}
              </span>
              <code className="text-[10px] text-fg-muted">{p.id}</code>
              <OriginBadge origin={p.origin} t={t} />
              {p.state !== "active" ? (
                <span className="rounded bg-danger-fg/10 px-1.5 py-0.5 text-[10px] text-danger-fg">
                  {p.state}
                </span>
              ) : null}
              <button
                type="button"
                disabled={isCurrent}
                onClick={() =>
                  edits.setPluginsEnabled((prev) => toggleInSet(prev, p.id))
                }
                className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-medium shadow-sm transition-colors active:translate-y-px disabled:opacity-50 ${
                  enabled
                    ? "border-border-subtle bg-bg-elevated text-fg-default hover:border-danger-fg/40 hover:bg-danger-fg/10 hover:text-danger-fg"
                    : "border-success-fg/40 bg-success-fg/10 text-success-fg hover:bg-success-fg/20"
                }`}
                title={
                  enabled
                    ? t("editor.plugins.included.title")
                    : t("editor.plugins.excluded.title")
                }
              >
                {enabled ? t("editor.plugins.exclude") : t("editor.plugins.include")}
              </button>
            </li>
          );
        })}
      </ul>
    </EditorShell>
  );
}

// ─── main: tenant prompt ────────────────────────────────────────

function TenantPromptEditor({
  edits,
  isCurrent,
  t,
}: {
  edits: SolutionEdits;
  isCurrent: boolean;
  t: Translator;
}): ReactElement {
  return (
    <EditorShell
      title={t("editor.tenantPrompt.title")}
      sub={t("editor.tenantPrompt.sub")}
    >
      <textarea
        value={edits.tenantPrompt}
        disabled={isCurrent}
        onChange={(e) => edits.setTenantPrompt(e.target.value)}
        rows={18}
        placeholder={isCurrent ? "" : t("editor.tenantPrompt.placeholder")}
        className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
      />
    </EditorShell>
  );
}

// ─── main: host-block override ──────────────────────────────────

function OverrideEditor({
  okey,
  detail,
  edits,
  isCurrent,
  t,
}: {
  okey: OverrideKey;
  detail: SolutionDetail;
  edits: SolutionEdits;
  isCurrent: boolean;
  t: Translator;
}): ReactElement {
  const block = detail.mainBlocks.find((b) => b.overrideKey === okey);
  const value = edits.overrides[okey];
  const isOverridden = value !== null && value !== undefined;
  const defaultText = block?.defaultText ?? block?.text ?? "";
  const set = (next: string | null) =>
    edits.setOverrides((prev) => ({ ...prev, [okey]: next }));
  return (
    <EditorShell
      title={`⚙ ${t(OVERRIDE_TITLE_KEY[okey])}`}
      sub={t("editor.override.sub")}
    >
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            isOverridden
              ? "bg-warning-fg/15 text-warning-fg"
              : "bg-fg-muted/15 text-fg-muted"
          }`}
        >
          {isOverridden ? t("editor.override.overridden") : t("editor.override.hostDefault")}
        </span>
        {!isCurrent ? (
          isOverridden ? (
            <button
              type="button"
              onClick={() => set(null)}
              className="rounded border border-border-subtle px-2 py-0.5 text-[10px] hover:bg-bg-raised"
            >
              {t("editor.override.reset")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => set(defaultText)}
              className="rounded border border-border-subtle px-2 py-0.5 text-[10px] hover:bg-bg-raised"
            >
              {t("editor.override.override")}
            </button>
          )
        ) : null}
      </div>
      {isOverridden ? (
        <textarea
          value={value ?? ""}
          disabled={isCurrent}
          onChange={(e) => set(e.target.value)}
          rows={16}
          className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
        />
      ) : (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-elevated p-2 font-mono text-[11px] leading-snug">
          {defaultText}
        </pre>
      )}
    </EditorShell>
  );
}

// ─── main: custom fragment ──────────────────────────────────────

function FragmentEditor({
  fragmentId,
  edits,
  isCurrent,
  t,
}: {
  fragmentId: string;
  edits: SolutionEdits;
  isCurrent: boolean;
  t: Translator;
}): ReactElement {
  const frag = edits.fragments.find((f) => f.id === fragmentId);
  if (!frag) {
    return (
      <EditorShell title={t("editor.fragment.title")} sub={t("editor.fragment.removed.sub")}>
        <div className="text-xs text-fg-muted">{t("editor.fragment.notFound")}</div>
      </EditorShell>
    );
  }
  const patch = (p: Partial<typeof frag>) =>
    edits.setFragments((prev) =>
      prev.map((x) => (x.id === fragmentId ? { ...x, ...p } : x)),
    );
  return (
    <EditorShell
      title={t("editor.fragment.title")}
      sub={t("editor.fragment.sub")}
    >
      <Field label={t("editor.fragment.field.title")}>
        <input
          value={frag.title}
          disabled={isCurrent}
          onChange={(e) => patch({ title: e.target.value })}
          placeholder={t("editor.fragment.titlePlaceholder")}
          className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1 text-xs disabled:opacity-60"
        />
      </Field>
      <textarea
        value={frag.body}
        disabled={isCurrent}
        onChange={(e) => patch({ body: e.target.value })}
        rows={14}
        placeholder={t("editor.fragment.bodyPlaceholder")}
        className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
      />
      {!isCurrent ? (
        <button
          type="button"
          onClick={() =>
            edits.setFragments((prev) => prev.filter((x) => x.id !== fragmentId))
          }
          className="self-start rounded border border-danger-fg/40 px-2 py-0.5 text-[10px] text-danger-fg hover:bg-danger-fg/5"
        >
          {t("editor.fragment.remove")}
        </button>
      ) : null}
    </EditorShell>
  );
}

// ─── workers overview ───────────────────────────────────────────

function WorkersOverview({
  detail,
  edits,
  t,
}: {
  detail: SolutionDetail;
  edits: SolutionEdits;
  t: Translator;
}): ReactElement {
  const { spec } = detail;
  const isCurrent = detail.isCurrent;
  return (
    <EditorShell
      title={t("editor.workers.title")}
      sub={t("editor.workers.sub")}
    >
      <ul className="flex flex-col gap-1">
        {spec.workers.map((w) => {
          const e = edits.workerEdits[w.slug];
          const excluded = e ? !e.enabled : !w.enabled;
          const toggle = () => {
            const cur = edits.workerEdits[w.slug];
            if (!cur) return;
            edits.setWorkerEdits((prev) => ({
              ...prev,
              [w.slug]: { ...cur, enabled: !cur.enabled },
            }));
          };
          return (
            <li
              key={w.slug}
              className="flex items-center gap-2 rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 text-xs"
            >
              <span
                className={`font-medium ${
                  excluded ? "text-fg-muted line-through" : ""
                }`}
              >
                {e?.name || w.name}
              </span>
              <code className="text-[10px] text-fg-muted">{w.slug}</code>
              <span className="text-[10px] text-fg-muted">{w.kind}</span>
              <button
                type="button"
                disabled={isCurrent}
                onClick={toggle}
                className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-medium shadow-sm transition-colors active:translate-y-px disabled:opacity-50 ${
                  excluded
                    ? "border-success-fg/40 bg-success-fg/10 text-success-fg hover:bg-success-fg/20"
                    : "border-border-subtle bg-bg-raised text-fg-default hover:border-danger-fg/40 hover:bg-danger-fg/10 hover:text-danger-fg"
                }`}
                title={
                  excluded
                    ? t("editor.workers.excluded.title")
                    : t("editor.workers.included.title")
                }
              >
                {excluded ? t("editor.workers.include") : t("editor.workers.exclude")}
              </button>
            </li>
          );
        })}
        {spec.workers.length === 0 ? (
          <li className="text-xs text-fg-muted">{t("editor.workers.none")}</li>
        ) : null}
      </ul>
    </EditorShell>
  );
}

// ─── worker node (root + soul + host + tools + skills) ──────────

function WorkerNodeEditor({
  selected,
  detail,
  edits,
  t,
}: {
  selected: string;
  detail: SolutionDetail;
  edits: SolutionEdits;
  t: Translator;
}): ReactElement {
  const isCurrent = detail.isCurrent;
  // selected = worker:<slug>[:sub]
  const rest = selected.slice("worker:".length);
  const [slug, sub] = splitWorker(rest);
  const worker = detail.spec.workers.find((w) => w.slug === slug);
  const view = detail.workerViews[slug];
  const edit = edits.workerEdits[slug];
  if (!worker || !view || !edit) {
    return (
      <EditorShell title={t("editor.worker.notFound.title")} sub={t("editor.worker.notFound.sub")}>
        <div className="text-xs text-fg-muted">{t("editor.worker.notFound.body")}</div>
      </EditorShell>
    );
  }
  const set = (patch: Partial<WorkerEdit>) =>
    edits.setWorkerEdits((prev) => ({ ...prev, [slug]: { ...edit, ...patch } }));
  const excluded = !edit.enabled;

  if (sub === "soul") {
    return (
      <EditorShell
        title={t("editor.worker.soul.title", { name: edit.name })}
        sub={t("editor.worker.soul.sub")}
      >
        <textarea
          value={edit.soul}
          disabled={isCurrent}
          onChange={(e) => set({ soul: e.target.value })}
          rows={18}
          placeholder={isCurrent ? "" : t("editor.worker.soul.placeholder")}
          className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
        />
      </EditorShell>
    );
  }

  if (sub === "override:executionBias") {
    // Per-worker execution-bias override — mirrors the main
    // agent's override editor structure. The other host blocks
    // (runtime / plugin fragments / skill catalogue) are
    // read-only and live in the Inspector's rendered preview, so
    // this node is just the one overridable block.
    const ebBlock = view.blocks.find(
      (b) => b.overrideKey === "executionBias",
    );
    const defaultText = ebBlock?.defaultText ?? ebBlock?.text ?? "";
    const isOverridden =
      edit.executionBias !== null && edit.executionBias !== undefined;
    return (
      <EditorShell
        title={t("editor.worker.eb.title", { name: edit.name })}
        sub={t("editor.worker.eb.sub")}
      >
        <div className="rounded border border-border-subtle bg-bg-elevated">
          <div className="flex items-center gap-2 px-3 py-2 text-xs">
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                isOverridden
                  ? "bg-warning-fg/15 text-warning-fg"
                  : "bg-fg-muted/15 text-fg-muted"
              }`}
            >
              {isOverridden ? t("editor.override.overridden") : t("editor.override.hostDefault")}
            </span>
            {!isCurrent ? (
              isOverridden ? (
                <button
                  type="button"
                  onClick={() => set({ executionBias: null })}
                  className="ml-auto rounded border border-border-subtle px-2 py-0.5 text-[10px] hover:bg-bg-raised"
                >
                  {t("editor.override.reset")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => set({ executionBias: defaultText })}
                  className="ml-auto rounded border border-border-subtle px-2 py-0.5 text-[10px] hover:bg-bg-raised"
                >
                  {t("editor.override.override")}
                </button>
              )
            ) : null}
          </div>
          {isOverridden ? (
            <textarea
              value={edit.executionBias ?? ""}
              disabled={isCurrent}
              onChange={(e) => set({ executionBias: e.target.value })}
              rows={14}
              className="w-full border-t border-border-subtle bg-bg-base px-2 py-1.5 font-mono text-[11px] leading-snug disabled:opacity-60"
            />
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border-subtle bg-bg-base p-2 font-mono text-[11px] leading-snug">
              {defaultText}
            </pre>
          )}
        </div>
      </EditorShell>
    );
  }

  if (sub === "tools") {
    return (
      <EditorShell title={t("editor.worker.tools.title", { name: edit.name })} sub={t("editor.worker.tools.sub")}>
        <ResourcePicker
          title={t("tree.node.tools")}
          options={view.availableTools}
          excluded={edit.toolsDeny}
          disabled={isCurrent}
          onToggle={(n) => set({ toolsDeny: toggleInSet(edit.toolsDeny, n) })}
          t={t}
        />
      </EditorShell>
    );
  }

  if (sub === "skills") {
    return (
      <EditorShell
        title={t("editor.worker.skills.title", { name: edit.name })}
        sub={t("editor.worker.skills.sub")}
      >
        <ResourcePicker
          title={t("tree.node.skills")}
          options={view.availableSkills}
          excluded={edit.skillsDeny}
          disabled={isCurrent}
          onToggle={(n) => set({ skillsDeny: toggleInSet(edit.skillsDeny, n) })}
          t={t}
        />
      </EditorShell>
    );
  }

  // worker root → fields + exclude toggle
  return (
    <EditorShell
      title={`${excluded ? "📋" : "🤖"} ${edit.name}`}
      sub={t("editor.worker.root.sub")}
    >
      <div className="flex items-center gap-2">
        <code className="text-[10px] text-fg-muted">{worker.slug}</code>
        <span className="text-[10px] text-fg-muted">{worker.kind}</span>
        <button
          type="button"
          disabled={isCurrent}
          onClick={() => set({ enabled: !edit.enabled })}
          className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-medium shadow-sm transition-colors active:translate-y-px disabled:opacity-50 ${
            excluded
              ? "border-success-fg/40 bg-success-fg/10 text-success-fg hover:bg-success-fg/20"
              : "border-border-subtle bg-bg-elevated text-fg-default hover:border-danger-fg/40 hover:bg-danger-fg/10 hover:text-danger-fg"
          }`}
          title={
            excluded
              ? t("editor.worker.excluded.title")
              : t("editor.worker.included.title")
          }
        >
          {excluded ? t("editor.worker.include") : t("editor.worker.exclude")}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t("editor.worker.field.name")}>
          <input
            value={edit.name}
            disabled={isCurrent}
            onChange={(ev) => set({ name: ev.target.value })}
            className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1 text-xs disabled:opacity-60"
          />
        </Field>
        <Field label={t("editor.worker.field.modelId")}>
          <input
            value={edit.modelId ?? ""}
            disabled={isCurrent}
            onChange={(ev) =>
              set({
                modelId:
                  ev.target.value.trim().length > 0 ? ev.target.value : null,
              })
            }
            className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1 font-mono text-xs disabled:opacity-60"
          />
        </Field>
        <Field label={t("editor.worker.field.description")}>
          <input
            value={edit.description ?? ""}
            disabled={isCurrent}
            onChange={(ev) =>
              set({
                description:
                  ev.target.value.trim().length > 0 ? ev.target.value : null,
              })
            }
            className="w-full rounded border border-border-subtle bg-bg-elevated px-2 py-1 text-xs disabled:opacity-60"
          />
        </Field>
      </div>
    </EditorShell>
  );
}

function splitWorker(rest: string): [string, string | undefined] {
  const i = rest.indexOf(":");
  if (i === -1) return [rest, undefined];
  return [rest.slice(0, i), rest.slice(i + 1)];
}

// ─── shared: origin badge + resource picker (unchanged logic) ───

function OriginBadge({ origin, t }: { origin: BlockOrigin; t: Translator }): ReactElement {
  const map: Record<BlockOrigin, { label: string; className: string }> = {
    core: { label: t("originBadge.core"), className: "bg-info-fg/10 text-info-fg" },
    "builtin-plugin": {
      label: t("originBadge.builtin"),
      className: "bg-success-fg/10 text-success-fg",
    },
    "tenant-plugin": {
      label: t("originBadge.tenantPlugin"),
      className: "bg-warning-fg/10 text-warning-fg",
    },
    host: { label: t("originBadge.host"), className: "bg-info-fg/10 text-info-fg" },
    workspace: {
      label: t("originBadge.workspace"),
      className: "bg-warning-fg/10 text-warning-fg",
    },
    tenant: { label: t("originBadge.tenant"), className: "bg-warning-fg/10 text-warning-fg" },
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

export function ResourcePicker({
  title,
  options,
  excluded,
  disabled,
  onToggle,
  t,
}: {
  title: string;
  options: ResourceOption[];
  excluded: Set<string>;
  disabled: boolean;
  onToggle: (name: string) => void;
  t: Translator;
}): ReactElement {
  const excludedCount = options.filter(
    (o) => !o.locked && excluded.has(o.name),
  ).length;
  const groups = new Map<string, ResourceOption[]>();
  for (const o of options) {
    const key = o.pluginId || groupKeyFromOrigin(o.origin);
    const cur = groups.get(key);
    if (cur) cur.push(o);
    else groups.set(key, [o]);
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    const rank = (k: string) => (k === "core" || k === "host" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.localeCompare(b);
  });
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle">
      <div className="flex items-center gap-2 bg-bg-elevated px-3 py-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-[11px] text-fg-muted">{options.length}</span>
        {excludedCount > 0 ? (
          <span className="ml-auto rounded-full bg-danger-fg/10 px-2 py-0.5 text-[10px] font-medium text-danger-fg">
            {t("resource.excludedCount", { n: excludedCount })}
          </span>
        ) : null}
      </div>
      <div className="max-h-[60vh] overflow-auto bg-bg-base">
        {orderedKeys.map((key) => {
          const items = groups.get(key)!;
          return (
            <div key={key}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-bg-base/95 px-3 pb-1 pt-2 backdrop-blur">
                <span className="text-[11px] font-semibold text-fg-default">
                  {groupLabel(key, t)}
                </span>
                <span className="rounded-full bg-fg-muted/10 px-1.5 text-[10px] text-fg-muted">
                  {items.length}
                </span>
              </div>
              <ul className="px-1.5 pb-1">
                {items.map((o) => (
                  <ResourceRow
                    key={o.name}
                    option={o}
                    isExcluded={excluded.has(o.name)}
                    disabled={disabled}
                    onToggle={onToggle}
                    t={t}
                  />
                ))}
              </ul>
            </div>
          );
        })}
        {options.length === 0 ? (
          <div className="px-3 py-3 text-xs text-fg-muted">{t("resource.none")}</div>
        ) : null}
      </div>
    </div>
  );
}

function ResourceRow({
  option: o,
  isExcluded,
  disabled,
  onToggle,
  t,
}: {
  option: ResourceOption;
  isExcluded: boolean;
  disabled: boolean;
  onToggle: (name: string) => void;
  t: Translator;
}): ReactElement {
  return (
    <li
      className={`group flex items-center gap-2 rounded px-2 py-1 ${
        o.locked ? "" : "hover:bg-bg-elevated"
      }`}
    >
      <code
        className={`font-mono text-[11px] ${
          isExcluded
            ? "text-fg-muted line-through"
            : o.locked
              ? "text-fg-muted"
              : "text-fg-default"
        }`}
      >
        {o.name}
      </code>
      {o.locked ? (
        <span
          className="ml-auto"
          title={t("resource.locked.title")}
        >
          <Lock className="size-3 text-fg-muted/50" aria-label={t("resource.locked.label")} />
        </span>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onToggle(o.name)}
          className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-medium shadow-sm transition-colors active:translate-y-px disabled:opacity-50 ${
            isExcluded
              ? "border-success-fg/40 bg-success-fg/10 text-success-fg hover:bg-success-fg/20"
              : "border-border-subtle bg-bg-elevated text-fg-default hover:border-danger-fg/40 hover:bg-danger-fg/10 hover:text-danger-fg"
          }`}
          title={
            isExcluded
              ? t("resource.row.excluded.title")
              : t("resource.row.included.title")
          }
        >
          {isExcluded ? t("resource.include") : t("resource.exclude")}
        </button>
      )}
    </li>
  );
}

function groupKeyFromOrigin(origin: ResourceOption["origin"]): string {
  return origin === "core" ? "core" : "host";
}

function groupLabel(key: string, t: Translator): string {
  if (key === "core") return t("resource.group.core");
  if (key === "host") return t("resource.group.host");
  return key;
}
