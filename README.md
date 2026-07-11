<h1 align="center">Tianshu · 天枢</h1>

<p align="center">
  <strong>The self-hosted AI agent platform — with a real browser, a real sandbox.</strong>
</p>

<p align="center">
  <a href="https://github.com/tianshu-ai/tianshu/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/tianshu-ai/tianshu/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/@tianshu-ai/tianshu"><img alt="npm" src="https://img.shields.io/npm/v/@tianshu-ai/tianshu?style=flat-square&logo=npm&logoColor=white"></a>
  <a href="https://github.com/tianshu-ai/tianshu/releases"><img alt="release" src="https://img.shields.io/github/v/release/tianshu-ai/tianshu?include_prereleases&style=flat-square&logo=github&logoColor=white"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=flat-square"></a>
  <a href="https://github.com/tianshu-ai/tianshu/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/tianshu-ai/tianshu?style=flat-square&logo=github&logoColor=white"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white"></a>
  <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/badge/Node-22%2B-339933?style=flat-square&logo=node.js&logoColor=white"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="#-install">🚀 Install</a> ·
  <a href="#-what-you-get">✨ What you get</a> ·
  <a href="#-first-run--5-minutes-start-to-finish">👋 First run</a> ·
  <a href="#️-day-2-control">🎛️ Day-2 control</a> ·
  <a href="#️-architecture">🏗️ Architecture</a> ·
  <a href="#️-roadmap">🗺️ Roadmap</a>
</p>

<p align="center">
  <em>⭐ Tianshu (天枢) — the brightest star of the Big Dipper, the celestial pivot.</em>
</p>

<!--
  TODO: drop a 1600×900+ PNG/GIF at docs/assets/hero.png
  showing the chat UI with the sandbox exec output AND the
  browser sidecar in one frame. Recommend either:
    (a) agent live-editing a file with the file tree visible,
    (b) agent driving a real Chromium tab on the right while
        typing on the left.
  When the file exists, the markdown below renders the image;
  until then GitHub shows a broken-image placeholder that
  links to the README's anchor.
-->
<!-- ![Tianshu — agent + sandbox + browser, side by side](docs/assets/hero.png) -->

---

## 🚀 Install

### Prerequisites

| What           | Why                                                |
|----------------|----------------------------------------------------|
| **Node 22+**   | Runtime. Use a Node manager (`nvm` / `volta` / `asdf`); avoid system Node with `sudo`. |
| **Docker** (recommended) *or* **macOS Apple Silicon / Linux + KVM** | Sandbox layer. The default **OpenShell** backend needs a running Docker daemon (Docker Desktop / Colima / OrbStack / …). The alternative **microsandbox** backend needs hardware virt instead of Docker. Pick one — they're mutually exclusive. Chat still works without either, but `exec` / browser tools won't. |
| **An LLM API key** | Anthropic, OpenAI, or Google. Or a local model server reachable on the network. |

### One command

```bash
npm install -g @tianshu-ai/tianshu@latest
```

Don't `sudo`. If you hit `EACCES`, switch to a Node manager that
puts the global bin under your user directory — not a system
folder.

### Configure your provider

```bash
tianshu setup
```

A short interactive wizard. It:

1. Asks which provider to use (Anthropic / OpenAI / Google).
2. Reads your API key with a hidden prompt.
3. Writes `~/.tianshu/config.json` (settings) and `~/.tianshu/.env`
   (secret).

Once a model is configured, the wizard hands you over to the
**setup agent** — an LLM-driven assistant running in the same
terminal that can finish the rest of the configuration for
you. It has 18 tools (`run_doctor`, `sandbox_inventory`,
`config_write`, `plugin_enable`, `build_sandbox`,
`use_sandbox_build`, `secret_write`, `apply_update`, ...) and
asks for your confirmation before every state-changing call.
Things you can ask it right now:

- *"Set me up a search API key for the web-search plugin."* —
  it'll ask which provider (Tavily / Brave / SerpAPI / ...),
  prompt for the key, and write it via `secret_write` into
  the right tenant's plugin config. No editing JSON by hand.
- *"Build my sandboxes so I can use the browser."* — it
  calls `sandbox_inventory` first to see what's already on
  disk, then `build_sandbox` and `use_sandbox_build` to fill
  in whatever's missing. Browser tools work the moment the
  layered `task-runner-with-browser` snapshot is published.
- *"Doctor's complaining about my provider — fix it."* — it
  reads `run_doctor`, finds the offending line, and proposes
  the specific `config_write` or `secret_write` call to fix
  it before running anything.
- *"Am I on the latest version?"* — it runs
  `check_for_update` and, if you say yes, `apply_update`.

You can exit anytime (type *done* / Ctrl-C) and come back
later — the agent re-reads state from disk on each invocation.

