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

## Pattern 2 — Long output: write iteratively, not in one shot

When the deliverable is big (long HTML, multi-section markdown,
a 1500-line generated file), the failure mode you want to avoid
is **emitting the whole thing in one tool call.** Two reasons:

- The provider's tool_use input stream truncates large strings,
  so a `write_file` carrying thousands of lines of `content`
  often fails with `content` missing entirely.
- Even if the call lands, the next agent / human reading the
  task has nothing to follow until the giant blob arrives. A
  partial run leaves nothing on disk.

Do this instead:

1. Decide the structure of the output up front (TOC, section
   list, what each section contains). Write that as a short
   plan in the task description — you'll reference it as you go.
2. Write the file in pieces. The shape that works depends on
   the deliverable:
   - **Markdown / prose / HTML report:** use `write_file` for
     the first chunk (front matter / TOC / first section), then
     `read_file` and `edit_file` to append each subsequent
     section. Each `edit_file` call can target the end-of-file
     marker (e.g. "</body>") and replace it with `new_section +
     marker`.
   - **Generated code:** `write_file` the file once with the
     real content; if the result is so big the call is
     truncating, the file is too big for one LLM run regardless
     of tool shape — split the deliverable into separate files
     (one module per file is the right shape anyway).
3. After each chunk: keep the chunk size small enough that the
   tool_use args don't get truncated. There's no fixed line
   count — watch for the truncation hint in the tool result.

This pattern's side benefits:

- The output file exists after the first call, so a partial
  run still leaves something on disk.
- The agent can `read_file` what it just wrote when composing
  later sections, keeping coherence without re-loading sources.

What *not* to do:

- Do not write a "skeleton" full of `<!-- TODO: section X -->`
  placeholders and then try to fill them all in one
  `edit_file({edits: [...]})` batch. The combined batch JSON
  ends up larger than the original write would have been and
  trips the same truncation it was meant to avoid. (This
  recipe used to be in this skill; it didn't work.)

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
  the whole thing lands. Write the file in chunks (Pattern 2).
- **One `edit_file` call per tiny edit** when you're making
  several adjacent changes — the `edits[]` batch is atomic
  and saves round-trips. (This is the right reason to use
  `edits[]`; it's not a workaround for tool-arg truncation.)

## When you're stuck mid-task

If you find yourself in the failure mode this skill describes —
you've loaded too much, the next call is failing, you're not
sure how to proceed:

1. Stop trying to emit the deliverable.
2. Write `/tmp/<task-slug>/state.md` capturing what you've done
   so far and what's left.
3. **Then** call `task_complete` with summary
   `"partial: section 1/4 written. See state.md for remaining
   work."` — including the fact that it's partial in the
   summary.
4. The orchestrator can read state.md and either continue this
   task or split the rest into a follow-up task. That's
   recoverable; a `no_completion` stall is not.

## See also

- `workboard-howto` — task lifecycle, task_complete contract,
  how the orchestrator reads your output.
- `microsandbox-exec-howto` — for tasks that compile / run code
  rather than read / write large text.
