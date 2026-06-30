// Solution view — pane ③ Inspector.
//
// Three stacked sections:
//   1. Context blurb for the selected node.
//   2. Diff vs reality for the whole solution (reuses the same
//      `/solutions/:slug/diff?against=reality` call the old view
//      used; shown as a compact op list).
//   3. Rendered preview: read-only text for the focused block.

import type { ReactElement } from "react";
import type {
  OverrideKey,
  SolutionDetail,
  SolutionEdits,
} from "./solution-state.js";

export function SolutionInspector({
  selected,
  detail,
  edits,
}: {
  selected: string;
  detail: SolutionDetail;
  edits: SolutionEdits;
}): ReactElement {
  return (
    <div className="flex flex-col">
      <InspectorSection title="Inspector">
        <div className="text-xs text-fg-default">
          {contextBlurb(selected, detail, edits)}
        </div>
      </InspectorSection>

      <InspectorSection title="Diff vs reality">
        {edits.diff === null ? (
          <button
            type="button"
            onClick={() => void edits.runDiff()}
            disabled={edits.busy}
            className="rounded border border-border-subtle px-2 py-1 text-[11px] hover:bg-bg-raised disabled:opacity-50"
          >
            Compute diff
          </button>
        ) : edits.diff.entries.length === 0 ? (
          <div className="text-[11px] text-fg-muted">
            No differences — solution matches reality.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {edits.diff.entries.map((e) => (
              <li
                key={e.path}
                className="flex items-center gap-1.5 py-0.5 font-mono text-[11px]"
              >
                <span
                  className={`rounded px-1 text-[9px] ${
                    e.op === "add"
                      ? "bg-success-fg/15 text-success-fg"
                      : e.op === "remove"
                        ? "bg-danger-fg/15 text-danger-fg"
                        : "bg-warning-fg/15 text-warning-fg"
                  }`}
                >
                  {e.op === "add" ? "add" : e.op === "remove" ? "rem" : "chg"}
                </span>
                <code className="truncate">{e.path}</code>
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>

      <InspectorSection title="Rendered preview">
        <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-base p-2.5 font-mono text-[11px] leading-relaxed text-fg-muted">
          {renderedPreview(selected, detail, edits) || "—"}
        </pre>
      </InspectorSection>
    </div>
  );
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <div className="border-b border-border-subtle px-3.5 py-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
        {title}
      </h3>
      {children}
    </div>
  );
}

// ─── context blurb ──────────────────────────────────────────────

function contextBlurb(
  selected: string,
  detail: SolutionDetail,
  edits: SolutionEdits,
): string {
  if (selected === "plugins") {
    return `Plugin set drives the available tools (${detail.availableTools.length}), skills (${detail.availableSkills.length}) and prompt fragments below. ${edits.pluginsEnabled.size} of ${detail.availablePlugins.length} enabled.`;
  }
  if (selected === "root" || selected === "main") {
    return `Main agent: ${detail.mainBlocks.length} prompt blocks, ${detail.availableTools.length} tools, ${detail.availableSkills.length} skills, ${detail.spec.workers.length} workers.`;
  }
  if (selected === "main:tenant-prompt") {
    return "The tenant prompt is the editable body of the main-agent system prompt for this solution.";
  }
  if (selected.startsWith("main:override:")) {
    const key = selected.slice("main:override:".length) as OverrideKey;
    const overridden = edits.overrides[key] !== null;
    return overridden
      ? "Overridden for this solution. The host default is replaced by your text below."
      : "Using the host default. Override it to customise this block for the solution.";
  }
  if (selected.startsWith("main:fragment:")) {
    return "A custom prompt fragment appended to the main-agent prompt.";
  }
  if (selected === "main:tools") {
    return `${detail.availableTools.length} tools available · ${edits.toolsDeny.size} excluded.`;
  }
  if (selected === "main:skills") {
    return `${detail.availableSkills.length} skills available · ${edits.skillsDeny.size} excluded.`;
  }
  if (selected === "workers") {
    const excluded = detail.spec.workers.filter((w) => {
      const e = edits.workerEdits[w.slug];
      return e ? !e.enabled : !w.enabled;
    }).length;
    return `${detail.spec.workers.length} workers · ${excluded} excluded.`;
  }
  if (selected.startsWith("worker:")) {
    const rest = selected.slice("worker:".length);
    const slug = rest.includes(":") ? rest.slice(0, rest.indexOf(":")) : rest;
    const view = detail.workerViews[slug];
    const e = edits.workerEdits[slug];
    if (view && e) {
      const excluded = !e.enabled;
      return `${e.name}${excluded ? " (excluded)" : ""}: ${view.availableTools.length} tools, ${view.availableSkills.length} skills. ${e.toolsDeny.size + e.skillsDeny.size} excluded.`;
    }
    return "Worker node.";
  }
  return "Select a node to inspect.";
}

// ─── rendered preview ───────────────────────────────────────────

function renderedPreview(
  selected: string,
  detail: SolutionDetail,
  edits: SolutionEdits,
): string {
  if (selected === "main:tenant-prompt") {
    return edits.tenantPrompt;
  }
  if (selected.startsWith("main:override:")) {
    const key = selected.slice("main:override:".length) as OverrideKey;
    const ov = edits.overrides[key];
    if (ov !== null && ov !== undefined) return ov;
    const block = detail.mainBlocks.find((b) => b.overrideKey === key);
    return block?.defaultText ?? block?.text ?? "";
  }
  if (selected.startsWith("main:fragment:")) {
    const id = selected.slice("main:fragment:".length);
    return edits.fragments.find((f) => f.id === id)?.body ?? "";
  }
  if (selected === "root" || selected === "main") {
    // Compose the main-agent block list joined — a v1 rendered
    // preview of the whole main prompt.
    return detail.mainBlocks
      .map((b) => {
        if (b.kind === "tenant-prompt") return edits.tenantPrompt;
        if (b.overrideKey) {
          const ov = edits.overrides[b.overrideKey];
          if (ov !== null && ov !== undefined) return ov;
          return b.defaultText ?? b.text;
        }
        if (b.customFragmentId) {
          return (
            edits.fragments.find((f) => f.id === b.customFragmentId)?.body ??
            b.text
          );
        }
        return b.text;
      })
      .filter((t) => t && t.trim().length > 0)
      .join("\n\n");
  }
  if (selected.startsWith("worker:")) {
    const rest = selected.slice("worker:".length);
    const i = rest.indexOf(":");
    const slug = i === -1 ? rest : rest.slice(0, i);
    const sub = i === -1 ? undefined : rest.slice(i + 1);
    const view = detail.workerViews[slug];
    const e = edits.workerEdits[slug];
    if (!view || !e) return "";
    if (sub === "soul") return e.soul;
    if (sub === "host") {
      return view.blocks
        .filter((b) => b.kind !== "worker-soul")
        .map((b) => {
          // Reflect the per-worker execution-bias override in the
          // preview when set.
          if (b.overrideKey === "executionBias" && e.executionBias !== null) {
            return `## ${b.title}\n${e.executionBias}`;
          }
          return `## ${b.title}\n${b.text}`;
        })
        .join("\n\n");
    }
    if (sub === "tools" || sub === "skills") return "";
    // worker root → composed worker prompt
    return view.blocks
      .map((b) => {
        if (b.kind === "worker-soul") return e.soul;
        if (b.overrideKey === "executionBias" && e.executionBias !== null) {
          return e.executionBias;
        }
        return b.text;
      })
      .filter((t) => t && t.trim().length > 0)
      .join("\n\n");
  }
  return "";
}
