# ADR-0006 — Plugin-contributed system-prompt fragments for tools

| Status      | Draft |
| ----------- | ----- |
| Date        | 2026-06-16 |
| Author      | Yu Yu |
| Supersedes  | — |
| Depends on  | [ADR-0001 — Multi-tenancy](./multi-tenant.md), [ADR-0003 — Plugin system](./plugins.md), [ADR-0004 — Plugin capabilities & sandbox contract](./sandboxes.md), [ADR-0005 — LSP integration](./lsp.md) |

## Context

The default chat agent's system prompt is built in
`packages/server/src/chat/handler.ts` by `defaultSystemPrompt()`.
Today it ends with a hand-edited `## Tool guidelines` block:

```
File creation / edits:
- Use `write_file` ONLY for new files or complete rewrites of small
  files (≲ ~500 lines / ~40KB). For long output (HTML reports,
  multi-section markdown), write a small skeleton with
  `<!-- TODO: section X -->` placeholders FIRST, then fill each
  section with `edit_file`. ...
- Use `edit_file` for any change to an existing file. ...

Sandbox shell (`exec`):
- Don't run a foreground server with `exec` ...
- The sandbox already ships chromium (CDP 9222), Playwright MCP ...
```

Three things are wrong with this:

1. **The text mentions tools the host can't guarantee exist.**
   `write_file` / `edit_file` ship in `plugins/files`, `exec` ships
   in `plugins/microsandbox`. A tenant that disables either plugin
   still sees these instructions on every turn, training the agent
   to reach for tools the model knows aren't available.

2. **Workers don't get any of it.** Worker LLMs go through
   `runAgentLoop()` (chat/agent-loop.ts:333). When `req.systemPrompt`
   is set (every fs-backed worker has a SOUL.md), the host uses
   that string verbatim and skips `defaultSystemPrompt`. The
   tool-guidelines block is therefore **main-agent-only**. Worker
   bundles compensate by hand-copying the same advice into
   `SOUL.md` / `skills/large-input-large-output.md` — every author
   re-derives "use skeleton for long output" from scratch and the
   versions drift.

3. **Tool descriptions and prompt-level guidance live in different
   files and drift.** `edit_file`'s schema description and the
   host-level "use multiple edits in one batch" line are both
   advice the model needs at decision time, but they're authored
   in three places (`edit-file.prompt.md`, `handler.ts`,
   `large-input-large-output.md`) by three different mental
   models. PR #123 made `edits` required and removed the
   single-edit shorthand from the schema; the prompt files are
   still telling the model "shorthand `{old_text, new_text}`
   still works" two PRs later. Dead bytes the model sees on every
   turn.

The plugin system already has `manifest.contributes.systemPromptFragments`
(plugin-sdk/src/manifest.ts:248). It's currently **main-agent only**
and used by exactly one plugin (`workboard`'s `prefer-delegation`
fragment). The hooks needed to fix all three problems above are
mostly there — they need to be widened to cover workers and
re-anchored to the plugin that owns each fragment.

## Decision

Plugins own the prompt fragments for the tools they contribute,
and the host injects those fragments into every agent that has
the tool enabled — main chat agent and workers alike.

### 1. `systemPromptFragments` becomes scope-aware

```ts
// plugin-sdk/src/manifest.ts
interface SystemPromptFragmentContribution {
  /** Stable id for cross-references. Must be unique within the
   *  plugin. The host renders `<plugin-displayName>` headers, not
   *  ids, so this is for humans + override targeting. */
  id: string;
  /** Imperative sentence(s). Short. Long instructions belong in
   *  skills. */
  text: string;
  /**
   * Which agents see this fragment. Default `"main"` for back-compat
   * with the existing workboard fragment (which is genuinely main-only).
   *
   *  - `"main"` — default chat agent only.
   *  - `"worker"` — every fs-backed worker whose `toolsAllow`
   *    includes at least one tool this plugin contributes.
   *  - `"all"` — both. Use for tool-mechanics advice that
   *    applies regardless of caller (file-write rules,
   *    sandbox-shell rules).
   */
  scope?: "main" | "worker" | "all";
  /**
   * Optional gate: only inject when the named tool is available
   * to the receiving agent. Lets a plugin contribute multiple
   * fragments tied to specific tools (e.g. one for `edit_file`,
   * one for `glob`) without firing all of them when only `glob`
   * is enabled.
   *
   * For `scope: "worker"` this is checked against the worker's
   * `toolsAllow` (or the global allow when toolsAllow is unset).
   * For `scope: "main"` it's checked against the main agent's
   * resolved tool list.
   */
  whenToolEnabled?: string;
}
```

