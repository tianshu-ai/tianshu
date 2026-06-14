---
name: worker-fleet
description: How to design a multi-worker fleet for a non-trivial user request. Read this when the user asks for something that has natural separation of concerns (research → write, design → build → test, scrape → analyse → report) and a single worker would either lose context or do all roles badly. Covers role decomposition, SOUL.md authoring per role, task DAG design, and failure handling.
scope: main
---

# Designing a worker fleet

When the user gives you a non-trivial goal, your default is to be
boring: drop one task, let `llm-default` handle it. That works for
small, single-axis requests.

This skill is for when it doesn't. Three signals say "fleet":

1. **Multiple distinct roles.** "Design then build then test" is
   three roles; bundling them into one prompt makes the agent
   skim the spec because it's also writing code in the same turn.
2. **Quality matters across boundaries.** A coder who also writes
   docs writes mediocre docs; a writer who also picks the model
   architecture picks the wrong one. Boundaries enforce focus.
3. **Sequential dependency you can name.** If you can draw an
   arrow ("the next agent reads what the previous one wrote"),
   the arrow exists in the worker_agents pool too — make it
   explicit via task `depends_on` instead of hand-holding.

If none of those apply, **don't build a fleet** — overhead
without payoff.

## Reuse over create (read this twice)

Before creating any new worker, run:

```
tenant_config_list({ path: "workers" })
```

For every role you think you need, ask in this order:

1. **Does an existing worker fit?** Match by responsibility, not
   by name. The `coder` worker is a generalist code writer —
   reuse it instead of inventing `frontend-dev` / `backend-dev`
   / `python-coder` siblings. The `llm-default` worker is a
   generalist for everything that doesn't need a sharper SOUL.
2. **Can the existing worker do this with a clearer task
   description?** Most "bad" outputs are bad task descriptions,
   not wrong workers. Tighten the description first.
3. **Can a small SOUL.md edit on the existing worker absorb the
   new role?** If the new role is a 20% twist on an existing
   one, edit `tenant_config_write workers/<slug>/SOUL.md`
   instead of forking.
4. **Only when 1–3 fail or the user explicitly asked for a new
   worker** — build the new one.

Proliferating workers is the most common over-engineering trap.
Three consequences if you do it anyway:

- Each new SOUL is one more thing to maintain when behaviour
  drifts.
- The user sees more rows in the Worker agents page than they
  needed; the cognitive load is on them, not you.
- Identity collisions get more likely (a `writer` and a
  `content-writer` confuse both the user and future you).

Ack the reuse decision out loud to the user when you make it:
"I'll use the existing `coder` worker for the build step — it
fits." That gives them a chance to override ("actually I want
a separate `coder-typescript` for this project") before you
commit.

## When NOT to fleet (just as important)