Non-interactive flavour for Docker / CI (skips the
interactive agent, only writes the provider config):

```bash
tianshu setup --non-interactive --provider=anthropic --api-key=sk-***
```

### Start the service

```bash
tianshu start
```

On macOS this installs a launchd agent
(`~/Library/LaunchAgents/ai.tianshu.prod.plist`) that auto-starts
at login and auto-restarts on crash. Linux systemd support is on
the roadmap; for now, run `npm run dev` from a checkout.

Open <http://localhost:3110> and start chatting.

### Verify everything

```bash
tianshu doctor
```

Reports across 8 dimensions — runtime / version freshness / config
files / LLM providers / network / sandbox / plugins / tenant DBs.
Read-only. Run it anytime something feels off.

---

## ✨ What you get

Tianshu is **a runtime, not a chatbox.** Three things make it different:

🌐 **A real Chromium sidecar per tenant.** Playwright + noVNC. The agent
navigates, clicks, types — you watch it live in a side panel, take the
mouse back when you want to.

📦 **A real Linux sandbox per tenant.** Every `exec` runs in an
isolated sandbox — crash it, fork-bomb it, fill the disk, your host is
untouched. Two interchangeable backends ship as plugins (pick **one**;
they're mutually exclusive): **OpenShell** (Docker container, the
recommended default — near-zero idle CPU on Apple Silicon and a
built-in per-host network egress policy) or
[microsandbox](https://github.com/microsandbox/microsandbox) (a
Hypervisor.framework / KVM microVM, if you'd rather not run Docker).

📁 **A real per-tenant workspace.** The agent reads and writes files
you can preview in the UI; they persist across sessions. The file
tree is a first-class citizen, not a "tool output."

Plus:

- 🎛️ **Workforce Studio — your agent config, as a versionable
  Solution.** Stop hand-editing scattered `agent.json` /
  `SOUL.md` files. Studio extracts your live setup (main agent +
  every worker + the plugin enable-set + prompt blocks) into one
  **Solution** you can edit in a three-pane IDE, diff against
  what's running, export/import as a file, and **activate** in one
  click. Override a single worker's model or execution-bias,
  include/exclude plugins, tune prompt fragments — then apply the
  whole thing atomically. See
  [docs/architecture/solutions.md](docs/architecture/solutions.md).

  ![Workforce Studio — your agent config as an editable, diffable Solution](docs/assets/workforce-studio.png)

- 💻 **OpenCode workers.** Beyond the built-in worker, run
  [opencode](https://github.com/sst/opencode) +
  oh-my-openagent inside a prebuilt sandbox image as a first-class
  worker type — near-real-time transcript and resolved tool chips
  stream back to the board.
- 🤖 **Background workers, not "tools."** Dispatch parallel agents
  onto a Kanban board; watch elapsed time per task; intervene when
  one stalls. Define task dependency graphs in a single batch.
- 🔍 **The orchestrator is a supervisor.** The main agent (天枢,
  literally "the pivot") doesn't just dispatch — it reads across
  every worker run on the board (duration, intervention rate,
  failure-reason clusters, token cost) and proposes tuning back
  to you: *“Your `web-research` worker hits the 10-min watchdog
  on 1 in 5 runs — want me to raise its `timeoutMs` to 15 min?”*
  Analytics is a recommendation surface, never an auto-tuning
  control loop — every change still needs your confirm. See
  [ADR-0002 §12](docs/architecture/workers.md#12-orchestrator-side-analytics--continuous-improvement)
  for the full story.
- 🏢 **Multi-tenant from row 1.** Every record carries `tenantId`.
  Sidecars, workspaces, and worker pools are tenant-isolated.
- 🧠 **A setup assistant that fixes things.** `tianshu setup` runs a
  Claude/Codex-driven wizard with 18 tools: it can read your doctor
  report, enable plugins, write config, build sandboxes, and even
  upgrade itself. See it talk you through it in
  [the launch video](https://youtu.be/Xw7c3JrlUVo).
- 🎚️ **Point-and-click day-2 controls.** A Settings surface for the
  things you used to hand-edit: a **Models** page to manage the
  provider catalog (add/edit providers + models, pick the default,
  keys stay server-side), a **Network Policy** page to see sandbox
  egress denials and allow hosts with one click, and MCP-server and
  per-plugin config pages. Config files stay the source of truth —
  edit either way, they stay in sync.

  ![Settings → Models: manage the provider catalog from the UI](docs/assets/models.png)

  ![Settings → Network Policy: sandbox egress denials + allow-list](docs/assets/network-policy.png)
- 🔌 **Resilient model calls.** Rate-limit-aware retries (honours
  `Retry-After`), and a client that rides out a dropped connection
  with exponential backoff and resumes the interrupted turn — no
  duplicated messages, no lost prompt.
- 🔎 **Key-free web search built in.** An Exa/Parallel-backed
  `web_search` plus a `web_fetch` tool, no extra API key to wire up.

> ⚠️ **Security note (0.5.0):** the admin/Settings pages (Models,
> MCP servers, Network Policy, plugin config) are **not yet behind an
> authorization gate** — any signed-in user can edit host-wide
> config. Run Tianshu as a **single trusted operator** for now, and
> don't expose the admin surface to untrusted users on a multi-tenant
> box. A proper auth/role gate lands with the login work on the
> roadmap.

---

## 👋 First run — 5 minutes start to finish

A narrated walk-through. From zero to "agent driving a real
browser on your screen":

### Step 1 · Install + wizard (~2 min)

```bash
npm install -g @tianshu-ai/tianshu@latest
tianshu setup
```

The wizard picks a provider, reads your key, writes config. If
you skip the LLM step you can edit `~/.tianshu/config.json` by
hand later.

### Step 2 · Start the service (~10 s)

```bash
tianshu start
```

The wizard already verified network / config. `tianshu start`
installs the launchd agent and waits for the server to answer
`/api/health`.

### Step 3 · Ask the setup agent to finish the configuration

After `tianshu setup` writes the provider config it drops you
straight into the **setup agent** (still in the same terminal).
This is where you finish wiring things up. Type plain English:

> **You:** Set up sandboxes so I can use the browser tool.

The agent will:

1. Run `sandbox_inventory` to see what's already built.
2. If a snapshot is missing, propose `build_sandbox
   (template='task-runner')` and ask you to confirm.
3. After ~10 min (cold) or ~3 min (warm) the snapshot lands; the
   agent publishes it to the `task` role pointer with
   `use_sandbox_build`.
4. Repeat for the browser layer
   (`task-runner-with-browser` on top of the task snapshot).

If the build looks stuck, the agent calls `check_build_progress`
first — it reads the launchd logs, classifies the build state
(`in_progress` / `stalled` / `errored`), and tells you whether
to wait or retry. It will NOT silently retry a 10-minute build
that's still pulling apt packages.

While you're here, you can keep talking to the agent about
other setup work — say *"add a Tavily API key for web search"*
or *"check for tianshu updates"* and it'll handle them with the
same confirm-before-mutating loop. When you're done, type
*done* or Ctrl-C; the agent saves state to disk and you can
come back later with another `tianshu setup`.

### Step 4 · Open the SPA and use it

```bash
open http://localhost:3110
```

This is the actual product UI — the chat surface your agent
runs under. Try:

> **You:** Open hacker news and tell me the top story right now.

Watch the side panel: a real Chromium tab navigates. The agent
can click, type, scroll. You can take the mouse back any time.

Done. You've got a working agent.

### What if something goes wrong?

| Symptom | First step |
|---|---|
| `tianshu doctor` flags a blocker | Read the line; the `detail` field has the fix. |
| Browser tool says "runner not ready" | `sandbox_inventory` in chat; build the missing snapshot. |
| `tianshu start` says "server didn't respond" | `tianshu logs --stream=err -f` for the actual error. |
| Setup wizard wedged | Ctrl-C, re-run `tianshu setup --wizard`. |
| `npm install -g` errors with EACCES | Switch to nvm / volta / asdf. Don't `sudo`. |

More in [Troubleshooting](docs/getting-started.md#troubleshooting).

---

## 🎛️ Day-2 control

Once things are running, these are the commands you'll use daily:

```bash
tianshu status               # plist label, pid, port, /api/health
tianshu logs -f              # tail stdout + stderr
tianshu restart              # bounce the server
tianshu stop                 # bootout the launchd agent
tianshu tenant list          # tenants + users + open-in-browser URLs
tianshu update               # check + install npm latest
tianshu update --check       # only check, exit 0/1/2
```

Behind a Cloudflare tunnel or reverse proxy? Set
`server.publicUrl` in `~/.tianshu/config.json` once — every CLI
command prints that hostname instead of `localhost`.

When something breaks:

```bash
tianshu doctor                       # what's wrong?
tianshu logs -f                      # what's the server saying?
ls ~/Library/LaunchAgents/ai.tianshu*.plist   # is the agent installed?
launchctl list | grep tianshu        # is it loaded? PID? exit code?
```

Deeper guides:
[Getting started](docs/getting-started.md) ·
[Updating](docs/updating.md) ·
[Running as a service](docs/running.md) ·
[Developing from a checkout](docs/developing.md).

---

## 🏗️ Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser"]
    UI["React + Vite UI"]
  end

  subgraph Server["@tianshu-ai/server"]
    REST["REST /api"]
    WS["WebSocket /ws"]
    Agent["Agent runtime<br/>pi-agent-core"]
    Workers["Background worker pool"]
    DB[("SQLite<br/>(WAL)")]
  end

  subgraph Sidecars["Per-tenant sidecars"]
    ChromiumBox["Chromium + Playwright + noVNC"]
    SandBox["Linux sandbox<br/>(OpenShell / microsandbox)"]
    Files["Workspace filesystem"]
  end

  LLM[(LLM providers<br/>Anthropic / OpenAI /<br/>Google / local)]

  UI <-- WebSocket --> WS
  UI <-- HTTP --> REST
  WS --> Agent
  REST --> Agent
  Agent <--> DB
  Agent --> Workers
  Workers --> ChromiumBox
  Workers --> SandBox
  Workers --> Files
  Agent <--> LLM
```

The agent runtime stands on
[`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
by [@badlogic](https://github.com/badlogic). The sandbox layer is
pluggable: **OpenShell** (Docker, the recommended default) or
[microsandbox](https://github.com/microsandbox/microsandbox)
(Hypervisor.framework / KVM) — one at a time.

A 0.x repo, but the core loop — chat, sandbox `exec`, sidecar browser,
multi-tenant filesystem, background workers — works end-to-end today.
See the [Architecture Decision Records](docs/architecture/) for
the full picture.

---

## 🗺️ Roadmap

**Shipped (0.3.x)**

- [x] `npm install -g @tianshu-ai/tianshu` published to npm
- [x] Production single-port server (SPA + API on `:3110`)
- [x] `tianshu doctor` — runtime / config / network / sandbox / plugins
- [x] Setup agent with 18 tools (inventory, build, fix, upgrade)
- [x] Tenant model, plugin registry, sandbox role pointers

**Shipped (0.4.x → 0.5.0)**

- [x] **Workforce Studio** — extract / edit / diff / export / activate
      your agent config as a Solution
- [x] **OpenCode workers** — opencode + oh-my-openagent as a worker
      type, in a prebuilt sandbox image
- [x] **Settings UI** — Models (provider catalog), Network Policy
      (sandbox egress), MCP servers, per-plugin config
- [x] Rate-limit-aware model retries + client auto-reconnect / resume
- [x] Key-free `web_search` + `web_fetch`
- [x] Worker task dependency graphs in one batch

**Next (0.5.x → 0.6)**

- [ ] **Auth + roles** — login, and an authorization gate on the
      admin/Settings surface (see the security note above)
- [ ] Docker image with sandbox layer baked in
- [ ] Linux systemd user service (matches macOS launchd UX)
- [ ] Skills marketplace (registry + install command)
- [ ] **Orchestrator analytics**: `worker_analytics` /
      `worker_task_timeline` /
      `worker_propose_tuning` tools so the main agent
      can read across worker runs and propose concrete
      tuning (see ADR-0002 §12)

Tracked in [GitHub Issues](https://github.com/tianshu-ai/tianshu/issues).

---

## 🚫 What it's not

- ❌ A drop-in ChatGPT clone — see
  [LibreChat](https://github.com/danny-avila/LibreChat),
  [Open WebUI](https://github.com/open-webui/open-webui).
- ❌ A no-code workflow builder — see
  [Dify](https://github.com/langgenius/dify),
  [Flowise](https://github.com/FlowiseAI/Flowise).
- ❌ A hosted SaaS — no billing, no SSO, no SLA. Run it on a box you own.
- ❌ An LLM dev framework — Tianshu is an *application* on top of
  pi-agent-core.

---

## 📺 Build log

A development log goes out roughly every week. Pick the channel that
fits you:

| Channel | Language | Format |
| --- | --- | --- |
| [dev.to/tianshu_ai](https://dev.to/tianshu_ai) | English | Long-form articles |
| [YouTube @Tianshu-AI](https://www.youtube.com/@Tianshu-AI) | English | Long-form video |
| Bilibili 天枢AI *(launching)* | 中文 | Long-form video |
| X / Twitter *(launching)* | English | Build-in-public threads |
| 小红书 / 抖音 *(launching)* | 中文 | Short-form clips |

---

## 🤝 Contributing

PRs, issues, and discussions are welcome — even on day 0. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for setup and code style.

For security issues please follow [SECURITY.md](./SECURITY.md). **Do
not** file vulnerabilities in public issues.

---

## 📜 License

[Apache License 2.0](./LICENSE) © 2026 Yu Yu and Tianshu contributors.

Built on [pi-agent-core](https://github.com/badlogic/pi-mono) (MIT) by
[@badlogic](https://github.com/badlogic); sandbox backends
[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) and
[microsandbox](https://github.com/microsandbox/microsandbox) (Apache-2.0,
by [@nyxxxie](https://github.com/nyxxxie) and contributors).
