# ADR-0002 — Orchestrator + workers, with builtin/tenant config layering

| Status | Accepted |
| --- | --- |
| Date | 2026-06-03 |
| Updated | 2026-06-05 — worker default cwd moved under `users/<owner>/projects/...` (see Revision 2026-06-05) |
| Author | Yu Yu |
| Supersedes | — |
| Depends on | [ADR-0001 — Multi-tenancy from row 1](./multi-tenant.md) |

## Context

Tianshu's main agent ("orchestrator", 天枢) does not do every kind of
work itself. Specialised tasks are dispatched to **worker agents** —
autonomous sub-agents that run in the same per-tenant sandbox, pick
ready tasks off a Kanban board, execute them, and report results back.

The closed-source predecessor already had this pattern with a clean
implementation in `agent-manager.ts` + `worker.ts` + `tasks.ts`. This
ADR formalises the same shape for the open-source rewrite, with two
deliberate refinements:

1. **Builtin / tenant config layering** is made an explicit first-class
   mechanism instead of a bunch of ad-hoc path lookups.
2. The `tasks` schema is locked in at v0 so worker capability can be
   added incrementally without DB migrations every PR.

## Decision

### 1. The cast (4 builtin agents + 1 orchestrator)

All names follow Chinese-mythology convention. Each ships with a
`SOUL.md` (persona) and optional `MEMORY.md` / `TOOLS.md`.

| Role          | Display      | Emoji | Purpose |
|---------------|--------------|-------|---------|
| `orchestrator`| 天枢          | ⭐    | Talks to the user. Plans. Dispatches tasks. |
| `qianliyan`   | 千里眼        | 👁️    | Read-only codebase / workspace search (`rg`, `ast-grep`). |
| `luban`       | 鲁班          | 🛠️    | Generalist maker — code + documents (PDF/PPT/Word/HTML). |
| `xihe`        | 羲和          | 📚    | External research — library docs, GitHub, web fetch. |
| `nvwa`        | 女娲          | 🎨    | Visual generation (Gemini native image). |

> **Naming change vs. closed-source repo:** the predecessor used
> `role=maker` with `displayName=鲁班`. We rename the role itself to
> `luban` so all four workers share the same mythology-name convention.
> `maker` is no longer a recognised role name in the open-source repo.

A worker cannot dispatch tasks to other workers — only the orchestrator
opens tasks. This avoids recursive dispatch hells and keeps the
control flow inspectable.

### 2. Builtin config directory

Ships with the server package, mounted read-only into every sandbox at
`/builtin/`.

```
packages/server/builtinConfig/
├── orchestrator/
│   ├── SOUL.md                    # 天枢 persona
│   ├── MEMORY.md                  # default long-term context
│   ├── TOOLS.md                   # tools available to the orchestrator
│   └── skills/                    # orchestrator-only skills
├── workers/
│   ├── qianliyan/{SOUL.md, MEMORY.md}
│   ├── luban/{SOUL.md, MEMORY.md, TOOLS.md}
│   ├── xihe/{SOUL.md, MEMORY.md}
│   └── nvwa/{SOUL.md}
└── skills/                        # generic shared skills
    ├── ppt-production/SKILL.md
    ├── duckdb-csv-query/SKILL.md
    ├── reportlab-chinese-pdf/SKILL.md
    └── ...
```

Resolution: `BUILTIN_CONFIG_DIR` env var, defaulting to
`<server-package>/builtinConfig/`. Sandbox mount at `/builtin/`,
read-only.

### 3. Tenant overrides

Live under the workspace structure agreed in ADR-0001:

```
~/.tianshu/tenants/<tenantId>/workspace/_tenant/config/
├── orchestrator/
│   ├── SOUL.md           # tenant overrides 天枢 persona
│   ├── MEMORY.md         # tenant adds long-term memory for the team
│   └── skills/           # tenant adds orchestrator skills
├── workers/
│   ├── qianliyan/SOUL.md # tenant overrides a builtin worker
│   ├── luban/MEMORY.md   # …or just one file under it
│   └── <newRole>/SOUL.md # tenant defines a brand-new worker
└── skills/               # tenant adds shared skills
    └── <skillName>/SKILL.md
```

The tenant's `_tenant/config/` directory is mounted into the sandbox
at the same path as before — `/workspace/_tenant/config/`.

### 4. Resolution rules

> The fundamental rule: **whole files override; collections merge.**

#### 4.1 Persona files (`SOUL.md`, `MEMORY.md`, `TOOLS.md`)

Per file:

- `<tenant>/_tenant/config/orchestrator/SOUL.md` exists → use it.
- Otherwise → use `builtin/orchestrator/SOUL.md`.

Same per-file rule for each `workers/<role>/SOUL.md` etc.

