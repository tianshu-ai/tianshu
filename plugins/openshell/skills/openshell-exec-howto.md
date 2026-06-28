---
name: openshell-exec-howto
description: How to use the OpenShell sandbox `exec` tool — workdir, file paths, persistence, and recovery.
---

# Running commands in the OpenShell sandbox

The `exec` tool runs a shell command inside the per-tenant **OpenShell**
sandbox (Docker container, managed by NVIDIA OpenShell). It is the
moral equivalent of the microsandbox `exec` — same tool name, same
schema, different backing runtime.

## Working directory

Default `workdir` is `/workspace/users/<userId>` — the same dir
`read_file` / `write_file` see as their root. A file written by
`write_file("foo.py")` is reachable as `exec("python3 foo.py")` with
no path gymnastics.

If you need to step outside the user home (e.g. peek at `/etc`,
install packages with `apt`), pass an absolute `workdir`.

## Path semantics

- Inside the sandbox shell, `/` is the **container root**, not the
  workspace root.
- `read_file` / `write_file` paths are **relative to the workspace
  root** by default.
- A file written via `write_file("foo.py")` lives at
  `/workspace/users/<userId>/foo.py` inside the sandbox.
- Use **relative paths in both tools** to avoid confusion.

## Persistence

- Files under `/workspace/...` are bind-mounted from the host. They
  survive `reset_sandbox`, sandbox upgrades, and server restarts.
- Everything else (`/tmp`, apt-installed packages, pip caches) is
  ephemeral and wiped on `reset_sandbox`.

## Timeouts

- Default: **5 minutes** per `exec` call.
- Override with `timeout_ms` — hard cap is **30 minutes**.
- The runner kills the guest process on timeout; an outer watchdog
  fires +5s later in case the runner itself hangs.

## Recovery

If `exec` returns `timed_out: true` repeatedly, or the sandbox
status reports `error`, call `reset_sandbox`. Workspace files are
safe; only the container state is reset.

## What's different vs. microsandbox

This plugin is the **OpenShell** backend. Compared to the
microsandbox plugin:

- Backed by Docker, not a microVM. No Apple Silicon Hypervisor.framework
  involvement, no idle-CPU burn from vGIC synchronisation.
- Slightly cooler first-boot: container pull + create vs. VM cold
  start, typically faster on warm Docker.
- No browser sidecar (yet). Use microsandbox if you need
  Chromium / Playwright in the same workspace.
- No per-task sandbox pool (yet). All tasks share the long-lived
  sandbox.

Pick whichever backend's trade-off fits the workload; only one
provides `sandbox.shell` at a time, swap via plugin enable/disable.