- One-shot Q&A, retrieval, or chat-as-thinking — main agent.
- Anything ≤ 5 minutes single-worker — overhead > payoff.
- Tasks where the "different roles" are actually the same person
  doing different *steps* (e.g. "first research, then write the
  same report"). Use one worker with a clearer SOUL instead.
- Throwaway / prototype work the user will rewrite anyway.

## Sizing

- **2 workers** is the common case. (designer + builder), (writer
  + editor), (researcher + summariser).
- **3 workers** when you want a third pair of eyes — typically a
  QA / reviewer / critic at the end. Most "design → build → test"
  flows want 3.
- **4+ workers** is rare. Don't introduce a worker just because a
  *file type* is different (one md writer, one py writer); split
  on *responsibility*, not output format.

If you're tempted to use 5+, you're probably modelling a function
call graph as a fleet — collapse the small ones into a single
worker that runs them sequentially.

## Designing each role

For every worker you propose:

1. **Name the responsibility in one sentence.** "Designs the
   API spec, writes no code." If the sentence has an "and"
   that's not just fluff, split into two roles.
2. **List inputs and outputs explicitly.** What files does the
   worker read? What files does it produce? Path conventions
   below.
3. **Anti-list the role.** What is the worker NOT supposed to
   do? "Don't read source files", "don't run tests", "don't
   add features the spec doesn't mention". This goes in SOUL.md.
4. **Pick a kind + model.** `kind: "llm"` for everything LLM-
   shaped (the `kind` field is a runtime, not a label — see
   worker-creator). Model defaults to host default; only set
   `modelId` if the role genuinely needs Sonnet / Opus / etc.
5. **Decide allow-lists.** Default = omit toolsAllow /
   skillsAllow. Only narrow when the role *should* be sandboxed
   (e.g. a "summariser" worker that should only read, never
   write).

## SOUL.md template

Open with the role identity, then state the boundaries the
*role* needs (the global SOUL set by the Default LLM is gone
when this worker runs, so cover the basics yourself):

```
You are <role>, a workboard worker focused on <one-sentence
responsibility>.

## Your job

- <2-4 bullet points on what you DO>

## Your boundaries

- <2-4 bullet points on what you DO NOT do>
- <Mention sibling workers' roles so it doesn't try to do their job>

## Inputs / outputs

- Read: <explicit paths or "the description tells you">
- Produce: <explicit paths under ./projects/<slug>/>

## Exit contract

Call task_complete with a one-line summary of what you produced
and a `files` array listing every file you wrote. The orchestrator
only sees this summary — narrative replies don't reach it.
```

Keep it under 40 lines. Workers don't need a manifesto, they need
a contract.

## Path conventions

Pick a single project slug for the whole fleet's outputs and put
everything under `./projects/<slug>/`:

```
./projects/<slug>/
├── spec.md            <- architect's output
├── server.js          <- coder's output
├── server.test.js
├── README.md
├── qa-report.md       <- qa's output
└── (anything else workers produce)
```

Every task description tells its worker:
- exactly which sibling-produced files to read (full path), and
- exactly which files to produce (full path).

This is what makes the fleet composable: workers don't need to
know each other exists, only the file contract.

## Task DAG

One task per worker, normally. Use `depends_on` to express the
arrow:

```
T1 (architect)       — no deps, picked up immediately
T2 (coder)           — depends_on: [T1.id]
T3 (qa)              — depends_on: [T2.id]
```

Pool semantics:
- `task_create` returns the new task's `id`. Capture it before
  creating the dependent task.
- A blocked task stays in `ready` with a lock chip; the pool
  skips it until every dep reaches `done`.
- Same-priority tasks claimed in created-order; bump `priority`
  on the latest task only when you really need it ahead.

For *parallel* fan-out (e.g. one researcher feeds three
writers), you write three siblings all `depends_on: [T1.id]`.
Don't try to fan-in — workers can't talk to each other; if the
output needs aggregation, that's a fourth worker reading the
three siblings' outputs.

## Task description checklist

A good task description always has:

1. **Goal in one sentence** — what file(s) the worker writes.
2. **What to read** — full paths, named, `tenant_config_read`-
   able. Describe what's in those files briefly so the worker
   knows what to look for.
3. **What to produce** — full paths, format constraints (e.g.
   "JSON", "markdown with front-matter").
4. **Quality gate** — measurable criteria. Tests pass? At least
   N test cases? Output validates against schema? Lints clean?
   Whatever the role's "self-verify" looks like.
5. **Boundaries restated** — "don't add features the spec
   doesn't mention", "don't read source files".

If the description fits in two sentences, the task is too small
or too vague — either inline it (don't fleet at all) or split
it into more concrete subtasks.

## When the task ingests / produces a lot

If a task asks the worker to read ≥ 2 non-trivial files **and**
produce a single large output (long HTML / md / generated
code), you've crossed the threshold where naive prompting
breaks: the worker batches all the reads into one turn, the
tool results dominate the prompt, and the next call returns
empty (`no_completion`).

Two levers from the orchestrator side:

1. **Tell the worker to read this skill in the task description**:
   "Read the `large-input-large-output` skill before starting;
   apply pattern 1 (read-then-summarise) and pattern 2 (skeleton
   then fill)." Workers won't reach for that skill unless the
   description prompts them — the skill is `scope: worker` so
   they see it in `<available_skills>`, but they have to choose
   to read it.
2. **Or split the task**: one task per source file producing a
   summary, plus one final assembly task reading only the
   summaries. This is the bigger hammer; use it when the input
   set is large enough (≥ 4 files, or any individual file > 30
   KB) that even pattern 1 would push the worker close to its
   context window.

This isn't about being defensive — it's about matching the
task shape to the underlying token economics.

## Worked example: "Build me a URL shortener"

User says: *Build me a URL shortener service prototype.* You,
main agent, hear "design + build + test, single output dir,
classic 3-role flow":

**Step 1.** Read this skill (already done — you're here).

**Step 2.** Read worker-creator skill (the *how* of writing
agent.json + SOUL.md).

**Step 3.** Check what already exists — reuse over create:
```
tenant_config_list({ path: "workers" })
```
For each role, walk the reuse-over-create checklist above. The
fleet you want: `architect`, `coder`, `qa`. Suppose the tenant
has `coder` / `llm-default` / `echo-demo`:

- **architect** — no existing worker is a good fit (we want
  one that explicitly *doesn't* code), build it.
- **coder** — already there. Reuse, don't fork into
  `coder-typescript` or similar.
- **qa** — no existing fit (we want one that doesn't read
  source), build it.

Net: 2 new workers, 1 reused. Tell the user before writing:
"I'll reuse the existing `coder` worker for the build step,
and create `architect` + `qa` for design and testing. OK?"
This gives them a chance to override (e.g. "please make a
dedicated `coder-ts` for this project") before you commit.

**Step 4.** Create architect:
```
tenant_config_write({ path: "workers/architect/agent.json", ... })
tenant_config_write({ path: "workers/architect/SOUL.md", ... })
```
SOUL says: designs the API spec, writes no code, output is
`./projects/url-shortener/spec.md`, listing endpoints + data
model + error contract.

**Step 5.** Create qa:
```
tenant_config_write({ path: "workers/qa/agent.json", ... })
tenant_config_write({ path: "workers/qa/SOUL.md", ... })
```
SOUL says: black-box tests via curl/bash, doesn't read source
files, produces qa-report.md with PASS/FAIL per test.

**Step 6.** Drop tasks (capture each id from the response):
```
T1 = task_create(worker_agent_id="architect", title="Design
  URL shortener API spec", description="<describes inputs +
  required spec.md sections + 'don't write code' boundary>")

T2 = task_create(worker_agent_id="coder", depends_on=[T1.id],
  title="Implement URL shortener per spec", description="<read
  spec.md, output server.js + server.test.js + package.json +
  README.md, must npm test pass before task_complete>")

T3 = task_create(worker_agent_id="qa", depends_on=[T2.id],
  title="Black-box test the URL shortener", description="<read
  README, start server, curl-test 6+ scenarios, qa-report.md
  with PASS/FAIL each, summary at end>")
```

**Step 7.** Tell the user the three task ids and that the board
will animate them in dependency order. Pool picks them up
automatically; you don't poll.

**Step 8.** When the user comes back:
```
task_list()
```
Surface the deliverables (workboard expanded cards already
render delivery-file chips clicking through to the file open
dialog — point the user there rather than dumping content
inline).

## Failure handling

- **A worker calls task_complete with `summary` describing
  failure**: read its session transcript via `task_get_history`
  to understand why; either patch the description and re-run
  (`task_move` to ready), or take it over yourself.
- **A task is `stalled` (label set after MAX_ATTEMPTS retries)**:
  same diagnosis path, but you usually need to fix the worker's
  SOUL.md or rebalance the fleet.
- **Cascade — a downstream task fails because its upstream
  delivered the wrong thing**: don't blame the downstream
  worker. Re-run the upstream with a tighter description.

When in doubt, ask the user — fleet design is a judgement call,
and the user has context the description doesn't carry.

## See also

- `worker-creator` — the file format for agent.json / SOUL.md
  / per-worker skills.
- `workboard-howto` — board mechanics, task tools, delivery
  files.
- `skill-creator` — if you want to ship a worker its own skill
  bundle as part of the fleet.
