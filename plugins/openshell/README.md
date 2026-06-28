# @tianshu-builtin/plugin-openshell

A Tianshu plugin that provides `sandbox.shell` backed by
**[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)** instead of
`microsandbox`. Same agent-facing tools (exec / reset / status), much
gentler on macOS-host CPU (no Hypervisor.framework loop).

| | OpenShell (this plugin) | microsandbox |
|---|---|---|
| Backend | Docker container | macOS Virtualization.framework microVM |
| Idle CPU on macOS Apple Silicon | **~0.07%** | ~126% (vmnetd + Hyper loop) |
| Cold start (first sandbox) | ~5s | ~3s |
| Warm start (subsequent) | ~1s | ~1s |
| exec round-trip | 17–35ms | similar |
| readFile / writeFile | via `openshell sandbox upload/download` (~30ms) | direct host-fs (instant) |
| Sandbox isolation | Landlock + seccomp + namespace + OPA policy | Hypervisor.framework |
| Network policy | yes (per-provider allowlist) | no |

## When to pick this over microsandbox

- **You're on Apple Silicon and the fan is loud.** microsandbox's
  vmnet host-network bridge plus the Hypervisor.framework virt loop
  is the root cause; OpenShell on Docker Desktop sidesteps both.
- **You need network egress policy.** OpenShell ships with per-
  provider allowlists (Claude Code / Codex / etc.) out of the box;
  microsandbox doesn't.
- **You're OK with Docker as a dependency.** OpenShell needs a
  running Docker daemon; microsandbox runs without Docker.

If none of the above applies, stick with microsandbox.

---

## Prerequisites

