# `plugins/` — Tianshu plugin projects

This directory hosts the source for **Tianshu plugins** — UI panels,
sidebar sections, server routes, WS handlers — authored as their own
npm workspaces under the monorepo umbrella.

> Background: [ADR-0003 — Plugin system](../docs/architecture/plugins.md).

## Layout

Each plugin is a self-contained workspace package:

```
plugins/
├── files/
│   ├── package.json           # name: "@tianshu-plugin/files"
│   ├── manifest.json          # PluginManifest (ADR-0003 §5)
│   ├── server.ts              # exports activate(ctx)
│   ├── client.tsx             # exports components map
│   └── tsconfig.json
├── browser/
├── task-board/
└── calendar/
```

The four directories above are the planned **builtin** plugins that
ship with the server bundle (per ADR-0003 §11). Tenant-installed
plugins live elsewhere — at
`<tenant>/_tenant/config/plugins/<id>/` inside a tenant's workspace —
and are out of scope for this directory.

## How a plugin is wired

1. The plugin's package builds to `dist/` like any other workspace.
2. `npm run sync:plugins` (also run automatically by `npm run build`
   and `npm run dev`) copies each plugin's `manifest.json` into
   `packages/server/builtinConfig/plugins/<id>/manifest.json` so
   server-side discovery finds it at runtime. Those copies are
   `.gitignore`d — the plugin source is the single source of truth.
3. `packages/server/src/index.ts` imports each builtin plugin's
   `server` entry and registers it with the `PluginRegistry`'s
   `moduleMapResolver`.
4. `packages/web/src/lib/plugin-registry.ts` (PR #33, planned) will
   import each plugin's `client` entry statically and wire the
   components into the chat shell's contribution slots. Until then
   the panels exist as code but the chat shell renders only its own
   built-in surfaces.

## Authoring rules (in short)

- Plugin id: `^[a-z0-9][a-z0-9-]{1,30}$`. Globally unique.
- Manifest schema: see `@tianshu/plugin-sdk` types.
- Server module exports `activate(ctx) -> { routes?, wsHandlers? }`
  and optional `deactivate()`. Throws inside `activate()` mark the
  plugin `state: "failed"` without taking down siblings.
- Client module exports a `components` map keyed by the strings used
  in `manifest.contributes`.
- API routes are mounted at `/api/p/<plugin-id>/<path>` automatically
  by the host — never hard-code that prefix in your plugin.
- WS message `type` strings must be globally unique across active
  plugins; recommended namespace is `<plugin-id>:<event>`.

A walk-through ("How to write a plugin") will land in
`CONTRIBUTING.md` as part of **ADR-0003 PR #34**.
