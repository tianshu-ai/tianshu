# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────
# Full Debian base: has python3 + build-essential so better-sqlite3
# (native) compiles. We build everything (plugin-sdk, plugins,
# server dist, web dist) here, then copy only what's needed into a
# slim runtime image.
FROM node:22-bookworm AS build

WORKDIR /app

# NOTE: better-sqlite3 v12 ships prebuilt binaries for linux-x64 and
# linux-arm64 (glibc), so a plain `npm ci` normally needs NO compiler.
# If a future dep needs to compile, uncomment the toolchain install:
#   RUN apt-get update && apt-get install -y --no-install-recommends \
#         python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy manifests first for better layer caching. The workspace root
# plus every workspace package.json — npm needs them all to resolve
# the workspace graph during `npm ci`.
COPY package.json package-lock.json ./
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
# Plugin workspaces (plugins/*). Copy the whole tree of manifests;
# a glob per-dir is brittle, so copy all package.json under plugins.
COPY plugins/ plugins_tmp/
RUN mkdir -p plugins \
  && (cd plugins_tmp \
      && find . -name package.json -maxdepth 2 -exec sh -c \
         'mkdir -p ../plugins/$(dirname "$1") && cp "$1" ../plugins/"$1"' _ {} \; ) \
  && rm -rf plugins_tmp

# Install all deps (incl. dev — we need tsc/vite to build).
RUN npm ci

# Now bring in the full source and build.
COPY . .
RUN npm run build

# Prune dev dependencies for the runtime copy. `npm prune --omit=dev`
# leaves better-sqlite3's compiled binary in place.
RUN npm prune --omit=dev


# ── Runtime stage ────────────────────────────────────────────────
# Slim base, same Debian release (bookworm) so the better-sqlite3
# binary built above is ABI-compatible.
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3110 \
    TIANSHU_HOME=/data \
    TIANSHU_IGNORE_SETUP=1 \
    NODE_OPTIONS=--no-warnings

# Copy the built app + pruned node_modules from the build stage.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/bin ./bin
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY --from=build /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/builtinConfig ./packages/server/builtinConfig
COPY --from=build /app/packages/web/dist ./packages/web/dist
# Built-in plugins (server + client bundles) that the server loads.
COPY --from=build /app/plugins ./plugins

# Data dir (tenants, sqlite dbs, workspaces) lives on a volume.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3110

# Lightweight healthcheck against the API the server serves.
HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3110)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "serve"]