1. **Docker daemon** running. Docker Desktop, Colima, Lima, Rancher
   Desktop, and OrbStack are all known to work — OpenShell auto-
   detects the `host-gateway` alias each of them ships. Podman with
   libkrun on macOS has a [known bug](https://github.com/NVIDIA/openshell/issues/1519)
   and is not supported by this plugin yet.

2. **OpenShell + openshell-gateway binaries** on `$PATH`. Two ways:

   ### Option A — Homebrew / Linux package manager

   Not yet packaged. Use Option B until upstream ships brew taps /
   apt repos.

   ### Option B — GitHub release tarball

   Grab the matching artefact for your platform from
   <https://github.com/NVIDIA/openshell/releases>:

   | Platform | CLI tarball | Gateway tarball |
   |---|---|---|
   | macOS Apple Silicon | `openshell-aarch64-apple-darwin.tar.gz` | `openshell-gateway-aarch64-apple-darwin.tar.gz` |
   | Linux x86_64 (musl) | `openshell-x86_64-unknown-linux-musl.tar.gz` | `openshell-gateway-x86_64-unknown-linux-gnu.tar.gz` |
   | Linux aarch64 (musl) | `openshell-aarch64-unknown-linux-musl.tar.gz` | `openshell-gateway-aarch64-unknown-linux-gnu.tar.gz` |
   | Fedora 44 x86_64 | `openshell-0.0.71-1.fc44.x86_64.rpm` | `openshell-gateway-0.0.71-1.fc44.x86_64.rpm` |
   | Fedora 44 aarch64 | `openshell-0.0.71-1.fc44.aarch64.rpm` | `openshell-gateway-0.0.71-1.fc44.aarch64.rpm` |
   | Debian / Ubuntu | `openshell_0.0.71-1_<arch>.deb` | — gateway not yet in deb form, use tarball |

   macOS tarball install:

   ```bash
   cd ~/Downloads
   tar xzf openshell-aarch64-apple-darwin.tar.gz
   tar xzf openshell-gateway-aarch64-apple-darwin.tar.gz
   mkdir -p ~/bin
   mv openshell openshell-gateway ~/bin/
   xattr -dr com.apple.quarantine ~/bin/openshell ~/bin/openshell-gateway   # remove Gatekeeper flag
   chmod +x ~/bin/openshell ~/bin/openshell-gateway
   echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc   # if not already there
   exec $SHELL -l
   openshell --version
   openshell-gateway --version
   ```

   Linux tarball install:

   ```bash
   tar xzf openshell-x86_64-unknown-linux-musl.tar.gz
   tar xzf openshell-gateway-x86_64-unknown-linux-gnu.tar.gz
   sudo install -m 755 openshell openshell-gateway /usr/local/bin/
   ```

   ### Option C — Build from source

   If you want the latest dev features (`0.0.72-dev.x`, the spike
   used this), clone and `cargo install`:

   ```bash
   git clone https://github.com/NVIDIA/openshell.git
   cd openshell
   cargo install --path crates/openshell-cli --root ~/.local
   cargo install --path crates/openshell-server --bin openshell-gateway --root ~/.local
   ```

   Cargo needs a stable Rust 1.84+. The build is ~10 minutes
   first time.

3. **OpenShell community sandbox image cached locally.** First
   `sandbox create` will pull it (~700 MB compressed); pre-warm
   to make the first agent exec snappier:

   ```bash
   docker pull ghcr.io/nvidia/openshell-community/sandboxes/base:latest
   ```

   If you want a leaner / customised image, point the plugin
   at it via `pluginConfig.fromImage` (see *Plugin config*).

## Verifying the host is ready

After Docker + the two binaries are installed:

```bash
openshell --version            # → openshell 0.0.71 (or newer)
openshell-gateway --version    # → openshell-gateway 0.0.71 (must match major.minor)
docker info | grep "Operating System"     # any Linux'ish daemon is fine
```

A mismatched CLI vs. gateway version is the most common error mode
when upgrading. Bump both at once.

---

## Enabling the plugin in Tianshu

Each tenant opts in independently. Edit
`<tianshu home>/tenants/<tenant id>/config.json` and add an
`openshell` block under `plugins`:

```json
{
  "plugins": {
    "microsandbox": { "enabled": false },
    "openshell": {
      "enabled": true,
      "config": {}
    }
  }
}
```

Disable `microsandbox` in the same edit if you don't want both
plugins fighting for the `sandbox.shell` capability — Tianshu's
registry will refuse to start with two providers for one exclusive
capability.

Either restart the server, or hit the *Refresh plugins* button in the
admin UI. You should then see:

```
[builtin-loader] loaded openshell → @tianshu-builtin/plugin-openshell/server
[plugin:openshell] [tenant:<id>] openshell-gateway pid=… on :17670
[plugin:openshell] [tenant:<id>] sandbox created name=tianshu-<id> workspace=… guest=/sandbox/workspace
```

The first sandbox `Ready` transition takes ~1s warm, ~5s cold (image
pull happens at this point if you skipped the pre-warm step).

## Plugin config

All fields are optional. Read by `OpenShellRunner` in `activate()`.

| Field | Type | Default | Effect |
|---|---|---|---|
| `openshellBin` | `string` | `openshell` (resolved via `$PATH`) | Path to the `openshell` CLI binary. |
| `gatewayBin` | `string` | `openshell-gateway` (resolved via `$PATH`) | Path to the gateway binary. |
| `port` | `integer` | `17670` | Loopback port for this tenant's gateway. Override if two Tianshu installs share a host or you have a port conflict. |
| `fromImage` | `string` | `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` (CLI default) | Base sandbox image. Override with a leaner / preloaded image. |

Example with overrides:

```json
"openshell": {
  "enabled": true,
  "config": {
    "openshellBin": "/Users/yuyu/.cargo/bin/openshell",
    "gatewayBin":   "/Users/yuyu/.cargo/bin/openshell-gateway",
    "port": 17680,
    "fromImage": "ghcr.io/myorg/dev-sandbox:latest"
  }
}
```

## State directory

The plugin owns one per-tenant directory:

```
<tianshu home>/tenants/<tenant>/state/openshell-plugin/
  certs/
    ca.crt / ca.key                ← mTLS root for this tenant
    server/{tls.crt, tls.key}      ← gateway's serving cert
    client/{tls.crt, tls.key}      ← shared by CLI + sandbox supervisor
    jwt/{signing.pem, public.pem, kid}   ← supervisor token signer
  gateway.toml                     ← regenerated each start
  gateway.log
  cli-xdg/openshell/...            ← plugin-local CLI config (no pollution of ~)
  io-scratch/                      ← upload/download staging, auto-cleaned
```

Safe to `rm -rf` on uninstall; certs/JWT will regen on next start.
**Do not** copy this dir between machines — the mTLS material is
local-trust-only.

## How it works

The plugin spawns `openshell-gateway` as a child process per tenant
the first time the runner starts. It then drives the standard
`openshell` CLI (`sandbox create`, `sandbox exec`, `sandbox upload`,
`sandbox download`) over a loopback `https://127.0.0.1:<port>` mTLS
link.

Inside the container, OpenShell's supervisor dials back to the host
gateway over the Docker bridge (`https://host.openshell.internal:<port>`)
using a sibling client cert that the docker driver mounts via the
`guest_tls_*` config keys.

`readFile`/`writeFile` go through `sandbox upload`/`download`
targeting `/sandbox/workspace/<path>` inside the container. We do
**not** bind-mount the tenant workspace dir — see the long comment
at the top of `src/runner/openshell-runner.ts` for the four-attempt
debugging story; tl;dr OpenShell's Landlock + fakeowner-mount layer
denies host-path bind mounts under any policy.

## Troubleshooting

### `openshell-gateway: command not found`

Step 2 above. Either install the binaries on `$PATH`, or set
`pluginConfig.gatewayBin` to the absolute path.

### `Error response from daemon: Cannot connect to the Docker daemon`

Docker isn't running. Start Docker Desktop / `colima start` /
`orb start` etc. and retry — the plugin will reuse the same gateway
process and recover automatically.

### `failed to read TLS CA from .../gateways/.../mtls/ca.crt`

This means the plugin's CLI XDG config got wiped or never written.
Causes:
- You manually deleted the state dir while the gateway was running.
  Restart the plugin: stop the tenant's server / restart tianshu and
  the plugin will lay down a fresh set of certs.
- Two Tianshu installs share a port. Set `pluginConfig.port` to a
  different value for one of them.

### Sandbox stuck in `Provisioning` forever

This is the [Podman+libkrun bug](https://github.com/NVIDIA/openshell/issues/1519).
Switch to Docker Desktop / Colima / OrbStack and the sandbox will
move to `Ready` on the next create.

### `bind source path does not exist`

You're on a Mac and your tenant's `workspaceDir` is under a path
Docker Desktop doesn't share by default (e.g. `/tmp/...`,
`/private/...`, an external volume). Move the tenant home to
under `~/` — the default `~/.tianshu/tenants/<id>/workspace`
already satisfies this.

### `mounts source path does not exist /host_mnt/...`

Same root cause as above, slightly different error. Same fix.

### Idle CPU is *still* high after switching

If you still see >50% idle CPU on `tianshu start`, that's not
OpenShell — it's microsandbox still running. Check the tenant's
`config.json` actually has `microsandbox.enabled = false`, and
the dev server log shows `[plugin:microsandbox] deactivated`.

---

## Limitations / out of scope

- **Browser sidecar.** `microsandbox` provides `browser.cdp` via
  CloakBrowser; this plugin doesn't yet. Tracked for a follow-up.
- **Per-task pool.** `sandbox.taskPool` is not provided. One long-
  lived sandbox per tenant; per-task isolation falls back to
  whatever the tenant gets from microsandbox.
- **Admin UI surfaces.** OpenShell's policy / provider / inference
  admin pages are not wired into Tianshu's tenant config UI yet.

If any of those become blocking for you, open a discussion on
the Tianshu repo with your use case.
