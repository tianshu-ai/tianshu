// Solution view — pane ① Explorer (solution structure tree).
//
// Builds a flat list of tree nodes from the SolutionDetail + the
// live edit state, and renders them VS-Code-explorer style.
// Selecting a node sets the focused-object id that pane ② keys
// off. Every worker is individually expandable into the same
// sub-node shape as the main agent (the one change Yu asked for
// on top of the mockup).

import type { ReactElement } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  OverrideKey,
  SolutionDetail,
  SolutionEdits,
} from "./solution-state.js";

// ─── node id scheme ─────────────────────────────────────────────
// plugins
// main:tenant-prompt | main:override:<key> | main:fragment:<id>
//   | main:tools | main:skills
// worker:<slug> | worker:<slug>:soul | worker:<slug>:override:executionBias
//   | worker:<slug>:tools | worker:<slug>:skills

export type NodeId = string;

interface TreeNode {
  id: NodeId;
  label: string;
  icon: string;
  depth: 0 | 1 | 2;
  /** count shown muted after the label */
  count?: string;
  badge?: { kind: "overridden" | "excluded" | "locked"; text: string };
  /** excluded → strikethrough + dim row */
  excluded?: boolean;
  /** expandable parent (worker root / workers group) */
  expandable?: boolean;
}

const OVERRIDE_META: Record<OverrideKey, { icon: string; label: string }> = {
  executionBias: { icon: "⚙", label: "Execution bias" },
  replyStyle: { icon: "💬", label: "Reply style" },
  userOnboarding: { icon: "👋", label: "User onboarding" },
};

/**
 * Build the visible node list. `expanded` is the set of expandable
 * node ids (workers group + each worker root) the operator has
 * opened; children only appear when their parent is expanded.
 */
export function buildTree(
  detail: SolutionDetail,
  edits: SolutionEdits,
  expanded: Set<NodeId>,
): TreeNode[] {
  const { spec } = detail;
  const nodes: TreeNode[] = [];

  // root
  nodes.push({
    id: "root",
    label: edits.name || spec.name,
    icon: "📦",
    depth: 0,
  });

  // plugins
  nodes.push({
    id: "plugins",
    label: "Plugins",
    icon: "🧩",
    depth: 1,
    count: `${edits.pluginsEnabled.size}/${detail.availablePlugins.length}`,
  });

  // main agent (expandable, like the workers group)
  nodes.push({
    id: "main",
    label: "Main agent",
    icon: "🤖",
    depth: 1,
    expandable: true,
  });
  if (expanded.has("main")) {
    nodes.push({
      id: "main:tenant-prompt",
      label: "Tenant prompt",
      icon: "📝",
      depth: 2,
    });
    for (const key of Object.keys(OVERRIDE_META) as OverrideKey[]) {
      const meta = OVERRIDE_META[key];
      const overridden = edits.overrides[key] !== null;
      nodes.push({
        id: `main:override:${key}`,
        label: meta.label,
        icon: meta.icon,
        depth: 2,
        badge: overridden
          ? { kind: "overridden", text: "overridden" }
          : undefined,
      });
    }
    for (const f of edits.fragments) {
      nodes.push({
        id: `main:fragment:${f.id}`,
        label: `Custom: ${f.title || "untitled"}`,
        icon: "➕",
        depth: 2,
      });
    }
    nodes.push({
      id: "main:tools",
      label: "Tools",
      icon: "🔧",
      depth: 2,
      count: `${detail.availableTools.length}`,
      badge: excludedBadge(edits.toolsDeny.size),
    });
    nodes.push({
      id: "main:skills",
      label: "Skills",
      icon: "📚",
      depth: 2,
      count: `${detail.availableSkills.length}`,
      badge: excludedBadge(edits.skillsDeny.size),
    });
  }

  // workers group (expandable)
  nodes.push({
    id: "workers",
    label: "Workers",
    icon: "👥",
    depth: 1,
    count: `${spec.workers.length}`,
    expandable: true,
  });
  if (expanded.has("workers")) {
    for (const w of spec.workers) {
      const e = edits.workerEdits[w.slug];
      const view = detail.workerViews[w.slug];
      const excluded = e ? !e.enabled : !w.enabled;
      const wid = `worker:${w.slug}`;
      nodes.push({
        id: wid,
        label: e?.name || w.name,
        icon: workerIcon(w.kind),
        depth: 1,
        excluded,
        expandable: true,
        badge: excluded ? { kind: "excluded", text: "excluded" } : undefined,
      });
      if (expanded.has(wid)) {
        nodes.push({
          id: `${wid}:soul`,
          label: "SOUL.md",
          icon: "📝",
          depth: 2,
        });
        // Execution bias as its own node, mirroring the main
        // agent's structure (where each overridable host block is
        // a flat node). It's the one per-worker overridable host
        // block; the remaining host blocks (runtime / plugin
        // fragments / skill catalogue) are read-only and shown in
        // the Inspector's rendered preview rather than cluttering
        // the tree.
        const ebOverridden = !!e && e.executionBias !== null;
        nodes.push({
          id: `${wid}:override:executionBias`,
          label: "Execution bias",
          icon: "⚙",
          depth: 2,
          badge: ebOverridden
            ? { kind: "overridden", text: "overridden" }
            : undefined,
        });
        nodes.push({
          id: `${wid}:tools`,
          label: "Tools",
          icon: "🔧",
          depth: 2,
          count: view ? `${view.availableTools.length}` : undefined,
          badge: excludedBadge(e?.toolsDeny.size ?? 0),
        });
        nodes.push({
          id: `${wid}:skills`,
          label: "Skills",
          icon: "📚",
          depth: 2,
          count: view ? `${view.availableSkills.length}` : undefined,
          badge: excludedBadge(e?.skillsDeny.size ?? 0),
        });
      }
    }
  }

  return nodes;
}

