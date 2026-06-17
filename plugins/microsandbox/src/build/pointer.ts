// Tenant-level "current snapshot" pointer.
//
// Stored as JSON at `<tenant>/_tenant/sandbox/current.json`. Two
// independent role pointers — the long-lived browser sandbox and
// the future per-task sandbox can pin different snapshots:
//
//   {
//     "browser": {
//       "snapshotName": "tianshu-default-2026-06-07-1",
//       "baseImage":    "python:3.12-slim",
//       "publishedAt":  "2026-06-07T08:30:00.000Z",
//       "publishedBy":  "user_admin"
//     },
//     "task": { ... same shape, may differ from browser ... },
//
//     // Legacy compatibility — older code (the runner today, third-
//     // party tools) still reads the top-level snapshotName field.
//     // We mirror the browser pointer here on every write so old
//     // readers continue to work without changes.
//     "snapshotName": "...",
//     "baseImage":    "...",
//     "publishedAt":  "...",
//     "publishedBy":  "..."
//   }
//
// Old single-pointer files written before this PR are auto-upgraded
// on read: the top-level fields are promoted to both `browser` and
// `task` so behaviour matches the previous shared-snapshot model
// until the user picks them apart in the admin UI.
//
// `_tenant/sandbox/` is a tenant-shared dir under workspace; the
// agent's per-user fs tools cannot reach it, but the microsandbox
// plugin can write here directly because it owns the publish
// workflow.

import * as path from "node:path";
import { promises as fs } from "node:fs";

/**
 * One snapshot reference. Same shape that the legacy single-pointer
 * file used at the top level.
 */
export interface SandboxPointer {
  snapshotName: string;
  baseImage: string;
  /** ISO timestamp. */
  publishedAt: string;
  /** Best-effort attribution; populated from AgentToolContext.userId. */
  publishedBy?: string;
}

/** Roles that can have an independent active snapshot. */
export type SandboxRole = "browser" | "task";

/**
 * Tenant-level pointer file shape: one entry per role, plus the
 * legacy top-level fields kept in sync with the browser role for
 * backwards compatibility.
 */
export interface SandboxPointers {
  browser: SandboxPointer | null;
  task: SandboxPointer | null;
}

const TENANT_SANDBOX_DIR = "_tenant/sandbox";
const POINTER_BASENAME = "current.json";

export function pointerPath(workspaceDir: string): string {
  return path.join(workspaceDir, TENANT_SANDBOX_DIR, POINTER_BASENAME);
}

function parseEntry(raw: unknown): SandboxPointer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SandboxPointer>;
  if (
    typeof r.snapshotName !== "string" ||
    typeof r.baseImage !== "string" ||
    typeof r.publishedAt !== "string"
  ) {
    return null;
  }
  return {
    snapshotName: r.snapshotName,
    baseImage: r.baseImage,
    publishedAt: r.publishedAt,
    publishedBy: typeof r.publishedBy === "string" ? r.publishedBy : undefined,
  };
}

/**
 * Read the legacy single pointer (= the browser role). Kept for
 * the runner's start path which still consumes one snapshot today;
 * PR-B will switch the runner to `readPointers().task` for the
 * per-task pool.
 */
export async function readPointer(
  workspaceDir: string,
): Promise<SandboxPointer | null> {
  const all = await readPointers(workspaceDir);
  return all.browser;
}

/**
 * Read both role pointers. Auto-upgrades legacy single-pointer
 * files (top-level snapshotName only) by mirroring the legacy entry
 * to both browser and task roles — matches the pre-split sharing
 * behaviour until the operator splits them apart in the UI.
 */
export async function readPointers(
  workspaceDir: string,
): Promise<SandboxPointers> {
  const p = pointerPath(workspaceDir);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { browser: null, task: null };
    }
    throw err;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { browser: null, task: null };
  }

  const legacyTop = parseEntry(parsed);
  const browser = parseEntry(parsed.browser) ?? legacyTop;
  const task = parseEntry(parsed.task) ?? legacyTop;
  return { browser, task };
}

/**
 * Legacy single-pointer write — sets BOTH roles to the same
 * snapshot. Used by `tenant_config_write` callers that still think
 * one-pointer; equivalent to clicking "Use as Both" in the UI.
 */
export async function writePointer(
  workspaceDir: string,
  pointer: SandboxPointer,
): Promise<void> {
  await writePointers(workspaceDir, { browser: pointer, task: pointer });
}

/**
 * Persist both role pointers. Also writes the legacy top-level
 * fields (mirroring the browser role) so older readers (current
 * runner, external tools) keep working without changes.
 */
export async function writePointers(
  workspaceDir: string,
  pointers: SandboxPointers,
): Promise<void> {
  const p = pointerPath(workspaceDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Legacy mirror: choose browser when present, fall back to task,
  // so no role being unset doesn't strand the legacy reader.
  const legacy = pointers.browser ?? pointers.task;
  const out: Record<string, unknown> = {
    browser: pointers.browser,
    task: pointers.task,
  };
  if (legacy) {
    out.snapshotName = legacy.snapshotName;
    out.baseImage = legacy.baseImage;
    out.publishedAt = legacy.publishedAt;
    if (legacy.publishedBy !== undefined) out.publishedBy = legacy.publishedBy;
  }
  await fs.writeFile(p, JSON.stringify(out, null, 2) + "\n", "utf8");
}
