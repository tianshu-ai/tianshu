---
name: tianshu-mount-layout
description: How the host filesystem maps into the sandbox guest, and which sub-paths inside the mount are yours vs other users' vs shared. Read this whenever paths look confusing.
when:
  toolPresent: exec
---

Tianshu mounts the **whole tenant workspace** into the sandbox guest, but `exec`
defaults its working directory to **your user home**, a sub-path inside it.

## The mount

A single bind-mount maps the entire tenant workspace into the guest:

| Host                          | Guest         |
|-------------------------------|---------------|
| `<tenant>/workspace/`         | `/workspace/` |

So everything inside the host's tenant workspace is visible from `exec`,
including other users' homes and the shared `_tenant/` config dir.

## Layout inside the mount

```
/workspace/
├── users/
│   ├── <your-userId>/        ← YOUR home. exec defaults its cwd here.
│   ├── <other-userId>/       ← Other users' homes. Visible. DO NOT touch.
│   └── ...
└── _tenant/                  ← Tenant-level shared config. Read-only for you.
```

## What this means

- `write_file('/foo.py')` → host writes to `<tenant>/workspace/users/<you>/foo.py`,
  visible at `/workspace/users/<you>/foo.py` inside the guest.
- `exec('python3 foo.py')` (no workdir) starts at `/workspace/users/<you>/`,
  finds the file.
- `exec('ls /workspace')` shows other users' dirs and `_tenant/`. **Don't write
  to them** — that's a policy violation (and may be enforced by future PRs).
- Anything outside `/workspace/` (e.g. `/usr`, `/etc`, `/tmp`) is the sandbox
  guest OS. exec can read most of it; only `/workspace/` is mirrored to the host.

## Mental model

```
your file tools  ───►  host  ◄────── bind-mount /workspace ──────►  guest  ◄───  exec
                       │                                            │
                       │ (host fs paths)              (guest fs paths)
                       └─── same bytes, two views ──────────────────┘
                              your home is one sub-path,
                              not the whole mount
```

When in doubt about paths, run `exec('pwd')` to see where you are, or use
absolute guest paths starting with `/workspace/users/<your-userId>/`.
