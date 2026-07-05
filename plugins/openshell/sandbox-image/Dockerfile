# syntax=docker/dockerfile:1
#
# Tianshu OpenCode sandbox image.
#
# Extends the OpenShell community base (Ubuntu + Node 22 + uv/python +
# claude/gh/codex CLIs + the default sandbox policy) and PREINSTALLS,
# for the sandbox user, everything an OpenCode worker needs:
#   - opencode-ai pinned to a version with the websearch tool +
#     OPENCODE_ENABLE_PARALLEL flag (the base image ships an older
#     opencode that lacks these), installed to a user-writable prefix
#     so the sandbox user runs it without root/EACCES.
#   - oh-my-openagent (omo) + its (large) dependency tree, warmed into
#     opencode's plugin cache so a task run does NOT download ~500 MB
#     of deps on every start.
#
# Why preinstall: the worker used to install these at task time, but
# omo pulls a huge dep tree over the deny-by-default egress (one host
# approved at a time), which is slow and repeats per isolated task.
# Baking it into the image = one build, instant startup, no per-task
# network install.
#
# Build (from this dir):
#   docker build -t tianshu/opencode-sandbox:latest .
# Then point the openshell plugin at it:
#   plugins.openshell.config.fromImage = "tianshu/opencode-sandbox:latest"
#
# The openshell runner passes this to `openshell sandbox create --from`.

ARG BASE_IMAGE=ghcr.io/nvidia/openshell-community/sandboxes/base:latest
FROM ${BASE_IMAGE}

# Versions pinned for reproducibility. Keep OPENCODE_VERSION in sync
# with OPENCODE_VERSION in plugins/workboard/src/worker/opencode-worker.ts.
ARG OPENCODE_VERSION=1.17.13
ARG OMO_PACKAGE=oh-my-openagent@latest

# --- 1. Upgrade opencode (root global) -----------------------------
# The base image preinstalls an older opencode at /usr/lib/node_modules.
# Overwrite it with our pinned version so `opencode` on PATH is the
# right one for every user (no per-task user-prefix install needed).
USER root
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && opencode --version

# --- 2. Warm the omo plugin cache for the sandbox user -------------
# opencode auto-installs npm `plugin` entries via Bun into
# $XDG_CACHE_HOME/opencode/node_modules on first run. We pre-warm that
# cache as the `sandbox` user (HOME=/sandbox) by launching opencode
# once with an opencode.json that lists the plugin, so the heavy
# dependency download happens at build time, not per task.
#
# The warm run is offline-friendly: it only needs the npm/GitHub
# fetches for the plugin install; we give it a throwaway config with
# no provider so it installs the plugin then exits. A non-zero exit
# from the (provider-less) run is fine — we only care that the plugin
# + deps got cached.
USER sandbox
WORKDIR /sandbox
RUN mkdir -p /sandbox/.config/opencode /sandbox/.warmup \
    && cat > /sandbox/.config/opencode/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "snapshot": false,
  "autoupdate": false,
  "plugin": ["oh-my-openagent"]
}
JSON
# Trigger plugin install: `opencode` loads plugins at startup. Run a
# no-op command; ignore its exit (no model configured). The install
# populates ~/.cache/opencode/node_modules with omo + deps.
RUN cd /sandbox/.warmup \
    && (OPENCODE_DISABLE_LSP_DOWNLOAD=1 timeout 600 opencode run "noop" --format json < /dev/null > /sandbox/.warmup/warm.log 2>&1 || true) \
    && echo "opencode plugin cache warmed:" \
    && du -sh /sandbox/.cache/opencode 2>/dev/null || true

# Leave the throwaway warmup config out of the runtime — the worker
# writes its own opencode.json per task. Keep the cache.
RUN rm -rf /sandbox/.warmup /sandbox/.config/opencode/opencode.json

USER sandbox
ENTRYPOINT ["/bin/bash"]
