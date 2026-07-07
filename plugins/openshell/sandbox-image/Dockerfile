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
# Pin an EXACT omo version (never @latest). opencode re-resolves an
# unpinned plugin against npm on every startup, which stalls through
# the openshell egress proxy and hangs plugin-load; a pinned version
# warmed here matches what the worker requests (OMO_VERSION in
# opencode-worker.ts) so opencode uses the cached package and skips
# the npm resolve. Keep in sync with OMO_VERSION in the worker.
ARG OMO_PACKAGE=oh-my-openagent@4.15.1

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
RUN mkdir -p /sandbox/.config/opencode /sandbox/.warmup/.opencode
# The warmup config lists the plugin AND ships an omo config that
# looks like a real task's, so the warm run triggers not just the
# plugin DEP install but also omo's one-time FIRST-INIT PROVISIONING
# (codegraph binary + ast-grep + ~/.omo state). That provisioning,
# if left to the first real task, stalls under the openshell gRPC
# exec tunnel (observed: omo hangs at first init in a fresh sandbox);
# doing it at build time bakes the provisioned ~/.omo + caches into
# the image so every runtime start is already "hot" and skips it.
RUN cat > /sandbox/.warmup/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "snapshot": false,
  "autoupdate": false,
  "plugin": ["oh-my-openagent@4.15.1"],
  "permission": { "*": "allow" }
}
JSON
# NOTE: mirror the RUNTIME omo config here (esp. disabled_mcps:["lsp"])
# so the warm run does the SAME first-init as a real task — with the
# lsp-daemon MCP disabled. Otherwise the warm run leaves lsp-daemon
# state that differs from runtime and the first real task still pays
# (and hangs on) the cold first-init. Keep in sync with buildOmoConfig
# in plugins/workboard/src/worker/opencode-worker.ts.
RUN cat > /sandbox/.warmup/.opencode/oh-my-opencode.jsonc <<'JSON'
{
  "agents": { "sisyphus": { "model": "warmup/none" } },
  "model_fallback": false,
  "runtime_fallback": false,
  "telemetry": false,
  "disabled_mcps": ["lsp"]
}
JSON
# Run opencode once with the omo config active. It installs the
# plugin deps AND kicks omo's first-init provisioning. No model is
# reachable, so it exits non-zero after provisioning — that's fine,
# we only want the cached deps + provisioned ~/.omo state.
RUN cd /sandbox/.warmup \
    && (OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_CONFIG=./opencode.json \
        timeout 600 opencode run "noop" --format json < /dev/null \
        > /sandbox/.warmup/warm.log 2>&1 || true) \
    && echo "opencode plugin cache warmed:" \
    && du -sh /sandbox/.cache/opencode 2>/dev/null || true \
    && echo "omo provisioned state:" \
    && du -sh /sandbox/.omo 2>/dev/null || true

# Drop the throwaway warmup workdir + config; KEEP the warmed caches
# (~/.cache/opencode) and omo's provisioned state (~/.omo). BUT also
# drop the codegraph LOCK dir the warm run left behind
# (~/.omo/codegraph/locks/codegraph-buildkitsandbox.lock, named after
# the build container): baking a stale lock into the image makes
# omo's codegraph init contend/wait on a lock from a process that no
# longer exists, which intermittently hangs the first task in a fresh
# sandbox. Keep the provisioned codegraph data, drop only the locks.
RUN rm -rf /sandbox/.warmup /sandbox/.config/opencode/opencode.json \
    && rm -rf /sandbox/.omo/codegraph/locks /sandbox/.omo/*/locks \
    && find /sandbox/.omo -name '*.lock' -exec rm -rf {} + 2>/dev/null || true

USER sandbox
ENTRYPOINT ["/bin/bash"]
