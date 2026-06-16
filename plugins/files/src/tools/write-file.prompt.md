Create or overwrite a file in the workspace. Parent directories
are created if missing.

## Guidelines

- Use `write_file` for new files or complete rewrites. For
  in-place changes to an existing file prefer `edit_file`.
- **If the target file already exists, you must call `read_file`
  on it first.** `write_file` will refuse to overwrite an
  unseen file with a specific error — overwriting blind is how
  you destroy work the user will be sad about.
- Don't proactively create documentation files (`*.md`,
  `README.*`) the user didn't ask for.
- Avoid writing emojis to files unless the user asked.
