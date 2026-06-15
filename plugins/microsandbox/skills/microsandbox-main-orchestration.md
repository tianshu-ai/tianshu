---
name: microsandbox-main-orchestration
description: How the main (orchestrator) agent should describe sandbox-bound tasks to its workers. Read before writing a `task_create` description that will run shell commands, browser scripts, or file conversions in the sandbox — it covers what the worker already has so you don't ask it to install duplicates.
scope: main
---

# Sandbox capabilities the worker already has

When you write a `task_create` description that the worker will
execute via `exec`, `browser_*`, or any sandbox-bound tool, **do
not tell the worker to install software the sandbox image already
ships**. Workers see this list themselves (via
`microsandbox-exec-howto`), but a task description that says "if
this fails, install X" overrides their own skill and burns time
on installs that don't survive a reset.

The default sandbox image carries:

| Tool | Already there | Don't ask worker to install |
|---|---|---|
| Chromium + Playwright MCP | CDP `127.0.0.1:9222`, MCP `:3200`, noVNC `:6080` | `playwright install chromium`, `npx playwright install` |
| LibreOffice 25.2 | `soffice --headless --convert-to ...` | `apt install libreoffice*` (already there) |
| Node 22 LTS + npm + npx | npmmirror configured | `nvm install`, manual node tarballs |
| Python 3.12 + pip | tuna PyPI mirror configured | reinstalling python |
| `pdftoppm`, `fc-cache`, `jq`, `git` | one-shot build done | duplicates of these |

For one-off Python packages the worker can `pip install` them at
runtime — that's fine. The trap is **reinstalling the runtime
itself or a multi-hundred-MB binary** (chromium, JDK, LibreOffice
fonts) only to throw it away on the next `reset_sandbox`.

## How to phrase the task

Bad (worker burns 3 minutes on a redundant install):

> Convert `/workspace/users/dev/projects/foo/report.docx` to PDF.
> If `soffice` isn't available, install LibreOffice with apt.

Good (worker just runs the conversion):

> Convert `/workspace/users/dev/projects/foo/report.docx` to PDF
> using `soffice --headless --convert-to pdf <input> --outdir
> /workspace/users/dev/projects/foo/`. The sandbox already has
> LibreOffice; don't reinstall.

Bad (worker tries Path A, then dutifully follows your fallback):

> Render the deck. Path A: use `browser_navigate` to open the
> page. Path B: if A doesn't work, `pip install playwright &&
> playwright install chromium` and use page.pdf().

Good (no second path, points at the existing browser):

> Render the deck. Use `browser_navigate(<file URL>)` then
> `browser_screenshot()`. The sandbox's own chromium handles
> this — don't install another browser. If the in-sandbox
> chromium is unhealthy (verify with `browser_health_check`),
> escalate via `task_intervention_required` instead of
> reinstalling.

## When the worker should install something

Most agent tasks don't need new packages. A few legit cases:

- A small Python package with no native deps (markitdown,
  beautifulsoup4, requests). `pip install` adds ~1s and lands
  in `/usr/local/lib/python3.12/site-packages/` which is part
  of the rootfs delta — survives until reset.
- A short-lived utility for a one-shot task (`pip install
  pdfplumber` to extract a specific PDF's tables).

For anything bigger (chromium, ffmpeg, JDK, LibreOffice, CUDA
toolkit), don't `apt install` ad-hoc. Edit the Sandboxfile, run
a build, switch the tenant onto it. That's the path
`microsandbox-build-use` documents.
