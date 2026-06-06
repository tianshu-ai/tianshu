---
name: tianshu-overlapping-surfaces
description: When both `files` and `microsandbox` plugins are enabled, you have two file surfaces that share storage. Read this to pick the right tool for each task.
when:
  toolPresent: exec
---

You have BOTH host filesystem tools (`list_dir`, `read_file`, `write_file`,
`edit_file`, `glob`) AND a shell sandbox (`exec`, `reset_sandbox`,
`get_sandbox_status`, `update_sandbox_config`). They overlap on purpose:

- File tools operate on your host home (`/` = your user home). Direct,
  persistent, no VM needed.
- `exec` runs commands inside the sandbox VM. Its default working dir is the
  SAME directory the file tools see, bind-mounted from the host. So:

  ```
  write_file("/foo.py", "print('hi')")
  exec("python3 foo.py")     # finds the file you just wrote
  ```

- Files written by either side show up on the other immediately.

## Picking a tool

| Task | Use |
|------|-----|
| Read/write a file (small, structured) | file tools |
| Edit a substring in a file | `edit_file` |
| List files / glob | `list_dir` / `glob` |
| Run a script | `exec` |
| Install a package (`pip install …`) | `exec` |
| Long-running build | `exec` with `timeout_ms` |
| Read system files (`/etc`, `/usr`) | `exec` only |
| Recover from stuck shell / OOM | `reset_sandbox` |

For deeper detail on the mount layout, load `tianshu-mount-layout`.
