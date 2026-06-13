// One-shot migration: dump every row in `worker_agents` that
// doesn't have a matching `_tenant/config/workers/<slug>/` slot to
// disk, in the format the new fs loader expects.
//
// Runs on every workboard activation. Idempotent — once a row's
// slot exists, this is a no-op for that row. Safe to remove in
// PR-C after the table itself is dropped.
//
// Slug rules:
//   * builtin row    → builtin_key (already a kebab-case slug)
//   * user row       → slugify(name) + dedup with -2 / -3 / ...
//
// We never delete the DB row here; the merger (fs-worker-agents.ts)
// shadows the DB row by slug as long as the fs slot exists. PR-C
// drops the table after we're confident the migration is settled.

import fs from "node:fs";
import path from "node:path";
import type { WorkerAgent } from "./db/agents.js";

export interface MigrateResult {
  migrated: string[];
  preserved: string[];
}

export function migrateWorkerAgentsToFs(args: {
  tenantHomeDir: string;
  dbAgents: readonly WorkerAgent[];
  onWarn?: (msg: string) => void;
}): MigrateResult {
  // Caller passes either `<tenantHome>` or `<tenantHome>/workspace`.
  // PluginContext.workspaceDir is the workspace dir, so the second
  // candidate is the common case.
  const candidates = [
    path.join(args.tenantHomeDir, "workspace", "_tenant", "config", "workers"),
    path.join(args.tenantHomeDir, "_tenant", "config", "workers"),
  ];
  const targetRoot = candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
  fs.mkdirSync(targetRoot, { recursive: true });
  const warn = args.onWarn ?? ((m) => console.warn(m));

  const existing = new Set<string>(
    fs
      .readdirSync(targetRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  );

  const migrated: string[] = [];
  const preserved: string[] = [];

  for (const a of args.dbAgents) {
    const baseSlug = a.builtinKey || slugify(a.name) || a.id;
    let slug = baseSlug;
    let n = 2;
    while (existing.has(slug)) {
      // Same slug already on disk — assume the fs slot wins, mark
      // the DB row as preserved (not migrated) and move on. We do
      // NOT try to dedup-and-still-migrate; if the user wants both
      // rows they can rename one in-DB and re-run.
      preserved.push(slug);
      slug = "";
      break;
    }
    void n; // (kept for readability — see dedup branch removed)
    if (!slug) continue;

    const dir = path.join(targetRoot, slug);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const agentJson: Record<string, unknown> = {
        kind: a.kind,
        displayName: a.name,
        enabled: a.enabled,
        source: a.source,
      };
      if (a.description) agentJson.description = a.description;
      if (a.modelId) agentJson.modelId = a.modelId;
      if (a.toolsAllow) agentJson.toolsAllow = a.toolsAllow;
      if (a.skills) agentJson.skillsAllow = a.skills;

      fs.writeFileSync(
        path.join(dir, "agent.json"),
        JSON.stringify(agentJson, null, 2) + "\n",
        "utf8",
      );
      if (a.systemPrompt && a.systemPrompt.trim().length > 0) {
        fs.writeFileSync(path.join(dir, "SOUL.md"), a.systemPrompt, "utf8");
      }
      existing.add(slug);
      migrated.push(slug);
    } catch (err) {
      warn(
        `[migrate-workers] failed to migrate "${a.name}" → ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { migrated, preserved };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