**Persona files are not merged.** Markdown has no structured merge
semantics; merging would produce contradictory personalities. If a
tenant wants "the builtin persona, but slightly different", they copy
the builtin file into their override path and edit. This is a
deliberate trade-off in favour of predictability.

#### 4.2 Worker roster

`available_workers = builtin/workers ∪ tenant/_tenant/config/workers`

- A role name present only in builtin → builtin worker available.
- A role name present only in tenant → custom tenant-only worker
  available.
- A role name present in both → tenant version wins (per file 4.1).

This means **tenants can both override existing workers and add new
ones.**

#### 4.3 Skills

Skills are a flat collection identified by directory name.

Resolution order (later wins on name collision):

1. `builtin/skills/<name>/`
2. `<tenant>/_tenant/config/skills/<name>/`
3. `builtin/orchestrator/skills/<name>/` *(orchestrator-only skill set)*
4. `<tenant>/_tenant/config/orchestrator/skills/<name>/`

Every running agent's `<available_skills>` block is built by walking
its visible layers and emitting one `SKILL.md` summary per unique
name.

### 5. Worker session model

Worker runs are recorded in the same `sessions` table as user
conversations (per ADR-0001). They are distinguished by `kind` and an
extra `worker_role` column we introduce here:

```sql
ALTER TABLE sessions ADD COLUMN worker_role TEXT;  -- nullable; only set when kind='worker'
```

Resulting columns the v0 schema actually creates:

```sql
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),  -- task.owner_user_id for workers
  parent_id         TEXT REFERENCES sessions(id),
  status            TEXT NOT NULL,                       -- active|compacted|archived
  kind              TEXT NOT NULL DEFAULT 'user',        -- user|worker|system
  worker_role       TEXT,                                -- e.g. 'qianliyan'; null for kind='user'
  title             TEXT,
  project_slug      TEXT,                                -- workers always have one
  compacted_summary TEXT,
  created_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
```

Why use the same table:

- Worker runs *are* conversations (system prompt + agent loop +
  tool calls + final message); reusing the schema keeps the message
  history machinery uniform.
- `search_history` (per ADR-0001) becomes useful for the orchestrator
  to recall prior worker runs the same way it recalls user
  conversations.

### 6. Tasks / Kanban board

```sql
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  project_slug    TEXT NOT NULL,                    -- task always belongs to a tenant project
  owner_user_id   TEXT NOT NULL REFERENCES users(id),
  worker_role     TEXT,                             -- nullable: orchestrator may say "any worker"
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL,                    -- todo|in_progress|done|stalled|aborted
  priority        INTEGER NOT NULL DEFAULT 0,
  result_summary  TEXT,
  result_files    TEXT,                             -- JSON array of /workspace paths
  session_id      TEXT REFERENCES sessions(id),     -- the worker session that handled it
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER
);
CREATE INDEX idx_tasks_status_priority ON tasks(status, priority DESC);
CREATE INDEX idx_tasks_project        ON tasks(project_slug);
CREATE INDEX idx_tasks_owner          ON tasks(owner_user_id);
```

Lifecycle:

```
[orchestrator INSERT row]
        │ status=todo
        ▼
   ┌────todo────┐
   │            │ worker pool claims (UPDATE WHERE status='todo' RETURNING)
   │            ▼
   │       in_progress  ── status=stalled if N rounds without complete
   │            │
   │            ▼
   └─────►   done ──────► orchestrator notification
```

Kanban columns map directly onto `status`. UI renders four columns
(todo / in-progress / done / stalled), `aborted` is hidden by default.

### 7. Worker pool — tenant-scoped

One pool per tenant, started lazily when its first task lands. Polls
that tenant's DB for `status='todo'` rows.

Configuration with override layering:

| Setting | Global default | Tenant override location |
|---|---|---|
| `worker.count`  | `~/.tianshu/config.json` | `<tenant>/config.json` |
| `worker.pollMs` | `~/.tianshu/config.json` | `<tenant>/config.json` |
| `worker.model`  | `~/.tianshu/config.json` | `<tenant>/config.json` |

Tenant config wins, falls through to global when missing. Whitelist
enforcement (per ADR-0001): these three fields are explicitly in the
tenant-overridable allow-list.

#### 7.1 Worker agents (N+6.2)

The `worker.count`/`worker.model` knobs above describe how many
orchestrator-style workers run; **worker agents** are the actual
configured instances the workboard pool dispatches to. The concept
is fully owned by the workboard plugin — schema, REST, admin UI
and seeding all live in `plugins/workboard/`. The host has zero
worker_agent vocabulary.

The plugin's `db/agents.ts` ensures the schema idempotently on
every activation:

