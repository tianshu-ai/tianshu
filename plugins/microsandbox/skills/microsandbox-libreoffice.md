---
name: microsandbox-libreoffice
description: How to convert / read / extract Office documents inside the sandbox using the pre-installed LibreOffice (soffice). Covers docx / xlsx / pptx / odt round-trips, PDF rendering, slide-deck text extraction with markitdown, and the sandbox-specific gotchas (AF_UNIX shim, font cache, single-process mode, output paths).
when:
  toolPresent: exec
---

# LibreOffice in the sandbox

The sandbox image ships LibreOffice 25.2 (`writer / calc /
impress`) plus its CLI alias `soffice`. Use it directly — don't
`pip install python-docx` / `openpyxl` / `python-pptx` for tasks
that are basically format conversion. They're worth their weight
when you need cell-level edits or programmatic slide construction;
for "give me the text", "convert to PDF", "extract slide images",
`soffice` is one shell call away.

## Conversion table

```bash
# Office → text
soffice --headless --convert-to txt   input.docx --outdir /tmp/
soffice --headless --convert-to txt   input.xlsx --outdir /tmp/   # cells joined by tabs
soffice --headless --convert-to txt   input.pptx --outdir /tmp/   # slides as paragraphs

# Office → PDF (the workhorse: any → pdf, lossless layout)
soffice --headless --convert-to pdf   input.docx  --outdir /tmp/
soffice --headless --convert-to pdf   input.xlsx  --outdir /tmp/
soffice --headless --convert-to pdf   input.pptx  --outdir /tmp/

# Office round-trips
soffice --headless --convert-to docx  input.odt   --outdir /tmp/
soffice --headless --convert-to xlsx  input.csv   --outdir /tmp/
soffice --headless --convert-to csv   input.xlsx  --outdir /tmp/

# PDF → image (multi-page; use pdftoppm, NOT soffice)
soffice --headless --convert-to pdf   input.pptx  --outdir /tmp/
pdftoppm -jpeg -r 150 /tmp/input.pdf /tmp/slide
# → /tmp/slide-01.jpg, /tmp/slide-02.jpg, ...
```

**`--outdir` is required.** Without it `soffice` writes the
output next to the input, which means a relative input path that
resolves anywhere unexpected (your `cwd` in the sandbox is
`/workspace`, not `/tmp`). Always pass `--outdir`.

## Reading content (text extraction)

For "what does this document say?" — skip the conversion step
and use `markitdown`, which understands docx / xlsx / pptx /
pdf natively and outputs structured Markdown:

```bash
pip install --quiet "markitdown[all]"   # already in image cache; first call ~1s
python -m markitdown report.docx
python -m markitdown deck.pptx          # slide titles + body text + speaker notes
python -m markitdown sheet.xlsx         # tabular Markdown
```

Markitdown is the right pick when you need to **summarise** the
document or pass content to another LLM call. `soffice
--convert-to txt` is the right pick when you need a raw textual
artefact for an export pipeline.

## Multi-page slide / PDF preview

For visual QA of generated decks (the agent decides "did the
bullets I generated actually fit?"), render every page to JPEG
and inspect with the vision model:

```bash
soffice --headless --convert-to pdf deck.pptx --outdir /tmp/
pdftoppm -jpeg -r 150 /tmp/deck.pdf /tmp/slide
ls /tmp/slide-*.jpg
```

`-r 150` is a good visual-QA DPI; bump to 300 for print review,
drop to 96 if you only want a thumbnail grid.

To re-render a single slide after a fix:

```bash
pdftoppm -jpeg -r 150 -f 7 -l 7 /tmp/deck.pdf /tmp/slide-7-fixed
```

## Sandbox-specific gotchas

### Single-instance lock

`soffice` uses an X server profile + an internal lock file under
`~/.config/libreoffice/`. If two `soffice --headless` calls run
concurrently in the same VM, the second one waits for the first.
Two safe options:

- **Sequential calls** (default; just don't background them).
- **Per-call user profile** when you legitimately need parallel:
  ```bash
  soffice --headless \
          -env:UserInstallation=file:///tmp/lo-$$ \
          --convert-to pdf input.docx --outdir /tmp/
  ```
  `$$` is the shell's PID; one fresh profile per invocation. Costs
  ~200 ms of cold start per call.

### AF_UNIX socket shim (probably NOT needed here)

Some sandbox runtimes block `socket(AF_UNIX, ...)`, which makes
`soffice --headless` hang waiting on its internal IPC. Microsandbox
on macOS / Linux **does NOT block AF_UNIX** (verified), so you
don't need a shim. If a future runtime change breaks this, the
diagnostic is:

```bash
python3 -c 'import socket; socket.socket(socket.AF_UNIX); print("OK")'
# OK   → no shim needed
# OSError → AF_UNIX blocked, build an LD_PRELOAD shim that falls
#          back to socketpair (see Anthropic pptx skill for the C source)
```

### Java warning is benign

You'll see `Warning: failed to launch javaldx - java may not
function correctly`. Java is only needed for the optional
spreadsheet macro / form-controls path, which we don't use.
Ignore.

### CJK font rendering

The image build runs `fc-cache -fv` so first-call rendering is
fast and Chinese / Japanese / Korean glyphs render properly.
If a build skips that step, the first `soffice` call eats 30+s
synchronising fonts.

### `--outdir` and absolute paths

`soffice` resolves `--outdir` against the sandbox's `cwd`
(`/workspace` by default). When the agent's `exec` runs from a
project subdirectory, prefer absolute paths in BOTH `--outdir`
and the input filename so the output lands where you expect.

## When LibreOffice is the WRONG tool

- **Cell-level editing / formulas in xlsx**: use `openpyxl` or
  Pandas. `soffice` rewrites the whole file; structural metadata
  (named ranges, conditional formatting) can shift.
- **Programmatic slide creation from scratch**: use `pptxgenjs`
  (Node) or `python-pptx`. `soffice` is for converting an
  existing deck, not authoring one.
- **Markdown / text reports**: don't bounce through Office. Just
  write `.md`.

## Cleanup

`soffice` leaves `~/.config/libreoffice/`, `~/.cache/libreoffice/`,
and any per-call `/tmp/lo-*` profile dirs around. Sandbox `/tmp`
is wiped on `reset_sandbox`; `~` (root) survives. If you're
running thousands of conversions in one session, `rm -rf
~/.cache/libreoffice/` periodically to keep disk usage from
creeping.
