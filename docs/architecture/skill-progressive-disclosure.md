# ADR-0007 — Skill progressive disclosure

| Status      | Draft |
| ----------- | ----- |
| Date        | 2026-06-16 |
| Author      | Yu Yu |
| Supersedes  | — |
| Depends on  | [ADR-0001 — Multi-tenancy](./multi-tenant.md), [ADR-0003 — Plugin system](./plugins.md), [ADR-0006 — Plugin-contributed system-prompt fragments](./tool-prompt-contributions.md) |

## Context

Tianshu currently has four kinds of "agent prompt text" with overlapping
semantics:

| Layer | Where | Always-on? | Owned by |
| ----- | ----- | ---------- | -------- |
| A. Hardcoded in `defaultSystemPrompt` | `handler.ts:1082-1140` | Yes (main only) | Host |
| B. `systemPromptFragments` | `manifest.contributes` | Yes | Plugin |
| C. Tool descriptions | `*.prompt.md` next to tool | Per-tool, with the schema | Plugin |
| D. Skills | `<plugin>/skills/*.md` | **Yes (full text!)** | Plugin |

Layer A is being drained by ADR-0006. After PR-A lands, the host
defaults are five lines (identity, tenant, user, reply style) and
every plugin-specific guideline lives in B.

But D is still wrong.

`formatAvailableSkillsBlock` renders **the entire markdown body** of
every active skill into the system prompt. That is not "available
skills, load on demand" — that is "all skills, always loaded". Two
side effects:

1. **Token waste.** A typical tenant with files + microsandbox +
   workboard + web-search has ~12 skill files; full text is several
   thousand tokens, sent on every turn whether the agent needs them
   or not.
2. **Poor selection signal.** The model sees the full body of every
   skill at once. It can't easily tell which one to follow when two
   are tangentially relevant; the "this is when to use me" hint that
   each skill writes for itself gets buried in the recipe text.

OpenCode and Claude Code both solved this with **progressive
disclosure**. Anthropic calls it that explicitly; OpenCode calls it
"native `skill` tool". The shape is the same: load metadata always,
load full text on demand.

This ADR adopts that shape, with one Tianshu-specific twist (skills
are owned by plugins, not by global directories).

> **What "progressive disclosure" means in concrete terms.** OpenCode
> ships a tool literally named `skill(name)` whose description is an
> XML list of all available skills. Claude Code injects metadata
> directly into the system prompt and tells the agent to read
> `<path>/SKILL.md` with the existing Read tool. We are taking the
> middle path: metadata in the system prompt, on-demand load via a
> dedicated `read_skill(name)` tool. Reasons in the "Why a dedicated
> tool" section below.

## Decision summary

1. **Skill metadata only in the system prompt.**
   `formatAvailableSkillsBlock` switches from full-body to a meta
   block (name + description + when-to-read + activation gate).
   Two-three lines per skill.

