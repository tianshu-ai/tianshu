# Running tianshu

This guide covers four ways to run the dev server during the
0.x preview, from "just want to try it" to "should survive a
reboot".

## Quick start (foreground)

After `npm install` + `tianshu setup --wizard`:

```bash
npm run dev
```

Starts six concurrent processes (server + web + 4 plugin tsc
watchers). Logs interleave on stdout. Ctrl-C to stop.

Use this when you're actively poking at tianshu's source code —
hot reload picks up edits.

## macOS — launchd (recommended for a permanent dev box)

For a tianshu instance that should survive reboots and restart on
crash, run it under `launchd` (the macOS-native init system).
**Don't use `nohup` / `&` / `screen`** — they don't survive logout
and don't auto-restart.

The `tianshu` CLI takes care of the launchd plist for you. You
shouldn't need to write XML or run `launchctl` directly.

### Install + start

```bash
tianshu setup --wizard
```

The wizard picks ports, writes `.env`, drops a plist into
`~/Library/LaunchAgents/`, bootstraps it, and waits for
`/api/health` to respond. On a multi-checkout machine the
plist label is derived from your checkout path (the first
checkout claims `ai.tianshu.dev`; later ones get
`ai.tianshu.dev.<sha8>`) so they coexist instead of
overwriting each other.

### Day-to-day

```bash
tianshu status      # installed / loaded / pid / health
tianshu start       # bootstrap if not loaded
tianshu stop        # bootout (idempotent)
tianshu restart     # kickstart -k, wait for /api/health
tianshu logs        # last 50 lines of stderr + stdout
tianshu logs --follow                  # tail -f
tianshu logs --lines=200 --stream=err  # bigger window, errors only
```

