# ADR-0001 — Multi-tenancy from row 1

| Status | Accepted |
| --- | --- |
| Date | 2026-06-03 |
| Updated | 2026-06-05 — projects moved from tenant-level to user-level (see Revision 2026-06-05) |
| Author | Yu Yu |
| Supersedes | — |

## Context

Tianshu is positioned as a **team** AI agent platform. Most open-source
peers (LibreChat, Open WebUI, Dify) treat multi-tenancy as a later
add-on; we will not. Tenancy is a core architectural axis from day 0.

The non-negotiable rule:

> _It is easier to start multi-tenant and stay correct than to bolt it
> on later. We start multi-tenant._

This ADR captures the design that the next implementation PR is
expected to follow.

## Decision

### 1. Tenant model

- **A tenant is a team / organization, not a single user.**
- A tenant contains multiple users.
- A user **cannot cross tenants**: the same human signing into tenant A
  and tenant B is two independent accounts. There is no global "user"
  concept.
- Each tenant configures its own OAuth / OIDC / IDP (GitHub, Google,
  Lark, custom). The same IDP can be reused by different tenants —
  sub claim is scoped to tenant.

User table primary key: `(tenant_id, external_id)`.

### 2. Physical isolation, not WHERE clauses

Each tenant gets its own filesystem directory and its own SQLite
database. There is **no cross-tenant table** in any DB; cross-tenant
operations (admin / metrics) are an explicit `GlobalOps` layer that
walks tenant directories.

```
$TIANSHU_HOME/                          # default ~/.tianshu, env-overridable
├── config.json                         # global defaults
└── tenants/
    ├── <tenantId>/
    │   ├── config.json                 # per-tenant config (whitelist override)
    │   ├── db.sqlite                   # per-tenant DB (WAL)
    │   ├── secrets/                    # API keys, OAuth secrets (mode 0600)
    │   └── workspace/                  # mounted into the per-tenant sandbox at /workspace
    │       ├── _tenant/                # tenant-shared (the team's stuff)
    │       │   ├── SOUL.md             # team agent persona
    │       │   ├── MEMORY.md           # team long-term memory
    │       │   └── config/skills/      # team-shared skills / orchestrator overrides
    │       └── users/<userId>/         # private to one user
    │           ├── USER.md
    │           ├── projects/<slug>/    # ALL projects live here (user-level)
    │           ├── uploads/
    │           ├── tmp/
    │           └── trash/
    │
    └── <tenantId>.deleted/             # soft-deleted tenant; ignored by scans
```

### 3. Workspace conventions

- **All projects are user-level** (`users/<userId>/projects/<slug>/`).
  Rationale: most v0 work is single-user; cross-user collaboration
  happens through workers (which carry their own ACL via
  `task.owner_user_id`) and a future explicit share mechanism, not by
  default-shared filesystem visibility. This keeps day-0 isolation
  simple and matches the per-user `cwd` model.
- **`uploads/` `tmp/` `trash/` `projects/` only exist under
  `users/<userId>/`.** Rationale: uploads frequently contain
  credentials or sensitive documents — default-private is safer than
  default-shared.
- **`_tenant/` has no `tmp/`, `trash/`, or `projects/`.** Shared space
  is for team-level config and persona only; it should not accumulate
  user state.
- **`SOUL.md` and `MEMORY.md` only exist at `_tenant/`.** Per-user
  personality lives in `users/<userId>/USER.md`.
- **Reserved `_` prefix.** `_tenant`, `_shared`, `_archive`, … are
  system-reserved. Project slugs cannot start with `_`.

### 4. Sandbox boundary = tenant

- One sandbox per tenant (Docker container). All users in a tenant
  share that sandbox.
- Mount: `<tenant>/workspace/` → `/workspace/`.
- Default cwd for a user-bound session:
  - If session is bound to a project → `/workspace/users/<userId>/projects/<slug>/`
  - Otherwise → `/workspace/users/<userId>/`
- **Explicit trade-off:** within a tenant, users do not have
  filesystem-level hard isolation. Soft isolation is enforced via
  default cwd + the system prompt. A teammate _can_ technically read
  another teammate's `users/<otherUserId>/...` if they go looking.
  This matches the "team is a single trust domain" semantics. Users
  who need hard isolation must be in separate tenants.

### 5. Session model

Sessions are **user-level** and managed entirely by the agent. Users
do not click "new chat" — the conversation is an endless scrolling
stream from the user's point of view.

