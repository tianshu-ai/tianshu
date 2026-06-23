# Developing from a checkout

If you want to hack on Tianshu itself (not just run it),
work from a git checkout.

## Setup

```bash
git clone https://github.com/tianshu-ai/tianshu.git
cd tianshu

npm install
npm run setup        # same wizard as `tianshu setup`, writes ~/.tianshu/
npm run doctor
npm run dev          # vite (5183) + server (3110) + plugin watchers
```

In dev mode you open <http://localhost:5183>. Vite proxies
`/api` and `/ws` to the server on `:3110`. The dev pipeline
hot-reloads server changes via `tsx watch` and SPA changes
via vite HMR.

The launchd plist installer (`tianshu start` from inside a
checkout) detects the `.git/` directory and installs a *dev-
shape* plist that runs `npm run dev` instead of the
production `npm run serve`. Label is `ai.tianshu.dev`.

## Workspace scripts

```bash
# build everything (type-check + bundle)
npm run build

# all tests
npm test

# server only
npm run dev   -w packages/server
npm run build -w packages/server
npm run test  -w packages/server

# web only
npm run dev   -w packages/web
npm run build -w packages/web
```

## Useful flags

```bash
# Skip the readiness check on startup (useful for empty-shell deploys
# where the wizard hasn't run yet)
TIANSHU_IGNORE_SETUP=1 npm run dev

# Probe each provider's /v1/models endpoint to test reachability
npm run doctor -- --probe-providers

# Boot a real microsandbox VM as a smoke test (~30s)
npm run doctor -- --probe-sandbox
```

## Default ports

| Port  | What                                |
|-------|-------------------------------------|
| 3110  | Server (API; also SPA in prod mode) |
| 5183  | Vite dev server (dev mode only)     |

Both are different from the closed-source predecessor's
`3100 / 5173` so the two projects can run alongside each
other on the same machine. Override via `PORT=` / `WEB_PORT=`
in `.env` if you need to.

## Updating a dev checkout

```bash
git pull
npm install         # in case dependencies changed
```

`tianshu update` refuses to run inside a git checkout — git
pull is the only correct path there.

## Releasing

Releases ship from the `hotfix/0.3.2` branch via
`.github/workflows/hotfix.yml`. The main branch tracks the
same commits via a follow-up PR after each hotfix lands. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the full release
flow.