function excludedBadge(
  n: number,
): { kind: "excluded"; text: string } | undefined {
  return n > 0 ? { kind: "excluded", text: String(n) } : undefined;
}

function workerIcon(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes("research")) return "🔎";
  if (k.includes("cod") || k.includes("dev")) return "💻";
  if (k.includes("review")) return "📋";
  return "🤖";
}

/** Expandable parents: the workers group + every worker root. */
export function expandableIds(detail: SolutionDetail): Set<NodeId> {
  const out = new Set<NodeId>(["main", "workers"]);
  for (const w of detail.spec.workers) out.add(`worker:${w.slug}`);
  return out;
}

// ─── render ─────────────────────────────────────────────────────

export function SolutionTree({
  detail,
  edits,
  expanded,
  onToggleExpand,
  selected,
  onSelect,
}: {
  detail: SolutionDetail;
  edits: SolutionEdits;
  expanded: Set<NodeId>;
  onToggleExpand: (id: NodeId) => void;
  selected: NodeId;
  onSelect: (id: NodeId) => void;
}): ReactElement {
  const nodes = buildTree(detail, edits, expanded);
  return (
    <div className="py-2">
      {nodes.map((n) => (
        <TreeRow
          key={n.id}
          node={n}
          isSelected={selected === n.id}
          isExpanded={expanded.has(n.id)}
          onToggleExpand={onToggleExpand}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  isSelected,
  isExpanded,
  onToggleExpand,
  onSelect,
}: {
  node: TreeNode;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleExpand: (id: NodeId) => void;
  onSelect: (id: NodeId) => void;
}): ReactElement {
  const pad =
    node.depth === 0 ? "pl-2" : node.depth === 1 ? "pl-5" : "pl-9";
  const isRoot = node.id === "root";
  return (
    <div
      className={`flex w-full items-center gap-1 border-l-2 ${pad} pr-2 py-1 text-xs whitespace-nowrap ${
        isSelected ? "border-info-fg bg-bg-raised" : "border-transparent hover:bg-bg-raised"
      }`}
    >
      {/* Chevron is its own hit target: toggles expand without
          changing selection. Bigger tap area + lucide icon so it
          reads as a real disclosure control. */}
      {node.expandable ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(node.id);
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-base hover:text-fg-default"
          aria-label={isExpanded ? "Collapse" : "Expand"}
        >
          {isExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <button
        type="button"
        onClick={() => {
          if (node.expandable && !isExpanded) onToggleExpand(node.id);
          onSelect(node.id);
        }}
        className="flex flex-1 items-center gap-1.5 text-left"
      >
        <span className="w-4 text-center opacity-80">{node.icon}</span>
        <span
          className={`${isRoot ? "font-semibold" : ""} ${
            node.excluded ? "text-fg-muted line-through" : ""
          }`}
        >
          {node.label}
        </span>
        {node.count ? (
          <span className="text-[10px] text-fg-muted">{node.count}</span>
        ) : null}
        {node.badge ? <TreeBadge badge={node.badge} /> : null}
      </button>
    </div>
  );
}

function TreeBadge({
  badge,
}: {
  badge: NonNullable<TreeNode["badge"]>;
}): ReactElement {
  const cls =
    badge.kind === "overridden"
      ? "bg-warning-fg/15 text-warning-fg"
      : badge.kind === "excluded"
        ? "bg-danger-fg/15 text-danger-fg"
        : "bg-fg-muted/15 text-fg-muted";
  return (
    <span
      className={`ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-medium ${cls}`}
    >
      {badge.text}
    </span>
  );
}
