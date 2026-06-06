# ADR-0003 — Plugin system (UI panels, sidebar sections, API routes)

| Status | Accepted |
| --- | --- |
| Date | 2026-06-04 |
| Updated | 2026-06-05 — added `composerActions` contribution + `useComposer()` host API (see §12) |
| Author | Yu Yu |
| Supersedes | — |
| Depends on | [ADR-0001 — Multi-tenancy from row 1](./multi-tenant.md), [ADR-0002 — Orchestrator + workers](./workers.md) |

## Context

Tianshu's chat UI has a row of icons in the top bar that toggle
right-side panels (files / browser / task-board / calendar / usage),
plus sections in the sidebar (workers, channels). The closed-source
predecessor wires every one of these in by hand inside the React
tree.

> **Note on “sessions”.** Sessions are an internal-only concept in
> Tianshu (per ADR-0001 §5): the agent decides when to compact and
> when to start a fresh session, and the user-visible conversation is
> a single endless stream. There is therefore no `sessions` sidebar
> section to plug into.

This does not match the project's positioning. Two reasons:

1. **Multi-tenant.** Different tenants want different surfaces. The
   "team running a research lab" doesn't need a kanban; the "agency
   running customer support" wants chat-channel bindings on the
   sidebar. Hard-coding all of them and toggling visibility is not the
   same as letting a tenant install only what they want.
2. **Build-in-public extensibility.** We want third parties to write
   plugins. That means there has to be a real plugin contract — not a
   "feature flag" disguised as one.

> **A plugin is not a feature flag. "Not installed" must mean "not
> visible". No grey-out, no tooltips telling the user to enable
> something they don't know about.**

## Inspirations

We looked at four extension models before settling on a hybrid:

| System | What we took |
| --- | --- |
| **VSCode Extension API** ⭐ primary | The `contributes` field. A single manifest declares **multiple contribution points** (commands, views, menus, keybindings, …); the runtime ships an `activate(context)` entry. We use this exact shape. |
| **Obsidian Plugin API** | Inside `onload()`, plugins call `addRibbonIcon` / `addCommand` / `registerView` programmatically. We let plugins return imperative handlers from `activate()` so manifest stays declarative AND runtime stays flexible. |
| **Backstage** | Explicit named "extension points" rather than free-form hooks. We use named contribution slots (`topBarButtons` / `rightPanels` / `sidebarSections` / …) instead of `addAnything(...)`. |
| **Logseq** | Reminded us not to invent a DOM API; React component refs are enough at this scale. |

We deliberately did not adopt:

- **Marketplace / signing / sandboxing** — out of scope for v0–v1.
  Adds enormous complexity for a tool with zero users.
- **A custom JS runtime** — plugins run in the same Node process / web
  bundle. Trust model in v0 is "tenant admin curates the list".

## Decision

### 1. Two surfaces, one mental model

A plugin is **one directory** containing one manifest plus a server
entry and a client entry. It can contribute to multiple slots
simultaneously.

```
<plugin-dir>/
├── manifest.json
├── server.ts (or server/index.ts)   # exports activate / deactivate
└── client.tsx (or client/index.tsx) # exports components map
```

A v0 builtin plugin lives at
`packages/server/builtinConfig/plugins/<id>/`. A tenant-installed plugin
lives at `<tenant>/workspace/_tenant/config/plugins/<id>/`.

> Worker manifests (ADR-0002) share the same directory-layering
> convention but are **a separate registry** because their lifecycle
> (poll loop, task claim) differs from UI plugins.

### 2. Always-on bundled surfaces

One surface is part of the chat shell itself, not a plugin, and
cannot be uninstalled:

- **`usage` panel** showing token / cost stats for the current tenant.

It ships inside `@tianshu/web` and `@tianshu/server`, hard-coded.
Anything else is a plugin.

(Sessions are agent-managed, not user-managed — see ADR-0001 §5 —
so there is no “new session” affordance in the chrome.)

### 3. Layering & resolution

Same rule as ADR-0002 §4:

- builtin and tenant directories are scanned independently
- same `id` → tenant manifest **fully replaces** builtin
- new `id` in tenant → tenant-only plugin

