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

## Output truncation

stdout/stderr each truncated at 200 lines / 8 KB. If output is bigger:

```
exec("long-running-thing > /workspace/out.log 2>&1")
read_file("/out.log")
```

…or pipe through `tail`/`sed` inline.

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
