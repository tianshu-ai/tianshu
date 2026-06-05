# Tenant workspace (`_tenant/`)

This directory is **shared by everyone in the tenant**. It is mounted
into the agent's sandbox at `/workspace/_tenant/`.

## What lives here

| Path | Purpose |
| --- | --- |
| `SOUL.md` | Team-level agent persona. The orchestrator reads it as part of its system prompt. |
| `MEMORY.md` | Team-level long-term memory (decisions, conventions, project context). |
| `config/` | Tenant-level overrides for builtin orchestrator/worker personas and skills. |

## Conventions

- `_tenant/` deliberately has **no** `tmp/`, `trash/`, or `projects/` —
  the shared area should not accumulate scratch state, and projects are
  per-user (see below). Use your personal home for those.
- The orchestrator may read team-level config from here. Anything that
  belongs to a single user (project files, uploads, scratch) lives in
  `users/<userId>/` instead.

## Where do projects live?

Projects are per-user, under `users/<userId>/projects/<slug>/`. Workers
are tenant-level (one shared pool), but each task runs with the cwd of
the user who created it. See [ADR-0001](https://github.com/tianshu-ai/tianshu/blob/main/docs/architecture/multi-tenant.md)
and [ADR-0002](https://github.com/tianshu-ai/tianshu/blob/main/docs/architecture/workers.md)
for the full layout rationale.
