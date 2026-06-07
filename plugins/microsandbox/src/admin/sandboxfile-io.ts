// Helpers for reading/writing the Sandboxfile from a per-user
// home dir. Used by the admin UI's GET/PUT routes (and shared
// with the agent-tool path which also reads the same file).
//
// Path convention:  <userHomeDir>/sandbox/Sandboxfile
//
// Writes are atomic (temp + rename) so a concurrent read never
// observes a half-written buffer; the admin page is single-user
// in v0 but the agent's `build_sandbox` tool may be reading the
// same file when the user clicks Save.

import * as path from "node:path";
import { promises as fs } from "node:fs";

export const SANDBOXFILE_REL = "sandbox/Sandboxfile";

export const DEFAULT_SANDBOXFILE = `# Sandboxfile (v0)
# Pick a base image and add layers. Saved to
# <user-home>/sandbox/Sandboxfile.

image: python:3.12-slim
cpus: 4
memory_mib: 4096

# Uncomment and edit to add layers:
# apt:
#   - libreoffice-writer
#   - fonts-noto-cjk
# pip:
#   - pandas
#   - numpy
# npm:
#   - tsx
#   - typescript
# exec:
#   - echo "ready"
`;

function resolvePath(userHomeDir: string): string {
  return path.join(userHomeDir, SANDBOXFILE_REL);
}

export async function readSandboxfile(
  userHomeDir: string,
): Promise<{ content: string; exists: boolean; path: string }> {
  const p = resolvePath(userHomeDir);
  try {
    const content = await fs.readFile(p, "utf8");
    return { content, exists: true, path: p };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: DEFAULT_SANDBOXFILE, exists: false, path: p };
    }
    throw err;
  }
}

export async function writeSandboxfile(
  userHomeDir: string,
  content: string,
): Promise<{ path: string }> {
  const p = resolvePath(userHomeDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Atomic write: write to temp then rename.
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, p);
  } catch (err) {
    // Clean up temp on failure.
    try {
      await fs.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  return { path: p };
}
