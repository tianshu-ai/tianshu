// Compute the "effective skills" list for a worker agent — what
// `<available_skills>` will actually contain when the worker
// runs. Mirrors the merge order used by the host's chat handler /
// agent-loop:
//
//   1. host self-shipped skills     (via `host.skillCatalog`,
//                                    pluginId === "host")
//   2. plugin skills                (via `host.skillCatalog`)
//   3. tenant shared skills         (`_tenant/config/skills/`)
//   4. tenant per-worker skills     (`_tenant/config/workers/<slug>/skills/`)
//
// Then, if `agent.skills` is non-null, we narrow to that allow-list.
// The `null` semantics is "no restriction" — the agent loop applies
// the same rule (PR #98).
//
// Returns names only; the UI doesn't need bodies. The result feeds
// the read-only worker-agents listing so the user can see what
// each worker effectively has access to without spinning a real
// run.

import fs from "node:fs";
import path from "node:path";
import type { SkillCatalogCapability } from "@tianshu/plugin-sdk";
import type { WorkerAgent } from "./types.js";

export interface ComputeEffectiveSkillsArgs {
  agent: WorkerAgent;
  /** From `host.skillCatalog`. May be null if the host doesn't
   *  expose the capability. */
  hostSkillCatalog: SkillCatalogCapability | null;
  /** Tenant-config root (= `<tenant>/workspace/_tenant/config/`).
   *  Caller resolves it. */
  tenantConfigDir: string;
}

export function computeEffectiveSkillsFor(
  args: ComputeEffectiveSkillsArgs,
): string[] {
  const names = new Set<string>();

  // Layer 1+2: host + plugin skills via the catalog capability.
  if (args.hostSkillCatalog) {
    try {
      for (const e of args.hostSkillCatalog.list()) {
        if (e?.name) names.add(e.name);
      }
    } catch {
      // Catalog hiccup is non-fatal; we still have the tenant
      // layers below.
    }
  }

  // Layer 3: tenant shared skills.
  for (const n of scanSkillsRoot(
    path.join(args.tenantConfigDir, "skills"),
  )) {
    names.add(n);
  }

  // Layer 4: per-worker skills under `workers/<slug>/skills/`.
  // Slug is the runtime id (= directory name); `builtinKey` is
  // the same value for builtin workers (see fs-worker-agents.ts).
  const slug = args.agent.id;
  if (slug) {
    for (const n of scanSkillsRoot(
      path.join(args.tenantConfigDir, "workers", slug, "skills"),
    )) {
      names.add(n);
    }
  }

  // Apply the agent's allow-list, if any.
  let out: string[];
  if (args.agent.skills) {
    const allow = new Set(args.agent.skills);
    out = [...names].filter((n) => allow.has(n));
  } else {
    out = [...names];
  }
  return out.sort();
}

/** Walk `<root>/<name>/SKILL.md` and pull `name:` from the
 *  frontmatter. We don't need the body. Match the loader's
 *  rules: directory-style only, frontmatter-required. */
function scanSkillsRoot(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    const skillMd = path.join(root, e.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const name = readSkillName(skillMd);
    if (name) out.push(name);
  }
  return out;
}

function readSkillName(filePath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  // Cheap frontmatter parser: just enough to pull `name:`.
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const head = raw.slice(3, end);
  for (const line of head.split("\n")) {
    const m = line.match(/^\s*name\s*:\s*(.+?)\s*$/);
    if (m) {
      // Strip surrounding quotes if any.
      let v = m[1]!;
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  return null;
}
