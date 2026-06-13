---
name: worker-creator
description: How to create or edit a workboard worker agent — agent.json fields, the kind/slug/SOUL trio, allow-list semantics (omit = unrestricted), and which tools to use. Read this when the user asks you to add, configure, or tighten a worker's permissions.
---

# Authoring workboard worker agents

Worker agents live as directory bundles under
`tenant-config:///workers/<slug>/`. Each bundle has up to three
files; only `agent.json` is required.

```
tenant-config:///workers/<slug>/
├── agent.json     (required)
├── SOUL.md        (optional — system prompt)
└── skills/        (optional — per-worker skill bundle)
    └── <name>/SKILL.md
```

The pool scans this directory on activation; new workers show up
on the next worker pool refresh, edits take effect on the next
worker run.

## When to use this skill

- User says "create a worker that uses Sonnet" / "add an LLM
  researcher" / etc. → read this, then write `agent.json`.
- User says "lock down what worker X can call" → read this and
  patch `agent.json`'s allow-lists.
- User says "make a custom prompt for the LLM worker" → write
  `SOUL.md` next to `agent.json`.

If the user is **just running tasks** on existing workers, this
skill is not relevant — use `workboard-howto` instead.

## Tool you'll use

`tenant_config_write` does all writes. Don't reach for any
worker_agent_* tool — that set was retired (use the filesystem).
Path inside the workspace is `workers/<slug>/<file>`. Examples:

```
tenant_config_write({
  path: "workers/sonnet-researcher/agent.json",
  content: '{...}'
})

tenant_config_write({
  path: "workers/sonnet-researcher/SOUL.md",
  content: "You are..."
})
```

`tenant_config_list` / `tenant_config_read` to inspect existing
workers (see `tenant-config:///workers/`).

## `agent.json` schema

```jsonc
{
  // Required: which runtime drives this worker.
  "kind": "llm" | "echo",

  // Optional: human-readable name shown in the admin UI.
  // Defaults to the slug if omitted.
  "displayName": "Sonnet Researcher",

  // Optional: free-form description for humans.
  "description": "Long-form research worker, slow but careful.",

  // Optional: model id (kind=llm only).
  // Examples: "sap-proxy/claude-sonnet-4-6",
  //           "sap-openai/gpt-5",
  //           "sap-gemini/gemini-2.5-pro".
  // Omit to use the host default.
  "modelId": "sap-proxy/claude-sonnet-4-6",

  // Optional: tool / skill allow-lists. SEE BELOW for semantics.
  "toolsAllow":  null | string[],
  "skillsAllow": null | string[],

  // Optional. Defaults to true. Set false to mute the worker
  // without removing its config (e.g. "disable but keep
  // around").
  "enabled": true,

  // Optional provenance hint.
  //   "builtin" → seed shipped by a plugin
  //   "user"    → human authored
  // Default "user" for files you write yourself.
  "source": "user"
}
```

## Allow-list semantics — read carefully

Both `toolsAllow` and `skillsAllow` follow the same rule:

| Field shape   | Meaning |
|---|---|
| **omitted / `null`** | **No restriction** — worker sees every host + plugin + tenant tool/skill currently exposed. New plugins added later become automatically available. |
| **`[]`** (empty array) | **Total deny** — worker can't call any tool / read any skill. Almost never what you want. |
| **`["a","b"]`** | **Allow-list** — exactly those names, nothing else. Static; new plugins do **not** flow in. |

Two extra invariants the runtime layers on top:

1. `task_complete` is **always** available to LLM workers (forced
   by the worker pool) — you don't need to list it.
2. Orchestration tools (`task_create`, `task_list`, `task_update`,
   `task_move`, `task_delete`, `task_get_history`) are **always
   denied** to workers regardless of `toolsAllow`. Workers are
   for *doing* tasks, not *managing* the board. Don't include
   them; the runtime strips them anyway.

Tenant skills (anything under `_tenant/config/skills/` or
`_tenant/config/workers/<slug>/skills/`) **bypass** the
`skillsAllow` filter — they always show through. Only host /
plugin skills are gated by the allow-list.

## Picking a slug

The directory name is the slug — it's also the worker's runtime
identity (used in logs, task assignment, etc). Rules:

- kebab-case: `[a-z0-9][a-z0-9-]*`
- short and meaningful: `sonnet-researcher`, `local-dev`,
  `customer-support`. Not `worker1`, not `default`, not `tmp`.
- unique within the tenant.
- once you pick a slug, **don't rename** — tasks already
  assigned to that worker reference it by slug. Rename = lose
  history. If you need a new identity, create a fresh bundle and
  delete the old one with `tenant_config_delete`.

## SOUL.md

Per-worker system prompt. Whatever you put in here replaces the
default kind prompt. Keep it focused on:

- the worker's identity ("you are a long-form research worker")
- exit contract (call `task_complete` with a summary)
- any house rules ("write deliverables under ./projects/<slug>/")

If you don't write a `SOUL.md`, the worker uses its kind's
default. For `kind: "llm"` that's the prompt shipped by the
`llm-default` seed.

## Per-worker skills

Drop a `<name>/SKILL.md` under `workers/<slug>/skills/` and that
skill becomes visible to **only** this worker (not main, not
other workers). Useful for narrow operating instructions ("when
you build sandboxes, always pin Node 20"). Frontmatter follows
the standard skill format — see `skill-creator` for details.

## Workflow

1. Check the existing slugs:
   ```
   tenant_config_list({ path: "workers" })
   ```
2. Pick a slug; confirm with the user if you're unsure.
3. Write `agent.json`. If `kind: "llm"`, decide on
   `modelId` and (optionally) `toolsAllow` / `skillsAllow`. **If
   in doubt, omit them — unrestricted is the right default for
   most cases.**
4. Optionally write `SOUL.md`.
5. Optionally seed any private skills under `skills/<name>/SKILL.md`.
6. Tell the user: pool picks the new worker up on the next
   worker-pool refresh (currently: server restart). Mention this
   cost — they may want to pick a moment to restart.
7. After a refresh, point them at the Worker agents admin page
   so they can verify the row + expand it to see the effective
   tools/skills the worker will actually have.

## Common mistakes

- **Empty array thinking it means "default"**. `[]` means
  "deny everything". Use `null` (or omit the field entirely)
  for "no restriction".
- **Listing `task_create` / `task_list` in `toolsAllow`**.
  They're denied by the runtime regardless. Wastes a slot; just
  omit them.
- **Reusing a slug**. The new bundle inherits old task history
  pointed at that slug. Delete first.
- **Writing `SOUL.md` for `kind: "echo"`**. Echo workers don't
  run an LLM; the prompt does nothing. Stick to `agent.json`.
- **Forgetting to include `kind`**. The loader skips bundles
  with no kind, with a warning in the server log. Always include
  it.

## See also

- `workboard-howto` — using the kanban + tasks day-to-day.
- `skill-creator` — how to author the markdown skills you might
  drop into `workers/<slug>/skills/`.
