# Contributing to Tianshu

Thanks for your interest! Tianshu is early-stage and contributions of all
sizes — typo fixes, bug reports, features, docs — are very welcome.

## Quick Links

- **Bugs / feature requests:** [GitHub Issues](https://github.com/tianshu-ai/tianshu/issues)
- **Security issues:** see [SECURITY.md](./SECURITY.md) — please **don't** file
  security bugs in public issues
- **Discussions / questions:** [GitHub Discussions](https://github.com/tianshu-ai/tianshu/discussions)

## Development Setup

### Prerequisites

- Node.js **22+** (we test against the version in CI)
- npm 10+
- (optional) Docker, if you want to run the production build locally

### Get the code running

```bash
git clone https://github.com/tianshu-ai/tianshu.git
cd tianshu

cp .env.example .env
npm install
npm run dev
```

This starts:

- **Server** at `http://localhost:3100` (Express + WebSocket, hot-reload via `tsx watch`)
- **Web** at `http://localhost:5173` (Vite dev server, HMR)

The web app proxies `/api` and `/ws` to the server, so just open
http://localhost:5173 and start chatting.

### Useful single-package commands

```bash
# Server only
npm run dev   -w packages/server
npm run build -w packages/server

# Web only
npm run dev   -w packages/web
npm run build -w packages/web

# Type-check the whole monorepo
npm run build

# Run tests (server)
npm test
```

### Tests

Server tests live next to the code as `*.test.ts` and are run with
[Vitest](https://vitest.dev). Adding tests for new pure helpers or DB
migrations is encouraged. Tests must NOT require a network connection or
running sidecar containers — use temp dirs and mocks.

## Project Layout

```
tianshu/
├── packages/
│   ├── server/   # Express + WebSocket backend, agent runtime
│   └── web/      # React + Tailwind + Vite frontend
└── docs/         # Architecture notes, RFCs, dev log
```

Most contributions touch one package at a time. The server owns business
logic + persistence; the web package is presentation only.

## Code Style

- **TypeScript strict** — no `any` unless there's a real reason; comment when there is
- **No semicolons-only style debates** — match what's around you
- **Comments matter** — explain *why* a non-obvious decision was made, not what
  the code does. Long inline comments are encouraged when they capture the
  reasoning future contributors will need
- **No unused imports / vars** — tsc will yell, please listen
- **Don't reach across packages** — server and web don't import each other;
  shared types are duplicated for now (a `packages/shared` may come later)

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/). Common types:

- `feat:` new feature
- `fix:` bug fix
- `chore:` build/tooling/maintenance, no behaviour change
- `docs:` docs-only changes
- `refactor:` code change that neither fixes a bug nor adds a feature
- `test:` add or correct tests

Optional scope in parens: `feat(taskboard): show task elapsed time`.

Body is optional but encouraged for non-trivial changes — explain the *why*.

## Pull Requests

1. **Open an issue first** for substantial changes so we can discuss design
   before you spend hours on it
2. Fork, branch off `main`, work on your branch
3. Keep PRs focused — one logical change per PR
4. **Test your change** locally (`npm run dev`) before requesting review
5. Make sure `npm run build` passes (CI will check)
6. Reference the issue: "Fixes #123" / "Refs #123"
7. Be patient — reviews may take a few days; ping if it's been a week

## Reporting Bugs

A good bug report contains:

- What you did (commands, browser actions)
- What you expected
- What actually happened
- OS / Node version / browser
- Server logs and browser console output
- A minimal repro if possible

For security bugs, see [SECURITY.md](./SECURITY.md).

## Suggesting Features

Feature ideas are welcome — open an issue with the `enhancement` label and
describe:

- The problem you're trying to solve (not just the solution)
- Who benefits / when this matters
- Any prior art (other projects that handle this well)

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE) that covers this project.
