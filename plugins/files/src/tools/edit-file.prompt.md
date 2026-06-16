Apply one or more exact-text replacements inside an existing file.

Pass `edits: [{old_text, new_text}, ...]` for a batch — the file
is read once, edits run in order in memory, and the result is
written atomically only if every edit succeeds (so a partial
batch never lands on disk). Each `old_text` must appear exactly
once at the moment its edit runs, otherwise the whole batch
fails and reports which edit tripped.

Use `write_file` for new files or full rewrites; reach for
`edit_file` when you're patching specific regions.

## Usage

- **You must call `read_file` on the target path first.**
  `edit_file` will refuse with a specific error if the path was
  never read in this session — exact text matching only works
  when you've actually seen the bytes you're matching against.
- Keep `old_text` as small as possible while still being unique
  in the file. Don't pad with large unchanged regions to
  "connect" two distant changes; emit two separate edits in the
  same batch instead.
- The only edit kind is exact-text replace. Insertions /
  deletions / appends are expressed as a replace where `new_text`
  includes the surrounding anchor (e.g. delete = `{old_text:
  "X", new_text: ""}`; insert-before-X = `{old_text: "X",
  new_text: "new\nX"}`).
- Line endings (CRLF vs LF) and BOM are preserved automatically.
  Match by content; you don't need to know which the file uses.
- Whitespace and indentation are tolerated: trailing-whitespace
  drift, run-of-spaces collapse, and whole-block indent shift
  are matched fuzzily. You still need to send the right text
  in the right order; just stop polishing whitespace by hand.
- For renaming a symbol that occurs many times, set
  `replace_all: true` on that edit instead of writing one edit
  per occurrence.
