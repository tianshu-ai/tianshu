# ADR-0004 — Plugin capabilities & sandbox contract

| Status | Draft |
| --- | --- |
| Date | 2026-06-06 |
| Author | Yu Yu |
| Supersedes | — |
| Depends on | [ADR-0001 — Multi-tenancy](./multi-tenant.md), [ADR-0003 — Plugin system](./plugins.md) |

## Context

ADR-0003 gave us a plugin system with named contribution slots —
`topBarButtons`, `rightPanels`, `composerActions`, `apiRoutes`, … —
and a per-tenant registry that activates each enabled plugin's
`server.activate()`.

Two things ADR-0003 explicitly punted on now need to land:

1. **Heavy runtime providers.** We want to give the agent a code
   sandbox (microsandbox first, more later). A sandbox isn't a
   right-panel — it's a long-running, expensive resource that other
   plugins (and the core agent loop) need to *consume* through a
   stable interface.
2. **Inter-plugin relationships.** "Two plugins both want to be the
   code sandbox" must fail loud, not silently let the second
   overwrite the first. "Plugin X needs a code sandbox to be useful"
   should fail with a clear message instead of silently dying inside
   `activate()`.

> **v0 scope note.** This ADR ships `provides` + `requires` only.
> A separate `conflicts` field ("this plugin refuses to coexist
> with X") is deferred — the `exclusive: true` flag on capabilities
> already covers the only real v0 scenario (two plugins both
> wanting to be `sandbox.shell`). We add `conflicts` later if a real
> use case shows up that exclusivity can't express.

A first instinct was "give every plugin a `type` field". We rejected
this — see the alternatives section. Instead we extend the same
contribution-points pattern ADR-0003 already uses.

## Decision

### 1. New contribution slot: `sandboxes`

Sandboxes are added as a new key under `manifest.contributes`, just
like `rightPanels` or `apiRoutes`:

```jsonc
{
  "id": "microsandbox",
  "version": "0.1.0",
  "displayName": "MicroSandbox",
  "client": { "entry": "@tianshu-builtin/plugin-microsandbox/client" },
  "server": { "entry": "@tianshu-builtin/plugin-microsandbox/server" },
  "provides": ["sandbox.shell", "browser.cdp"],
  "contributes": {
    "sandboxes": [{
      "id":          "main",
      "kind":        "shell",
      "displayName": "MicroSandbox",
      "module":      "MicroSandboxRunner"      // key in server.exports.sandboxes
    }],
    "rightPanels": [
      { "id": "shell",   "displayName": "Shell",   "component": "SandboxShellPanel" },
      { "id": "browser", "displayName": "Browser", "component": "BrowserPanel" },
      { "id": "status",  "displayName": "Sandbox", "component": "SandboxStatusPanel" }
    ],
    "topBarButtons": [
      { "id": "shell",   "icon": "Terminal", "tooltip": "Sandbox shell", "opensPanel": "microsandbox.shell" },
      { "id": "browser", "icon": "Globe",    "tooltip": "Browser",       "opensPanel": "microsandbox.browser" },
      { "id": "status",  "icon": "Box",      "tooltip": "Sandbox",       "opensPanel": "microsandbox.status" }
    ]
  }
}
```

A plugin is **not** typed as "a sandbox plugin". The plugin above
contributes a sandbox **and** three panels **and** three top-bar
buttons — exactly like `files` contributes both an upload composer
action and a right-panel browser. Type-tagging the whole plugin
would force us to invent ugly composite types or split one logical
plugin into N tiny ones. The slot model already gives us the right
granularity.

> **About `kind`.** The `kind` enum on a `sandboxes[]` entry is
> used by the Plugin Manager UI to pick an icon and to gate which
> runner methods are expected to work. v0 ships `"shell"` only;
> future kinds (`"vm"`, `"wasm"`, …) are additive. There is no
> `"code"` kind — running Python is `bash -c "python ..."` inside a
> shell sandbox; the agent doesn't need a separate "code" tool.

### 2. `SandboxRunner` interface (new in `@tianshu/plugin-sdk`)

A sandbox contribution's `module` key resolves to a value in the
plugin's server-side `exports.sandboxes` map. That value must be a
factory implementing the `SandboxModule` contract:

```ts
// packages/plugin-sdk/src/server.ts (new)

export interface SandboxRunner {
  /** Stable id; equals `<plugin-id>.<contribution-id>`. */
  readonly id: string;
  readonly kind: SandboxKind;

  // ---- shell execution ------------------------------------------------
  exec(req: ExecRequest): Promise<ExecResult>;

  // ---- workspace I/O --------------------------------------------------
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  /** Host-side absolute path to this tenant's workspace dir, used by
   *  the Files plugin and other host-side filesystem code. The
   *  sandbox guest typically sees the same dir mounted at
   *  /workspace. */
  workspacePath(): string;

  // ---- lifecycle ------------------------------------------------------

  /** Drop any in-memory state and re-init. Host triggers it from:
   *  (a) the admin "Reset" button in the status panel; or
   *  (b) the agent calling the `reset_sandbox` tool when its own
   *      `exec` call hit a stuck/poisoned shell or runaway service.
   *  The host never calls reset() automatically (no "reset on
   *  compact" magic). */
  reset(): Promise<void>;

  /** Tear down. Called on tenant DB pool eviction or plugin
   *  deactivation. Must be idempotent. */
  shutdown(): Promise<void>;

  /** Snapshot for the status panel / GET /api/p/<id>/status. */
  status(): Promise<SandboxStatus>;

  // ---- optional browser sidecar ---------------------------------------
  /** If this runner's plugin also `provides: ["browser.cdp"]`, it
   *  exposes the browser sidecar through this getter. Otherwise
   *  undefined. Host code that wants "the browser for this tenant"
   *  reads it via `capabilities.get("browser.cdp")` instead of
   *  poking at the runner directly — the link here is just so
   *  bundled providers don't need a second module entry. */
  readonly browser?: BrowserSidecar;
}

export interface BrowserSidecar {
  /** Host port forwarded to chromium CDP (9222 inside guest). */
  cdpHostPort(): number | undefined;
  /** Host port forwarded to Playwright MCP (3200 inside guest). */
  mcpHostPort(): number | undefined;
  /** Host port forwarded to noVNC (6080 inside guest). */
  vncHostPort(): number | undefined;
  /** Set by the BrowserPanel ResizeObserver; read by the agent's
   *  browser tool to re-apply page.setViewportSize() after navigation. */
  setLastViewport(v: { width: number; height: number }): void;
  getLastViewport(): { width: number; height: number } | undefined;
  /** Restart chromium + playwright-mcp without rebuilding the whole
   *  sandbox. Returns true on success. */
  restart(): Promise<boolean>;
}

export interface SandboxModule {
  /** Called once per tenant after the host has resolved capability
   *  conflicts. Returning the runner registers it with the
   *  capability registry. If the same module also provides
   *  `browser.cdp`, it returns a runner whose `.browser` is
   *  populated. */
  start(ctx: PluginContext): Promise<SandboxRunner>;
}

export type SandboxKind = "shell";  // future: "vm" | "wasm" | …

export interface ExecRequest {
  /** Shell command. Equivalent to `bash -c <command>` in the guest. */
  command: string;
  /** Working directory inside the guest. Default: `/workspace`. */
  workdir?: string;
  /** Override timeout in ms. Default plugin-defined; host caps at 30 min. */
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Wall time in ms. */
  durationMs: number;
  /** True iff the command was killed by timeout. */
  timedOut: boolean;
}

export interface SandboxStatus {
  state: "starting" | "ready" | "running" | "error" | "stopped";
  uptimeMs: number;
  lastError?: string;
  /** Plugin-specific extra fields (image, runtime version, idle
   *  countdown, browser sidecar status, …). */
  meta?: Record<string, unknown>;
}
```

The agent (in `packages/server/src/chat/...`) gets a tool registered
at each turn (`exec`, `reset_sandbox`) only if the tenant has
`sandbox.shell` registered with the runner reporting a healthy
`status()`. See §10. If `browser.cdp` is also registered, the
agent additionally gets a `browser` tool that drives playwright-mcp
through the sidecar's host port — same shape as the closed-source
repo's `browser` tool. Without `sandbox.shell`, no shell tool;
without `browser.cdp`, no browser tool. Same "not installed = not
visible" rule as ADR-0003.

### 3. Capability tags (closed vocabulary)

A **capability** is a maintainer-defined tag that names a concrete
capability the platform cares about. The vocabulary is closed: it
lives in `@tianshu/plugin-sdk` as a constant, gets versioned with
the SDK, and is the single source of truth for inter-plugin
dependency checks.

```ts
// packages/plugin-sdk/src/capabilities.ts (new)
export const KNOWN_CAPABILITIES = {
  "sandbox.shell": {
    exclusive: true,
    description:
      "Run shell commands and read/write files in an isolated per-tenant workspace.",
  },
  "browser.cdp": {
    exclusive: true,
    description:
      "Provide a headless chromium reachable via Chrome DevTools Protocol + Playwright MCP, with a noVNC viewport for the user.",
  },
  // … (extended only in this file, by a maintainer PR)
} as const;

export type CapabilityName = keyof typeof KNOWN_CAPABILITIES;
```

Why closed-vocabulary instead of deriving from contribution slots:

- **Greppable.** One file lists every capability the platform
  knows about. Reviewers can see the full surface area at a glance.
- **Decoupled from slot shape.** Today `sandbox.shell` happens to
  come from a `sandboxes[]` contribution. Tomorrow we may want a
  capability that isn't tied to any specific slot (e.g. `auth.sso`,
  `runtime.gpu-available`). A closed enum handles both cases
  uniformly.
