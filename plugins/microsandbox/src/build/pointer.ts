// Tenant-level "current snapshot" pointer.
//
// Stored as JSON at `<tenant>/_tenant/sandbox/current.json`:
//
//   {
//     "snapshotName": "tianshu-default-2026-06-07-1",
//     "baseImage":    "python:3.12-slim",
//     "publishedAt":  "2026-06-07T08:30:00.000Z",
//     "publishedBy":  "user_admin"
//   }
//
// When present, `MicrosandboxRunner.doStart()` reads this and starts
// the main sandbox via `fromSnapshot(snapshotName)` instead of
// `image(default)`. When absent, the runner falls back to its
// configured default image.
//
// `_tenant/sandbox/` is a tenant-shared dir under workspace; the
// agent's per-user fs tools cannot reach it, but the
// microsandbox plugin can write here directly because it owns the
// publish workflow.

import * as path from "node:path";
import { promises as fs } from "node:fs";

export interface SandboxPointer {
  snapshotName: string;
  baseImage: string;
  /** ISO timestamp. */
  publishedAt: string;
  /** Best-effort attribution; populated from AgentToolContext.userId. */
  publishedBy?: string;
}

const TENANT_SANDBOX_DIR = "_tenant/sandbox";
const POINTER_BASENAME = "current.json";

export function pointerPath(workspaceDir: string): string {
  return path.join(workspaceDir, TENANT_SANDBOX_DIR, POINTER_BASENAME);
}

export async function readPointer(
  workspaceDir: string,
): Promise<SandboxPointer | null> {
  const p = pointerPath(workspaceDir);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SandboxPointer>;
    if (
      typeof parsed.snapshotName !== "string" ||
      typeof parsed.baseImage !== "string" ||
      typeof parsed.publishedAt !== "string"
    ) {
      return null;
    }
    return {
      snapshotName: parsed.snapshotName,
      baseImage: parsed.baseImage,
      publishedAt: parsed.publishedAt,
      publishedBy: parsed.publishedBy,
    };
  } catch {
    return null;
  }
}

export async function writePointer(
  workspaceDir: string,
  pointer: SandboxPointer,
): Promise<void> {
  const p = pointerPath(workspaceDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(pointer, null, 2) + "\n", "utf8");
}