`scope` defaults to `"main"` so the existing `workboard.prefer-delegation`
fragment keeps its current behaviour with zero manifest edits.

### 2. Worker injection point

`runAgentLoop()` already builds `pluginFragments` for the main
chat agent (handler.ts:319). The worker path
(chat/agent-loop.ts:333) does not — when `req.systemPrompt` is
set, the host skips `defaultSystemPrompt()` entirely.

This ADR adds a new helper next to the existing one:

```ts
// chat/handler.ts — already exported
formatPluginPromptFragments(fragments) -> string

// new
formatToolFragmentsForWorker({
  fragments,        // all systemPromptFragments active in the tenant
  workerToolsAllow, // resolved tool ids the worker can call
}) -> string
```

The worker path becomes:

```ts
let systemPrompt: string;
if (req.systemPrompt) {
  const skillBlock = formatAvailableSkillsBlock(skills);
  const toolBlock = formatToolFragmentsForWorker({
    fragments: pluginFragments,
    workerToolsAllow: req.toolsAllow ?? "all",
  });
  // Order: SOUL → tool guidelines → available skills.
  // Tool guidelines come from plugins so we treat them like
  // SDK-level rules; SOUL-level identity wins, mechanics
  // follow, skill catalogue last.
  systemPrompt = [req.systemPrompt, toolBlock, skillBlock]
    .filter(Boolean)
    .join("\n\n");
}
```

### 3. Per-agent overrides

Worker authors sometimes want to say "for *this* worker, prefer
multiple small edits over one big edit" — that's an
agent-specific override of plugin guidance, not a global change.

`agent.json` (fs-worker bundle) gains:

```json
{
  "promptFragmentOverrides": {
    "files.edit-file-rules": {
      "append": "This worker handles refactors; prefer many small edits with read_file in between."
    },
    "files.write-file-rules": {
      "replace": "Custom guidance specific to this agent..."
    },
    "microsandbox.exec-foreground": {
      "drop": true
    }
  }
}
```

Override key is `<pluginId>.<fragment.id>`. Three operations:
- `append` — concatenate after the plugin text
- `replace` — replace the plugin text entirely
- `drop` — omit the fragment for this worker

Main-agent overrides live in tenant config rather than
`agent.json` (the main agent has no per-tenant agent.json):

```
_tenant/config/main-agent/prompt-overrides.json
```

Same shape, same keys.

### 4. Migration: hardcoded guidelines move into manifests

The `## Tool guidelines` block in `defaultSystemPrompt()`
(handler.ts:1131-1140) gets deleted. Each line becomes a
plugin-contributed fragment with `scope: "all"`:

| Current line in `handler.ts` | Owning plugin | Fragment id |
|---|---|---|
| "Use `write_file` ONLY for new files…" | `files` | `write-file-rules` |
| "Use `edit_file` for any change…" | `files` | `edit-file-rules` |
| "Each `edit_file` `old_text` must appear EXACTLY ONCE…" | `files` | `edit-file-uniqueness` |
| "The only edit kind is exact-text replace…" | `files` | `edit-file-shape` |
| "Don't run a foreground server with `exec`…" | `microsandbox` | `exec-foreground` |
| "The sandbox already ships chromium…" | `microsandbox` | `exec-installed-runtimes` |

