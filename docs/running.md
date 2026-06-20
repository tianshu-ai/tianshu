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

### 1. Drop a plist

Create `~/Library/LaunchAgents/ai.tianshu.dev.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.tianshu.dev</string>

    <key>ProgramArguments</key>
    <array>
        <!-- Adjust to your nvm / homebrew npm path; `which npm`
             tells you what to put here. -->
        <string>/Users/YOU/.nvm/versions/node/v22.0.0/bin/npm</string>
        <string>run</string>
        <string>dev</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/path/to/your/tianshu/checkout</string>

    <key>RunAtLoad</key>
    <true/>

    <!-- Restart on crash, but don't loop on a deliberate Ctrl-C. -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <!-- Wait at least 30s between restarts so we don't hammer the
         provider key when something's permanently broken. -->
    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>/tmp/tianshu-dev.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/tianshu-dev.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <!-- launchd does NOT inherit your shell PATH. Set it
             explicitly to whatever `which node` / `which npm`
             resolves to. -->
        <key>PATH</key>
        <string>/Users/YOU/.nvm/versions/node/v22.0.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/YOU</string>
        <key>NODE_OPTIONS</key>
        <string>--no-warnings</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
```

Replace `YOU`, the nvm version, and `/path/to/your/tianshu/checkout`
to match your setup. `which npm` and `pwd` (from inside the
checkout) are your friends.

### 2. Load it

```bash
UID=$(id -u)
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.tianshu.dev.plist
```

### 3. Verify

```bash
# Wait ~30s on first boot — npm has to build plugin-sdk + 4 plugins
# + sync builtinConfig before the server can listen.
curl http://localhost:3110/api/health
# → {"status":"ok","name":"tianshu","tenants":1}

UID=$(id -u)
launchctl print gui/$UID/ai.tianshu.dev | grep -E "state|pid"
# → state = running
#   pid = 12345
```

### Day-to-day

```bash
UID=$(id -u)

# Restart cleanly (e.g. after pulling new code)
launchctl kickstart -k gui/$UID/ai.tianshu.dev

# Stop without unloading (will restart on next login)
launchctl kill SIGTERM gui/$UID/ai.tianshu.dev

# Unload completely (won't restart on login)
launchctl bootout gui/$UID/ai.tianshu.dev

# Tail logs
tail -f /tmp/tianshu-dev.out.log
tail -f /tmp/tianshu-dev.err.log
```

### Troubleshooting

**Service starts and immediately dies (KeepAlive keeps relaunching)**
- Check `/tmp/tianshu-dev.err.log` for the actual error.
- Most common: PATH wrong → `npm: command not found`. Fix the
  `EnvironmentVariables.PATH` in the plist.
- Next most common: setup blocker → `tianshu doctor` will tell you.
  Either fix the config or set `TIANSHU_IGNORE_SETUP=1` in the plist's
  `EnvironmentVariables`.

**Service starts but `/api/health` 404s**
- First boot needs ~30s to build plugins. Tail
  `/tmp/tianshu-dev.out.log` and watch for
  `[tianshu] server listening on http://localhost:3110`.

**Port conflict (`EADDRINUSE`)**
- Probably a stray `npm run dev` in another terminal. Kill it:
  `pkill -f "tianshu_opensource.*concurrently"`.
- Or you have the closed-source predecessor running on 3100.
  Make sure the open-source repo's `.env` is `PORT=3110` (the
  open-source default), not 3100.

## Linux — systemd (TODO)

The same shape works under systemd; we'll write up the unit file
once a Linux contributor wants it. Until then, run `npm run dev`
under your favourite supervisor (systemd user service, supervisord,
runit, …) — it's just an `npm` command in a working directory.

## Docker — TODO

`tianshu start` (single-port production server, no vite) plus a
Dockerfile is the next CLI milestone (PR #2 from the doctor/setup
roadmap). Until then, the canonical way to run is one of the above.

## Picking the right mode

| You want… | Use |
| --- | --- |
| To poke at tianshu's source | `npm run dev` |
| Permanent local instance, survives reboots | launchd plist (this guide) |
| Run inside a container | wait for `tianshu start` + Dockerfile |
| Multi-machine deploy with auth | not yet — 0.3.x roadmap |

## Related

- [`tianshu doctor`](../README.md#what-npm-run-doctor-checks) — read-only health check.
- [`tianshu setup --wizard`](../README.md#what-npm-run-setup-does) — first-run config.
- Identity / multi-user: see PR #159 for `?tenant=alpha&user=alice` URL switching.