DB schema (per tenant):

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  external_id  TEXT NOT NULL,
  provider     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(provider, external_id)
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  parent_id         TEXT REFERENCES sessions(id),  -- compact chain
  status            TEXT NOT NULL,                 -- active|compacted|archived
  kind              TEXT NOT NULL DEFAULT 'user',  -- user|worker|system  (worker reserved)
  title             TEXT,
  project_slug      TEXT,                          -- nullable, may bind to a project
  compacted_summary TEXT,
  created_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
CREATE INDEX idx_sessions_user_active ON sessions(user_id, status);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  role        TEXT NOT NULL,                      -- user|assistant|tool|system
  content     TEXT NOT NULL,                      -- JSON
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_messages_session_time ON messages(session_id, created_at);
```

Rules:

- A user has at most **one** `status='active'` session at any time.
- When the agent decides to compact, it writes `compacted_summary`,
  flips the old session to `status='compacted'`, and creates a fresh
  `status='active'` session whose `parent_id` points back. Original
  messages are **never deleted**.
- The user-visible "endless conversation" is:
  ```sql
  SELECT m.* FROM messages m
  JOIN sessions s ON m.session_id = s.id
  WHERE s.user_id = ?
  ORDER BY m.created_at ASC;
  ```
- Compact triggers (option **C**):
  - Agent decides "topic shifted" → compact proactively.
  - Token budget approaches model limit → compact as a safety net.
- Cross-session retrieval (option **A** for v0): agents get a
  `search_history` tool. UI search comes later.

### 6. Worker pool (designed in ADR-0002)

The full worker design lives in [ADR-0002](./workers.md). Summary of
what this ADR's schema must support:

- Sessions table has a `kind` column (`user` | `worker` | `system`).
  Worker runs are rows with `kind='worker'`.
- Sandbox is tenant-scoped → workers run in the same per-tenant
  sandbox. No extra isolation work.
- ADR-0002 introduces a `tasks` table and adds a `worker_role`
  column on `sessions`. Both ship in the v0 schema even though no
  worker code runs in PR #20 — avoids a later migration.
- WebSocket protocol reserves a `subscribe_to_worker` message type
  so a user can observe a running worker live.
- Worker pool is **tenant-scoped** (one shared pool per tenant — for
  capacity / quota / billing). Each task runs with the cwd of the
  user who created it, i.e.
  `/workspace/users/<task.owner_user_id>/projects/<task.project_slug>/`.
  Workers see only the task owner's home; they do not cross to other
  users in the same tenant. Inputs from `users/<owner>/uploads/` are
  copied to the task's `inputs/<task-id>/` subdirectory at dispatch
  time (see ADR-0002 §9).

### 7. Configuration

- **Two layers**: `~/.tianshu/config.json` (global) and
  `<tenant>/config.json` (tenant). Tenant-level wins.
- **Whitelist on tenant overrides.** Server port, log path, and other
  process-wide knobs cannot be overridden by a tenant. Model lists,
  default model, OAuth provider config, branding can.
- **API keys can live in either place.** Tenant key wins; falls back
  to global. Useful for self-host with billing per tenant.

### 8. Tenant ID format

- `^[a-z0-9][a-z0-9_-]{1,30}$` (2–32 chars, lowercase + digits + `-_`).
- Reserved prefixes: `_` (system).
- Rejected: any string canonicalising to a different filesystem path
  (path traversal protection).

### 9. Tenant lifecycle

- **Create:** tenant directory is created; `templates/tenant-workspace/`
  is copied into `<tenant>/workspace/_tenant/`. A migration runs
  against the new `db.sqlite` to bootstrap schema.
- **Auto-default:** if no tenants exist on first boot, a tenant with
  `id='default'` is auto-created and a dev user is provisioned. Can be
  disabled via global config.
- **Delete:** rename `<tenantId>/` → `<tenantId>.deleted/`. Scans skip
  `*.deleted`. A separate `--purge` CLI permanently removes deleted
  tenants. `_archive/` zips can be added later if desired.

### 10. Connection cache

- `better-sqlite3` is synchronous and each `Database` instance is one
  file handle. Cache opened tenant DBs in an LRU (default size 32).
- WAL mode + short-lived statements; reopening a DB is cheap.

## Consequences

### Good

- **Cross-tenant data leaks are physically impossible.** No
  forgotten `WHERE tenant_id = ?` can hurt.
- **Backup, restore, archive, migrate are file-level operations.** A
  tenant is a directory; copy it, you have backups.
- **Easy to scale to a tenant-per-machine future** if we ever want
  it.
- Onboarding mental model: "your team folder lives at
  `~/.tianshu/tenants/<id>/`". Predictable, debuggable.

### Trade-offs accepted

- **Schema migrations have to walk every tenant DB.** We accept this;
  a `migrate-all` helper makes it routine. (Postgres adapter, when it
  arrives, can keep schema-per-tenant or schema-per-table — that's a
  later decision.)
- **No filesystem-level isolation between users in a tenant.** A
  user that pokes around with `ls /workspace/users/...` will see
  teammates' files. This matches our "team = single trust domain"
  positioning. Users who need hard isolation belong in separate
  tenants.
- **Cross-tenant analytics need an explicit `GlobalOps` path.** We
  prefer this — it makes admin operations an explicit subsystem
  rather than `WHERE 1=1`.

## Implementation order (PR #20)

1. `~/.tianshu/` layout + `TIANSHU_HOME` env support.
2. Global / tenant config layering with whitelist enforcement.
3. SQLite pool (LRU) + WAL + migration framework
   (`schema_version` table + `migrations/` directory).
4. v0 schema: `users`, `sessions` (with `kind`), `messages`.
5. Tenant lifecycle: create, list, delete (rename to `.deleted`),
   `auto-create default`.
6. Workspace seeding from `templates/tenant-workspace/` and
   `templates/user-workspace/`.
7. Request middleware: `req.ctx = { tenantId, userId, tenant }`.
8. Dev mode: default `tenantId=default`, default dev user.
9. Basic CLI: `tianshu tenant create | list | delete`.
10. Tests: path traversal rejected; `.deleted` scan skipping;
    cross-tenant access fails; migration is idempotent.

Out of scope for PR #20 (tracked separately):

- pi-agent-core wiring (PR #21+).
- Browser sidecar / microsandbox (PR #22+).
- Compact / `search_history` logic.
- Worker pool.

## Revision 2026-06-05 — projects moved to user level

Original ADR placed projects under `_tenant/projects/<slug>/` ("all
projects are tenant-level"). Reverted: projects now live under
`users/<userId>/projects/<slug>/`. Drivers:

- **Day-0 simplicity.** Most v0 work is single-user. Default-shared
  filesystem visibility added cross-cutting questions (whose `tmp/`,
  whose `inputs/`, whose ACL?) before any sharing UX existed.
- **Worker model preserved.** Workers remain a tenant-scoped pool
  (capacity / quota), but each task runs in the owner's home; this
  is the same data flow as before, just rooted under `users/<owner>/`
  instead of `_tenant/`.
- **No DB schema change required.** `sessions.project_slug` and
  `tasks.{owner_user_id, project_slug}` are unchanged — only the path
  on disk changed.

Follow-up (not in this revision):

- Project sharing across users in a tenant. Likely a `project_acl`
  table or symlink farm under `_tenant/shared/`. Not needed for v0.

## Revision 2026-06-27 — channel bindings stay user-scoped

Channel bindings (a wechat QR scan, a telegram bot token, future
channel credentials) are personal: when user Yu binds his wechat,
the binding is stamped with `owner_user_id = yu` and the other
users in the same tenant cannot see it, list it, or send through
it. Channel sessions opened off that binding inherit the same
user scoping (`sessions.user_id` is populated from
`binding.owner_user_id` at `ensureChannelSession` time).

Considered alternative — *tenant-shared bindings*: one admin in a
tenant scans a customer-service wechat once, every member of the
tenant can read inbound messages on it and reply through it.
This would have been valuable for the 'enterprise CS team' shape
but was rejected for v0:

- **Privacy default.** A binding carries auth tokens (iLink
  bearer for wechat, bot tokens for telegram) plus the inbound
  message stream from the platform user on the other side.
  Defaulting that to tenant-shared leaks both. Opt-in sharing
  requires a UX + ACL story we haven't designed.
- **Product framing.** Today tianshu is positioned as a personal
  AI assistant first; the multi-tenant story exists so families /
  small teams can share infrastructure, not so one user's
  credentials get pooled.
- **No DB schema constraint.** Switching to tenant-shared later
  is additive: a `bindings.shared_with` JSON column or a
  `binding_share` join table, plus relaxing the user_id check in
  `/api/channel-sessions` and `host.channelBindings.list`. The
  current strict path is the safer default.

Follow-up (not in this revision):

- Tenant-shared bindings as an explicit opt-in mode
  (`binding.shared = "tenant"`), gated on owner action in the
  channel admin UI. Required iff someone reports the enterprise
  CS use case.
- Cross-user binding handoff ("I'm OOO, please let Alice receive
  my channel messages until Friday"). Separate feature from the
  always-on shared mode above.

## References

- `memory/2026-06-03.md` and `memory/2026-06-05.md`
  (workspace-internal session logs).
- Predecessor closed-source repo — the `workspace-template/`
  shape and tool docstrings (`/workspace/project/<slug>/` etc.)
  informed both conventions.
