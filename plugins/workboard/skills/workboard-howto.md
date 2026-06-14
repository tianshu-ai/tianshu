---
name: workboard-howto
description: How to use the workboard plugin — drop tasks on the kanban, watch the worker pool process them, and patch / move / delete rows. The board is per-user inside a tenant.
---

# Using the workboard

The workboard plugin gives you a per-user kanban with five visible
columns and a worker pool that automatically picks up `todo` tasks.
This skill is the contract between you (the agent) and the user's
view of the board.

## When to use

- The user asks you to "remember to do X later" → drop a task.
- A multi-step request can be split into independent units of work
  → file each unit as a task so the user can track progress.
- You want to hand off a long-running step to a worker → pin
  the task with `worker_agent_id` (the slug of the worker; see
  `tenant_config_list({path:"workers"})` for what's registered).
  Pinning by slug is the recommended path — dispatch by kind is
  not exposed.

If the user is asking a one-shot question, do NOT create a task.
Tasks are for work that survives across turns.

## Tools at a glance

| Tool          | Use when …                                                    |
| ------------- | ------------------------------------------------------------- |
| `task_list`   | Reading the board (always do this first to avoid duplicates). |
| `task_create` | Adding a new ready task. Default project is `inbox`.          |
| `task_update` | Changing title / description / priority / project.            |
| `task_move`   | Walking a task between columns (`todo`→`in_progress`→`done`). |
| `task_delete` | Removing a task you created by mistake.                       |

## Status lifecycle

```
ready  →  in_progress  →  done
                   ↘     ↗
                    awaiting-intervention   (label, not status)
                          ↘
                           main agent picks task_continue /
                           task_retry_fresh / task_extend_timeout /
                           task_abort
```

- `ready` tasks are claimable by workers. Don't sit on them.
- `in_progress` is set automatically when a worker claims.
- `done` is the happy path: worker called `task_complete`, OR
  you called `task_abort` on a stuck task (with a reason).
- A failure / watchdog timeout adds the `awaiting-intervention`
  label to a `ready` row and drops a `task_intervention_required`
  notification on you. Pick one of the four intervention tools —
  do NOT just `task_move(status="ready")`, that would skip the
  reason-tracking and re-queue without context.
- The legacy `stalled` label is treated identically by the pool's
  skip filter; old rows still work.

## Project slugs

Tasks group under a free-form `project` slug (default `inbox`).
Use this when the user has multiple parallel threads — e.g.
`website-redesign`, `q3-research`. Re-use existing slugs; don't
fragment with typos. Call `task_list` with no filter first to see
what already exists.

## Worker roles

Every worker pool runs at least one `echo` worker — a 30-second
sleep that writes a short result_summary. This exists so the loop
is visible end-to-end.

Real worker roles ship with later PRs (per ADR-0002 §1):

Worker registry is per-tenant and lives at
`_tenant/config/workers/<slug>/`. The two seeded entries on a
fresh tenant are `echo-demo` (a no-op demo) and `llm-default`
(a generic LLM worker). The user typically authors more workers
via the chat agent + `tenant_config_write` (see the
`worker-creator` skill for the contract).

Set `worker_agent_id` on a task to pin it to one specific
worker. Leave it empty to let any enabled worker pick it up
(rarely what you want — prefer pinning so behaviour is
predictable). Use `tenant_config_list({path:"workers"})` to
discover available slugs.

## Common patterns

> **task_create / task_delete are batch tools.** Always wrap items in
> the `tasks` / `ids` array — even for a single row. Per-row
> failures don't abort the rest of the batch; check the
> `results[]` field in the response.

**Drop a task and forget it (delegated work):**

```
task_create({
  tasks: [
    {
      title: "Convert the Q2 sales CSV to a one-page chart",
      description: "Source: /uploads/q2-sales.csv. Output: /reports/q2.png",
      worker_agent_id: "coder"
    }
  ]
})
```

**Track your own progress (delegate to the demo worker):**

```
task_create({
  tasks: [
    {
      title: "Reach out to 5 candidate contributors",
      worker_agent_id: "echo-demo"   // demo: marks done after a delay
    }
  ]
})
// later, after you do the work:
task_move({ id: "<id>", status: "done", result_summary: "Sent 5 DMs" })
```

**Bulk-create a roadmap, then drop them all:**

```
task_create({
  tasks: [
    { title: "Stage 1: write spec",  worker_agent_id: "llm-default" },
    { title: "Stage 2: implement",   worker_agent_id: "coder"       },
    { title: "Stage 3: test",        worker_agent_id: "coder"       },
  ]
})
// later:
task_delete({ ids: ["<id1>", "<id2>", "<id3>"] })
```

**Revive an awaiting-intervention task:**

```
// resume the same session, optional hint:
task_continue({ task_id: "<id>", hint: "use skeleton-then-fill" })

// or start a brand new session, optional revised brief:
task_retry_fresh({ task_id: "<id>", description: "..." })

// or just give it more time (especially when failure_reason
// starts with "watchdog timeout"):
task_extend_timeout({ task_id: "<id>", additional_ms: 600_000 })

// or give up:
task_abort({ task_id: "<id>", reason: "data missing" })
```

## Don'ts

- Don't poll `task_list` in a tight loop. The worker pool drains
  immediately on writes; the user sees updates within a few
  seconds via the kanban panel.
- Don't create tasks for one-turn questions. The user will see
  them pile up.
- Don't hand-edit `result_summary` on a worker-completed task —
  it's the worker's report. Use `task_update.description` for
  your own notes.
