# Workforce Studio — IDE-layout rework (implementation brief)

> Status: planned. Not yet implemented. Pick this up in a fresh
> session: "implement the Studio IDE rework per
> docs/architecture/studio-ide-rework-plan.md".

## Goal

Replace the Solution view's current **vertical stacked-accordion**
layout with a **three-pane IDE layout** (VS Code style). Pure
front-end rework — all data + server logic already exist
(ADR-0008 Phases 1–3, shipped in 0.4.4). Do NOT change the
host / capability / route layer. Only restructure
`plugins/workforce-studio/src/solution-view.tsx`.

A static mockup of the target layout lives at
`workspace-tianshu/drafts/studio-ide-mockup.html` (天枢 workspace).
Open it for the visual target. Summary below.

## Target layout

```
┌─ topbar: [Solution ▾] [Solution|Reality toggle] [drift: N changes]  ⬇Export 🚀Apply ─┐
├──────────────┬─────────────────────────────┬──────────────────────┤
│ ① Explorer   │ ② Editor (focused object)   │ ③ Inspector          │
│ (solution    │                             │ (context + diff +    │
│  tree)       │                             │  rendered preview)   │
└──────────────┴─────────────────────────────┴──────────────────────┘
```

CSS grid: `grid-template-columns: 260px 1fr 300px`, body fills
remaining height, each column `overflow-y: auto`.

### ① Explorer — solution structure tree

```
📦 <solution name>
├ 🧩 Plugins (enabled/total)
├ 🤖 Main agent
│  ├ 📝 Tenant prompt
│  ├ ⚙ Execution bias      [overridden badge if set]
│  ├ 💬 Reply style          [overridden]
│  ├ 👋 User onboarding      [overridden]
│  ├ ➕ Custom: <title>      (one node per custom fragment)
│  ├ 🔧 Tools (count)        [N excluded badge]
│  └ 📚 Skills (count)       [N excluded badge]
└ 👥 Workers (count)
   ├ 🔎 <worker>             ← EXPANDABLE (Yu's explicit ask)
   │  ├ 📝 SOUL.md
   │  ├ ⚙ host blocks (read-only reference, one node or grouped)
   │  ├ 🔧 Tools (count)     [N excluded]
   │  └ 📚 Skills (count)    [N excluded]
   ├ 💻 <worker> …
   └ 📋 <worker>            [excluded badge + strikethrough name]
```

- Selecting a node loads its editor in pane ②.
- Tree nodes carry status badges: `overridden` (yellow),
  `excluded` / excluded-count (red), `locked` (muted).
- Excluded workers/plugins: strikethrough name + dashed/dim row.
- **Every worker is individually expandable** — same sub-node
  shape as Main agent. This is the one change Yu asked for on top
  of the mockup.
- Selected node: left accent bar + raised bg.

### ② Editor — focused object

One object at a time (no more infinite scroll). Each node kind
maps to an editor:

| Node | Editor |
| --- | --- |
| Plugins | include/exclude list (existing PluginsSection content) |
| Main agent → Tenant prompt | textarea (existing tenant-prompt block) |
| Main agent → Execution bias / Reply style / User onboarding | host-block override editor: show host default + "Override…" / textarea + "Reset to host default" |
| Main agent → Custom: <id> | custom fragment editor (title + body + remove) |
| Main agent → Tools / Skills | the grouped deny ResourcePicker |
| Worker (root node) | worker fields: name / description / modelId / enabled (Exclude/Include) |
| Worker → SOUL.md | worker SOUL textarea |
| Worker → host blocks | read-only reference (pre) |
| Worker → Tools / Skills | the worker's deny ResourcePicker |

All these editors **already exist** in the current file as
sub-components / inline JSX inside `SolutionDetailPanel`,
`WorkerEditor`, `SolutionBlockCard`, `ResourcePicker`,
`NewFragmentCard`. The rework is to:
1. Lift their **state** (already all in `SolutionDetailPanel`:
   name, description, tenantPrompt, skillsDeny, toolsDeny,
   overrides, fragments, workerEdits, pluginsEnabled) — keep it
   exactly as-is.
2. Replace the **render** (the long stacked `<Section>` column)
   with: a tree (driven by the same state + `detail`) + a
   `selected` node id + a switch that renders the matching
   editor in pane ②.

### ③ Inspector — context + diff + rendered

- Context blurb for the selected node (e.g. for Plugins: "drives
  N tools / M skills / K fragments below").
- **Diff vs reality** for the whole solution (reuse existing
  `runDiff` → `/solutions/:slug/diff?against=reality`), shown as
  a compact op list (add/remove/change). Optional Phase-2:
  per-node diff filtering.
- **Rendered preview**: for main-agent / worker nodes, show the
  composed prompt text. Simplest: reuse the Reality view's
  rendered `systemPrompt` (already in the snapshot for current),
  or for a named solution show the block list joined. Acceptable
  v1: show the selected block's text. Keep it read-only `<pre>`.

## Hard constraints

- **No server / SDK / route changes.** Everything needed is
  already in `SolutionDetail` (mainBlocks, workerViews,
  availableSkills/Tools/Plugins, tenantPrompt, workerPrompts).
- **Keep all existing edit state + the save() payload shape**
  identical — the `/solutions/save` and `/solutions/:slug/apply`
  contracts must not change. save() already serialises
  overrides + customFragments + workerEdits + pluginsEnabled +
  deny sets; reuse it verbatim.
- **`current` mirror stays read-only**: every editor disables
  inputs when `detail.isCurrent`.
- Top-level Solution/Reality toggle stays in `client.tsx`
  (unchanged). This rework is only the Solution-view internals;
  the Reality view (RealityView) is untouched.
- Theme tokens only (bg-base/elevated/raised, border-subtle,
  fg/fg-muted, success-fg/danger-fg/warning-fg/info-fg). No
  hard-coded hex.

## Suggested file structure

Split `solution-view.tsx` (1660 lines) into:

```
solution-view.tsx        — SolutionView (list + layout shell)
  solution-tree.tsx      — Explorer tree (node model + rendering)
  solution-editors.tsx   — pane ② editors (plugins/prompt/override/
                            fragment/picker/worker)
  solution-inspector.tsx — pane ③ (context + diff + rendered)
  solution-state.ts       — the SolutionDetailPanel state hook
                            (extract useSolutionEdits() so tree +
                            editors + inspector share it)
```

Node-id scheme for selection + routing, e.g.:
`plugins` | `main:tenant-prompt` | `main:override:executionBias` |
`main:fragment:<id>` | `main:tools` | `main:skills` |
`worker:<slug>` | `worker:<slug>:soul` | `worker:<slug>:tools` |
`worker:<slug>:skills`.

## Acceptance

- typecheck clean, plugin build green, 31 tests pass.
- Manual: Solution view shows 3 panes; tree navigates; every
  worker expands to sub-nodes; editing any field still saves +
  applies exactly as today; `current` mirror read-only.
- No regression in the Reality view.

## Out of scope (later)

- Per-node diff filtering in the inspector.
- Drag-reorder of fragments / workers.
- Phase 4 (plugin enable/disable on Apply) — separate ADR work.

## Reference commits (Phases 1–3, all on main / shipped 0.4.4)

- Phase 2 PR #266 (solution abstraction + editors).
- Phase 3 PR #267 (apply).
- Current solution-view.tsx is the source of all editor
  sub-components to reuse.
