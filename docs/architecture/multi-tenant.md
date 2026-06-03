# ADR-0001 — Multi-tenancy from row 1

| Status | Accepted |
| --- | --- |
| Date | 2026-06-03 |
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
    │       │   ├── config/skills/      # team-shared skills
    │       │   └── projects/<slug>/    # ALL projects live here (tenant-level)
    │       └── users/<userId>/         # private to one user
    │           ├── USER.md
    │           ├── uploads/
    │           ├── tmp/
    │           └── trash/
    │
    └── <tenantId>.deleted/             # soft-deleted tenant; ignored by scans
```

### 3. Workspace conventions

- **All projects are tenant-level.** No private projects per user.
  Rationale: this is a team product; projects are how teams organise
  work, and they should be visible by default.
- **`uploads/` `tmp/` `trash/` only exist under `users/<userId>/`.**
  Rationale: uploads frequently contain credentials or sensitive
  documents — default-private is safer than default-shared.
- **`_tenant/` has no `tmp/` or `trash/`.** Shared space should not
  accumulate temporary garbage by accident.
- **`SOUL.md` and `MEMORY.md` only exist at `_tenant/`.** Per-user
  personality lives in `users/<userId>/USER.md`.
- **Reserved `_` prefix.** `_tenant`, `_shared`, `_archive`, … are
  system-reserved. Project slugs cannot start with `_`.

### 4. Sandbox boundary = tenant

- One sandbox per tenant (Docker container). All users in a tenant
  share that sandbox.
- Mount: `<tenant>/workspace/` → `/workspace/`.
- Default cwd for a user-bound session:
  - If session is bound to a project → `/workspace/_tenant/projects/<slug>/`
  - Otherwise → `/workspace/users/<userId>/`
- **Explicit trade-off:** within a tenant, users do not have
  filesystem-level hard isolation. Soft isolation is enforced via
  default cwd + the system prompt. A teammate _can_ technically read
  another teammate's `users/<otherUserId>/uploads/` if they go looking.
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

### 6. Worker pool (deferred design)

We do not implement workers in PR #20, but we reserve seats:

- Sessions table already has a `kind` column. Worker runs will be
  `kind='worker'` rows.
- Sandbox is tenant-scoped → workers run in the same per-tenant
  sandbox. No extra design needed for isolation.
- A future `tasks` table joins to `sessions(kind='worker')`.
- WebSocket protocol will reserve a `subscribe_to_worker` message
  type so a user can observe a running worker live.

The unresolved question — how a worker accesses a user's
`uploads/` — is left for the worker design ADR.

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

## References

- `memory/2026-06-03.md` (workspace-internal — Yu's session log).
- Old closed-source repo (`/Users/yuyu/git/tianshu`) — the
  `workspace-template/` shape and tool docstrings (`/workspace/project/<slug>/` etc.) inform the team-side conventions.