- **Author intent is explicit.** The plugin manifest says exactly
  what it provides; we don't reverse-engineer it from `kind`
  strings.
- **Bad strings fail at load.** Any `provides` / `requires` value
  not in `KNOWN_CAPABILITIES` is a manifest validation error,
  caught the same way today's id-format errors are caught.

Manifest authors declare provides / requires directly:

```jsonc
{
  "id": "microsandbox",
  "provides":  ["sandbox.shell", "browser.cdp"],
  "requires":  [],
  "contributes": {
    "sandboxes": [
      { "id": "main", "kind": "shell", "module": "MicroSandboxRunner" }
    ]
  }
}
```

Link between `provides` and `contributes`:

- A capability is **provided** by the plugin once at least one of
  its contributions backs it. For `sandbox.shell` that means a
  `contributes.sandboxes[]` entry with `kind: "shell"` whose
  `module` resolves to a real `SandboxModule.start()` returning a
  ready (or nullable-but-registered, see §9) runner.
- If `provides[]` lists a capability that the plugin's contributions
  don't actually back, the plugin is marked `failed` with reason
  `"declared provides[\"sandbox.shell\"] without a backing sandboxes[] contribution of kind=shell"`.
  That symmetry catches typos and stale manifests at activation
  time.

The per-tenant registry adds a `byCapability` map:

```ts
interface CachedTenantRegistry {
  entries: ActivePluginEntry[];
  byWsType:    Map<string, { entry: ActivePluginEntry; handler: PluginWsHandler }>;
  byCapability: Map<CapabilityName, ProvidedCapability>;
}

interface ProvidedCapability {
  capability: CapabilityName;
  pluginId: string;
  exclusive: boolean;            // copied from KNOWN_CAPABILITIES
  /** For `sandbox.*` this is the SandboxRunner. */
  value: unknown;
}
```

A capability flagged `exclusive: true` rejects a second provider
in the same tenant; the second plugin is marked `failed` (§7).

### 4. Lifecycle: per-tenant long-lived

> Decided 2026-06-06: per-tenant, long-running. Not per-conversation,
> not per-tool-call.

- The host calls `SandboxModule.start(ctx)` exactly once per tenant,
  the first time `ensureForTenant` activates the plugin.
- The returned `SandboxRunner` is cached in
  `byCapability.get("sandbox.shell")` for that tenant for the
  lifetime of the tenant DB pool entry.
- The runner may be lazily warm: `start()` may return before the
  guest VM is fully booted, as long as `status()` reports
  `"starting"` until ready and the first `exec()` blocks on warmup.
- Idle reaping: the runner is allowed to stop the guest after
  `idleShutdownMs` of no `exec` calls (default 4 h, mirroring the
  closed-source repo). `status()` reports `"stopped"`; next `exec()`
  triggers warm-resume.
- `reset()` is called when:
  - an admin clicks **Reset** in the right-panel status surface; or
  - the agent calls the `reset_sandbox` tool (§10) because its own
    `exec` invocation hit a stuck shell / corrupted state.
  The host does **not** auto-reset on conversation compact or on
  tool-call failure. Resets are always an explicit human or agent
  decision.
- `shutdown()` is called on tenant softDelete or DB pool eviction
  (same hook that today calls `registry.invalidate(tenantId)`).

State inside one tenant is whatever the guest filesystem and any
long-running services hold. Each runner decides whether `reset()`
preserves the workspace bind-mount (it should — mirroring the
closed-source repo) or wipes it (only on explicit user request).

### 5. `provides` and `requires`

Plugin manifests get two new top-level optional fields, both arrays
of strings from the closed `CapabilityName` vocabulary:

```jsonc
{
  "id":       "code-interpreter-ui",
  "requires": ["sandbox.shell"],
  "provides": []
}
```

Semantics:

- `provides[]`: capabilities this plugin claims to provide. Must be
  backed by a real contribution (see §3). Validated at activation.
- `requires[]`: capabilities this plugin needs from *some other*
  active plugin in the tenant (or itself, if it both provides and
  requires). If not satisfied at activation time, this plugin is
  marked `failed` with reason
  `"requires capability \"sandbox.shell\" — no provider enabled"`.

`requires` are dependencies, not load-order — they only check that
the provider exists by activation time. Activation order is given by
the topological sort below.

Why no `requires.pluginId`: if you actually depend on a specific
plugin, that plugin should claim a capability tag for the thing
you care about, and you require the tag. Hard-coding plugin ids in
requires turns plugins into singletons by name; capabilities keep
them swappable by contract. Adding a new capability tag is a
maintainer PR to `capabilities.ts` — cheap, and forces explicit
thought about what "the thing you depend on" actually is.