### 4. Tenant config decides what's installed

`<tenant>/config.json` adds an overridable field (per ADR-0001 §7
allow-list):

```jsonc
{
  "plugins": {
    "files":      { "enabled": true },
    "browser":    { "enabled": true }
    // "task-board" not listed → invisible
  }
}
```

- listed + `enabled:true` → installed and active
- listed + `enabled:false` → installed but paused (visible in
  admin UI, not in chat UI)
- not listed → completely invisible (won't appear in admin UI's
  default view either; must `?show=available` opt-in)

The v0 way to install/uninstall a plugin is to flip the toggle in
the bundled **Plugin Manager** modal (top-bar puzzle-piece icon).
This writes to `<tenant>/config.json` atomically. Hand-editing the
file + restarting still works for ops use cases.

### 5. Manifest schema

Field naming follows VSCode where possible (`contributes`, `activate`).

```jsonc
{
  "id":          "files",                            // required, ^[a-z0-9][a-z0-9-]{1,30}$
  "version":     "1.0.0",                            // required, semver
  "displayName": "Workspace Files",                  // required
  "description": "Browse files in _tenant/projects/",
  "author":      "tianshu-ai",
  "license":     "Apache-2.0",
  "permissions": ["workspace.read"],                 // declarative only in v0
  "client": { "entry": "@tianshu-builtin/plugin-files/client" },
  "server": { "entry": "@tianshu-builtin/plugin-files/server" },

  "contributes": {
    "topBarButtons": [{
      "id":          "files.toggle",
      "icon":        "FolderOpen",                   // lucide-react export name
      "tooltip":     "Workspace files",
      "opensPanel":  "files.main",
      "order":       100                             // optional, default 100
    }],
    "rightPanels": [{
      "id":          "files.main",
      "displayName": "Files",
      "component":   "FilesPanel"                    // key in client.components
    }],
    "sidebarSections": [{
      "id":          "files.recent",
      "displayName": "Recent",
      "component":   "FilesSidebarRecent",
      "after":       "workers"                       // anchor point id
    }],
    "apiRoutes": [{
      "method":  "GET",
      "path":    "/files/list",                      // mounted at /api/p/<plugin-id>/files/list
      "handler": "listFiles"                         // key in server.exports.routes
    }],
    "wsMessages": [{
      "type":    "files.subscribe",
      "handler": "handleSubscribe"
    }],
    "commands": [{
      "id":    "files.newProject",
      "title": "New project"
    }]
  }
}
```

### 6. Server-side runtime API (`@tianshu/plugin-sdk`)

A server-side plugin module exports `activate` (and optional
`deactivate`):

```ts
import type { PluginContext, PluginServerExports } from "@tianshu/plugin-sdk";

export async function activate(ctx: PluginContext): Promise<PluginServerExports> {
  ctx.log.info(`activating files for tenant ${ctx.tenantId}`);
  return {
    routes: {
      listFiles: (req, res) => { /* … */ },
    },
    wsHandlers: {
      handleSubscribe: (msg, ws, ctx) => { /* … */ },
    },
  };
}

export async function deactivate(): Promise<void> { /* cleanup */ }
```

`PluginContext` is strictly tenant-scoped:

```ts
interface PluginContext {
  pluginId: string;
  tenantId: string;
  /** The opened tenant DB — same instance used by core. */
  db: Database;
  /** Resolved + merged tenant config. */
  config: ResolvedConfig;
  /** Bound logger that prefixes [plugin:<id>] [tenant:<id>]. */
  log: PluginLogger;
  /** Absolute path to the tenant's workspace dir. */
  workspaceDir: string;
  /** Send a WS message to every socket connected for this tenant. */
  broadcast(type: string, payload: unknown): void;
}
```

API routes a plugin contributes are mounted at:

```
/api/p/<plugin-id>/<contributed-path>
```

The `/api/p/` prefix keeps plugin routes from colliding with core
routes (`/api/me`, `/api/health`, `/api/plugins`).

Errors:

- `activate()` throws → plugin marked `state: "failed"`, included in
  `GET /api/plugins` for diagnostics, but its routes / WS handlers are
  **not** mounted. One bad plugin must not take down sibling plugins
  or core.
