# ADR-0005 — Language Server Protocol (LSP) integration

| Status      | Draft |
| ----------- | ----- |
| Date        | 2026-06-16 |
| Author      | Yu Yu |
| Supersedes  | — |
| Depends on  | [ADR-0001 — Multi-tenancy](./multi-tenant.md), [ADR-0003 — Plugin system](./plugins.md), [ADR-0004 — Plugin capabilities & sandbox contract](./sandboxes.md) |

## Context

Today the agent edits code blind. `edit_file` lands a string
replace and returns `ok`; the model only finds out it broke the
build the next time it tries to run something — often several tool
calls later, after follow-up edits that compound the breakage.
OpenCode (sst/opencode) solved this by wiring a Language Server
Protocol client into the edit tool: every successful write/edit
synchronously fetches diagnostics for the touched file and
appends them to the tool result, so the model sees `error TS2322:
Type 'string' is not assignable to type 'number'` in the *same*
tool turn that introduced it. That tightens the feedback loop from
"3-5 turns later" to "next token".

We want the same thing in Tianshu, with one extra constraint that
OpenCode doesn't have: **multi-tenancy** (ADR-0001). Two tenants
must not share an LSP process — `rootUri`, file watchers and
diagnostics are all addressable by absolute path, and one
`typescript-language-server` rooted at `/data/workspaces/A` would
happily report on `/data/workspaces/B` if both happened to be in
the same node_modules tree. So whatever we ship has to be tenant-
scoped from the first commit, same red line as everything else
(see MEMORY.md).

This ADR also folds in three smaller `plugins/files` hardening
items that we want in the same PR because they share the
edit/write code path:

1. **Externalize tool descriptions** to `.txt` siblings (OpenCode
   does this; lets us iterate prompt without touching code).
2. **Require Read before Edit/Write** — runtime check + prompt
   guideline. The model can't blindly overwrite a file it never
   saw.
3. **Preserve line endings + BOM** in `edit_file`. Round-tripping
   a CRLF file through string replace currently silently flips
   it to LF on disk; that's a real-world Windows footgun.

## Decision summary

1. Build an in-process LSP **manager** as a host service in
   `packages/server/src/lsp/`. Not a plugin — it's foundational
   like `tenants` or `auth`, and other plugins (workboard, future
   refactor/code-search plugins) will want to consume diagnostics
   too, so it lives at the host layer.
2. **Process model**: one LSP process per `(tenantId, languageId,
   workspaceRoot)` tuple. LRU pool capped at N (default 8 per
   tenant, 64 globally). Idle eviction after 10 min. Each process
   is `spawn`'d on the host, **not** inside microsandbox — the
   stdio JSON-RPC traffic is too chatty for sandbox NAT/RPC
   overhead, and language servers are operator-trusted binaries
   (the user installs them), not user input.
3. **Language registry**: 3 built-ins in v0.1, schema modelled on
   OpenCode's `Server.Info`:
   - `typescript` (`typescript-language-server --stdio`)
   - `gopls`
   - `pyright` (`pyright-langserver --stdio`)
   Schema is config-only so adding `rust-analyzer` / `clangd` etc.
   in v0.2 is a manifest entry, not a code change.
4. **Bootstrap**: on first use of a language whose binary is
   missing, the manager attempts auto-install (`npm i -g …` /
   `pip install …` / `go install …@latest`) once per tenant,
   logs the attempt, and surfaces a clear error to the agent if
   it fails. Operators can preinstall to skip.
5. **Diagnostic delivery**: synchronous. `edit_file` /
   `write_file` block on `textDocument/diagnostic` (pull) or
   `publishDiagnostics` (push) for the touched file with a 3 s
   timeout, debounce 150 ms, then append the formatted
   diagnostics to the tool's text output. Modelled on OpenCode's
   `LSP.Diagnostic.report`.
6. **Failure isolation**: LSP errors never break the edit. If the
   server crashes, the language isn't installed, or the timeout
   fires, the tool result still says "edit applied"; the
   diagnostics block is just absent (or shows a one-line warning
   "diagnostics unavailable: <reason>"). The edit is the
   contract; the diagnostic is the bonus.

## Why host service, not a plugin

The temptation was to ship LSP as `plugins/lsp` and let
`plugins/files` consume it via plugin-to-plugin RPC (the
capability pattern from ADR-0004). We rejected this for v0.1:

- **Activation order.** A plugin needs another plugin's
  capability resolved at `activate()` time. ADR-0004's
  `requires` field works for sandbox-shaped capabilities that
  are tenant-scoped resources, but LSP wants to be available
  to host-internal callers too (e.g. a future ref-code-search
  flow), and the host can't depend on plugin capabilities
  cleanly.