A dedicated `conflicts[]` field is **deferred** — see the v0 scope
note in Context. Today, exclusivity is expressed by
`KNOWN_CAPABILITIES[name].exclusive = true`, which the registry
enforces in §7.

### 6. Activation order

Today the registry activates plugins in discovery order. With
`requires` we need a topological sort.

```
discovery → validate manifests → topo-sort (requires edges) → activate one by one
```

If the graph has a cycle, every plugin in the cycle is marked
`failed: "circular requires: a → b → a"`. Plugins outside the cycle
are unaffected.

Each plugin's `activate()` runs **after** all its `requires` are
already `state: "active"`. Inside `activate()` the plugin can call
`ctx.capabilities.get("sandbox.shell")` to grab the runner it
depends on (new API on `PluginContext`).

### 7. Exclusivity enforcement

A plugin enters the activation loop only if:

- it is `enabled: true` in tenant config;
- for every capability it `provides[]` that is `exclusive: true` in
  `KNOWN_CAPABILITIES`, no earlier-activated plugin has registered
  that capability.

Otherwise it is marked `failed` with reason
`"capability \"sandbox.shell\" already provided by plugin <id>"`.
Sibling plugins continue to load.

There is **no automatic preference** between two plugins both
providing `sandbox.shell`. If the user enables both, the second one
(alphabetical by `id`, or topological tie-breaker) fails. The
admin-facing error in `GET /api/plugins` makes it obvious which one
to disable.

### 8. PluginContext additions

```ts
interface PluginContext {
  // … existing fields from ADR-0003
  capabilities: CapabilityHandle;
}

interface CapabilityHandle {
  /** Get a registered capability. Returns undefined if no provider. */
  get<T = unknown>(name: CapabilityName): T | undefined;
  /** True iff a provider is registered. Cheaper than get() when the
   *  caller doesn't need the value. */
  has(name: CapabilityName): boolean;
  /** Subscribe to lifecycle events for one capability. Useful when a
   *  plugin wants to lazy-init only after `sandbox.shell` exists. */
  on(name: CapabilityName, ev: "registered" | "unregistered", fn: () => void): () => void;
}
```

In v0 we ship `get()` and `has()` synchronously. The activation
order guarantees that by the time your `activate()` runs, every
capability in your `requires` is already registered. `on()` is
useful for the agent loop §10 — it lets the chat layer flip
`exec` / `browser` on/off as providers come and go without polling.

### 9. The microsandbox plugin (first concrete consumer)

A new builtin plugin lives at `plugins/microsandbox/`:

```
plugins/microsandbox/
├── manifest.json
├── src/
│   ├── server.ts            // SandboxModule + status/exec routes + WS broadcasts
│   ├── client.tsx           // SandboxShellPanel + BrowserPanel + StatusPanel
│   └── runner/
│       ├── index.ts         // facade switching between flavours
│       ├── microsandbox.ts  // wraps the user-installed `microsandbox` binary
│       ├── browser.ts       // BrowserSidecar inside the same sandbox VM
│       └── nullable.ts      // stand-in if the binary isn't found
```

This plugin provides **both** `sandbox.shell` and `browser.cdp`,
because in microsandbox the headless chromium runs *inside* the same
MicroVM as the shell sandbox — splitting them across two plugins
would double the VM count for no benefit. Other future providers
(say a remote-cluster shell sandbox) might provide only
`sandbox.shell`; the agent gracefully falls back to no-browser mode.

Key design points:

- **User-supplied runtime.** We do not bundle the microsandbox binary.
  At plugin start, the runner shells out to a configured path (default
  `microsandbox` on PATH). If not found, `start()` resolves a
  `nullable` runner whose `status()` reports `state: "error"` with a
  clear hint, and whose `exec()` returns a structured error. The
  capability is **still** registered (so dependent plugins don't fall
  over with "no provider"), but the agent tool surface refuses to
  call it — see §10.
- **Dynamic packaging via Sandboxfile.** Microsandbox is
  project-oriented: each "project" is a directory with a
  `Sandboxfile` (YAML) that names sandboxes, the OCI image each
  pulls from, mounts, env, and entry commands. We do **not** invent
  our own packaging — we let the tenant author a Sandboxfile.

  The plugin looks for `<tenant>/_tenant/config/microsandbox/Sandboxfile`
  on start. If present, that project is what `start()` initialises
  and what every `exec()` runs against. If absent, the plugin
  falls back to a built-in minimal Sandboxfile referencing a stock
  python + chromium image. Sandboxfile syntax is microsandbox's
  problem to evolve — we version-pin the binary in the plugin's
  `package.json` and surface the parsed structure read-only in
  `status().meta.sandboxfile`.

  > Image layer caches and EROFS artifacts live in microsandbox's
  > own cache (`~/.microsandbox/` by default). The plugin does not
  > shell out to `docker build` or operate Dockerfiles.