- A handler throwing inside a request → standard Express error path;
  the runtime adds `X-Tianshu-Plugin: <id>` header for traceability.

### 7. Client-side runtime API

A client-side plugin module exports a `components` map keyed by the
strings used in the manifest's `contributes`:

```ts
import type { PluginClientExports, PanelProps, SidebarSectionProps } from "@tianshu/plugin-sdk/client";
import FilesPanel from "./FilesPanel";
import FilesSidebarRecent from "./FilesSidebarRecent";

export const components: PluginClientExports["components"] = {
  FilesPanel: FilesPanel as React.FC<PanelProps>,
  FilesSidebarRecent: FilesSidebarRecent as React.FC<SidebarSectionProps>,
};
```

Components receive a tightly typed `props`:

```ts
interface PanelProps {
  tenantId: string;
  userId: string;
  plugin: PluginRuntimeInfo;            // { id, version, displayName }
}

interface SidebarSectionProps extends PanelProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

interface ComposerActionProps extends PanelProps {
  composer: ComposerApi;                // see §12
}
```

A `PluginRegistry` in `@tianshu/web` statically imports every builtin
plugin's `client` module and registers its components by `<plugin-id, component-key>`. The chat shell asks the
registry for components when rendering the lists returned by
`GET /api/plugins`.

Tenant-only plugins (v1+ feature) will be loaded via dynamic
`import()`. In v0, a tenant manifest whose `client.entry` is not in
the registry surfaces as `state: "client-bundle-missing"` in
`GET /api/plugins` and its UI contributions are silently dropped (per
the "not installed = not visible" rule).

### 8. Server API

```
GET  /api/plugins
```

Returns the resolved list, in stable order:

```ts
interface PluginListEntry {
  id: string;
  version: string;
  displayName: string;
  description: string | null;
  source: "builtin" | "tenant";
  state: "active" | "disabled" | "failed" | "client-bundle-missing";
  failedReason?: string;
  contributes: ContributesV1;       // exactly as in manifest
}
```

v0 ships both endpoints:

```
GET   /api/plugins             # list
PATCH /api/plugins/:id         # body: { "enabled": boolean }
```

The Plugin Manager UI calls `PATCH` to flip enabled state for the
current tenant. The server persists the change to
`<tenant>/config.json`, invalidates the tenant's plugin registry
cache, and re-runs discovery + activation so the new state is live
for subsequent requests.

### 9. Activation & broadcast

- Plugin activation runs on tenant DB pool open (lazy, per-tenant), so
  `tenantA` getting a request triggers activation only for that
  tenant. Process-global plugins don't exist in v0.
- A plugin's WS handler runs in the same socket loop as core chat;
  message `type` strings are matched against the manifest. Two
  plugins must not register the same `wsMessages.type` — duplicate
  registration is a plugin-load failure for the second.

### 10. Naming & ID rules

- `id`: `^[a-z0-9][a-z0-9-]{1,30}$` (same shape as tenantId for
  consistency).
- Top-bar button id: `<plugin-id>.<key>`.
- Right-panel id: `<plugin-id>.<key>`.
- API mount: `/api/p/<plugin-id>/<path>`.
- WS message types: free-form strings, but must be globally unique
  across active plugins; recommended namespace `<plugin-id>:<event>`.

### 11. Default tenant config (dev mode)

The `bootstrapDevTenantIfNeeded` helper installs **only the `files`
plugin** in the dev tenant's `config.json`. The files plugin
contributes both the right-side panel (browse / preview) and the
composer paperclip button (upload), so a fresh install has the basic
chat workflow out of the box. Other builtin plugins (browser /
task-board / calendar) are present under `builtinConfig/plugins/`
but are **not listed** in the dev tenant's config — the user has to
opt in by editing `config.json`. This makes the "plugin opt-in"
semantics observable on the very first boot.

### 12. Composer contributions (added 2026-06-05)

The chat composer (the textarea + send button at the bottom of the
chat shell) is itself an extensible surface. Plugins contribute
buttons to it via `contributes.composerActions[]`:

```jsonc
{
  "contributes": {
    "composerActions": [{
      "id":        "attach",
      "icon":      "Paperclip",        // lucide-react export name
      "tooltip":   "Attach file",
      "component": "UploadButton",     // key in client.components
      "order":     100
    }]
  }
}
```

A contributed component receives `ComposerActionProps`, which adds
a `composer: ComposerApi` field to the standard `PanelProps`:

```ts
interface Attachment {
  id: string;                           // host-assigned
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  path?: string;                        // relative to user home, e.g. /uploads/x.csv
  progress?: number;                    // 0..1
  error?: string;
  meta?: Record<string, unknown>;
}

interface ComposerApi {
  attachments: Attachment[];
  addAttachment(a: Omit<Attachment, "id">): string;
  updateAttachment(id: string, patch: Partial<Omit<Attachment, "id">>): void;
  removeAttachment(id: string): void;
  registerDraftTransform(fn: DraftTransform): () => void;
}

type DraftTransform = (
  text: string,
  attachments: Attachment[],
) => string | Promise<string>;
```

Plugins use the API in two coordinated ways:

1. **Stage attachments.** Adding an `Attachment` makes the host
   render a chip above the textarea and disables Send while any
   attachment has `status === "uploading"`. Errored attachments do
   not block sending — the user can remove them or send anyway.
2. **Register a draft transform.** Just before the user's text is
   sent, the host runs each registered transform in registration
   order on the draft. This is how the `files` builtin's paperclip
   appends an `[Attached files]` block so the agent (which already
   knows about `./uploads/` from its system prompt — ADR-0001 §3)
   sees the list without us touching the WebSocket protocol.

The SDK exposes a `useComposer()` hook so plugin components can pull
the live `ComposerApi` without prop-drilling:

```ts
import { useComposer } from "@tianshu/plugin-sdk/client";

function UploadButton() {
  const composer = useComposer();
  // …
}
```

The host installs the live accessor at boot via
`__installUseComposer(...)`; the SDK keeps a single accessor slot.
In unit tests for plugin components, install a fake accessor before
rendering.