- **Lifecycle.** LSP processes outlive any single plugin — they
  warm up over a session, hold caches, watch files. Tying their
  lifetime to a plugin's enabled state would mean reinstalling
  TS server every time someone toggles a flag.
- **One direction at a time.** Plugins → host is fine; host →
  plugin would be a new dependency direction. Avoid for now.

When/if a second plugin needs LSP, it consumes the host service
through a small typed interface (`LSPService.diagnostics(file)`),
not through plugin-to-plugin RPC.

## Multi-tenancy: what "tenant-scoped LSP" means in practice

LSP itself has no concept of a tenant — it speaks file paths and
URIs. Tenant safety comes from three things, all enforced by the
manager, none by the LSP protocol:

1. **One process per (tenant, language, root).** Pool key
   includes `tenantId`. Two tenants with TS projects rooted at
   different absolute paths get two `tsserver` processes. There
   is no shared instance, ever.
2. **rootUri pinned to the tenant's workspace.** The manager
   computes `rootUri` by walking up from the edited file looking
   for a project marker (`tsconfig.json`, `go.mod`,
   `pyproject.toml`, …) but stops at the tenant's workspace root
   (`/data/workspaces/<tenantId>/`). It will never hand a server
   a root above the tenant boundary.
3. **Diagnostic event scoping.** Diagnostics from the LSP
   process are tagged with the tenantId at the manager boundary,
   so the chat handler only forwards them to sessions in the
   originating tenant. Same scoping as tool output today.

This means **n-tenant deployments pay an LSP cost that scales
with active languages × active tenants**, not with traffic. The
LRU + idle eviction is what keeps that bounded. v0.1 default cap
of 8 per tenant / 64 global is a guess — we revisit after we have
real traffic.

## Diagnostic delivery: synchronous, with timeout

Two viable shapes:

- **Sync**: tool blocks on diagnostics, appends to result.
  Latency cost is real (typically 200–800 ms for an incremental
  TS edit, up to several seconds for cold start). Model sees
  errors immediately.
- **Async**: tool returns "edit applied" right away, manager
  posts diagnostics into a "next-tool-call inbox" that the chat
  loop drains before the next user-visible turn. Better latency
  for unrelated edits, but two failure modes — diagnostics never
  shown if the next turn doesn't include any tool call, and the
  chat loop has to grow a new inbox concept.

We pick **sync**, matching OpenCode. The latency cost is
acceptable because (a) LS diagnostics are warm after the first
edit per session, (b) timeout caps the worst case at 3 s, (c) the
async failure modes aren't worth the complexity. We can revisit
async later if first-edit cold-start becomes a UX problem.

## Bootstrap: auto-install with explicit failure path

OpenCode auto-installs language servers on first use; we follow
suit. The alternative ("user must install before LSP works") is
viable but ships a worse first-run experience: the user enables
LSP, edits a `.ts` file, sees no diagnostics, has to figure out
that they were silently dropped because `typescript-language-
server` isn't on PATH.

Auto-install rules:

- **Triggered lazily.** First time a `(tenant, language)` pair is
  needed, manager tries `which <binary>`. Hit → spawn. Miss →
  attempt the language's documented install command, log to a
  per-tenant install log, retry spawn.
- **Cached at the host level.** Install is a host-wide effect (a
  binary on PATH), not per-tenant. We mark it installed once and
  every tenant uses the same binary. That's fine — it's the same
  binary anyway, and the per-tenant isolation we care about is at
  the *process* level, not the executable.
- **Failure is loud.** If install fails (no network, no
  package manager, sandboxed environment), the manager records
  the failure and the next edit's tool result includes a one-line
  diagnostics-unavailable note with the reason. We do not retry
  install on every edit; one shot per host process boot, then the
  operator has to intervene.
- **Operators can preinstall.** Documented in
  `docs/architecture/lsp.md` (this doc) and surfaced in the
  admin UI. CI / docker images SHOULD preinstall the languages
  they expect to use.

## Tool-side hardening (folded into this ADR)

These three changes don't strictly need an ADR but they share
test scope and review surface with the LSP work, so they ship in
the same PR. Recording the design choices here for the same
audit-trail benefit ADRs give the bigger items.

### Externalize tool descriptions

`plugins/files/src/tools/{edit,write}-file.ts` carry their
description as a multi-line string literal today. We move them
to sibling `.txt` files and import them as text via esbuild's
`text` loader, matching OpenCode's
`packages/opencode/src/tool/edit.txt` pattern. Three benefits:

- Iterate prompt without touching code review.
- Diff-friendly — prompt edits show as plain markdown changes.
- Easier to A/B prompts later (the loader can swap files).

The TypeScript schema (`Type.Object({...})`) stays inline; only
the human-facing `description` moves out.

### Require Read before Edit/Write

OpenCode's `edit.txt` says "you must use Read at least once
before editing" and the runtime enforces it. We adopt both:

- **Prompt**: a line in the existing `## Tool guidelines` block
  in `defaultSystemPrompt` saying the same thing.
- **Runtime**: each request-context carries a per-session
  `Set<string>` of resolved-paths the agent has read. `read_file`
  inserts on success; `edit_file` and `write_file` (when the
  target already exists) consult it and refuse with a specific
  error if the path is missing. The error tells the agent what
  to do: "use read_file to load <path> first".

The store is per-chat-session, not global. New session resets it;
this matches user mental model ("the agent forgets between
chats") and avoids cross-session false positives.

`write_file` for new files (target doesn't exist) is exempt —
there's nothing to read.

### Preserve line endings + BOM

`edit_file` does naive `String.prototype.replace` today. If the
source has CRLF and the model sends LF in `old_text`, the find
fails. If the find succeeds and `new_text` is LF, the file ends
up with mixed endings. BOMs vanish silently.

Fix, modelled on OpenCode's `edit.ts`:

1. Detect line ending of the source file (`\r\n` if any line
   ends with it, else `\n`).
2. Normalize both `old_text` and `new_text` to that ending
   before applying.
3. Detect/strip BOM on read, re-prepend on write if it was
   present.

These run inside the existing per-edit loop in `executeEditFile`,
so the atomic-batch contract is unchanged.

## Out of scope (v0.1)

Explicitly **not** in this ADR:

- **LSP features beyond diagnostics.** No completion, no hover,
  no go-to-definition, no rename, no code actions. Those are IDE
  surfaces; the agent doesn't benefit from them in the edit
  loop. Add later if a concrete use case appears.
- **Document sync from the editor side.** We don't run a doc
  view in the chat UI, so we only push file contents to the LSP
  via `textDocument/didOpen` + `didChange` for the file the
  agent just edited; we don't try to mirror the workspace.
- **Multi-root projects.** v0.1 detects one root per file. A
  multi-root TS project (workspace with multiple `tsconfig.json`)
  gets multiple LSP processes, which is wasteful but correct.
  Smarter detection later.
- **Sandbox-internal LSP.** If a plugin starts running code
  inside a microsandbox and wants LSP for files inside the
  sandbox, that's a separate ADR. v0.1 LSP only sees files in
  `/data/workspaces/<tenantId>/`.
- **Custom languages from plugins.** A plugin can't contribute
  its own language registry entry yet. Manifest field for that
  exists in our heads but not in code. Later.

## Test surface

- `lsp/manager.test.ts`: pool keying by `(tenant, lang, root)`,
  LRU eviction, idle eviction, tenant-boundary refusal (root above
  tenant home is rejected).
- `lsp/diagnostics.test.ts`: with a stub LSP server (jsonrpc over
  pipe), verify timeout, debounce, formatted output shape.
- `plugins/files/edit-file.test.ts`: line-ending preservation
  (CRLF in / CRLF out), BOM preservation, Read-required runtime
  check (error path).
- `plugins/files/write-file.test.ts`: Read-required only when
  target exists.
- Integration: chat handler → edit_file → diagnostics block in
  tool result, with a TS file that has a deliberate type error.

## Migration / rollout

- Ship `lsp_enabled` per-tenant config flag, default `true` in
  dev, `false` in any prod-flagged tenant for the first release.
- Operator can disable globally via host config to skip the
  bootstrap path entirely.
- Existing `edit_file` / `write_file` callers see no schema
  change. Tool result text gains a trailing diagnostics block
  when LSP fires; otherwise unchanged.

## Open questions

- **Quota.** No per-tenant LSP quota in v0.1. If a tenant pegs 8
  language servers at idle eviction's 10 min boundary, that's
  ~800 MB resident. Probably fine for any plausible v0.1 scale,
  but flag for review when we onboard a paying tenant.
- **gopls without `go` toolchain.** Unlike TS/Python, `gopls`
  needs the Go toolchain present to actually do anything useful.
  Auto-install installs gopls but if `go` is missing, gopls runs
  but reports nothing useful. Decide whether to gate on `go`
  detection or just let it degrade quietly. Lean toward "let it
  degrade, log it".
- **Pyright vs ty.** OpenCode supports both (`ty` is a newer Rust
  type checker). v0.1 picks pyright (more mature). Reconsider
  after Astral's `ty` stabilises.
