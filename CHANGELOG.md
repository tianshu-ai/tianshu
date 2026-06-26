# Changelog

All notable changes to this project will be documented in this file.

See [Conventional Commits](https://www.conventionalcommits.org) and
[release-please](https://github.com/googleapis/release-please) for how
this file is automatically maintained.

## [0.3.30](https://github.com/tianshu-ai/tianshu/compare/v0.3.29...v0.3.30) (2026-06-26)

### Bug Fixes

* **ui:** PDF / HTML / image previews collapsed to a thin strip
  at the top of the modal because FilePreviewModal and
  FileOpenDialog wrapped DocumentViewer in `min-h-0 flex-1
  overflow-auto`. An `overflow-auto` parent does not propagate
  bounded height to a `h-full` iframe / img child — it becomes
  a scroll container, and the inner element falls back to
  content height (effectively zero for a remote PDF loading
  asynchronously). Outer body wrappers now use a plain
  `flex min-h-0 flex-1 flex-col` and each DocumentViewer branch
  owns its own overflow when it needs one.

## [0.3.29](https://github.com/tianshu-ai/tianshu/compare/v0.3.28...v0.3.29) (2026-06-26)

### Bug Fixes

* **ui:** three layout regressions in 0.3.28's file previews:
  * HTML preview height collapsed because the iframe sat inside
    an `overflow-auto` parent (an overflow container does not
    propagate height to a `h-full` child). Iframe now gets the
    full body directly.
  * CodeBlock first source line offset ~16px below the gutter's
    "1" because shiki's `<pre>` carries inline `padding: 1rem`
    on top of our wrapper's `p-3`. Added a CSS rule on
    `.shiki-host > pre` that resets shiki's padding to match.
  * CodeBlock last few lines had no line number because the
    gutter used `text-[11px]` and the body used `text-[12px]`,
    drifting ~80px short by line 50. Gutter bumped to 12px.

## [0.3.28](https://github.com/tianshu-ai/tianshu/compare/v0.3.27...v0.3.28) (2026-06-26)

### Features

* **ui:** rich file previews across the host through a single
  unified DocumentViewer. The chain that started in 0.3.23 with
  the host-shared Modal / MarkdownBlock / DocumentViewer now
  covers every common file kind a user might open from the
  files panel, workboard task delivery, or any `OpenFileApi`
  consumer:
  * **HTML**: live `<iframe>` preview running as a null origin
    (sandbox=allow-scripts/popups/forms/modals, no
    same-origin) so even hostile markup can't read tianshu
    cookies. Render / Source toggle.
  * **Code (~30 languages)**: shiki-highlighted with line
    numbers and a copy button. Lazy-imported via
    `shiki/bundle/web` — the ~600KB wasm and per-language
    grammars stay out of the initial bundle and download only
    when a user opens a code file.
  * **PDF**: browser-native PDF viewer via `<iframe>` (no
    pdf.js dependency).
  * **Video / Audio**: `<video controls>` / `<audio controls>`
    against the /raw stream.
  * **Image**: `<img>` against /raw; SVG also gets a
    Render / Source toggle (since SVG is itself markup).
  * **CSV / TSV**: parsed by papaparse (lazy-loaded), rendered
    as a real HTML `<table>` with sticky header and a 1000-row
    cap with an inline notice.
  * **Office (docx/xlsx/pptx + ODF + rtf)**: friendly
    placeholder pointing the user at the Download button.
    In-browser Office rendering needs a server-side LibreOffice
    pass which is a separate follow-up PR.
## [0.3.27](https://github.com/tianshu-ai/tianshu/compare/v0.3.26...v0.3.27) (2026-06-25)

### Features

* **ui:** Modal gains a `headerActions` slot (ReactNode rendered
  to the left of the close X). File-preview modals now use it
  to expose a Download button: files-plugin `FilePreviewModal`
  and the host `FileOpenDialog`. The download `<a>` points at
  the existing `/api/p/files/raw` route with a `download=<name>`
  attribute, so the browser saves instead of navigating even on
  viewable MIME types. FileOpenDialog also drops its bespoke
  inline header in favour of Modal's default header + the new
  slot, with the full path relegated to a small sub-header.

## [0.3.26](https://github.com/tianshu-ai/tianshu/compare/v0.3.25...v0.3.26) (2026-06-25)

### Bug Fixes

* **ui:** Modal height chain now propagates cleanly through flex.
  After 0.3.25 the body wrapper was block-level `min-h-0 flex-1`
  and every caller wrapped its content in `flex h-full flex-col`.
  CSS `height: 100%` inside a flex parent with no explicit pixel
  height anywhere up the tree behaves inconsistently across
  browsers — some collapse it to 0, some size to content. Result:
  files preview lost its scrollbar (content collapsed), and
  FileOpenDialog scrolled but didn't reach the last few lines.
  Fix: Modal body becomes `flex flex-col`, callers switch from
  `h-full` to `flex-1 min-h-0`. The whole chain is now flex-based
  with explicit space distribution.

## [0.3.25](https://github.com/tianshu-ai/tianshu/compare/v0.3.24...v0.3.25) (2026-06-25)

### Bug Fixes

* **ui:** remove Modal's built-in scroll container to fix double
  scrollbars. In 0.3.23 the new Modal body wrapper carried
  `overflow-auto`, but every existing caller already had its own
  inner overflow container. Two stacked scrollers produced a
  visible double scrollbar and let the inner content scroll out
  from under the modal's fixed header. Modal now bounds the body
  height (still `min-h-0 + flex-1`) but lets callers supply the
  scroll container themselves. McpServers EditDialog (the only
  caller without its own inner overflow) gains one on its form.

## [0.3.24](https://github.com/tianshu-ai/tianshu/compare/v0.3.23...v0.3.24) (2026-06-25)

### Bug Fixes

* **ui:** FileOpenDialog now renders Markdown through the shared
  DocumentViewer instead of a bare <pre>. PR #195 (0.3.23)
  swapped the dialog's outer chrome to Modal but missed the
  inner text-rendering path, so opening a .md file from the
  workboard task delivery list (or any other surface routed
  through OpenFileApi) showed raw markdown source. Files-plugin
  preview was unaffected because it already used DocumentViewer
  directly. Both routes now converge on the same host primitive.

## [0.3.23](https://github.com/tianshu-ai/tianshu/compare/v0.3.22...v0.3.23) (2026-06-25)

### Features

* **ui:** host-shared UI primitives (Modal / MarkdownBlock /
  DocumentViewer) plugins reuse through plugin-sdk's
  `__installUiPrimitives` + `useUiPrimitives()` hook. Replaces
  five hand-rolled `fixed inset-0 z-50 bg-black/...` modals
  scattered across files plugin, workboard plugin
  (ExecutionDialog + TaskModal), FileOpenDialog, and McpServers
  EditDialog with one canonical chrome. Replaces three different
  text rendering paths (chat ReactMarkdown vs. files `<pre>`
  vs. workboard `<pre>`) with one DocumentViewer that dispatches
  on filename / mime. Markdown dispatch is conservative—only
  `.md / .markdown` files get the Markdown renderer so source
  code with stray `# heading` lines doesn't render giant H1s.
  Net: a `.md` file viewed in the files plugin now renders
  pixel-identically to the same content rendered in chat.

## [0.3.22](https://github.com/tianshu-ai/tianshu/compare/v0.3.21...v0.3.22) (2026-06-24)

### Features

* **agent:** `tool_catalog_refresh` admin tool. The main agent
  can force-replay the tool catalog into the current chat
  session on demand — e.g. when the user asks 'what tools do I
  have' or after a silent upgrade where the auto-detector
  didn't fire (session stamp == new tool's since version).
  Two modes: `full` (default; lists every tool with a parseable
  since) and `since` (lists tools newer than a given
  since_version). Workers cannot call it. New host-tool plumbing
  in `PluginRegistry` (`opts.hostTools`) means future host-owned
  tools no longer have to forge a fake plugin.

## [0.3.21](https://github.com/tianshu-ai/tianshu/compare/v0.3.20...v0.3.21) (2026-06-24)

### Features

* **agent:** per-prompt tool-delta detector for cross-upgrade
  sessions. When a chat session has been open across a server
  upgrade and a builtin tool's `manifest.since` post-dates the
  session's stamped version, the next user prompt's turn opens
  with a synthetic system note listing the newly-available
  tools. Stops the model from "staying in its lane" on
  historical conversations after a release adds tools. Schema:
  `manifest.contributes.tools[].since` (semver) on the plugin
  side; `sessions.created_under_app_version` on the host side
  (migration 009). Workers are skipped; NULL-stamp sessions are
  claimed without notification.

## [0.3.20](https://github.com/tianshu-ai/tianshu/compare/v0.3.19...v0.3.20) (2026-06-24)

### Bug Fixes

* **workboard:** surface `worker_analytics` via `manifest.json`.
  0.3.19 shipped `buildWorkerAnalyticsTool` in `server.ts`'s
  exports but never listed it in `contributes.tools[]`, so the
  plugin registry skipped it and the agent couldn't see the tool.
  Adds the missing entry plus three manifest-hygiene tests that
  pin the symmetry between server.ts's exports.tools keys and
  manifest.json's contributes.tools[].module values — the bug
  cannot reappear without a test failing.

## [0.3.19](https://github.com/tianshu-ai/tianshu/compare/v0.3.18...v0.3.19) (2026-06-24)

### Features

* **workboard:** add `worker_analytics` orchestrator-only tool.
  ADR-0002 §12 — the main agent (天枢) can now read across
  recent worker runs and report per-agent + per-role stats
  (total / succeeded / intervened / watchdog-timeout counts,
  avg / p50 / p95 duration, total attempts, top-N failure
  reasons). Windowed by `windowDays` (default 7) or
  `allTime`. Owner-scoped — cross-tenant analytics stays
  out of scope. Read-only: this is a recommendation surface
  the orchestrator turns into prose tuning suggestions for
  the user, not a control loop. Workers are denied the tool.

## [0.3.18](https://github.com/tianshu-ai/tianshu/compare/v0.3.17...v0.3.18) (2026-06-24)

### Features

* **prompt:** inject a Runtime Context block (local time +
  timezone + host + tenant/user) into every agent's system
  prompt. Covers the main agent, worker agents, and the
  setup wizard's CLI agent. The LLM no longer has to guess
  "what day is it?" / "am I on macOS or Linux?" / "what
  timezone is the user in?" — the answers are in the prompt
  from the first turn. Re-rendered on every prompt build so
  the clock stays fresh across multi-minute sessions. Time
  format is ISO-8601 with explicit local offset (parses
  cleanly on Anthropic / OpenAI / Google).

## [0.3.17](https://github.com/tianshu-ai/tianshu/compare/v0.3.16...v0.3.17) (2026-06-23)

### Bug Fixes

* **workboard:** cancel the live worker when a task is deleted
  or moved out of `in_progress`. Without this fix, an
  abandoned worker kept burning LLM tokens after its task was
  gone / moved, and (worse) wrote status / labels back when
  it finished — clobbering a status move or crashing on a
  foreign-key error for a deleted row. Covers both the
  chat-side `task_move` / `task_delete` tools and the REST
  `PATCH /tasks/:id` / `DELETE /tasks` handlers (the UI's
  drag-card path). The REST delete handler now also wires the
  per-task sandbox teardown the chat tool already had.

## [0.3.16](https://github.com/tianshu-ai/tianshu/compare/v0.3.15...v0.3.16) (2026-06-22)

### Features

* **launchd:** use stable `ai.tianshu.prod` / `ai.tianshu.dev`
  labels instead of hash-suffixed ones. npm-global installs
  used to get an unreadable id like `ai.tianshu.dev.f71469f0`,
  and the hash rotated whenever the install path changed
  (e.g. an nvm version bump), leaving stale plists behind on
  every upgrade. Now: one stable label per install shape, and
  `tianshu start` / wizard auto-cleans orphan plists pointing
  at the same install path. `tianshu start` when run against
  the new label without an existing plist prints a one-line
  “run the wizard to migrate” hint instead of refusing.

## [0.3.15](https://github.com/tianshu-ai/tianshu/compare/v0.3.14...v0.3.15) (2026-06-22)

### Features

* **cli-agent:** new `check_build_progress` read-only tool +
  system-prompt guidance. When `build_sandbox` appears stuck,
  the agent now checks whether the build is still actively
  making progress (recent `[builder]` activity in the launchd
  logs) or has actually errored, instead of blindly retrying.
  Errors → retry. Still-progressing → quote the latest log
  line to the user ("still pulling apt packages, last activity
  22s ago") and wait. Avoids the 10-15 min double-build that
  happened when the agent's request timed out while the build
  itself was still fine.

## [0.3.14](https://github.com/tianshu-ai/tianshu/compare/v0.3.13...v0.3.14) (2026-06-22)

### Features

* **cli-agent:** new `sandbox_inventory` read-only tool +
  inventory-first system-prompt guidance. The setup agent
  used to dive into the full 2-snapshot layered build flow
  without first checking whether the user already had
  snapshots built and published. It now fetches
  `/api/p/microsandbox/{status,builds}`, surfaces what's on
  disk and which role pointers (browser / task) are
  currently published, and branches accordingly:
  - already fully set up → say so, skip the 10-15 min build
  - builds exist but unpublished → propose `use_sandbox_build`
  - nothing built → run the standard layered flow

## [0.3.13](https://github.com/tianshu-ai/tianshu/compare/v0.3.12...v0.3.13) (2026-06-22)

### Bug Fixes

* **publish:** include `plugins/**/templates/**` in the npm
  tarball. The microsandbox plugin's three Sandboxfile yaml
  templates (task-runner / browser / task-runner-with-browser)
  were missing from published global installs, so
  `build_sandbox` from the cli-agent and the admin UI's
  template dropdown both saw "no built-in templates". Root
  package.json + plugins/microsandbox/package.json `files`
  allowlists both needed to agree; they now do.

## [0.3.12](https://github.com/tianshu-ai/tianshu/compare/v0.3.11...v0.3.12) (2026-06-22)

### Features

* **doctor:** new "Tianshu version" check compares the running
  version against npm's `latest` dist-tag. Reports `ok` when
  up to date, `warning` when newer is available (with the
  `tianshu update` command to apply), `ok` when running from
  a git checkout (suggest `git pull`) or when the registry is
  unreachable. Opt out with `tianshu doctor
  --skip-version-check` for offline / CI runs.
* **cli-agent:** two new tools, `check_for_update` (read-only
  npm-registry probe) and `apply_update` (mutating; runs
  `npm install -g @tianshu-ai/tianshu@<tag>`, gated by CLI
  confirmation), plus system-prompt guidance teaching the
  setup agent how to drive an upgrade and how to act as a
  fixer rather than just an inspector. After a successful
  upgrade the user is told to run `tianshu restart`; the agent
  does not auto-bounce the service.

## [0.3.11](https://github.com/tianshu-ai/tianshu/compare/v0.3.10...v0.3.11) (2026-06-22)

### Bug Fixes

* **server:** `/api/health` now reads `version` from the
  top-level package.json instead of hard-coding it. Previously
  every release shipped with `version: "0.2.0"` baked into the
  endpoint, so doctor and the CLI update check couldn't
  distinguish running versions and would suggest upgrades that
  were already installed.

## [0.3.10](https://github.com/tianshu-ai/tianshu/compare/v0.3.9...v0.3.10) (2026-06-22)

### Features

* **core/urls:** centralise port and URL resolution in a single
  `core/urls.ts` module. Replaces four drifting inline copies
  in cli.ts, setup/service.ts, setup/checks/network.ts, and
  setup/start-server.ts.
* **server:** publish `server.effectivePublicUrl` to global
  config on each boot. Out-of-process CLI commands
  (`tianshu tenant list`, doctor) read it and print a URL that
  actually opens, regardless of whether the install is dev or
  prod shape. Detection is runtime-accurate (looks at
  `TIANSHU_WEB_DIST`), not a filesystem heuristic.

### Bug Fixes

* **cli:** `tianshu tenant list` no longer prints the vite dev
  port on production installs where vite never runs. Reads the
  operator-declared `server.publicUrl` or the
  server-published `server.effectivePublicUrl` first; only
  falls back to dev/prod filesystem heuristic when neither is
  set.

## [0.3.9](https://github.com/tianshu-ai/tianshu/compare/v0.3.8...v0.3.9) (2026-06-22)

### Bug Fixes

* **setup:** skip the "Web port" prompt on production-mode
  installs. In prod the server hosts the SPA on the API port
  (TIANSHU_WEB_DIST), so there's no second port to pick.
  Wizard now asks for just the API port and adjusts the prompt
  copy to say so. Dev mode (git checkout) still prompts for
  both ports.

## [0.3.8](https://github.com/tianshu-ai/tianshu/compare/v0.3.7...v0.3.8) (2026-06-22)

### Bug Fixes

* **env:** read & write `.env` from `<TIANSHU_HOME>/.env` on
  global installs (default `~/.tianshu/.env`). Previously the
  wizard wrote ports to the install dir's `.env` which (a) may
  not be user-writable on some node prefixes and (b) gets
  blown away on `npm install -g` upgrades. Result: doctor and
  the running server fell back to default ports even though
  the user had picked something else in the wizard. Dev mode
  (git checkout) keeps writing to repoRoot/.env so existing
  developer workflows aren't disturbed.

## [0.3.7](https://github.com/tianshu-ai/tianshu/compare/v0.3.6...v0.3.7) (2026-06-22)

### Features

* **doctor, cli-agent:** distinguish dev mode (two ports, vite
  hosts the SPA) from production mode (one port, server hosts
  the SPA via TIANSHU_WEB_DIST). doctor now reports the actual
  access URL instead of a misleading "web port 5183 free" hint
  on prod installs. cli-agent's system prompt teaches it to read
  doctor's output for the canonical URL rather than hardcoding
  one.

## [0.3.6](https://github.com/tianshu-ai/tianshu/compare/v0.3.5...v0.3.6) (2026-06-22)

0.3.5 mounted the static handler and the SPA fallback but the
fallback used `res.sendFile()` which 404'd on global installs
even though the file existed on disk (Express 5 send module
behaviour we don't fully understand on absolute paths). Symptom:
`curl localhost:3110/` returned a 1.6kB NotFoundError page;
browser users saw a blank Express error page instead of the
chat UI.

### Bug Fixes

* **serve:** read `index.html` into a buffer at mount time and
  `res.send` it on each SPA fallback request, bypassing
  `res.sendFile`. Faster too — no per-request syscall.
* **setup:** wizard's "Web UI" output now shows the right URL
  for the actual mode — single-port `http://localhost:3110` in
  production, separate `http://localhost:5183` only in dev.

## [0.3.5](https://github.com/tianshu-ai/tianshu/compare/v0.3.4...v0.3.5) (2026-06-22)

0.3.4 added `npm run serve` for production-mode startup but
the script used a shell variable (`TIANSHU_WEB_DIST="$PWD/..."`)
that npm doesn't always expand. On launchd-driven invocations
the server saw the literal string `"$PWD/packages/web/dist"`
as the dist path, `path.resolve()` turned it into a nonsense
relative path, the directory didn't exist, and the static
mount fell through to the warning branch. Symptom: `curl /`
returned 404 even though `/api/health` was healthy.

### Bug Fixes

* **serve:** replace the shell-variable-based `serve` script
  with a real `bin/serve.mjs` entrypoint that resolves the
  package root from `import.meta.url`. Works regardless of cwd
  or shell quoting behaviour

## [0.3.4](https://github.com/tianshu-ai/tianshu/compare/v0.3.3...v0.3.4) (2026-06-22)

Fixes the wizard's launchd plist on global npm installs. 0.3.3
actually started but the wizard-installed launchd agent ran
`npm run dev`, which invokes `tsc` via the build chain —
devDependencies aren't on disk in a global install:

  sh: tsc: command not found
  npm error code 127  (looped every 30s under KeepAlive)

### Bug Fixes

* **server, setup:** add `npm run serve` (production startup
  without dev toolchain) and teach the wizard to write a plist
  that picks `serve` over `dev` when running from a global
  install. Server mounts the pre-built web dist on the same
  port when `TIANSHU_WEB_DIST` is set, so one process + one
  port is enough for the end-user case. Dev mode (running
  from a git checkout) keeps the existing two-port watch-and-
  rebuild shape

## [0.3.3](https://github.com/tianshu-ai/tianshu/compare/v0.3.2...v0.3.3) (2026-06-22)

Really-working hotfix. 0.3.2 also broke under `npm install -g`:
the `peerDependencies` shape on `@tianshu-ai/plugin-sdk` (added
to trim the tarball) created an empty
`tianshu/node_modules/@modelcontextprotocol/sdk/` placeholder
directory that Node's module resolver treated as authoritative
but couldn't actually load files from. Symptom: same
`ERR_MODULE_NOT_FOUND` users saw on 0.3.0/0.3.1, just one
level deeper.

### Bug Fixes

* **publish:** move `@modelcontextprotocol/sdk` back to
  plugin-sdk's `dependencies`. npm's bundleDependencies now
  ships plugin-sdk's full transitive subtree inside the
  tarball (tarball back to ~5MB, an acceptable cost). Module
  resolution from plugin-sdk's code walks up and finds
  mcp-sdk inside `tianshu/node_modules/` immediately, on both
  local installs and global `npm install -g`. Verified by
  simulating `-g` install via `--prefix <tmpdir>`.

## [0.3.2](https://github.com/tianshu-ai/tianshu/compare/v0.3.1...v0.3.2) (2026-06-22)

Out-of-band hotfix shipping a working npm tarball. Versions
**0.3.0 and 0.3.1 are broken** — the published packages were
missing all 14 server runtime dependencies (better-sqlite3,
ws, hono, the mcp sdk, etc.). Hoisted-workspace install in
dev mode masked this; the published tarball revealed it.
Anyone on those versions will see `Cannot find package` errors
on first invocation. Skip straight to 0.3.2.

### Bug Fixes

* **publish:** rename the workspace plugin SDK from
  `@tianshu/plugin-sdk` (a scope we don't own) to
  `@tianshu-ai/plugin-sdk`. Bundle it into the published
  tarball via `bundleDependencies` so users get it on install
  without needing a separate npm publish for the SDK. Aggregate
  every sub-package's runtime `dependencies` into root so
  `npm install -g @tianshu-ai/tianshu` actually pulls everything
  the server needs at runtime ([#172](https://github.com/tianshu-ai/tianshu/pull/172))

## [0.3.0](https://github.com/tianshu-ai/tianshu/compare/v0.2.0...v0.3.0) (2026-06-21)


### Features

* **admin:** /admin shell + microsandbox sandbox-admin page (ADR-0004 N+4) ([#67](https://github.com/tianshu-ai/tianshu/issues/67)) ([c0b864f](https://github.com/tianshu-ai/tianshu/commit/c0b864f2b88a231eb34862e6df7ec3a69bc09350))
* ADR-0005 LSP integration + plugin-files hardening ([#125](https://github.com/tianshu-ai/tianshu/issues/125)) ([ad81da8](https://github.com/tianshu-ai/tianshu/commit/ad81da8cc191805cb3da04a97bef24133f331c30))
* auto-compact via harness + worker sidebar UI cleanup ([#85](https://github.com/tianshu-ai/tianshu/issues/85)) ([6bfcadd](https://github.com/tianshu-ai/tianshu/commit/6bfcadd689ff79030d7da8285d680f8ef1dd9151))
* **chat:** agent tool loop with fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)b, server side) ([#43](https://github.com/tianshu-ai/tianshu/issues/43)) ([424bfaf](https://github.com/tianshu-ai/tianshu/commit/424bfaf1ff17e9c036ed15cd6c51f4a0ea9d9bb6))
* **chat:** assistant message meta line (model / token usage / context %) ([#57](https://github.com/tianshu-ai/tianshu/issues/57)) ([156ed73](https://github.com/tianshu-ai/tianshu/commit/156ed73c338f15bcad24463b713102be42dcdc5a))
* **chat:** auto-compact conversation history at 50% context window ([#56](https://github.com/tianshu-ai/tianshu/issues/56)) ([c24e728](https://github.com/tianshu-ai/tianshu/commit/c24e728281b6881fff7393d419bf8b87081658c4))
* **chat:** auto-compress oversize images before sending to vision providers ([#55](https://github.com/tianshu-ai/tianshu/issues/55)) ([31b715f](https://github.com/tianshu-ai/tianshu/commit/31b715f7dc71ae130a6ddba46ccc7ba3a48854d0))
* **chat:** chat handler + worker on pi-agent-core's AgentHarness (N+6.4) ([#81](https://github.com/tianshu-ai/tianshu/issues/81)) ([5cea697](https://github.com/tianshu-ai/tianshu/commit/5cea697d74e9f5346bce152af26ae4b8ff58dd61))
* **chat:** inject workspace scaffold into agent prompt; move projects to user level ([#46](https://github.com/tianshu-ai/tianshu/issues/46)) ([#47](https://github.com/tianshu-ai/tianshu/issues/47)) ([761cd92](https://github.com/tianshu-ai/tianshu/commit/761cd9217f722079d89a8ff1863ba7a35f9dd4e1))
* **chat:** minimal end-to-end chat over WebSocket (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)) ([#25](https://github.com/tianshu-ai/tianshu/issues/25)) ([348f214](https://github.com/tianshu-ai/tianshu/commit/348f214f153bfa1c7763704f6daf92016293c9d4))
* **chat:** multimodal user messages — attachments as first-class content ([#52](https://github.com/tianshu-ai/tianshu/issues/52)) ([a74689a](https://github.com/tianshu-ai/tianshu/commit/a74689ae9573c7153b85e258a923d6ecc7470820))
* **chat:** persist tool turns + render them inline (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)c) ([#44](https://github.com/tianshu-ai/tianshu/issues/44)) ([8b2f96f](https://github.com/tianshu-ai/tianshu/commit/8b2f96f572b73cedf89104836e46af8d586743bc))
* **cli:** `tianshu doctor` + `tianshu setup --wizard` + global-installable bin ([#158](https://github.com/tianshu-ai/tianshu/issues/158)) ([2772e6d](https://github.com/tianshu-ai/tianshu/commit/2772e6dcc3e1897f285592fc6060940208fd651b))
* **dev-identity:** URL-driven tenant/user switching via cookie ([#159](https://github.com/tianshu-ai/tianshu/issues/159)) ([5c8d9b3](https://github.com/tianshu-ai/tianshu/commit/5c8d9b3b08dd1cd1f8dff241c425d18c3d46759a))
* **files,server:** move workspace layout block to files plugin fragment ([#136](https://github.com/tianshu-ai/tianshu/issues/136)) ([cb823e5](https://github.com/tianshu-ai/tianshu/commit/cb823e5baaafd973eb022d4a452d8067693b298b))
* **files:** clarify read-required prompt + accept paged reads as full ([#138](https://github.com/tianshu-ai/tianshu/issues/138)) ([6450d4b](https://github.com/tianshu-ai/tianshu/commit/6450d4b3e80a7dec42b463489144bc0e62db11b7))
* **files:** move fs agent tools into the files plugin (ADR-0004 N+3.5) ([#62](https://github.com/tianshu-ai/tianshu/issues/62)) ([49ab627](https://github.com/tianshu-ai/tianshu/commit/49ab6272fe8155b2c135c23789e315b4b0fd7526))
* **files:** workspace:// URI scheme for tool→UI file references ([#86](https://github.com/tianshu-ai/tianshu/issues/86)) ([77e7fb7](https://github.com/tianshu-ai/tianshu/commit/77e7fb7181c0cdd6c3f517a46d6924c37b4dcb8e))
* **microsandbox,workboard:** per-task sandbox pool with stop-not-remove lifecycle ([#141](https://github.com/tianshu-ai/tianshu/issues/141)) ([16c277c](https://github.com/tianshu-ai/tianshu/commit/16c277cde20171d62ed381933065a62ef6b0c481))
* **microsandbox:** allow file:// + pdf + vision in Playwright MCP, prompt fragment for ephemeral task sandbox ([#145](https://github.com/tianshu-ai/tianshu/issues/145)) ([c6fbabc](https://github.com/tianshu-ai/tianshu/commit/c6fbabced99df5c7b4de7885461ba5bb8f4e567a))
* **microsandbox:** browser sidecar scaffold + 3 agent tools + admin Browser page (ADR-0004 N+5.1) ([#68](https://github.com/tianshu-ai/tianshu/issues/68)) ([74e17a7](https://github.com/tianshu-ai/tianshu/commit/74e17a7d98068f2c48dfdf0a2036eb0c565a96b5))
* **microsandbox:** build resilience — SDK rename, Node fallback, node-python template ([#133](https://github.com/tianshu-ai/tianshu/issues/133)) ([a65490d](https://github.com/tianshu-ai/tianshu/commit/a65490db579687e630ec2615b4eed16191140c89))
* **microsandbox:** builtin plugin scaffold + nullable runner (ADR-0004 N+2) ([#60](https://github.com/tianshu-ai/tianshu/issues/60)) ([babdf6d](https://github.com/tianshu-ai/tianshu/commit/babdf6d8cd1beb67d5c1df36a94a1fa3e2604706))
* **microsandbox:** drop privileges to a real tenant user inside the guest ([#139](https://github.com/tianshu-ai/tianshu/issues/139)) ([53c1b83](https://github.com/tianshu-ai/tianshu/commit/53c1b838858ea20593af627a50a43eda8119ed4e))
* **microsandbox:** eager warm-up on plugin activation ([#64](https://github.com/tianshu-ai/tianshu/issues/64)) ([43a8424](https://github.com/tianshu-ai/tianshu/commit/43a842478e0a1d1bf1084129b530327874f34d41))
* **microsandbox:** expand node-python template to full browser stack ([#134](https://github.com/tianshu-ai/tianshu/issues/134)) ([cd4c0af](https://github.com/tianshu-ai/tianshu/commit/cd4c0afde1fef1b4d63e9069f60a5b473e8a6e6b))
* **microsandbox:** expose memory / cpu / image / timeout in plugin config UI + browser_health_check ([#120](https://github.com/tianshu-ai/tianshu/issues/120)) ([d06326e](https://github.com/tianshu-ai/tianshu/commit/d06326e02314556ec523ac66ea75f1f1b64c5899))
* **microsandbox:** inject $USER / $HOME / $MSB_USER_ID into exec context ([#137](https://github.com/tianshu-ai/tianshu/issues/137)) ([e93cb1b](https://github.com/tianshu-ai/tianshu/commit/e93cb1bc1e82d4a0f3ea7167f3a06b7c7575980a))
* **microsandbox:** live browser stack — port forward + auto supervisord + Playwright MCP wired (ADR-0004 N+5.3) ([#70](https://github.com/tianshu-ai/tianshu/issues/70)) ([fb671c2](https://github.com/tianshu-ai/tianshu/commit/fb671c247e36966e79103c973e9f4ba5ff6bf8ef))
* **microsandbox:** make minimal.yaml a real task-runner template ([#151](https://github.com/tianshu-ai/tianshu/issues/151)) ([79e92f0](https://github.com/tianshu-ai/tianshu/commit/79e92f04b47f613221cecd66a9a41f482f99c4f7))
* **microsandbox:** pool monitor section + Configure dialog ([#143](https://github.com/tianshu-ai/tianshu/issues/143)) ([6a38c3d](https://github.com/tianshu-ai/tianshu/commit/6a38c3d8eb434b04c29d8ca696d908d4d824c531))
* **microsandbox:** Sandboxfile templates + Browser template (CloakBrowser + Playwright MCP + noVNC) (ADR-0004 N+5.2) ([#69](https://github.com/tianshu-ai/tianshu/issues/69)) ([00ed8f1](https://github.com/tianshu-ai/tianshu/commit/00ed8f1432c06e9d58dfd5721422f451f55fcd6f))
* **microsandbox:** split snapshot pointer into Browser + Task roles ([#140](https://github.com/tianshu-ai/tianshu/issues/140)) ([79581a5](https://github.com/tianshu-ai/tianshu/commit/79581a59203fc0fbe40295a91dc573a8ffbb6d9b))
* **n5-4:** direct MCP mount via SDK, dynamic browser viewport, MCP servers admin ([#76](https://github.com/tianshu-ai/tianshu/issues/76)) ([6eb310f](https://github.com/tianshu-ai/tianshu/commit/6eb310ff51718ae4c6a86750577830bdcc18de93))
* **plugin-files:** fuzzy replacers + replace_all in edit_file (ADR-0006 PR-B groundwork) ([#130](https://github.com/tianshu-ai/tianshu/issues/130)) ([9c5796a](https://github.com/tianshu-ai/tianshu/commit/9c5796aa1315eb7fd0ce8759933ff1dc8be88add))
* **plugins/files:** scope to per-user home + tighten top-bar icons ([#40](https://github.com/tianshu-ai/tianshu/issues/40)) ([e8be301](https://github.com/tianshu-ai/tianshu/commit/e8be30150c785a534438d24686ae2d6b7e09f317))
* **plugins/files:** styled panel matching the closed-source repo ([#38](https://github.com/tianshu-ai/tianshu/issues/38)) ([22c1b01](https://github.com/tianshu-ai/tianshu/commit/22c1b017c6ed42d3a9deb9c377eabcb42b8c9544))
* **plugins:** capability registry, requires/provides, sandbox surface (ADR-0004 N+1) ([#59](https://github.com/tianshu-ai/tianshu/issues/59)) ([ba751c7](https://github.com/tianshu-ai/tianshu/commit/ba751c7b9b6fa97fd4d946a0d65e38476107810a))
* **plugins:** catalog client + Plugin Manager Catalog tab (P1) ([#34](https://github.com/tianshu-ai/tianshu/issues/34)) ([4376d67](https://github.com/tianshu-ai/tianshu/commit/4376d672becc941f86779ee895e54c99054e5e18))
* **plugins:** composer file uploads + composerActions SDK contribution ([#48](https://github.com/tianshu-ai/tianshu/issues/48)) ([#49](https://github.com/tianshu-ai/tianshu/issues/49)) ([0bea614](https://github.com/tianshu-ai/tianshu/commit/0bea61476f5e74e393f68f6460d29b8b4aeb0a00))
* **plugins:** contributes.tools[] \u2014 plugins own their agent tools (ADR-0004 N+3) ([#61](https://github.com/tianshu-ai/tianshu/issues/61)) ([db56329](https://github.com/tianshu-ai/tianshu/commit/db56329bc7d6044f2674bb4a3b254e02af7f3111))
* **plugins:** files plugin (workspace browser, server side) ([#35](https://github.com/tianshu-ai/tianshu/issues/35)) ([b2ec9a3](https://github.com/tianshu-ai/tianshu/commit/b2ec9a312c4805aeb546e750d0dacb76e72ed6bb))
* **plugins:** plugin runtime + Plugin Manager UI (PR [#31](https://github.com/tianshu-ai/tianshu/issues/31)) ([#32](https://github.com/tianshu-ai/tianshu/issues/32)) ([9405d57](https://github.com/tianshu-ai/tianshu/commit/9405d57ad9e1785c95856c048bbb3320edb67da0))
* **prompt:** add tool-guidelines block to defaultSystemPrompt (OpenClaw-style) ([#124](https://github.com/tianshu-ai/tianshu/issues/124)) ([ea227ea](https://github.com/tianshu-ai/tianshu/commit/ea227ea340940b93f96e63acaac6783ab57ac7a5))
* **server:** agent fs tools (PR [#21](https://github.com/tianshu-ai/tianshu/issues/21)a) ([#42](https://github.com/tianshu-ai/tianshu/issues/42)) ([791819a](https://github.com/tianshu-ai/tianshu/commit/791819ac2ea51883b4263fcee559689a400ec141))
* **server:** inject Execution Bias + AGENTS.md / SOUL.md / USER.md into system prompt ([#148](https://github.com/tianshu-ai/tianshu/issues/148)) ([ee1c97c](https://github.com/tianshu-ai/tianshu/commit/ee1c97c7c287f9ce04c4ff1d61b624a1b6fdf4c4))
* **server:** inject plugin systemPromptFragments into worker prompt (ADR-0007 PR-B) ([#129](https://github.com/tianshu-ai/tianshu/issues/129)) ([aa2e055](https://github.com/tianshu-ai/tianshu/commit/aa2e05535bbae7f3eee9b4ab5bc755ba2e7a0080))
* **server:** optional system-prompt dump for debugging ([#131](https://github.com/tianshu-ai/tianshu/issues/131)) ([76328db](https://github.com/tianshu-ai/tianshu/commit/76328db337dd5436b11abf9b683601b5277beb26))
* **setup:** cli-agent shows every action, confirms before mutating, no silent auto-fix ([#167](https://github.com/tianshu-ai/tianshu/issues/167)) ([bee4106](https://github.com/tianshu-ai/tianshu/commit/bee4106333d79c92ebe7e1d2b324b93c355b9d92))
* **setup:** in-CLI agent handoff after wizard for conversational setup ([#165](https://github.com/tianshu-ai/tianshu/issues/165)) ([07e1012](https://github.com/tianshu-ai/tianshu/commit/07e1012e10abb1140ca87d687850aa0aa6640392))
* **setup:** wizard probes default model first; smart-skip when working ([#164](https://github.com/tianshu-ai/tianshu/issues/164)) ([c6f9f7f](https://github.com/tianshu-ai/tianshu/commit/c6f9f7fa5e4f2d94f3a4e90bda0be343272f1a89))
* **setup:** wizard supports custom baseUrl + custom model id ([#163](https://github.com/tianshu-ai/tianshu/issues/163)) ([4d21143](https://github.com/tianshu-ai/tianshu/commit/4d21143f037f60b27b7faf802e21a184f1b2db3e))
* **skills:** drop load_skill meta-tool; manage skills via filesystem ([#98](https://github.com/tianshu-ai/tianshu/issues/98)) ([b352c74](https://github.com/tianshu-ai/tianshu/commit/b352c749b0bc8f19d753e478ed70b0f6acbd16fc))
* **skills:** mirror host & plugin SKILL.md into tenant config so one tool reads them all ([#104](https://github.com/tianshu-ai/tianshu/issues/104)) ([bc5c890](https://github.com/tianshu-ai/tianshu/commit/bc5c8900dbf4c07577cdab6d742c344917425832))
* **skills:** on-demand prompt fragments via plugin-contributed skills (ADR-0004 N+4) ([#63](https://github.com/tianshu-ai/tianshu/issues/63)) ([ec6cf6f](https://github.com/tianshu-ai/tianshu/commit/ec6cf6ffdb0258625b484fe1c7c53834756a15ea))
* **skills:** tenant-scoped skill discovery + main agent skill-creator ([#97](https://github.com/tianshu-ai/tianshu/issues/97)) ([98e0480](https://github.com/tianshu-ai/tianshu/commit/98e0480bfed24f05642c951eb543e9f542ad4ff8))
* **tenant:** infrastructure layer (PR [#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([4b6e7ae](https://github.com/tianshu-ai/tianshu/commit/4b6e7ae62da101c7998cf8e7dfe9b8b58cc969a3))
* **ui:** model selector pill in composer (PR [#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([#29](https://github.com/tianshu-ai/tianshu/issues/29)) ([5a835ff](https://github.com/tianshu-ai/tianshu/commit/5a835ff99b0b74c135e7c02cdebe895079d1b53c))
* **ui:** refine chat layout to match closed-source repo (PR [#23](https://github.com/tianshu-ai/tianshu/issues/23)) ([#27](https://github.com/tianshu-ai/tianshu/issues/27)) ([090c6eb](https://github.com/tianshu-ai/tianshu/commit/090c6eb47e6b02c6d0c0c6dcaabb4debe06c47f0))
* **ui:** tianshu-style chat UI (PR [#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([#26](https://github.com/tianshu-ai/tianshu/issues/26)) ([086fce7](https://github.com/tianshu-ai/tianshu/commit/086fce7fe55d29131ccce9cf7da48750aa2c74ef))
* **web-search:** plugin with Tavily / Brave + secret config + provider health cache ([#114](https://github.com/tianshu-ai/tianshu/issues/114)) ([fc636f2](https://github.com/tianshu-ai/tianshu/commit/fc636f285cdeef8590246f4ca3acbd9b6513d6db))
* **web:** collapsible tool-call rows (closed-source UI parity) ([#45](https://github.com/tianshu-ai/tianshu/issues/45)) ([78c1fb7](https://github.com/tianshu-ai/tianshu/commit/78c1fb7a2c87b7377827d2fa308b6c0db2bf35c1))
* **web:** manifest-driven top bar + right panel (PR [#33](https://github.com/tianshu-ai/tianshu/issues/33)) ([#36](https://github.com/tianshu-ai/tianshu/issues/36)) ([ba488fb](https://github.com/tianshu-ai/tianshu/commit/ba488fbff6a4c68e88f131d8d7fa34a2b59556aa))
* **web:** right-panel tab bar + resize handle (closed-source parity) ([#41](https://github.com/tianshu-ai/tianshu/issues/41)) ([25f1c98](https://github.com/tianshu-ai/tianshu/commit/25f1c984a25865911b65d8ab2c66331bac089f7a))
* **workboard,server,web:** execution dialog + session inbox + history pagination + concurrency fixes ([#94](https://github.com/tianshu-ai/tianshu/issues/94)) ([d79e665](https://github.com/tianshu-ai/tianshu/commit/d79e665eb97f10bc49b3f361090c74fa6bab4f40))
* **workboard:** batch task_create + task_delete ([#93](https://github.com/tianshu-ai/tianshu/issues/93)) ([759226e](https://github.com/tianshu-ai/tianshu/commit/759226e128d183c2292cad4f7cef90fb3380aa52))
* **workboard:** drop worker_agents table; UI read-only; REST mutation routes removed (PR-C) ([#101](https://github.com/tianshu-ai/tianshu/issues/101)) ([cba6701](https://github.com/tianshu-ai/tianshu/commit/cba67011824ced8e34e885250f231cc8d9866b5c))
* **workboard:** enable/disable worker agent from the admin UI ([#146](https://github.com/tianshu-ai/tianshu/issues/146)) ([d057696](https://github.com/tianshu-ai/tianshu/commit/d0576966fb9155d187745f7a6460db8c6bb0ed23))
* **workboard:** fs-only worker config + intervention model + skill / context plumbing ([#102](https://github.com/tianshu-ai/tianshu/issues/102)) ([f4e571e](https://github.com/tianshu-ai/tianshu/commit/f4e571e7546981b0cae0dabc2d32b44c9bdbd2be))
* **workboard:** host.modelCatalog capability + model_list tool for the main agent ([#107](https://github.com/tianshu-ai/tianshu/issues/107)) ([fb2d9ef](https://github.com/tianshu-ai/tianshu/commit/fb2d9ef98167ba68630476cdec3095ad664dd140))
* **workboard:** hot-reload pool when worker bundles change on disk ([#103](https://github.com/tianshu-ai/tianshu/issues/103)) ([2008527](https://github.com/tianshu-ai/tianshu/commit/2008527ccc542a9c19c1cb2c39edda2fc72248a2))
* **workboard:** kanban + worker pool plugin (ADR-0002 §6) ([#78](https://github.com/tianshu-ai/tianshu/issues/78)) ([0fac44a](https://github.com/tianshu-ai/tianshu/commit/0fac44af8afdf8f4d11620405c12d8ce4b34a041))
* **workboard:** LLM worker kind via host.agentLoop capability (N+6.3) ([#80](https://github.com/tianshu-ai/tianshu/issues/80)) ([cd53fac](https://github.com/tianshu-ai/tianshu/commit/cd53fac940ab7241ed2a9b03a5f5985352b21514))
* **workboard:** main agent can list available LLM models via  ([#106](https://github.com/tianshu-ai/tianshu/issues/106)) ([3e7a008](https://github.com/tianshu-ai/tianshu/commit/3e7a00811a21e3c1f43d9e25af277a3c1f1f86df))
* **workboard:** nudge main agent toward plan/design/build/verify decomposition ([#150](https://github.com/tianshu-ai/tianshu/issues/150)) ([a0a9a05](https://github.com/tianshu-ai/tianshu/commit/a0a9a05bd6a1604e1b2f8c6232af5744c29ba771))
* **workboard:** one-shot DB-&gt;fs migration; widen tenant_config_write boundary; retire worker_agent_* tools (PR-B) ([#100](https://github.com/tianshu-ai/tianshu/issues/100)) ([0ff0249](https://github.com/tianshu-ai/tianshu/commit/0ff0249b9a3310ee6c8e7eed192c6263e94f06fa))
* **workboard:** orchestrator tools for managing worker agents ([#96](https://github.com/tianshu-ai/tianshu/issues/96)) ([5f2d314](https://github.com/tianshu-ai/tianshu/commit/5f2d314e00e9c1272c372773c49a2720fb2a46b9))
* **workboard:** plugin-contributed agent seeds, fs-backed worker layout (PR-A) ([#99](https://github.com/tianshu-ai/tianshu/issues/99)) ([65b3b11](https://github.com/tianshu-ai/tianshu/commit/65b3b111b662e5015a550f3cfb528ef389e5cab6))
* **workboard:** retry/publish buttons on label chips ([#91](https://github.com/tianshu-ai/tianshu/issues/91)) ([6a0531e](https://github.com/tianshu-ai/tianshu/commit/6a0531ef586883e10b844e7edd51cd8f563f6d7b))
* **workboard:** show per-task sandbox name in task detail dialog ([#142](https://github.com/tianshu-ai/tianshu/issues/142)) ([4441cc4](https://github.com/tianshu-ai/tianshu/commit/4441cc49922270fb7a4cc8a6a938b2a49326777d))
* **workboard:** task execution history (REST + agent tool) ([#92](https://github.com/tianshu-ai/tianshu/issues/92)) ([3949e14](https://github.com/tianshu-ai/tianshu/commit/3949e14a038164a29096c6b711d9c5e8193fdeca))
* **workboard:** tool/skill catalog capabilities + worker agent ChipPicker ([#95](https://github.com/tianshu-ai/tianshu/issues/95)) ([aa1126a](https://github.com/tianshu-ai/tianshu/commit/aa1126aed6115786f2facafb0826846624e238cd))
* **worker-agents:** host table + REST + plugin seed + admin UI (ADR-0002 §7.1, N+6.2) ([#79](https://github.com/tianshu-ai/tianshu/issues/79)) ([a8b7378](https://github.com/tianshu-ai/tianshu/commit/a8b7378a80e4609f73eeef4f6e1ed1759ceb6255))


### Bug Fixes

* **adapter:** detect stream-truncated tool calls and surface a useful error ([#105](https://github.com/tianshu-ai/tianshu/issues/105)) ([2e95618](https://github.com/tianshu-ai/tianshu/commit/2e95618d78a4a536b2ab108095605e185baac6ec))
* **chat:** assistant messages with mixed text + tool calls render in author order ([#65](https://github.com/tianshu-ai/tianshu/issues/65)) ([ccedf35](https://github.com/tianshu-ai/tianshu/commit/ccedf3554072f8be8c912b596b764adabb7d81c5))
* **chat:** session storage chain + bridge pi tool_execution events (N+6.4 follow-up) ([#83](https://github.com/tianshu-ai/tianshu/issues/83)) ([0446273](https://github.com/tianshu-ai/tianshu/commit/04462730378ccf0037b121ed8361f918c2838740))
* **files:** make `edits` required in edit_file / tenant_config_edit schema ([#123](https://github.com/tianshu-ai/tianshu/issues/123)) ([daf2875](https://github.com/tianshu-ai/tianshu/commit/daf287514e0d040e003dbcb8d9600116a73a4c63))
* **microsandbox:** adapt to SDK rename of stopAndWait/removePersisted ([#132](https://github.com/tianshu-ai/tianshu/issues/132)) ([026d290](https://github.com/tianshu-ai/tianshu/commit/026d2909022a64329912cd07f9fced3d7feef526))
* **microsandbox:** destroyTask reclaims orphan VMs not in the pool map ([#144](https://github.com/tianshu-ai/tianshu/issues/144)) ([476f462](https://github.com/tianshu-ai/tianshu/commit/476f46287368fe24a667aa455318e6623586358f))
* **microsandbox:** guard exec against host-guest channel hangs ([#153](https://github.com/tianshu-ai/tianshu/issues/153)) ([80d5f54](https://github.com/tianshu-ai/tianshu/commit/80d5f54e05b3302acb2cffd826008611ce66697d))
* **microsandbox:** make execTimeoutMs actually fire (use shellStream + kill) ([#121](https://github.com/tianshu-ai/tianshu/issues/121)) ([ec41a55](https://github.com/tianshu-ai/tianshu/commit/ec41a559a49140d9132a39bd5cccc73a98a42836))
* **microsandbox:** tighten server-startup + verify-task prompts ([#152](https://github.com/tianshu-ai/tianshu/issues/152)) ([c4491a3](https://github.com/tianshu-ai/tianshu/commit/c4491a3118c441655c82510d4ad425852bbe4143))
* pipe agent-loop abort signal into tools so task_abort actually frees workers ([#154](https://github.com/tianshu-ai/tianshu/issues/154)) ([653f542](https://github.com/tianshu-ai/tianshu/commit/653f5428c0d7599de06e4a14f47aa956209483d2))
* **plugin-sdk:** re-resolve MCP endpoint on every callRemote ([#155](https://github.com/tianshu-ai/tianshu/issues/155)) ([827a888](https://github.com/tianshu-ai/tianshu/commit/827a888ad3fa8cddebde5d4a93dcd949bb572e01))
* **plugins:** mount contributed routes under /api/p/&lt;id&gt;/... ([#37](https://github.com/tianshu-ai/tianshu/issues/37)) ([3484ace](https://github.com/tianshu-ai/tianshu/commit/3484aceb51bc19d6900c91770e46dc9d91c3194f))
* **server:** refresh stale dynamic toolsets at worker run start ([#156](https://github.com/tianshu-ai/tianshu/issues/156)) ([1c0ae85](https://github.com/tianshu-ai/tianshu/commit/1c0ae85fc39c489c00ae4b0000aa718b04141530))
* **server:** substitute &lt;self&gt;/&lt;userId&gt; placeholders with caller's actual userId in system prompts ([#157](https://github.com/tianshu-ai/tianshu/issues/157)) ([3550d2a](https://github.com/tianshu-ai/tianshu/commit/3550d2ad6c88d76b9da9231888c2e3274c786ee3))
* **server:** unify USER.md prompt so empty templates trigger onboarding ([#149](https://github.com/tianshu-ai/tianshu/issues/149)) ([c595e08](https://github.com/tianshu-ai/tianshu/commit/c595e08309fe96338d649cc69c20e8d0025b6cb5))
* **setup:** force-reload .env after wizard writes; clear pass/fail signal on model ping ([#166](https://github.com/tianshu-ai/tianshu/issues/166)) ([1130ce6](https://github.com/tianshu-ai/tianshu/commit/1130ce695713ba423542f9fb956cfa2d76278694))
* **ui:** de-dupe ws handlers + message renders (StrictMode) ([#28](https://github.com/tianshu-ai/tianshu/issues/28)) ([0b8b5bc](https://github.com/tianshu-ai/tianshu/commit/0b8b5bcb3c163cfa277fa23ae32243bd8280de4d))
* **workboard:** nudge on done patches + fallback polling timer ([#89](https://github.com/tianshu-ai/tianshu/issues/89)) ([b959cd2](https://github.com/tianshu-ai/tianshu/commit/b959cd23efb24c2d16e7f229063ae14939d99143))
* **workboard:** show awaiting-intervention chip on board cards ([#118](https://github.com/tianshu-ai/tianshu/issues/118)) ([2220f76](https://github.com/tianshu-ai/tianshu/commit/2220f7631a42e9a2fbc7c03e58ab6b344929ed9b))
* **workboard:** task_move(status=ready) clears intervention labels (zombie task fix) ([#117](https://github.com/tianshu-ai/tianshu/issues/117)) ([a0d37b0](https://github.com/tianshu-ai/tianshu/commit/a0d37b0fa0089ff78fbf695c91b6a5a12ea998d1))
* **worker:** drop MAX_TURNS cap; deny task management tools in LLM workers ([#87](https://github.com/tianshu-ai/tianshu/issues/87)) ([4c00b41](https://github.com/tianshu-ai/tianshu/commit/4c00b418c2331b76dd039dd5fd732c4459ef5d0d))
* **write:** tool description guideline + repeat-truncation escalation ([#116](https://github.com/tianshu-ai/tianshu/issues/116)) ([91e60fe](https://github.com/tianshu-ai/tianshu/commit/91e60fe18591828b836e63d138b6506b8a072d44))
* WS chat respects user identity (close conversation isolation hole) ([#162](https://github.com/tianshu-ai/tianshu/issues/162)) ([c2f83b3](https://github.com/tianshu-ai/tianshu/commit/c2f83b31e9d6267de10e17a7054a0ed11f0e960e))


### Documentation

* ADR-0001 multi-tenant architecture ([#20](https://github.com/tianshu-ai/tianshu/issues/20)) ([e5d1cc7](https://github.com/tianshu-ai/tianshu/commit/e5d1cc794783ccd045b6081d9c0c9145fa24f2d9))
* ADR-0002 orchestrator + workers, with config layering ([#22](https://github.com/tianshu-ai/tianshu/issues/22)) ([6d5fff6](https://github.com/tianshu-ai/tianshu/commit/6d5fff6cac433e6134463b169103f20594cf7fd5))
* ADR-0003 plugin system (UI panels, sidebar sections, API routes) ([#30](https://github.com/tianshu-ai/tianshu/issues/30)) ([4386ccd](https://github.com/tianshu-ai/tianshu/commit/4386ccddcc8158b286559af894f0f532b1816724))
* ADR-0004 plugin capabilities & sandbox contract ([#58](https://github.com/tianshu-ai/tianshu/issues/58)) ([b6a84f4](https://github.com/tianshu-ai/tianshu/commit/b6a84f46e732ae483640d5efd3247db078192312))
* **architecture:** ADR-0007 — skill progressive disclosure ([#128](https://github.com/tianshu-ai/tianshu/issues/128)) ([56e114c](https://github.com/tianshu-ai/tianshu/commit/56e114c3c5c3319c444458c9e8aa4f54400c006e))
* **files,microsandbox:** clarify cross-tool path semantics ([#135](https://github.com/tianshu-ai/tianshu/issues/135)) ([802301b](https://github.com/tianshu-ai/tianshu/commit/802301beb80053d9e43e6b330b54399d6ff0bf5c))
* how to run tianshu as a background service (macOS launchd) ([#161](https://github.com/tianshu-ai/tianshu/issues/161)) ([e439c67](https://github.com/tianshu-ai/tianshu/commit/e439c678c7ac2de18f8b3bc3e50a07b3d1b5b615))
* **microsandbox:** teach the agent how to start servers without hanging exec ([#119](https://github.com/tianshu-ai/tianshu/issues/119)) ([c03a2f3](https://github.com/tianshu-ai/tianshu/commit/c03a2f3ddcfb5fb9c62620309d3d6bb8ada7b0b1))
* **microsandbox:** tell agents to use existing chromium + libreoffice instead of reinstalling ([#122](https://github.com/tianshu-ai/tianshu/issues/122)) ([16b3363](https://github.com/tianshu-ai/tianshu/commit/16b33634d366876695cd1aabdeb62e9f72e5aa03))


### Refactor

* **chat:** storage owns image base64 + drop legacy helpers + migration 004 ([#84](https://github.com/tianshu-ai/tianshu/issues/84)) ([2a1fa58](https://github.com/tianshu-ai/tianshu/commit/2a1fa580b06b2288b2ff499fbd57613ceb429f69))
* **middleware:** pluggable IdentityResolver chain ([#160](https://github.com/tianshu-ai/tianshu/issues/160)) ([d7e9265](https://github.com/tianshu-ai/tianshu/commit/d7e9265016a6533ec72d421c85174cd2a7a569dc))
* **workboard:** rename todo→ready, retry-on-failure, drop aborted state ([#88](https://github.com/tianshu-ai/tianshu/issues/88)) ([67a8cbb](https://github.com/tianshu-ai/tianshu/commit/67a8cbb77cdf962b198bc5cf1f64518392972095))
* **workboard:** stalled is a label, not a status (3 columns total) ([#90](https://github.com/tianshu-ai/tianshu/issues/90)) ([0c80ae9](https://github.com/tianshu-ai/tianshu/commit/0c80ae97242added8d289b950c56d700f96e8c57))

## [0.2.0](https://github.com/tianshu-ai/tianshu/compare/v0.1.0...v0.2.0) (2026-06-03)


### Features

* day-0 scaffolding ([786a0bd](https://github.com/tianshu-ai/tianshu/commit/786a0bdfb1bdf6cdd5e9e3abd2a03677da7c63b6))

## [Unreleased]

- Initial day-0 scaffolding (Express + WS server, React + Vite web).
