// Per-user build metadata.
//
// Each successful build leaves a small JSON file in the user's home
// at `<userHome>/sandbox/builds/<buildId>.json` so the agent can
// list past builds without poking at microsandbox's internal DB.
//
// The snapshot itself stays in microsandbox's snapshot store
// (`~/.microsandbox/snapshots/<name>`); we don't try to mirror the
// big artifact into user space.

import * as path from "node:path";
import { promises as fs } from "node:fs";

export interface BuildMetadata {
  buildId: string;
  snapshotName: string;
  baseImage: string;
  /** ISO timestamp when build finished. */
  builtAt: string;
  /** Wall time the build took, in ms. */
  durationMs: number;
  /** Tail of the build log (200 lines / 8 KB). */
  logTail: string;
  /** Path (under user home) to the Sandboxfile that produced this. */
  sandboxfilePath: string;
}

export const USER_BUILDS_REL = "sandbox/builds";

export function userBuildsDir(userHomeDir: string): string {
  return path.join(userHomeDir, USER_BUILDS_REL);
}

export function buildMetaPath(userHomeDir: string, buildId: string): string {
  return path.join(userBuildsDir(userHomeDir), `${buildId}.json`);
}

export async function writeBuildMetadata(
  userHomeDir: string,
  meta: BuildMetadata,
): Promise<void> {
  const p = buildMetaPath(userHomeDir, meta.buildId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(meta, null, 2) + "\n", "utf8");
}

export async function readBuildMetadata(
  userHomeDir: string,
  buildId: string,
): Promise<BuildMetadata | null> {
  try {
    const raw = await fs.readFile(buildMetaPath(userHomeDir, buildId), "utf8");
    return JSON.parse(raw) as BuildMetadata;
  } catch {
    return null;
  }
}

export async function listBuildMetadata(
  userHomeDir: string,
): Promise<BuildMetadata[]> {
  const dir = userBuildsDir(userHomeDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: BuildMetadata[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const buildId = name.slice(0, -".json".length);
    const meta = await readBuildMetadata(userHomeDir, buildId);
    if (meta) out.push(meta);
  }
  // Newest first.
  out.sort((a, b) => (a.builtAt < b.builtAt ? 1 : a.builtAt > b.builtAt ? -1 : 0));
  return out;
}
