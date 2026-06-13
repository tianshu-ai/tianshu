// Bridge between the new filesystem-backed worker-agent layout
// (`<tenant>/_tenant/config/workers/<slug>/`) and the existing
// `WorkerAgent` shape the pool / factory consume. PR-A keeps the
// DB-backed table around as a fallback so we can ship the
// filesystem path without breaking the kanban Execution dialog
// or the existing seed flow; later PRs (B/C) flip the source of
// truth and drop the table.
//
// Merge rule when both sources have a row for the same identity:
//   * Identity match: fs.slug === db.builtin_key (for builtin
//     rows) OR fs.slug === db.id (defensive).
//   * Filesystem wins. The DB row is kept around but the pool
//     ignores it as long as the fs slot exists.
//
// fs records that don't satisfy `WorkerAgent` (missing kind, etc.)
// are dropped with a warning instead of crashing — admin UI
// surfaces the same errors via the loader's `errors` field, so
// the user can fix them.
//
// We deliberately do NOT import the host's worker-agents-fs.ts —
// plugins shouldn't reach into server internals. The loader is
// small enough to own here.

import fs from "node:fs";
import path from "node:path";
import type { WorkerAgent } from "./db/agents.js";

interface SpecJson {
  kind?: string;
  displayName?: string;
  description?: string | null;
  modelId?: string | null;
  toolsAllow?: string[] | null;
  skillsAllow?: string[] | null;
  enabled?: boolean;
  source?: "builtin" | "user";
}

interface FsRecord {
  slug: string;
  spec: SpecJson;
  systemPrompt: string | null;
  updatedMs: number;
  errors: string[];
}

export interface MergedWorkerAgents {
  /** All agents the pool should consider, fs-first then any
   *  db-only rows (rows whose builtinKey isn't shadowed by an fs
   *  slot). Ordered by name. */
  agents: WorkerAgent[];
  /** Slugs whose fs record had errors — surfaced for logging. */
  fsErrors: Array<{ slug: string; reasons: string[] }>;
}

export function loadMergedWorkerAgents(args: {
  tenantId: string;
  tenantHomeDir: string;
  dbAgents: readonly WorkerAgent[];
}): MergedWorkerAgents {
  const fsRecords = scanFsWorkers(args.tenantHomeDir);
  const fsAgents: WorkerAgent[] = [];
  const fsErrors: Array<{ slug: string; reasons: string[] }> = [];
  const fsSlugs = new Set<string>();

  for (const r of fsRecords) {
    if (r.errors.length > 0) {
      fsErrors.push({ slug: r.slug, reasons: r.errors });
      if (!r.spec.kind) continue;
    }
    fsSlugs.add(r.slug);
    fsAgents.push(toWorkerAgent(args.tenantId, r));
  }

  // Drop any DB row whose identity overlaps an fs slot. `builtin_key`
  // is the natural identity for builtin rows (post-migration the
  // fs slug equals the old builtin_key); for user-created rows
  // there's no overlap with fs slugs unless the user creates a
  // user row with the same name as a seed. We always prefer the
  // fs version.
  const shadowed = new Set<string>();
  for (const a of args.dbAgents) {
    if (a.builtinKey && fsSlugs.has(a.builtinKey)) shadowed.add(a.id);
    if (fsSlugs.has(a.id)) shadowed.add(a.id);
  }
  const dbAgentsKept = args.dbAgents.filter((a) => !shadowed.has(a.id));

  const merged = [...fsAgents, ...dbAgentsKept].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { agents: merged, fsErrors };
}

function scanFsWorkers(tenantHomeDir: string): FsRecord[] {
  // Caller passes either the tenant root (`<...>/tenants/<id>`) or
  // its workspace dir (`<...>/tenants/<id>/workspace`). Both shapes
  // resolve to the same workers root so we accept either.
  const candidates = [
    path.join(tenantHomeDir, "workspace", "_tenant", "config", "workers"),
    path.join(tenantHomeDir, "_tenant", "config", "workers"),
  ];
  const root = candidates.find((p) => fs.existsSync(p));
  if (!root) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FsRecord[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    out.push(loadOne(e.name, dir));
  }
  return out;
}

function loadOne(slug: string, dir: string): FsRecord {
  const errors: string[] = [];
  let spec: SpecJson = {};
  let updatedMs = 0;
  const agentJson = path.join(dir, "agent.json");
  if (fs.existsSync(agentJson)) {
    try {
      const raw = fs.readFileSync(agentJson, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        spec = parsed as SpecJson;
      } else {
        errors.push("agent.json is not an object");
      }
    } catch (err) {
      errors.push(
        `agent.json parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      updatedMs = fs.statSync(agentJson).mtimeMs;
    } catch {
      /* ignore */
    }
  } else {
    errors.push("agent.json missing");
  }
  if (!spec.kind || typeof spec.kind !== "string") {
    errors.push("agent.json missing required field: kind");
  }

  let systemPrompt: string | null = null;
  const soulPath = path.join(dir, "SOUL.md");
  if (fs.existsSync(soulPath)) {
    try {
      systemPrompt = fs.readFileSync(soulPath, "utf8").trim();
      if (!systemPrompt) systemPrompt = null;
    } catch (err) {
      errors.push(
        `SOUL.md read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { slug, spec, systemPrompt, updatedMs, errors };
}

function toWorkerAgent(tenantId: string, r: FsRecord): WorkerAgent {
  const spec = r.spec;
  const kind = typeof spec.kind === "string" ? spec.kind : "unknown";
  const enabled = spec.enabled !== false;
  const source: WorkerAgent["source"] =
    spec.source === "user" ? "user" : "builtin";
  const builtinKey = source === "builtin" ? r.slug : null;
  return {
    id: r.slug,
    tenantId,
    kind,
    name: spec.displayName ?? r.slug,
    description: spec.description ?? null,
    modelId: spec.modelId ?? null,
    systemPrompt: r.systemPrompt,
    toolsAllow: spec.toolsAllow ?? null,
    skills: spec.skillsAllow ?? null,
    source,
    builtinKey,
    ownerUserId: null,
    enabled,
    overridesAt: null,
    createdAt: r.updatedMs || Date.now(),
    updatedAt: r.updatedMs || Date.now(),
  };
}