- **Per-tenant single instance.** One sandbox VM per tenant, started
  lazily on first `exec()`. Idle for >N minutes (config:
  `microsandbox.idleShutdownMs`, default 4 h to mirror the
  closed-source repo) → VM is paused; next `exec()` resumes it.
- **Workspace mount.** `<tenant>/workspace/` on the host is
  bind-mounted into the guest at `/workspace`. The runner's
  `readFile` / `writeFile` use the host path directly; the Files
  plugin reads/writes via that same path through `workspacePath()`.
- **Reset semantics.** `reset()` destroys the VM and re-creates from
  the warm snapshot. Workspace files survive (they're on the host).
  Long-running guest services (e.g. a `python -m http.server`) do
  not.

### 10. Agent tools wired through the capability registry

The chat agent loop (PR #43) registers two tools per active sandbox
capability:

- `exec` — registered iff `sandbox.shell` is present and healthy.
  Body: `{ command, workdir?, timeout_ms? }`. Delegates to
  `runner.exec()`. Output truncated at 200 lines / 8 KB to mirror
  the closed-source repo. Timeout cap 30 min.
- `reset_sandbox` — registered iff `sandbox.shell` is present.
  No params. Delegates to `runner.reset()`. Exposed to the agent so
  it can recover from "my last `exec` hung the shell" without
  waiting for a human. Agent system prompt gets a one-paragraph
  note about when to call it (timeouts, repeated zombie processes,
  `status().state === "error"`).
- `browser` — registered iff `browser.cdp` is present and the
  sidecar's `cdpHostPort()` returns a value. Delegates to a
  Playwright-MCP client connected to `mcpHostPort()`. Same shape
  as the closed-source repo's `browser` tool.

A tenant who enabled microsandbox but doesn't have the binary
installed will *not* see `exec` / `browser` / `reset_sandbox`
advertised to the model — preventing cascading "I called exec and
it errored" loops.

File I/O does **not** become a tool. Agent file access continues to
go through the existing `read_file` / `write_file` / `edit_file`
tools, which read directly from the host workspace path that the
Files plugin already exposes. When `sandbox.shell` is registered,
those tools resolve the workspace path via `runner.workspacePath()`
instead of the host's tenant-workspace resolver — giving plugin
authors one clean override seam.

The gate runs at the start of each agent turn (cheap; just reads the
registry). It uses the `CapabilityHandle.on("registered"|"unregistered")`
hook so the tool list updates without polling when an admin
enables/disables the plugin mid-session.

### 11. Tenant config

```jsonc
{
  "plugins": {
    "microsandbox": {
      "enabled": true,
      "config": {
        "binary":          "microsandbox",       // path or PATH lookup, e.g. /usr/local/bin/msb
        "projectDir":      "_tenant/config/microsandbox",  // resolved relative to tenant workspace; expects a Sandboxfile inside
        "sandboxName":     "default",            // which named sandbox in the Sandboxfile to drive
        "idleShutdownMs":  14400000,             // 4 h, matching the closed-source repo
        "execTimeoutMs":   300000                // 5 min default per-exec timeout; tools can extend up to 30 min
      }
    },
    "code-interpreter-ui": {
      "enabled": true                    // would fail if microsandbox disabled
    }
  }
}
```

Per-plugin `config` is opaque to the host and passed through to the
plugin's `activate(ctx)` (new field on `PluginContext.pluginConfig`).

### 12. `GET /api/plugins` shape changes

Added per-entry fields:

```ts
interface PluginListEntry {
  // … existing fields
  contributes: ContributesV1;    // includes the new `sandboxes` array
  capabilities: {
    provided: string[];           // ["sandbox.shell", "browser.cdp"]
    requires: string[];           // []
    missing:  string[];           // capabilities listed in requires but not satisfied
  };
}
```

Plugin Manager UI surfaces `missing` as a red badge on the row, with
a tooltip listing the missing capability names. Disabling a provider
that someone else `requires` shows a confirmation modal listing the
dependents.

### 13. Builtin plugin set update

ADR-0003 §11 names the v0 builtin plugin set as
`files / browser / task-board / calendar`, with `files` enabled in
the dev tenant by default and the rest opt-in. **This ADR adds
`microsandbox` as the fifth builtin.** The full post-ADR-0004 set is:

| # | Plugin id | Provides | Dev-tenant default | Notes |
| --- | --- | --- | --- | --- |
| 1 | `files` | — | **enabled** | Workspace browser + composer paperclip. ADR-0003 §11. |
| 2 | `browser` | — | opt-in | Browser panel stub; will be merged with `microsandbox`'s `browser.cdp` provider in a future ADR. |
| 3 | `task-board` | — | opt-in | Kanban panel stub. ADR-0003 §11. |
| 4 | `calendar` | — | opt-in | Calendar panel stub. ADR-0003 §11. |
| 5 | `microsandbox` | `sandbox.shell`, `browser.cdp` | opt-in | New in ADR-0004. Lives at `packages/server/builtinConfig/plugins/microsandbox/`. |

Why `microsandbox` is opt-in rather than enabled-by-default:

- The microsandbox binary is user-supplied; auto-enabling would
  hard-fail every fresh install that doesn't have it on PATH.
- Once enabled, the plugin still degrades gracefully via the
  nullable runner (§9) — the user gets a status panel telling them
  what's missing instead of a crash.
- The opt-in pattern is consistent with how ADR-0003 already treats
  `browser / task-board / calendar`: present under
  `builtinConfig/plugins/`, invisible until added to
  `<tenant>/config.json`.

The Plugin Manager UI (ADR-0003 §8) lists `microsandbox` in the
"Available" view so a tenant admin can flip it on with one click,
matching the existing pattern.

**Open question deferred to a later ADR:** the existing `browser`
builtin (panel stub) overlaps with `microsandbox`'s `browser.cdp`
capability. v0 keeps them separate — the stub `browser` builtin
is a client-only panel, `microsandbox`'s `browser.cdp` is the
actual sidecar. When the agent's browser tool lands (PR N+3), it
binds to the capability, not to the stub plugin. We unify the two
in a follow-up once the surface stabilises.

### 14. Sandboxfile relationship

This plugin is a **driver**, not a packaging system. The contract is:

```
<tenant>/_tenant/config/microsandbox/
├── Sandboxfile                ← authored by the tenant admin
└── (any other files referenced by Sandboxfile mounts)
```

The plugin invokes the microsandbox binary against this project on
`start()` and reuses the resulting microVM(s) for the tenant's
lifetime. We never parse Sandboxfile semantics ourselves beyond
locating the named sandbox; everything else is delegated.

If the user wants a different image, they edit the Sandboxfile and
call `reset()` (or restart the tenant). No "image build" step in our
code path.

### 15. Builtin plugin loading: file-scan instead of hard-coded

ADR-0003 §7 said builtin plugins are statically `import`-ed in
both the server (`packages/server/src/index.ts`'s
`moduleMapResolver`) and the web bundle. This made adding a builtin
a two-place change: drop a `manifest.json` directory **and** edit
`index.ts`. With v0 having only `files` it was fine; with
`microsandbox` (and the catalog letting tenants drop new plugin
dirs at runtime) it stops being fine.

This ADR revises the loading rule to **convention-based file
scanning on both sides**:

**Server** (Node ESM, fully dynamic):

```ts
// pseudo-code in core/plugins/registry.ts
async function buildBuiltinResolver(builtinDir: string) {
  const ids = await fs.readdir(path.join(builtinDir, "plugins"));
  const map: Record<string, PluginServerModule> = {};
  for (const id of ids) {
    const manifestPath = path.join(builtinDir, "plugins", id, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    if (!manifest.server?.entry) continue;
    const modUrl = pathToFileURL(
      path.join(builtinDir, "plugins", id, "dist", "server.js"),
    ).href;
    const mod = await import(modUrl);
    map[manifest.server.entry] = mod.default ?? mod;
  }
  return moduleMapResolver(map);
}
```

The scan runs the **first** time a tenant calls
`registry.ensureForTenant()` and the result feeds into a
process-level resolver cache (Node's ESM cache deduplicates the
actual module bodies). Subsequent tenants reuse the cached module
graph, so this is not a per-tenant cost.

**Web** (Vite static glob — still build-time, but no manual list):

```ts
// packages/web/src/plugins/registry.ts
const manifests = import.meta.glob(
  "/plugins/*/manifest.json",
  { eager: true, import: "default" },
);
const clients = import.meta.glob(
  "/plugins/*/dist/client.js",
  { eager: true },
);
// build a (id, components) map from the two
```

Vite resolves the glob at build time, so adding a builtin = drop
the directory + add it to the npm workspace, no edit to web
entrypoint code. Tenant-installed plugins (catalog-downloaded)
still go through the v1 dynamic-import path — not enabled in v0.

What this is **not**: a third-party server-plugin runtime. The
v0 trust model is unchanged — we only auto-load plugins that
live under `builtinConfig/plugins/` (shipped with the server) or
`<tenant>/_tenant/config/plugins/` (installed by an authenticated
admin via the catalog or by hand). We do not run arbitrary code
from random directories.

### 16. Refresh protocol — lazy with explicit invalidation

The registry already has `ensureForTenant()` (lazy, cached) and
`invalidate(tenantId)` (drop cache so the next `ensureForTenant()`
re-runs discovery + activation). v0 surfaces these to clients via:

| Endpoint | Effect |
| --- | --- |
| `GET /api/plugins` | Reads cache. Triggers initial discovery + activation if cache is empty for this tenant. |
| `PATCH /api/plugins/:id` | Writes `<tenant>/config.json`, calls `registry.invalidate(tenantId)`, returns fresh list. **Already implemented.** |
| `POST /api/plugins/catalog/refresh` | Re-fetches the remote catalog (separate cache from the registry). Already implemented. |
| `POST /api/plugins/refresh` *(new)* | Calls `registry.invalidate(tenantId)` and returns the freshly discovered + activated list. Use after manually dropping a plugin directory, after a `git pull` that adds a new builtin, or after a catalog install (§3). |
| `POST /api/plugins/install` *(catalog P2)* | Downloads a tarball, extracts to `<tenant>/_tenant/config/plugins/<id>/`, writes `enabled: true` in tenant config, then internally calls `registry.invalidate(tenantId)` so the same response includes the activated entry. |

Client-side, the Plugin Manager UI:

- Shows a **Refresh** button next to the tab strip that calls
  `POST /api/plugins/refresh`. Useful during local dev when the
  user is editing a builtin in-tree.
- Optimistically updates after `PATCH /api/plugins/:id` using the
  returned list.
- After `POST /api/plugins/install` succeeds, replaces the
  Installed-tab list with the response (no extra round-trip).

What we do **not** do in v0:

- **No fs watcher.** Re-scanning is explicit (PATCH / refresh /
  install). A watcher tempts plugin authors to think "hot reload
works"; module cache invalidation in Node is fiddly enough that
  the right answer for hot-edit-during-dev is restart the server.
- **No process-wide invalidation API for client usage.** A tenant
  cannot force re-discovery for *other* tenants. The catalog
  install path runs server-side and only invalidates the calling
  tenant; if an admin wants to push a builtin into every tenant
  they restart the server.
- **No module cache eviction on PATCH.** Toggling enabled →
  disabled → enabled re-runs `activate()` against the same module.
  Plugin authors must keep `activate()` idempotent if they hold
  process-global state — already implied by ADR-0003 §6 ("failure
  isolation") but worth restating.

### 17. Builtin visibility (revises ADR-0003 §11)

ADR-0003 §11 says "plugins not listed in `<tenant>/config.json`
are completely invisible." That rule was written for the
`browser / task-board / calendar` stubs and stays correct for
**third-party / catalog-installed** plugins, but it doesn't fit
builtins: a user expects builtins to be discoverable in the Plugin
Manager without first hand-editing `config.json`.

Revised rule:

| Source | Listed in `config.json`? | Visible in Plugin Manager? | Active? |
| --- | --- | --- | --- |
| **builtin** | yes, `enabled: true` | ✅ Installed tab | ✅ |
| **builtin** | yes, `enabled: false` | ✅ Installed tab (off) | ❌ |
| **builtin** | not listed | ✅ Installed tab (off, default) | ❌ |
| **tenant** (§catalog) | yes, `enabled: true` | ✅ Installed tab | ✅ |
| **tenant** | not listed but on disk | ✅ Installed tab (off) | ❌ |
| **tenant** | listed but not on disk | ❌ ("failed" diagnostic) | ❌ |
| **catalog only** (not downloaded) | n/a | ✅ Catalog tab only | ❌ |

The deciding rule: **"installed = on disk under a known plugin
root"**, not "listed in config." Config decides activation, not
visibility. ADR-0003 §4's three-state semantics (`listed+enabled`,
`listed+disabled`, `not listed`) collapses for builtins into two
states (`active`, `inactive`); the third state is not meaningfully
different from listed+disabled and the UI no longer distinguishes
them.

Server impact: `listPluginsForTenant()` already returns failed +
disabled rows; the change is in `ensureForTenant()` — builtins not
listed in config now get `state: "disabled"` rather than being
filtered out of `discoverPlugins()` results. The `?show=available`
opt-in from ADR-0003 §4 becomes redundant for builtins; we keep
it for tenant plugins-on-disk-but-not-config (rare, used during
upgrade / manual install).

## Alternatives considered

### Plugin `type` field

```jsonc
{ "id": "microsandbox", "type": "sandbox" }
```

**Rejected** because:

- One plugin already legitimately straddles slots (e.g. `files`
  contributes panels + composer actions + attachment renderers). A
  type-tag forces an artificial 1:1 between plugin and "kind".
- It's a less-flexible re-statement of contribution slots: every
  capability question — "is this a sandbox?", "is this a vector
  store?" — turns into "which slot did it contribute to?" anyway.
- Tools like VSCode (our primary inspiration per ADR-0003) explicitly
  don't type extensions; they look at `contributes.*` keys.

### Free-form capability strings derived from contribution slots

Earlier draft: derive `sandbox.shell` automatically from
`contributes.sandboxes[].kind = "shell"`. **Rejected** in favour of
the closed vocabulary in §3 because:

- A capability isn't always tied 1:1 to a contribution slot
  (`auth.sso`, `runtime.gpu-available` would have nowhere to live).
- Implicit derivation hides the platform's surface area; a closed
  list in `capabilities.ts` makes review trivial.
- Maintainer-controlled vocabulary prevents capability-name drift
  between plugins (`sandbox.shell` vs `shell-sandbox` vs `shell.run`).

### `requires.pluginId`

Allow a plugin to require a specific plugin id rather than a
capability. **Rejected**: turns plugins into singletons by name
and prevents drop-in replacement. If something is worth depending
on, it's worth giving a capability tag.

### Single `sandbox` field on the manifest root

```jsonc
{ "id": "microsandbox", "sandbox": { "kind": "code" } }
```

**Rejected**. Same shape as a contribution slot but inconsistent
with how every other extension point is authored. Future
`vectorStores`, `llmRouters` would each invent their own root
field. Better to put them under `contributes` so the mental model
stays uniform.

### Multi-provider sandboxes with a router

Allow N plugins to provide `sandbox.shell`; let the agent / user
pick. **Rejected for v0**: increases UX surface, requires a
selection layer in chat, and the per-tenant single-instance lifecycle
means the marginal cost of "just disable the other one" is tiny.
Reconsider once we have >1 sandbox plugin in the wild.

## Roll-out

| PR | Scope |
| --- | --- |
| **N (this)** | ADR-0004 (docs only). |
| **N+1** | `@tianshu/plugin-sdk` adds `SandboxRunner` / `SandboxModule` / `CapabilityHandle` + `KNOWN_CAPABILITIES` table; manifest types add `sandboxes[]`, `provides[]`, `requires[]`. Registry adds capability registry, topological sort, exclusivity checks. `GET /api/plugins` exposes capabilities[] and surfaces builtins as `disabled` rows even when not listed in tenant config (§17). `POST /api/plugins/refresh` endpoint added (§16). Tests cover requires-missing, exclusivity violation, cycle, requires-after-disable. |
| **N+1.5** | Convert builtin server loading from hard-coded `moduleMapResolver` to file-scan dynamic import (§15, server side). Convert web `PluginRegistry` to `import.meta.glob` (§15, web side). No new builtins added in this PR — just the loader change with `files` continuing to work. Plugin Manager UI gains a Refresh button. |
| **N+2** | `plugins/microsandbox/` builtin plugin: `nullable` runner first, then real microsandbox-binary integration behind a feature flag in `config.example.json`. Dev tenant config does **not** enable it by default — opt-in. |
| **N+3** | Agent loop wires `exec` / `reset_sandbox` / `browser` tools to the capability registry (§10); status-gated. Right-panel `SandboxShellPanel` (interactive shell, port of `SandboxShell.tsx` from the closed-source repo) + `BrowserPanel` (noVNC / CDP viewport) + `SandboxStatusPanel` (lifecycle + Reset). |
| **N+4** | (post-merge) Dynamic-packaging from user files (§9). Behind a separate flag because it shells out to `docker build` / similar. |

## Consequences

### Good

- **Same mental model** as ADR-0003 — one more contribution slot,
  one more named capability, no new top-level taxonomy.
- **Clear failure modes.** "Two sandboxes enabled" → second fails
  with a named reason. "Plugin needs sandbox.shell, none enabled" →
  fails before it can throw inside `activate()`. Both surface in
  Plugin Manager UI via existing `state: "failed"` plumbing.
- **Reusable.** When we later add `sandbox.vm`, `vectorStore.*`,
  `llmRouter.*` — each adds one slot + one capability prefix. No
  core changes.
- **Per-tenant long-lived runners** match real workloads (notebook-style
  iteration) without the per-conversation memory blow-up.

### Trade-offs accepted

- **No multi-provider sandboxes in v0.** Tenant has to pick one.
- **No automatic restart on crash** in v0 — the runner exposes
  `status()` and a manual Reset; supervised restart is future work.
- **Capability strings are derived, not authored.** A future
  contribution slot has to update the derivation table. We accept
  this in exchange for never having to ask plugin authors to
  hand-author capability names (which would diverge).
- **`microsandbox` requires a user-installed binary.** This keeps
  the open-source repo lean (no vendored runtime) at the cost of a
  more complex first-run experience. Mitigated by the gate in §10:
  if the binary isn't found, the agent simply doesn't see
  `exec` and the status panel tells the user why.

## References

- ADR-0001 (multi-tenant), ADR-0002 (workers), ADR-0003 (plugins).
- microsandbox: <https://github.com/microsandbox/microsandbox>
- VSCode `contributes` field (extension manifest).
