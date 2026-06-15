---
name: microsandbox-exec-howto
description: How to use `exec` effectively — default workdir, timeouts, output truncation, when to call `reset_sandbox` vs retrying.
when:
  toolPresent: exec
---

`exec` runs a command inside a per-tenant microVM started lazily on first use.

## Default working dir

`exec` defaults `cwd` to your user home inside the sandbox
(`/workspace/users/<your-userId>/`), the SAME dir `read_file`/`write_file`
operate on. So a relative path means the same file on both sides:

```
write_file("/hello.py", "print('hi')")
exec("python3 hello.py")     # → "hi"
```

Pass an absolute path in `workdir` to step outside (e.g. `/etc`, `/usr`,
`/tmp`).

## Timeouts

- Default: 5 minutes.
- Cap: 30 minutes (`timeout_ms` is clamped).
- Use `timeout_ms` for slow tasks: `pip install`, `npm install`, builds,
  data processing.
- A timed-out call returns `timed_out: true` and `exit_code: -1`. Retry with
  a larger timeout if the command is legitimately slow.

## Starting servers / long-running processes

**Don't run a foreground server with `exec`.** A command like
`python -m http.server 8000` or `npm start` never returns; the
`exec` call hangs until the host timeout, then your turn dies
with no useful output AND the server keeps running, tying up
the port for the next attempt.

Three safe shapes, in order of preference:

### 1. Skip the server (best)

If you only need to verify the file works in a browser, write
it and tell the user the path. Don't "verify by starting a
server" — the user will open it themselves. This is the
default for static sites, single-file games, demos.

### 2. Background + readiness check

When the verification truly needs the server up:

```bash
# detach completely so exec returns immediately
nohup setsid python -m http.server 8000 \
  > /tmp/srv.log 2>&1 < /dev/null &

# wait briefly, then probe
sleep 2
curl -sS --max-time 5 http://127.0.0.1:8000/ | head -20
```

Key moves: `nohup setsid ... &` detaches from this shell;
`> /tmp/srv.log 2>&1 < /dev/null` closes stdin and redirects
output so the parent shell can exit cleanly. Without these the
fd connection keeps `exec` waiting.

### 3. Bounded foreground (rarely useful)

If you need to capture output and the command will exit on its
own after some short time (a one-shot test runner, a CLI tool):

```bash
timeout 30 ./run-tests.sh 2>&1 | tail -50
```

`timeout` guarantees the call returns; the trailing `tail`
keeps stdout under the truncation cap.

### Stopping a server you started

```bash
pkill -f 'python -m http.server' || true
```

Or just `reset_sandbox` if it's gotten messy — your files in
`/workspace` survive.

## Output truncation

stdout/stderr each truncated at 200 lines / 8 KB. If output is bigger:

```
exec("long-running-thing > /workspace/out.log 2>&1")
read_file("/out.log")
```

…or pipe through `tail`/`sed` inline.

## Pre-installed tools (don't `apt install` / `pip install` what's already there)

The sandbox image ships with these out of the box. Use them
directly instead of installing alternatives:

- **`soffice`** (LibreOffice 25.2) — headless docx / xlsx / pptx /
  pdf conversion. See `microsandbox-libreoffice` for the full
  conversion table, sandbox-specific gotchas (single-instance
  lock, AF_UNIX status, font cache), and "when soffice is the
  WRONG tool".
- **`chromium` / Playwright MCP** — see `microsandbox-browser-howto`.
  Don't `playwright install chromium`; the sandbox already has it
  on CDP 9222 + MCP 3200.
- **`node`, `npm`, `npx`** — Node 22 LTS, configured to npmmirror
  in CN. `npm install <pkg>` works; just don't try to upgrade
  Node itself.
- **`fc-cache`** — already run at build time, so CJK fonts render
  in `soffice` and `chromium` without a 30s cold start.
- **`pdftoppm`** (Poppler) — PDF → PNG / JPEG, the right tool
  for multi-page rasterisation (used by the LibreOffice and
  PPTX flows).

If you need something not on this list and it's a one-shot:
`apt-get install -y <pkg>` works in the running VM but won't
survive a `reset_sandbox`. For persistence, edit Sandboxfile
and rebuild (see `microsandbox-build-use`).

## When to reset

Call `reset_sandbox` only when:

- `exec` keeps timing out (process stuck, kernel deadlocked).
- A long-running daemon (e.g. `python -m http.server`) is in your way.
- `get_sandbox_status` shows `state: "error"`.
- You broke something in `/etc` / `/usr` and want a clean slate.

`reset_sandbox` destroys the VM and re-creates it. **Files under
`/workspace` survive**; everything else (installed packages, `/tmp`, running
processes) does not.

## Cold start

The sandbox boots on first `exec` (≈10s the first time per session).
Subsequent calls in the same conversation are sub-second.