**Why text addendum, not a new WS message field?** The chat protocol
stays simple, the agent's mental model stays simple (PR #46 already
taught it that uploads live in `./uploads/`), and the upload plugin
is end-to-end reusable in environments that route messages through a
different transport. A structured `attachments[]` field on the
outbound message is a future option — it adds value when we want
typed consumption (e.g. "this image is rendered to the model as
image tokens") and that's not v0 surface.

**Why share state through a host store, not a context provider?**
Plugin composer components and the ChatInput live in unrelated
subtrees under `ChatLayout`. Threading a context through both works
but couples the layout shape to the SDK; a small zustand-backed
store keeps the SDK's React surface to one hook (`useComposer`) and
matches the rest of the web bundle's patterns.

### 13. Trust model (added 2026-06-07)

v0 plugins are **mutually trusted**. Concretely:

- All plugins share the tenant SQLite handle. A plugin can read or
  write any other plugin's tables. The host does not partition the
  schema by plugin id.
- All plugins share the workspace filesystem. A plugin can read or
  write any path under `<tenant>/workspace/`, including other
  plugins' state directories and other users' homes.
- All plugins share the tenant config write surface. A plugin can
  rewrite `<tenant>/config.json`, including disabling other
  plugins or changing global settings.
- `apiRoutes` mounted under `/api/p/<plugin-id>/...` share the
  tenant middleware's auth. Plugin A can call plugin B's routes
  with the same tenant credentials. There is no
  per-plugin route ACL.
- The `manifest.permissions[]` field is **declarative only**. The
  host does not check it before any of the above.

This is the right tradeoff for v0 because the only plugins that
load are **builtins shipped in the host repo** (`files`,
`microsandbox`) and tenant-installed plugins that the tenant admin
chose to install — same trust level as installing an npm package.

When the catalog ships third-party plugins (post-v1), this section
gets superseded by a real trust-boundary ADR. Likely shape:

- `permissions[]` enforced via a host-side gate that wraps
  `db`, `fs`, `apiRoutes`, and capability lookups.
- Plugin-to-plugin route calls require an explicit grant.
- Tenant config writes from a plugin require a permission and run
  through a validator that refuses changes to fields the plugin
  doesn't own.

**Until then: do not treat plugin boundaries as a security boundary.**
A malicious plugin can do anything the tenant can do.

## Consequences

### Good

- **One uniform abstraction** for top-bar buttons, right-side panels,
  sidebar sections, server routes, and WS handlers. New surface types
  (e.g. command palette later) just become new keys under
  `contributes`.
- **Crisp install semantics.** Not in `config.plugins` ⇒ user never
  sees it. No grey-out anti-pattern.
- **Tenants can replace builtins by id.** Acme can ship its own
  `files` panel implementation and the chat shell never knows the
  difference.
- **Failure isolation.** A broken plugin can't take down core or
  siblings.

### Trade-offs accepted

- **No dynamic third-party UI in v0.** Tenant manifests can declare
  contributions but their components must already be in the bundled
  `PluginRegistry` (i.e. v0 third-party plugins are server-only). Real
  dynamic-import client loading lands in v1. Day-0 we don't want to
  ship a custom module loader.
- **`activate()` runs in the same Node process.** No sandboxing in
  v0. Trust model = "tenant admin curates the list and trusts the
  authors". Marketplace / signing arrive in v2+.
- **Manifest is canonical, code is source of truth for contracts.**
  If a plugin's `manifest.contributes.commands[].id` doesn't match
  what its code emits, the manifest's claim is what shows up in the
  UI; the code's emit is what fires. Inconsistencies are the
  plugin's problem to fix. We do *not* enforce coupling at load time
  beyond unique-id checks.

## Roll-out

| PR | Scope |
| --- | --- |
| **#30** (this) | ADR-0003 (docs only) |
| **#31** | `@tianshu/plugin-sdk` package + server-side plugin discovery / activation / `GET /api/plugins` + tenant config `plugins` whitelist field. **Plugin Manager UI** (top-bar puzzle button) shipped together so PATCH replaces the "edit config + restart" workflow. |
| **#32** | 4 builtin plugin stubs: `files` / `browser` / `task-board` / `calendar` (each with full manifest, minimal server.activate, client component stub). All not enabled by default. |
| **#33** | Web `PluginRegistry`; replace ChatArea's hard-coded disabled icon row with manifest-driven rendering; drop the disabled placeholders. |
| **#34** | Docs: CONTRIBUTING "How to write a plugin"; `config.example.json` `plugins` snippet; bootstrapDevTenantIfNeeded enables `files` so first boot has something. |

### Catalog roll-out (parallel track)

The catalog lets users discover and install plugins authored in
separate repos. Hosted at
[`tianshu-ai/plugin-registry`](https://github.com/tianshu-ai/plugin-registry);
self-host by setting `TIANSHU_CATALOG_URL`.

| PR | Scope |
| --- | --- |
| **P1** (this slice) | Read-only catalog: `GET /api/plugins/catalog` + `POST /api/plugins/catalog/refresh`; Plugin Manager gains a `Catalog` tab listing entries with author / version / verified badge. **Install button is disabled** — lands in P2. |
| **P2** | `POST /api/plugins/install` — server downloads tarball, verifies declared `tarballSha256`, extracts to `<tenant>/_tenant/config/plugins/<id>/`, writes `enabled: true`, invalidates registry. Wires up the Catalog tab's Install button. |
| **P3** | First end-to-end community plugin in its own repo (`tianshu-ai/plugin-pomodoro` or similar) and a getting-started doc. |
| **P4** | Uninstall (delete on-disk dir + clear config). |
| **P5** | Upgrade detection (compare installed version vs `latestVersion`; surface a badge in Plugin Manager). |

## References

- `agent-manager.ts:1115-1300` (closed-source) — skills resolution
  layering rule we re-use here.
- VSCode Extension API: `package.json#contributes`,
  `vscode.ExtensionContext`.
- Obsidian Plugin API: `Plugin.onload()`, `addRibbonIcon`,
  `registerView`.
- Backstage: extension points + `createExtension`.
- ADR-0001 (multi-tenant), ADR-0002 (workers).
