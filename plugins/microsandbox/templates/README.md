# Sandboxfile templates

Each `*.yaml` here is a starting-point Sandboxfile a user can load
into the admin Sandbox page (or the agent can author via
`write_file`). Templates surface through the host:

- `GET /api/p/microsandbox/sandboxfile/templates` returns
  `{ templates: [{ id, displayName, description, content }, ...] }`.
- The admin page's "Load template" dropdown reads that list and
  pastes the picked template into the editor (replacing the
  current draft only after the user clicks Save).

Templates are not enforced — they're just curated examples that
follow the patterns from `skills/microsandbox-build-use.md` (use
`bash -c` for verification, regional mirrors for slow apt, etc.).

## When to add a new template

A new template earns its slot when:
1. Multiple users have hit the same "what packages do I need" wall
   for a real workload (Office automation, browser, data science),
   AND
2. The recipe survives a real `build & use` test on Apple Silicon
   arm64.

Otherwise leave it as a skill paragraph; less surface to maintain.
