---
name: microsandbox-config
description: How to change the sandbox VM image / cpus / memory using `update_sandbox_config`, and when a `reset_sandbox` is needed for the change to take effect.
when:
  toolPresent: update_sandbox_config
---

`update_sandbox_config` writes the tenant config file. The currently-running
VM is **not** restarted automatically; call `reset_sandbox` after this if you
want the new settings live now.

## Configurable fields

| Field | Default | Reset needed? |
|-------|---------|---------------|
| `image` | `python:3.12-slim` | yes (rebuilds VM) |
| `cpus` | 2 | yes |
| `memory_mib` | 2048 | yes |
| `sandbox_name` | `tianshu-<tenantId>` | yes (rarely useful) |
| `idle_shutdown_ms` | 14400000 (4h) | no (read live) |
| `exec_timeout_ms` | 300000 (5min) | no (read live per call) |

The result returns `reset_required: true/false` so you know whether to call
`reset_sandbox` next.

## Common changes

- Need a different OS / pre-installed packages: change `image`, then
  `reset_sandbox`. Image pulls happen on next `exec` (cold start cost).
- Memory pressure: bump `memory_mib`, `reset_sandbox`.
- Idle reaping too aggressive: raise `idle_shutdown_ms`. No reset needed.

## What NOT to do

- Don't set `image` to something you haven't verified locally first — a
  bad image leaves the sandbox in `state: "error"` and the agent loses
  `exec` until you fix the config.
- Don't set `cpus` higher than the host has free.
