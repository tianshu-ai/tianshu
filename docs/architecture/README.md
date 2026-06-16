# Architecture Decision Records (ADRs)

Permanent, dated records of architecture decisions for Tianshu.
Each ADR captures **context → decision → consequences**, so future
contributors can understand _why_ a piece of the system is shaped the
way it is — not just _what_ shape it has.

| # | Title | Status |
| --- | --- | --- |
| 0001 | [Multi-tenancy from row 1](./multi-tenant.md) | Accepted |
| 0002 | [Orchestrator + workers, with builtin/tenant config layering](./workers.md) | Accepted |
| 0003 | [Plugin system (UI panels, sidebar sections, API routes)](./plugins.md) | Accepted |
| 0004 | [Plugin capabilities & sandbox contract](./sandboxes.md) | Draft |
| 0005 | [Language Server Protocol integration](./lsp.md) | Draft |
| 0006 | [Plugin-contributed system-prompt fragments for tools](./tool-prompt-contributions.md) | Draft |
| 0007 | [Skill progressive disclosure](./skill-progressive-disclosure.md) | Draft |

## How to write an ADR

1. Copy the format of [ADR-0001](./multi-tenant.md).
2. File it as `docs/architecture/<NNNN>-<slug>.md`.
3. Include: `Status`, `Date`, `Author`, `Supersedes`.
4. Update the table above.
5. Link from the PR description that implements it.

ADRs are immutable once accepted. If a decision is reversed, write a
new ADR that supersedes it.
