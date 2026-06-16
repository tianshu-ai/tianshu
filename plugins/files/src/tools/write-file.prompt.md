Create or overwrite a file in the workspace. Parent directories
are created if missing.

## Guidelines

- Use `write_file` ONLY for new files or complete rewrites of
  small files. For changes to an existing file prefer
  `edit_file` (its `edits[]` accepts multiple disjoint
  replacements in one call).
- **If the target file already exists, you must call `read_file`
  on it first.** `write_file` will refuse to overwrite an
  unseen file with a specific error — overwriting blind is how
  you destroy work the user will be sad about.
- For long output (HTML reports, multi-section markdown, etc.),
  write a small skeleton with `<!-- TODO: section X -->`
  placeholders FIRST, then fill each section with `edit_file`.
  A single `write_file` carrying thousands of lines of
  `content` will trip the provider's tool-call stream
  truncation and the call will fail with `content` missing
  entirely.
- Don't proactively create documentation files (`*.md`,
  `README.*`) the user didn't ask for.
- Avoid writing emojis to files unless the user asked.