The text is also the moment to fix the dead "shorthand still works"
sentences (PR #123 already removed it from the schema) and to
soften the "≲500 lines / skeleton-then-fill" doctrine (separate
analysis; PR-A in flight).

After this migration `defaultSystemPrompt()` contains zero
plugin-specific text. Adding a new plugin or disabling an
existing one cleanly adds/removes its prompt influence.

### 5. Dev ergonomics

We add a `tenant_config_read({ path: "_runtime/system-prompt.txt" })`
virtual path (read-only, computed on read) that returns the exact
system prompt the host would build for the requested agent right
now:

```
GET /_runtime/system-prompt?agent=main
GET /_runtime/system-prompt?agent=worker:coder
```

This makes overrides debuggable without booting the agent — the
author can inspect the merged result before committing the
override.

The same virtual path is what powers a future "Inspect prompt"
button in the UI; out of scope for v0.1 of this ADR but the
path is reserved.

## Out of scope (v0.1)

- **Tool description authoring.** `AgentTool.schema.description`
  stays the only source of per-tool description. We are not
  introducing a separate "tool prompt" file alongside the schema.
  The fragment system is for **cross-tool / cross-call**
  guidance ("prefer X over Y", "batch edits"), which is
  exactly what the schema description shouldn't carry.

- **Dynamic fragments.** Fragments are static text in
  `manifest.json`. No `text(ctx) => string` callbacks. If a
  plugin needs runtime decisions, it should expose a tool or
  capability instead.

- **Skill replacement.** Skills (`skills/<name>/SKILL.md`)
  remain the on-demand, larger-form companion to fragments.
  Fragments are 1-3 sentences shown on every turn; skills are
  paragraphs read once when the agent decides the topic is
  relevant. ADR-0003 §"Skills" is unchanged.

- **i18n.** Fragments are English. Tenant locale handling is
  a separate concern.

- **Compile-time lint.** A nice-to-have would be: if a fragment's
  text mentions a tool name that doesn't appear in any plugin's
  tools[], flag at build time. Not v0.1 — manual review.

## Compatibility

- **Existing `workboard.prefer-delegation` fragment:** keeps
  scope-default `"main"`. Zero behaviour change.

- **Existing worker SOUL.md files:** continue to set
  `req.systemPrompt`. Workers gain the tool fragment block
  *after* their SOUL — adding new context, not replacing.
  Authors who want to suppress a fragment use `promptFragmentOverrides`
  with `"drop": true`.

- **Plugin authors:** `systemPromptFragments` keeps its current
  field shape; `scope` and `whenToolEnabled` are additive,
  optional, and default-back-compat.

## Implementation plan

Three PRs, in order:

### PR-A — Migrate hardcoded guidelines into plugin manifests (no SDK change)

Move the six lines in `handler.ts:1131-1140` into
`plugins/files/manifest.json` and `plugins/microsandbox/manifest.json`
under the existing `systemPromptFragments` field with
`scope: "main"` (interim — keeps current behaviour). Also fixes
the skeleton-fill / shorthand-drift content issues from the
edit_file abuse audit (separate analysis, same PR is fine).

Zero SDK / plugin-host changes. Smallest possible.

### PR-B — Scope-aware fragments + worker injection (SDK change)

Add `scope` + `whenToolEnabled` to `SystemPromptFragmentContribution`.
Add `formatToolFragmentsForWorker()` and wire it into
`runAgentLoop()`. Switch the migrated fragments from PR-A to
`scope: "all"` so workers also receive them. Drop the
duplicated guidance from `worker-fleet.md` /
`large-input-large-output.md` / SOUL templates.

This is the SDK-breaking change (additive, but version bump).

### PR-C — Per-agent overrides

Add `promptFragmentOverrides` to fs-worker `agent.json` schema,
implement `append` / `replace` / `drop` in the worker prompt
build path. Add `_tenant/config/main-agent/prompt-overrides.json`
for main-agent overrides. Add the
`_runtime/system-prompt.txt` virtual read.

## Open questions

1. **Fragment ordering.** When `scope: "all"` and multiple plugins
   contribute, the current `formatPluginPromptFragments` orders
   by registration order (alphabetical-ish). Is that stable enough
   or do we need explicit `priority`? Lean: not in v0.1, revisit
   if the prompt gets noisy.

2. **`whenToolEnabled` semantics for capability-gated tools.**
   `microsandbox.exec` is `available()` per-turn (off when sandbox
   is broken). Do we re-evaluate fragments per-turn or only at
   session start? Lean: session start. Per-turn would make the
   prompt non-deterministic mid-conversation.

3. **Override JSON format vs frontmatter.** `agent.json` is
   already JSON. `_tenant/config/main-agent/prompt-overrides.json`
   for symmetry? Or YAML for readability? Lean: JSON; matches
   existing tenant config conventions.
