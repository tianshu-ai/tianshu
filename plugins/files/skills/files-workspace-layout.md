---
name: files-workspace-layout
description: Conventions for the per-user workspace this `files` plugin manages — directory roles (projects, uploads, tmp, trash), where deliverables go, what NOT to touch.
when:
  toolPresent: read_file
---

Your default working directory is the user's private home in this tenant.
Filesystem tools (`list_dir`, `read_file`, `write_file`, `edit_file`, `glob`)
operate relative to this home (`/` = home).

## Personal directories

| Path | Role |
|------|------|
| `./projects/<slug>/` | Active work. Reports, code, deliverables go here. |
| `./uploads/`         | Files the user uploaded for you to look at. |
| `./tmp/`             | Scratch space. Clean up after yourself. |
| `./trash/`           | Soft-delete. Move things here instead of removing them. |
| `./USER.md`          | Personal preferences (read on demand). |

## Conventions

- Deliverables go to `./projects/<slug>/`, never the home root.
- When the user uploads a file, expect it under `./uploads/`.
- Don't leave scratch artefacts in `./projects/` or the root — use `./tmp/`.
- Other users' homes in this tenant are off-limits; you cannot reach them via
  these tools.
- When you make changes, briefly say what you changed in your reply.
