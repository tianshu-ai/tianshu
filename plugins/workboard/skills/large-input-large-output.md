---
name: large-input-large-output
description: How to handle tasks that read many large files OR produce a large structured output (long HTML, long markdown report, long codegen). Read this when a task description asks you to ingest more than two non-trivial files at once, or to write more than ~500 lines in one shot, or both. Covers the read-then-summarise pattern, skeleton-then-fill pattern, and the spill-to-file escape hatch.
scope: worker
---

# Reading lots, writing lots

The default failure mode for a task like *"read these 5 markdown
notes and produce one HTML report"* is:

1. You issue 5 parallel `read_file` calls in one assistant turn.
2. Five tool results, each tens of KB, all land in the next
   prompt as raw text.
3. You try to emit the whole HTML in one tool call.
4. The LLM call truncates / returns empty / the run aborts as
   `no_completion`.

The orchestrator can't see this from outside — to it the task
just stalled. From the inside the cause is obvious: you carried
too much state in the prompt and asked for too much output in
one shot.

This skill is the recipe for not doing that.

## When this applies

Read this skill at the top of any task description that:

- names ≥ 2 source files you have to read in detail, OR
- asks for an output > ~500 lines (long HTML / long md / long
  code), OR
- bundles "read material A, B, C, ... and synthesise into D"
  (the canonical multi-input synthesis shape).

If the task is a small one-off ("read README.md, summarise",
"write a 50-line script"), this skill is overkill. Skip it.

## Pattern 1 — Read-then-summarise per file

Cardinal rule: **what you keep in the prompt should be what you
need for the next step, not what you originally read.**

Sequence:

1. Read file 1.
2. **Immediately** write a structured summary to disk:
   ```
   write_file({
     path: "/tmp/<task-slug>/summary-01.md",
     content: "<2-3 paragraphs covering the bits that matter
       for the final output: claims, citations, headings,
       any quote you'll want verbatim>"
   })
   ```
3. Repeat for file 2, file 3, ... — **one file per turn**, not
   five files in one batched read.
4. When you start composing the output, read the **summary**
   files, not the originals. The summaries fit comfortably; the
   originals don't.
5. If you discover the summary is missing a fact mid-composition,
   targeted re-read the original (`read_file` with `offset` and
   `limit`) — don't load the whole thing again.

Why per-turn matters: tool results from a single turn all stay
in the next prompt. Five 30 KB files in one turn = 150 KB you
never wanted to keep. One file per turn lets auto-compact (which
fires after each turn_end) trim earlier turns away once you've
written the summary file.

## Pattern 2 — Skeleton then fill (large output)

Cardinal rule: **never emit more than ~500 lines in a single
tool call**.

Sequence:

1. Decide the structure of the output up front. Write it down:
   ```
   write_file({
     path: "<final-output-path>",
     content: "<skeleton — title / TOC / section headings /\n
       <!-- TODO: fill section X --> placeholders / closing tags>"
   })
   ```
   The skeleton is small (50-150 lines). It pins down structure
   so subsequent edits are local.
2. Fill the placeholders. `edit_file` accepts a batch of edits
   in one call — prefer that over one tool call per section
   when the new_texts are short enough that the combined call
   isn't itself a giant token blob:
   ```
   edit_file({
     path: "<final-output-path>",
     edits: [
       { old_text: "<!-- TODO: section A -->", new_text: "<...>" },
       { old_text: "<!-- TODO: section B -->", new_text: "<...>" },
       ...
     ]
   })
   ```
   The batch is atomic: either every edit applies or the file is
   left untouched and the result tells you which edit tripped.
3. If a section's content is itself big (~400+ lines of HTML /
   prose), split it across two skeletons-within-the-skeleton
   first, then fill each in its own batch. Don't try to dump
   one massive section in one edit.

This pattern has three side benefits:

- The output file exists from step 1, so a partial run still
  leaves something on disk.
- Atomic batches mean a typo in edit #5 doesn't leave edits 1-4
  half-applied; you fix the typo and resubmit.
- The agent can `read_file` what it just wrote when composing
  later sections, keeping coherence without re-loading sources.

## Pattern 3 — Spill to file (escape hatch)

If you absolutely must work with the raw text of a large source
mid-composition (e.g. exact quote attribution), **don't paste
the whole file into your reasoning**. Instead:

1. Read the file once, write its content to
   `/tmp/<task-slug>/source-<n>.md` (you can also just leave it
   at its original path).
2. Use `read_file` with `offset` + `limit` to pull the exact
   slice you need.
3. Throw the slice into your output and move on. Don't keep the
   full file's content in your reasoning across turns.

`tenant_config_read` (for skills / config) and `read_file` (for
workspace) both support `offset` + `limit`. Use them.

## Anti-patterns — don't do these

- **Five `read_file` calls in one assistant turn.** This is
  the most common offender. Even if every file is "small", the
  combined tool result will dominate the next prompt.
- **Asking the LLM to "now generate the whole HTML"** after
  loading five sources. Either you trim sources first (pattern
  1) or you write iteratively (pattern 2) or both.
- **Re-reading a file you've already summarised.** If you wrote
  a summary, trust it. If you don't, write a better summary next
  time.
- **Treating `task_complete` as the moment the deliverable is
  produced.** It's the moment you announce the deliverable is
  done. The file should already exist on disk before you call
  task_complete.
- **One giant `write_file` for a 2000-line HTML report.** Even
  if the model can produce it without truncating, the next
  agent / human reading the work has nothing to follow until
  the whole thing lands. Skeleton + edits is friendlier.
- **One `edit_file` call per section** when you have many
  small sections. The `edits` array supports a batch — use it
  to cut tool-call round-trips.

## When you're stuck mid-task

If you find yourself in the failure mode this skill describes —
you've loaded too much, the next call is failing, you're not
sure how to proceed:

1. Stop trying to emit the deliverable.
2. Write `/tmp/<task-slug>/state.md` capturing what you've done
   so far and what's left.
3. **Then** call `task_complete` with summary
   `"partial: skeleton + section 1/4 written. See state.md for
   remaining work."` — including the fact that it's partial in
   the summary.
4. The orchestrator can read state.md and either continue this
   task or split the rest into a follow-up task. That's
   recoverable; a `no_completion` stall is not.

## See also

- `workboard-howto` — task lifecycle, task_complete contract,
  how the orchestrator reads your output.
- `microsandbox-exec-howto` — for tasks that compile / run code
  rather than read / write large text.