2. **A new `read_skill(name)` host-level tool** that returns the
   full skill body. Behaviour and error surface modelled on
   OpenCode's `skill` tool but renamed so its purpose is obvious
   (it's a read, not a generic invocation).

3. **Plugin manifest is the only source of skills.** No filesystem
   walking, no global directories, no `.claude/skills` /
   `.opencode/skills` compatibility. Skills come from
   `manifest.contributes.skills[]`, period. Plugin enable / disable
   / refresh manages skill visibility via the existing plugin
   lifecycle.

4. **Progressive disclosure within a skill is achieved by
   cross-references between skills.** A skill can mention another
   skill by name; the agent will issue a second `read_skill` call.
   We do not implement multi-file skills (`reference.md`,
   `examples.md`, etc.) — split content across separate skills and
   cross-link instead.

5. **Workers see the same skill block.** `agent-loop.ts` worker
   path renders the same metadata block + provides the `read_skill`
   tool. Today workers either skip the skill block entirely or get
   the full-text block via `formatAvailableSkillsBlock` — both wrong.

6. **`scope` and `when` filtering is unchanged.** A skill that
   declares `scope: main` is invisible (no metadata, no
   `read_skill` access) to workers. Same for `when: { toolPresent:
   <id> }`. Filtering happens once when the per-(tenant, agentScope)
   skill catalogue is built; it is not re-checked on every
   `read_skill` call.

7. **The skill metadata block is cached per (tenantId, pluginsHash,
   agentScope).** Plugin enable / disable / refresh / install
   invalidates. Same lifecycle as `systemPromptFragments` (they
   share the cache key). Skill *bodies* are cached separately and
   loaded lazily on first `read_skill` call.

8. **Some skills graduate to fragments.** A skill whose content is
   "things the agent must know to use this plugin at all" is not a
   skill — it is a plugin fragment. As part of this ADR, we
   reclassify three existing skill files. Details in the migration
   table below.

## Why metadata in system prompt, not tool description

OpenCode lists skill metadata inside the `skill` tool's
`description`. We don't, for one reason:

The plugin-fragment block (ADR-0006) already sits in the system
prompt. Putting skill metadata there too keeps **all plugin-shaped
guidance** in one location:

```
SYSTEM PROMPT
  ├─ Host preamble (identity / tenant / user / reply style)
  ├─ ## Plugin guidance        (from ADR-0006: fragments)
  └─ ## Available skills       (from this ADR: meta only)
```

Tool descriptions stay focused on per-tool args + behaviour. We
spent ADR-0006 separating "host" from "plugin"; mixing skill
listings into a tool description would re-pollute that boundary.

## Why a dedicated tool, not Read

Claude Code uses the existing Read tool to load `SKILL.md`. We
considered the equivalent — putting plugin skills under a
read-permitted path so `read_file` could load them. We rejected
it for three reasons:

1. **Cross-tenant correctness.** Plugin skills are global
   (same plugin → same skill bodies for every tenant). Putting
   them under the per-user workspace would either duplicate them
   per tenant (sync hell on plugin upgrade) or whitelist a global
   path inside `read_file` (a multi-tenant path-safety footgun
   we'd rather not introduce).
2. **Better error surface.** `read_skill("missing-skill")` can
   reply with "unknown skill: missing-skill. available:
   workspace-layout, exec-howto, ..." which is actionable.
   `read_file` can only say "file not found".
3. **Forward compatibility.** If we ever want skill versioning,
   per-skill access permissions (à la OpenCode's
   `permission.skill[pattern]`), or skill parameters, those land
   on `read_skill` cleanly. Layering them onto `read_file` would
   make path semantics unprintable.

## What goes in the meta block

Per skill, three lines:

```
- name: microsandbox-exec-howto
  describes: how to use exec (timeouts, output truncation,
              server-startup pitfalls, pre-installed tools)
  read when: composing an exec call that runs a server, takes
              a long time, or produces lots of output
```

Field semantics:

- `name` — stable, agent passes this string to `read_skill`.
- `describes` — same `description` we already have in
  frontmatter. One sentence about what the skill covers.
- `read when` — new field, optional. If absent the model must
  guess from `describes`. Encouraged for any skill that's
  situational (i.e. most of them).

The block also gets a one-line preamble explaining the
`read_skill` tool exists and how to call it. The preamble is
written once by the host; plugins don't have to know about the
tool.

Total: ~4 lines per skill, vs. ~50-300 lines today. For a
typical tenant with 12 skills the block is ~50 lines instead of
~2500.

## What goes in the skill body

`read_skill` returns the markdown body verbatim, with two
trim-passes:

1. The frontmatter is stripped (we already parsed it for the
   meta block; sending it again wastes tokens and is confusing).
2. A trailing "See also: foo, bar" footer is appended if other
   skills cross-reference this one. Cheap to compute, useful
   for the agent's next-step decision.

Bodies are loaded lazily and memoised in-process. Refresh
invalidates.

## Migration: which skills become fragments

| Current skill | Decision | Why |
| ------------- | -------- | --- |
| `files-workspace-layout` | **→ fragment** | Fact sheet, not how-to. Always relevant. ~30 lines. |
| `microsandbox-exec-howto` | Stay skill | 200+ lines, situational. |
| `microsandbox-build-use` | Stay skill | Procedural, situational. |
| `microsandbox-config` | Stay skill | Procedural. |
| `microsandbox-browser-howto` | Stay skill | Procedural. |
| `microsandbox-libreoffice` | Stay skill | Reference table. |
| `web-search-howto` | Stay skill | But add `when: toolPresent: web_search` (today it's `scope: worker` only). |
| `workboard-howto` | Stay skill | Add `when: toolPresent: task_create` + `scope: main`. |
| `worker-creator` | Stay skill | Already correctly scoped. |
| `worker-fleet` | Stay skill | Already correctly scoped. |
| `large-input-large-output` | **Move + reshape** | Currently in workboard plugin but content is files-plugin oriented. Move to `plugins/files/skills/large-output-howto.md`, add `when: toolPresent: write_file`. |
| `tianshu-mount-layout` (host skill) | **→ fragment** | Always-relevant fact sheet about the mount tree. |
| `tianshu-overlapping-surfaces` (host skill) | **→ fragment** | Always-relevant. |

Three become fragments, ten stay skills (with frontmatter
tightening for some). The split aligns with ADR-0006 #3:
"one-sentence rule" → fragment, "step-by-step recipe" → skill.

## Cache contract

A new `SkillCatalogue` host service, peer to the existing
plugin-fragments cache:

- **Key**: `(tenantId, pluginsHash, agentScope)`
- **Value**: `Array<SkillMeta>` — name, description, readWhen,
  ownerPluginId, absPath (used by `read_skill` to load the body).
- **Invalidation**: same as fragments. Plugin
  enable / disable / install / uninstall / refresh-button.
- **Hot reload**: not in v0.1. Editing a skill's frontmatter
  during dev requires re-running the build (skills are mirrored
  to `dist/` via the existing plugin tsc build); the cache
  invalidates when manifest changes are detected on plugin
  reactivation.

Skill bodies are cached in a sibling LRU keyed by `absPath`,
with a small (32 entries) cap. Bodies are small markdown files;
this cache exists purely to avoid hitting the disk on every
`read_skill` call within a session.

## `read_skill` tool surface

```
read_skill({ name: "microsandbox-exec-howto" })
  → { ok: true, name: "microsandbox-exec-howto", body: "<markdown>" }
  → { ok: false, text: "unknown skill: foo. available: ..." }
  → { ok: false, text: "skill 'x' is gated by toolPresent: y, which is not active" }
```

The tool description is generated by the host (not a plugin)
and is short:

```
Read a skill's full content. Skills are referenced in the
"Available skills" section of your system prompt — pick the one
that matches the task and pass its `name`. Returns the
markdown body. If unsure which to read, prefer one with a
`read when` line that matches your current step.
```

`read_skill` filters by the same `(tenantId, agentScope)`
context as the metadata block. A skill that's not in the meta
block is not loadable; this prevents an agent from guessing a
skill name and side-stepping the `scope`/`when` filter.

## Out of scope (v0.1)

- **Per-skill access policies.** OpenCode supports
  `permission.skill["pattern"] = "allow|deny|ask"` with wildcard
  matching. We don't ship that yet. The current implicit policy
  is "every skill in the meta block is readable"; if and when
  we have a use case for tenant- or agent-scoped skill bans, it
  becomes its own ADR.

- **Multi-file skills.** No `reference.md` / `examples.md` /
  `scripts/`. Cross-link separate skills instead. We can add
  multi-file later if real workloads need it.

- **Skill versioning.** Today plugin version pins skill version.
  No reason to decouple in v0.1.

- **Skill inheritance / composition.** No.

## Implementation plan

PR-A (this ADR depends on, just merging): defaultSystemPrompt
detox. ✅ open as #127.

**PR-B**: worker fragment injection (small precursor; closes
ADR-0006 problem #2). `agent-loop.ts` calls
`pluginRegistry.systemPromptFragmentsForTenant` and prepends
the same `## Plugin guidance` block to the worker's SOUL prompt
(or to `defaultSystemPrompt` for non-SOUL workers). Filtered by
`scope` (`main` | `worker` | `all`, default `all`; ADR-0006 set
this up but didn't wire it).

**PR-C**: skill catalogue + `read_skill` tool +
metadata-only injection.
- Add `SkillMeta` type to plugin-sdk.
- Build the catalogue from active plugin manifests at the same
  point fragments are built.
- Replace `formatAvailableSkillsBlock` with a meta renderer
  (per-skill 4-line block).
- Register `read_skill` as a host-level builtin tool.
- Same wiring on the worker path.

**PR-D**: skill body lazy load + LRU + invalidation hooks tied
to plugin lifecycle.

**PR-E**: migration commits.
- Move three skills' content into plugin fragments.
- Move `large-input-large-output` from workboard to files plugin;
  rename to `large-output-howto`; reshape.
- Tighten remaining skills' frontmatter (`when:`, `scope:`).
- Delete `formatAvailableSkillsBlock`'s old code path.

PR-B through PR-E land independently. PR-B can land before PR-C;
PR-C / PR-D / PR-E together.

## Test surface

- `SkillCatalogue` builds correctly from manifest fixtures with
  `scope` / `when` / multiple plugins.
- Cache invalidation hits on plugin enable / disable / refresh.
- `read_skill("known")` returns body; `read_skill("unknown")`
  reports available skills; `read_skill("scoped-out")` reports
  the gate reason.
- Metadata block fits into ~4 lines per skill, no leak of full
  body.
- Worker agent-loop renders the same block; its `read_skill`
  honours `scope: main` exclusion.

## Risk

Bigger than ADR-0006. Three risks:

1. **Agents will read fewer skills than they should.** With full
   bodies always present, the model couldn't miss a skill — it
   was right there. With meta only, the model has to *choose*
   to read. Mitigation: make `describes` and `read when` precise
   when migrating; watch for tool-call patterns where a skill
   was clearly relevant but wasn't read; tighten meta lines
   based on observation.

2. **Cross-skill cross-references will rot.** "See also:
   foo-bar" becomes a dangling reference if `foo-bar` is later
   renamed or removed. Mitigation: lint pass that checks
   cross-references resolve to known skills, runs in CI on
   plugin manifest changes.

3. **Worker path divergence.** If main and worker render the
   skill block differently, the resulting drift is hard to
   debug. Mitigation: one renderer, called by both paths, with
   a single test fixture.
