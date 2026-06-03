# Tianshu Development Log

This is the source-of-truth dev log. We post a polished version of each
entry to dev.to / YouTube / Bilibili / X. The raw bullets live here.

Format: ISO-week or date heading, short status, links to PRs.

---

## 2026-W23 — Day 0 (2026-06-03)

### Done
- Created the public org repo `tianshu-ai/tianshu` (Apache-2.0).
- Day-0 scaffolding pushed: monorepo with `packages/server`
  (Express + WebSocket placeholder) and `packages/web` (React + Vite +
  Tailwind, hits `/api/health`).
- Community files: README (en/zh), CONTRIBUTING, CODE_OF_CONDUCT,
  SECURITY, NOTICE, ISSUE_TEMPLATE, PR template, dependabot, labels,
  release-please, CI.

### Next
- Wire `pi-agent-core` into the server.
- Add `tenantId` to the data model from row 1.
- Sketch the WebSocket protocol (subscribe / prompt / tool_start / …).

