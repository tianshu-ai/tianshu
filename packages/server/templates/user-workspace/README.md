# Your home in this tenant

This directory is **your private workspace** within the tenant. It is
mounted into the agent's sandbox at `/workspace/users/<your-id>/`, and
is the agent's default cwd whenever you chat with it.

## What lives here

| Path | Purpose |
| --- | --- |
| `USER.md` | Personal preferences. The agent reads it on every conversation. |
| `projects/<slug>/` | Your active projects — code, docs, deliverables go here. |
| `uploads/` | Files you upload through the chat (PDFs, images, datasets). |
| `tmp/` | Scratch space. The agent treats this as throwaway. |
| `trash/` | Soft-deleted files. The agent moves things here instead of removing. |

## Conventions

- Project slugs are lowercase, hyphenated, and do not start with `_`.
- The agent's default cwd is this directory. Deliverables go to
  `./projects/<slug>/`, **not** the home root.
- Other users in the same tenant cannot see what's here.
- Workers (tenant-level pool, but task-scoped) drop their results into
  the same `./projects/<slug>/` you assigned the task to.

See [ADR-0001](https://github.com/tianshu-ai/tianshu/blob/main/docs/architecture/multi-tenant.md)
for the full layout rationale.