```sql
CREATE TABLE IF NOT EXISTS workboard_worker_agents (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- runtime kind (echo|llm|...)
  name          TEXT NOT NULL,
  description   TEXT,
  model_id      TEXT,
  system_prompt TEXT,
  tools_allow   TEXT,                     -- JSON array of tool names
  skills        TEXT,                     -- JSON array of skill names
  source        TEXT NOT NULL,            -- 'builtin' | 'user'
  builtin_key   TEXT,                     -- non-null iff source='builtin'
  owner_user_id TEXT,                     -- NULL = tenant-shared
  overrides_at  INTEGER,                  -- NULL until first user edit
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- plus tasks.worker_agent_id (nullable, also added by ensureSchema)
```

Lifecycle:

- **Plugin seeds builtin agents** on activation from a hard-coded
  `BUILTIN_AGENT_SEEDS` array in `server.ts`. The seed loop upserts
  by `(tenant_id, builtin_key)` and respects user edits: rows whose
  `overrides_at` is non-NULL are left alone, so plugin updates
  never clobber user customisation.
- **Users CRUD their own agents** via
  `/api/p/workboard/agents`. Builtin rows can be edited (stamps
  `overrides_at`) or reset (clears `overrides_at` and re-applies
  the seed) but not deleted.
- **Pool dispatch.** The pool reads `workboard_worker_agents` on
  activation and on every `onAgentsWrite` callback (fired by the
  REST handlers right after a write), then asks its
  kind→handle factory to build one slot per known kind. Tasks
  pinned to a specific `worker_agent_id` are claimed only by that
  slot; unpinned tasks fall back to the legacy `worker_role`
  match.
- **Cross-plugin worker runtimes** compose by extending the
  workboard pool factory. The first non-echo runtime ships in
  N+6.3 (`kind=llm`) and is detailed below.

#### 7.2 LLM worker runtime (N+6.3)

`kind=llm` agents drive an actual LLM through the host's standard
agent loop. The plugin's `LLMWorker` is intentionally thin: it
translates a Task to a prompt, hands off to the host's
`host.agentLoop` capability, and writes the terminal result back
to `tasks` when the LLM calls `task_complete`.

Lifecycle:

1. Pool claims a task from the kanban.
2. `LLMWorker.run(task)` builds an initial prompt with the task
   title + description and a reminder that the agent must call
   `task_complete` to finish.
3. It calls `host.agentLoop.run({...})`. The runner:
   - creates a `kind='worker'` session owned by the task's user;
   - resolves the model from the agent row, falling back to the
     tenant default;
   - applies per-agent overrides (`system_prompt`, `tools_allow`,
     `skills`) to the toolset;
   - runs the streamSimple → toolcall → stream loop capped at
     MAX_TURNS=16;
   - enforces three layered timeouts (per
     `plugins.workboard.config.llm.*`): first-response, idle, and
     total max-run — same shape as the closed-source predecessor.
4. The LLM ends the run by calling `task_complete(summary, files)`.
   The runner captures the args and resolves `status='done'`.
   Walking off without it resolves `status='stalled'`.
5. `LLMWorker` translates the result to a `TerminalUpdate` and the
   pool writes it back to `tasks`.

Key design choices:

- **Worker session, not user session.** Each task gets its own
  `kind='worker'` session row, archived after the run. The
  orchestrator chat stays clean; a future admin UI can render
  "what did Agent X do for Task T" by walking the worker session.
- **`host.agentLoop` is a host-provided capability.** The plugin
  `requires: ["host.agentLoop"]`; the host registers a runner
  factory in `RegistryOpts.hostCapabilities` so every tenant gets
  a ctx-bound runner pre-seeded. Plugins never import server
  modules directly.
- **No new `worker_agents` columns.** Re-uses the generic
  `model_id / system_prompt / tools_allow / skills` columns added
  in N+6.2. The kind's `fields[]` whitelist advertises which the
  UI surfaces and the REST handler accepts.
- **`task_complete` is a workboard-contributed tool**, not part
  of the agent loop itself. The loop discovers it by name and wraps
  its executor to capture summary/files. Other callers of
  `host.agentLoop` can ship their own completion contract or skip
  it.

What's deliberately NOT here yet:

- Per-tenant or per-user model quotas.
- Streaming progress events back to a UI — transcript visible via
  messages table only.
- Multi-plugin LLM worker variants — the workboard factory is the
  seam to extend when needed.

### 8. Resource boundary recap

Per ADR-0001 the sandbox is tenant-scoped. Workers inherit that:

| Resource | Boundary | Notes |
|---|---|---|
| Worker pool | Tenant | One pool / quota / model budget per tenant. |
| Sandbox process | Tenant | Workers and human users share one container per tenant. |
| Worker default cwd | `/workspace/users/<task.owner_user_id>/projects/<task.project_slug>/` | Each task is bound to a (user, project) pair; the worker enters the owner's home, never another user's. |
| Read other users' homes | Forbidden. | Workers see only the task owner's tree under `/workspace/users/<owner>/`. |
| Read owner's `uploads/` directly | Forbidden by default. | See §9 for the explicit input-attachment mechanism. |
| Write inside owner's project | Allowed for the assigned slug. | |
| Write `_tenant/` | Forbidden. | Tenant-shared area is config + persona only; not a worker output target. |

### 9. Task inputs — copy, not link

When the orchestrator dispatches a task that needs to consume files
from the task owner's `uploads/`, the system **copies** those files
into the owner's project under a per-task subdirectory:

```
/workspace/users/<owner_user_id>/projects/<slug>/inputs/<task-id>/
└── <copied filename>
```

The worker is given that path explicitly in its task brief. Workers
**do not** receive raw paths to `uploads/`, and do not see other
users' homes at all.

Why copy (not symlink, not bind-mount):

- Simplest semantics. No "did the user delete this?" failure mode.
- Auditable: deleting a task deletes its inputs cleanly.
- Eliminates the surprise of "a worker is reading my private uploads
  *right now*"; the moment of consent is the dispatch.
- Cost (disk space) is acceptable for v0; deduplication can come later
  if it becomes a problem.

### 10. Worker → orchestrator messages

When a worker finishes (or stalls), it emits a system-level message
into the orchestrator's session, prefixed for unambiguous detection:

- `[Worker completion / Worker Agent 完成任务通知]` — task done.
- `[Worker stalled / Worker Agent 任务未完成]` — N rounds without complete.
- `[Worker startup report / Worker Agent 启动报告]` — pool boot found
  previously-stalled tasks.

The orchestrator is then expected to surface the result to the user
in the user's preferred language. (This convention is inherited
verbatim from the closed-source predecessor.)

### 11. Worker observability

Each worker session writes its full message stream to the `messages`
table just like a user session. Frontends can subscribe live via a
WebSocket message type reserved in ADR-0001:

```jsonc
// Client → Server
{ "type": "subscribe_to_worker", "sessionId": "<worker_session_id>" }
```

Permission check on subscribe: the worker's owning task's
`owner_user_id` must equal the requester's `userId` (or the requester
has admin role). Cross-user worker spying inside a tenant **is**
allowed because the tenant is a single trust domain — UI defaults to
"only mine", but APIs do not enforce single-user scoping.

## Consequences

### Good

- **Day-0 schema is right for workers.** PR #20 lays down `tasks` and
  the `worker_role` column even though no worker code runs yet — no
  later DB migration needed when worker code lands.
- **Builtin / tenant layering is uniform.** The same rule applies to
  orchestrator persona, worker persona, and skills. Easy to teach,
  easy to debug ("which file actually won?").
- **Tenants have a clean extensibility path.** Add a worker by
  dropping `_tenant/config/workers/<role>/SOUL.md`. No code changes,
  no service restart needed beyond a workspace reload.

### Trade-offs accepted

- **Persona files don't merge.** Tenants who want "builtin + small
  tweak" must copy the file. We prefer this over silent
  contradictions.
- **Workers can't dispatch tasks.** Limits expressiveness (no
  "swarm" patterns). We prefer the simpler control flow.
- **`role=maker` rename to `luban` is a breaking change vs. the old
  closed-source repo.** Our open-source repo has no users yet, so
  there is no migration cost.

## Implementation order

Roughly aligned with the planned PR sequence:

| PR | Scope (this ADR) |
|---|---|
| **#20** (tenant infra) | `sessions.worker_role` column + `tasks` table created; no worker code yet. |
| **#21** (orchestrator wiring) | Resolve builtin orchestrator `SOUL.md` + skills; orchestrator answers user. |
| **#22** (sandbox) | Mount `/builtin/` read-only and `/workspace/` per ADR-0001. |
| **#23** (first worker: `qianliyan`) | Worker pool skeleton, single role, `tasks` Kanban API endpoints. |
| **#24** | Add `luban`. Task inputs copy mechanism. |
| **#25** | Add `xihe`. |
| **#26** | Add `nvwa`. |

## References

- Closed-source predecessor:
  - `packages/server/builtinConfig/` — full file tree we are
    inheriting (with the `maker → luban` rename).
  - `packages/server/src/agent-manager.ts:1115-1300` — skills resolution
    order this ADR formalises.
  - `packages/server/src/worker.ts` — polling loop reference
    implementation.
  - `packages/server/src/tasks.ts` — Kanban DB layer reference.
- ADR-0001 — Multi-tenancy from row 1.
