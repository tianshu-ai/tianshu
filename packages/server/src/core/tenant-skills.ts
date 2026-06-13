// Tenant-scoped skill discovery.
//
// Mirrors the OpenClaw / Claude-Code convention: skills live as
// directory bundles (`<name>/SKILL.md` plus optional `scripts/`,
// `references/`, `assets/`) under the tenant's shared config tree.
// Discovery happens on every chat turn and worker run \u2014 no host
// restart required, no in-process cache. Tenant counts are bounded
// and `readdir` of a few small directories is cheap; matches the
// upstream "scan every snapshot" behaviour.
//
// Three roots are scanned, lowest-precedence first. Same-named skills
// at later positions override earlier ones (file path is overwritten;
// frontmatter is re-parsed each turn).
//
//   1. <tenant>/_tenant/config/skills/                       (shared)
//   2. <tenant>/_tenant/config/main/skills/                  (main agent)
//      OR <tenant>/_tenant/config/workers/<kind>/skills/     (worker)
//
// The dedup key is the directory name, mirroring how Claude Code's
// `~/.claude/skills/<name>/` resolves \u2014 not the frontmatter `name`
// field, which is allowed to drift from the directory.

import {
  getTenantMainSkillsDir,
  getTenantSharedSkillsDir,
  getTenantWorkerSkillsDir,
} from "./paths.js";
import { loadDirectorySkills, type LoadedSkill } from "./plugins/skills.js";

export type TenantSkillScope =
  | { kind: "main" }
  | { kind: "worker"; workerKind: string };

/** Scan tenant skill roots and return the merged, deduped list. */
export function loadTenantSkills(args: {
  tenantId: string;
  scope: TenantSkillScope;
  home?: string;
  /** Optional sink for parser failures. The chat handler logs these
   *  via `console.warn` so authors can see why their SKILL.md didn't
   *  register. */
  onFailure?: (failure: {
    filePath: string;
    reason: string;
    scope: string;
  }) => void;
}): LoadedSkill[] {
  const { tenantId, home, scope, onFailure } = args;

  // Lowest precedence first \u2014 later entries with the same dir name
  // overwrite earlier ones in the merged map. Skill `name` and
  // `description` come from the winner's frontmatter on every turn.
  const layers: Array<{ pluginId: string; rootDir: string }> = [
    {
      pluginId: "tenant-shared",
      rootDir: getTenantSharedSkillsDir(tenantId, home),
    },
  ];
  if (scope.kind === "main") {
    layers.push({
      pluginId: "tenant-main",
      rootDir: getTenantMainSkillsDir(tenantId, home),
    });
  } else if (scope.workerKind) {
    layers.push({
      pluginId: `tenant-worker-${scope.workerKind}`,
      rootDir: getTenantWorkerSkillsDir(tenantId, scope.workerKind, home),
    });
  }
  // worker scope without a kind: shared layer only — there's no
  // kind-specific directory to load.

  // Use a Map keyed by `dirName` (= contribution id from
  // loadDirectorySkills) so a higher-priority layer wins by name.
  const merged = new Map<string, LoadedSkill>();
  for (const layer of layers) {
    const result = loadDirectorySkills({
      pluginId: layer.pluginId,
      rootDir: layer.rootDir,
    });
    for (const f of result.failures) {
      onFailure?.({
        filePath: f.filePath,
        reason: f.reason,
        scope: layer.pluginId,
      });
    }
    for (const skill of result.skills) {
      merged.set(skill.source.contributionId, skill);
    }
  }
  return [...merged.values()];
}
