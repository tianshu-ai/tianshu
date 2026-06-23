# Getting started

This is the long version of the README's quick install. If
`npm install -g @tianshu-ai/tianshu@latest && tianshu setup &&
tianshu start` already worked for you, you can skip ahead to
[Day-2 control](#day-2-control).

## Requirements

- **Node 22 or newer.** `node --version` to check. We test
  against current Node 22, 24, and 25; older majors are not
  supported.
- **macOS Apple Silicon** or **Linux + KVM**. The sandbox
  layer (microsandbox) won't boot on other platforms. The
  chat surface still works elsewhere, but `exec` and the
  browser sidecar will be unavailable.
- **An API key** for at least one of Anthropic, OpenAI, or
  Google — or a local model server reachable on the network.

## Install

```bash
npm install -g @tianshu-ai/tianshu@latest
```

Tianshu installs to your global npm prefix and exposes a
`tianshu` binary. If you use a Node version manager (nvm /
volta / asdf), `tianshu` follows whichever Node you have
active when you `npm install -g`.

> **EACCES on system-Node installs?** Don't `sudo npm install
> -g`. Switch to nvm / volta / asdf so global installs land in
> a user-writable directory. Sudo'd npm-global state is a
> recurring footgun.

## First-run setup

```bash
tianshu setup
```

An interactive wizard (built on `@clack/prompts`) walks you
through:

- Picking your LLM provider (Anthropic, OpenAI, Google, or
  `skip` if you want to edit config by hand).
- Reading your API key with a hidden input.
- Writing `~/.tianshu/config.json` (provider settings, models,
  defaults).
- Writing `~/.tianshu/.env` (your key; the config references
  it as `${VAR}` so the actual secret never ends up in JSON).

### After the provider is configured: the setup agent

Once your provider is in place, the wizard launches the
**setup agent** — a Claude / Codex-driven assistant running
in the same terminal. It's the recommended path to finish
the rest of the configuration, instead of editing config
files by hand.

The agent has 18 tools and asks for your confirmation before
every state-changing call. Common things to ask it on day 0:

- **"Set me up a search API key for the web-search plugin."**
  It'll prompt for the provider (Tavily / Brave / SerpAPI /
  ...) and the key, then call `secret_write` against the
  right tenant. No JSON editing.

- **"Build my sandboxes so I can use the browser tool."**
  It calls `sandbox_inventory` first to see what's already on
  disk; on a fresh machine it'll propose the standard
  two-snapshot layered flow:
  1. `build_sandbox(template='task-runner')`           (~10 min cold)
  2. `use_sandbox_build(role='task', buildId=...)`
  3. `build_sandbox(template='task-runner-with-browser',
      fromSnapshot=<task snapshot from step 1>)`        (~3 min)
  4. `use_sandbox_build(role='browser', buildId=...)`
  If a build looks stuck the agent uses
  `check_build_progress` to decide between waiting and
  retrying — it won't silently restart a build that's just
  slow.

- **"Doctor's complaining about my provider — fix it."** It
  reads `run_doctor`, locates the line, and proposes the
  specific `config_write` or `secret_write` call before
  running anything.

- **"Am I on the latest version?"** Runs `check_for_update`;
  if you say yes, `apply_update` (which is just `npm install
  -g @tianshu-ai/tianshu@latest` under the hood).

Type *done* or hit Ctrl-C to exit the agent. State is on
disk, so a follow-up `tianshu setup` later picks up where
you left off.

### Non-interactive setup (Docker / CI)

Skips the agent step. Only writes the provider config and
exits.

```bash
tianshu setup --non-interactive \
  --provider=anthropic --api-key=sk-***
```

## Start the service

```bash
tianshu start
```

On macOS this installs a launchd agent at
`~/Library/LaunchAgents/ai.tianshu.prod.plist` (or
`ai.tianshu.dev` if you're running from a git checkout) and
bootstraps it. The agent auto-starts at login and
auto-restarts on crash.

```bash
open http://localhost:3110
```

You're chatting.

## Health check

```bash
tianshu doctor
```

`doctor` is a read-only audit covering:

```
┌  Tianshu doctor
│
◇  Runtime          → Node ≥ 22, OS supported
◇  Tianshu version  → up to date with npm latest?
◇  Config files     → ~/.tianshu/config.json + .env present
◇  LLM providers    → at least one provider's key resolves
│                     and defaultModel is reachable
◇  Network          → server port answering, /api/health green
◇  Sandbox          → microsandbox binary present
◇  Builtin plugins  → manifests parse, ids unique
◇  Tenant DBs       → each tenant's sqlite opens cleanly
└  Setup looks healthy
```

Flags:

- `--probe-providers` — hit each provider's `/v1/models`
  endpoint to test reachability + auth (slow; skip in normal
  runs).
- `--probe-sandbox` — boot a real microsandbox VM as a smoke
  test (~30s, pulls the image on first run).
- `--skip-version-check` — skip the npm-registry probe (use
  on offline / firewalled installs).
- `--json` — machine-readable output for scripts / monitors.

## Day-2 control

```bash
tianshu status               # what's loaded? port? pid? health?
tianshu logs -f              # tail stdout + stderr
tianshu restart              # bounce the server
tianshu stop                 # bootout from launchd
tianshu tenant list          # tenants + users + open-in-browser URLs
tianshu update               # check for + install npm latest
tianshu update --check       # check only, don't install
tianshu update --tag next    # pre-release channel
```

`tianshu start` / `restart` / `status` operate on
the launchd agent whose name matches your install shape
(`ai.tianshu.prod` for npm-global installs, `ai.tianshu.dev`
for git checkouts).

## Public hostname

If you put Tianshu behind a Cloudflare tunnel or a reverse
proxy, set the public URL once:

```jsonc
// ~/.tianshu/config.json
{
  "server": {
    "publicUrl": "https://tianshu.your-domain.com"
  }
}
```

Every CLI command that prints a URL (notably
`tianshu tenant list`) will use that instead of `localhost`.

## Background-service rules

`tianshu start` installs a real launchd agent. Don't run
Tianshu under `nohup`, `&`, or `screen` for a long-running
install — they don't survive logout and don't auto-restart on
crash.

The launchd plist details (paths, working directory, log
locations) live in [docs/running.md](./running.md).