Logs live at `~/Library/Logs/tianshu/<label>.{out,err}.log`
(macOS-conventional; Console.app surfaces them under "User
Reports"). The `tianshu logs` command is the fast path — it
resolves the label automatically.

### Troubleshooting

Boot failure? Run **`tianshu logs`** first, before anything else:

```bash
tianshu logs --lines=100
```

This is also what the setup agent does — if `tianshu setup --wizard`
reports the server didn't come up, it will read the same log
files via the `read_service_logs` tool and propose a specific
fix instead of guessing.

Common failure patterns:

| stderr says | Cause | Fix |
| --- | --- | --- |
| `command not found: npm` | launchd's PATH doesn't have npm. Common with volta / fnm / asdf installs that put npm under `~/.local/share/...` | Re-run `tianshu setup --wizard` from a shell where `which npm` returns the right path. The wizard captures it into the plist. |
| `EADDRINUSE: 3110` | Another `npm run dev` (or stale launchd agent) on the same port | `tianshu doctor` confirms it. Stop the other process, or pick a different `PORT` in `.env` and `tianshu restart`. |
| `Cannot find module` / `ENOENT package.json` | Wrong `WorkingDirectory` in the plist | Re-run wizard from inside the correct checkout. |
| (empty) + `lastExitStatus != 0` | Killed by signal pre-stdio (OOM → 137, SIGTERM → 143) | Check Activity Monitor / system logs. OOM means bump available memory or trim plugins. |

Health endpoint not responding (but launchd thinks it's up)? First
boot needs ~30s to build plugin-sdk + 4 plugins + sync
builtinConfig. Watch the log:

```bash
tianshu logs --follow
# wait for: [tianshu] server listening on http://localhost:3110
```

### Manual launchctl (advanced / when the CLI itself is broken)

If the CLI binary itself fails to run (missing dist build, broken
Node install), drop down to launchctl:

```bash
UID=$(id -u)
launchctl print gui/$UID/ai.tianshu.dev | grep -E "state|pid"
launchctl bootout gui/$UID/ai.tianshu.dev
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.tianshu.dev.plist
```

If you have a hashed label (multi-checkout machine), find it via
`tianshu status` first.

## Linux — systemd (user scope)

On Linux the same `tianshu` CLI manages a **user-scoped systemd
unit** — the direct analogue of the macOS launchd path. No root,
no system-wide unit; it runs as your user with your `$HOME`.

### Install + start

```bash
tianshu setup --wizard
```

The wizard picks ports, writes `.env`, drops a unit into
`~/.config/systemd/user/`, runs `systemctl --user enable --now`,
and waits for `/api/health`. Unit names mirror the launchd
labels: a global npm install gets `tianshu-prod.service`; the
first git checkout claims `tianshu-dev.service`; later checkouts
get `tianshu-dev-<sha8>.service` so they coexist.

### Day-to-day

```bash
tianshu status      # installed / loaded / pid / health
tianshu start       # systemctl --user enable --now
tianshu stop        # systemctl --user disable --now
tianshu restart     # systemctl --user restart, wait for /api/health
tianshu logs        # last 50 lines of stderr + stdout
tianshu logs --follow
```

Logs are captured to `~/.local/state/tianshu/log/<name>.{out,err}.log`
(via the unit's `StandardOutput=append:` / `StandardError=append:`),
so `tianshu logs` works even without journald access. They also go
to the journal — `journalctl --user -u tianshu-dev.service -f`.

### Headless servers: keep it running after logout

User services stop when your last session ends unless **lingering**
is enabled. Enable it once:

```bash
loginctl enable-linger "$USER"
```

The wizard prints this hint after install. Without a reachable user
systemd bus (some minimal containers / non-login shells), the wizard
falls back to telling you to run `npm run dev` directly.

### Troubleshooting

| stderr says | Cause | Fix |
| --- | --- | --- |
| `Failed to connect to bus` | No user systemd instance (minimal container / no login session) | Run `npm run dev` under your own supervisor, or start a user session / enable linger. |
| `command not found: npm` | The unit's `PATH` doesn't include your npm | Re-run `tianshu setup --wizard` from a shell where `which npm` resolves; it captures the path into the unit. |
| `EADDRINUSE: 3110` | Another process on the port | `tianshu doctor` confirms it; stop it or change `PORT` in `.env` and `tianshu restart`. |

## Docker

A multi-stage `Dockerfile` ships in the repo root. It builds the
server + web dist and runs the single-port production server
(`npm run serve`) — no vite, one port.

```bash
docker build -t tianshu .
docker run -d --name tianshu \
  -p 3110:3110 \
  -v tianshu-data:/data \
  tianshu
# then open http://localhost:3110
```

Details:
- Base: `node:22-bookworm` (build) → `node:22-bookworm-slim`
  (runtime), same Debian release so better-sqlite3's prebuilt
  native binary is ABI-compatible. No compiler toolchain needed.
- `TIANSHU_HOME=/data` — tenants, sqlite dbs, and workspaces live on
  the mounted volume, so they survive `docker rm`.
- `TIANSHU_IGNORE_SETUP=1` — skips the interactive setup gate so the
  container boots unattended (it bootstraps a `default` tenant + `dev`
  user on first run). Configure providers/auth via the mounted
  `/data` config or env as needed.
- `HEALTHCHECK` probes `/api/health`; `docker ps` shows `healthy`
  once it's up.

Inside the container the `tianshu` CLI is available
(`docker exec <name> node bin/tianshu.mjs status`), though service
management (systemd) is a no-op there — containers use the process
as PID 1, not a service manager.

## Picking the right mode

| You want… | Use |
| --- | --- |
| To poke at tianshu's source | `npm run dev` |
| Permanent local instance, survives reboots | launchd plist (macOS) / systemd user unit (Linux) |
| Run inside a container | `docker build` + `docker run` (Dockerfile in repo root) |
| Multi-machine deploy with auth | not yet — 0.3.x roadmap |

## Related

- [`tianshu doctor`](../README.md#what-npm-run-doctor-checks) — read-only health check.
- [`tianshu setup --wizard`](../README.md#what-npm-run-setup-does) — first-run config.
- Identity / multi-user: see PR #159 for `?tenant=alpha&user=alice` URL switching.
