---
name: microsandbox-build-publish
description: How to author a Sandboxfile, build a snapshot, sanity-check it, then publish it as the tenant's active image. Covers the build → preview → publish → reset loop and the common failure modes.
when:
  toolPresent: build_sandbox
---

The sandbox image you customize via a Sandboxfile. Three tools cooperate:

| Tool | What it does |
|------|--------------|
| `build_sandbox` | reads the Sandboxfile, boots a builder VM, runs the steps, captures a snapshot, writes build metadata. **Does not** affect the live sandbox. |
| `list_sandbox_builds` | lists past builds (newest first), with which one is currently published. |
| `publish_sandbox(build_id)` | swaps the tenant pointer to that build. The next `reset_sandbox` (or process restart) boots the new VM `fromSnapshot(...)`. |

## Sandboxfile location

`<your-userHomeDir>/sandbox/Sandboxfile`. Use `write_file("/sandbox/Sandboxfile", "...")` to author it; `build_sandbox` reads from there by default.

## Sandboxfile grammar (v0)

```yaml
image: python:3.12-slim          # required: any OCI image microsandbox can pull
cpus: 4                          # optional, default 4
memory_mib: 4096                 # optional, default 4096

# Pre-installed layers, applied in this order. All optional.
apt:
  - libreoffice-writer
  - fonts-noto-cjk
pip:
  - pandas
  - numpy
npm:
  - tsx
  - typescript

# Free-form shell commands, run last, in array order.
exec:
  - sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources
  - bash -c "curl -fsSL https://npmmirror.com/mirrors/node/v22.20.0/node-v22.20.0-linux-arm64.tar.xz | tar -xJ -C /usr/local --strip-components=1"
```

The four list slots are convenience wrappers: `apt`/`pip`/`npm` produce one
combined `apt-get install -y --no-install-recommends ...` (or pip / npm)
call. Anything more complex goes in `exec`.

## The full lifecycle

```
1. write_file("/sandbox/Sandboxfile", "...")
2. build_sandbox()                      # 30s–10min; returns build_id
3. (sanity-check via the admin /shell preview, or via tools below)
4. publish_sandbox(build_id)            # writes pointer
5. reset_sandbox()                      # live VM picks up the new snapshot
```

You can also sanity-check from the agent: tools work the same against
the build snapshot as against any image (the agent doesn't have a
preview-exec equivalent yet — that's an admin UI feature). For agent
flow, the cheap heuristic is: trust the build log tail
(`build_sandbox` returns it) for "did the install command succeed?",
then publish + reset, then run real verification commands via `exec`.

## Common failure modes

### apt step "succeeds" but the package isn't there
Usual cause: a step like `echo node=$(node --version)` swallows the
inner failure because `echo` exits 0 even with `$()` empty. **Verify
with `bash -c`**:

```yaml
exec:
  - bash -c "node --version && npm --version && libreoffice --version | head -1"
```

`bash -c` propagates the inner `&&` failure; the build fails properly.

### Slow apt
Default Debian mirrors are slow from CN. First exec step should swap to
a regional mirror:

```yaml
exec:
  - sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources
  - apt-get update -qq
  # …rest of your apt installs as a *single* exec line, or via the apt: list
```

If you're using the `apt:` list slot, the runner already issues
`apt-get update`; the `sed` line in `exec` happens before that, so the
update sees the fast mirror.

### apt's nodejs is too old
Debian bookworm ships Node 18; modern packages need 20+. Skip the apt
nodejs and grab a binary from a CN mirror:

```yaml
exec:
  - DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates xz-utils
  - bash -c "curl -fsSL https://npmmirror.com/mirrors/node/v22.20.0/node-v22.20.0-linux-arm64.tar.xz | tar -xJ -C /usr/local --strip-components=1"
  - npm config set registry https://registry.npmmirror.com
```

(`linux-arm64` because microsandbox on Apple Silicon is arm64; for
x86_64 hosts use `linux-x64`.)

### LibreOffice + CJK font rendering hangs
You also need `fontconfig` and a fontconfig refresh:

```yaml
exec:
  - DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk libreoffice-writer
  - fc-cache -fv
```

Without `fc-cache`, the first LibreOffice invocation can spend 30+s
rebuilding the font index (and sometimes hangs in our setup).

### Snapshot lost between sessions
`publish_sandbox` writes a pointer file; the live VM only picks it up
on `reset_sandbox`. If you publish but skip the reset, the next agent
turn still runs the old image. The user's admin UI has a one-click
"Publish & Reset" button that does both; from the agent always pair
them.

## Snapshot retention

Snapshots live in microsandbox's local store under
`~/.microsandbox/snapshots/<name>/`. They are *not* garbage-collected
automatically in v0; build a lot and you'll fill the disk. Old builds
can be removed manually with `rm -rf` on that path (no agent tool yet).

## Pre-flight checklist

Before calling `build_sandbox`, double-check:

- [ ] You wrote the Sandboxfile (`write_file("/sandbox/Sandboxfile", ...)`),
      not just discussed it.
- [ ] Final verification step uses `bash -c "<chained checks>"`, not bare
      `echo $(...)` (silent-failure trap).
- [ ] If installing user-space binaries (Node, Go, …) you used a regional
      mirror — default mirrors are too slow inside the sandbox network.
- [ ] You explicitly want this image — check with the user if you're
      changing the published sandbox; that affects every future agent
      turn.

## What NOT to do

- Don't call `publish_sandbox(build_id)` without first reading
  `list_sandbox_builds` to confirm the snapshot still exists.
- Don't run multi-stage workflows (download → compile → install) inline
  in the verification step — separate them. A failed download in line
  N+1 is much easier to debug than one of three commands chained
  through `&&`.
- Don't rely on `apt-get install` exit code alone to confirm the
  package works; the install can succeed but the binary may not be on
  `PATH`. Always test with `which <bin>` or `<bin> --version`.
- Don't `npm install -g <pkg>` immediately after `npm install -g
  npm@latest` in the same `exec` line — npm may relink during upgrade
  and the second call sees a half-installed registry. Split into two
  `exec` lines.
