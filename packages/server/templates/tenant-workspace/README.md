# Tenant workspace (`_tenant/`)

This directory is **shared by everyone in the tenant**. It is mounted
into the agent's sandbox at `/workspace/_tenant/`.

## What lives here

| Path | Purpose |
| --- | --- |
| `SOUL.md` | Team-level agent persona. The orchestrator reads it as part of its system prompt. |
| `MEMORY.md` | Team-level long-term memory (decisions, conventions, project context). |
| `config/` | Tenant-level overrides for builtin orchestrator/worker personas and skills. |
| `projects/<slug>/` | Team projects — code, docs, deliverables. **All projects are tenant-level.** Per-user private projects do not exist by design. |

## Conventions

- Project slugs are lowercase, hyphenated, do not start with `_`.
- `_tenant/` deliberately has **no** `tmp/` or `trash/` — the shared
  area should not accumulate scratch state. Use a project subdirectory
  or your personal `users/<userId>/tmp/` instead.
- The orchestrator and workers may write here. Workers default to
  `/workspace/_tenant/projects/<task.project_slug>/`.

See [ADR-0001](https://github.com/tianshu-ai/tianshu/blob/main/docs/architecture/multi-tenant.md)
for the full layout rationale.
