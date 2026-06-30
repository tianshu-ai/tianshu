// Filesystem-backed worker-agent loader.
//
// New layout (PR-A in the DB → fs migration):
//
//   _tenant/config/workers/<slug>/
//     agent.json   (required)
//     SOUL.md      (optional system prompt)
//     skills/      (optional, picked up by tenant-skills loader)
//
// Each subdirectory is one worker. The DB-backed `worker_agents`
// table still exists in PR-A as a fallback (so the existing
// workboard pool doesn't break before the migration lands), but
// new code paths should prefer this loader.

import fs from "node:fs";
import path from "node:path";
import { getTenantConfigDir } from "./paths.js";

/** Shape of the `agent.json` companion file. Forward-compatible:
 *  unknown fields are ignored; missing optional fields default to
 *  sane values. */
export interface WorkerAgentSpecJson {
  /** Worker kind id (e.g. "llm" / "echo"). REQUIRED. The pool's
   *  factory keys off this to pick the runtime. */
  kind?: string;
  /** Human-readable label for UI. Defaults to slug if omitted. */
  displayName?: string;
  /** Free-form description shown in the worker list. */
  description?: string | null;
  /** Model id for kinds that need one (e.g. llm). */
  modelId?: string | null;
  /** Allow-list of host tool names. null/undefined = no
   *  restriction. */
  toolsAllow?: string[] | null;
  /** Allow-list of host/plugin skill names (tenant skills are
   *  always visible regardless). */
  skillsAllow?: string[] | null;
  /** Default true. */
  enabled?: boolean;
  /** Per-worker host-block override sidecar pointers (relative to
   *  the worker dir). Written by Solution apply; read at runtime
   *  to replace the host default execution-bias block for this
   *  worker only. null = host default. */
  overrides?: {
    executionBias?: string | null;
  };
  /** Provenance hint. "builtin" = came from a plugin agentSeed
   *  contribution; "user" = created by hand or a tool. Used by
   *  the future reset path. */
  source?: "builtin" | "user";
}

export interface WorkerAgentFsRecord {
  /** Directory name (= unique id within the tenant). */
  slug: string;
  /** Absolute path to the worker directory on disk. */
  dir: string;
  /** Parsed `agent.json` (or `{}` if missing — see `valid`). */
  spec: WorkerAgentSpecJson;
  /** SOUL.md body, if present. */
  systemPrompt: string | null;
  /** mtime of agent.json (or directory, if missing) — useful for
   *  cache-busting downstream. */
  updatedMs: number;
  /** Why we couldn't load this worker, if anything. Empty array →
   *  ok. */
  errors: string[];
}

/** Resolve a single worker's execution-bias override body, or null
 *  when the worker has no override (→ host default applies). Reads
 *  the agent.json pointer + the sidecar fresh each call so an
 *  applied solution takes effect without a restart, mirroring
 *  `loadMainAgentConfig`. Never throws. */
export function loadWorkerExecutionBiasOverride(
  tenantId: string,
  slug: string,
  home?: string,
): string | null {
  const dir = path.join(getTenantConfigDir(tenantId, home), "workers", slug);
  let pointer: string | null = null;
  try {
    const raw = fs.readFileSync(path.join(dir, "agent.json"), "utf8");
    const parsed = JSON.parse(raw) as WorkerAgentSpecJson;
    pointer = parsed?.overrides?.executionBias ?? null;
  } catch {
    return null;
  }
  if (!pointer) return null;
  try {
    const body = fs.readFileSync(path.join(dir, pointer), "utf8");
    return body.trim().length > 0 ? body : null;
  } catch {
    return null;
  }
}

export function loadWorkerAgents(
  tenantId: string,
  home?: string,
): WorkerAgentFsRecord[] {
  const root = path.join(getTenantConfigDir(tenantId, home), "workers");
  if (!fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorkerAgentFsRecord[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    out.push(loadOne(e.name, dir));
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

function loadOne(slug: string, dir: string): WorkerAgentFsRecord {
  const errors: string[] = [];
  let spec: WorkerAgentSpecJson = {};
  let updatedMs = 0;
  const agentJson = path.join(dir, "agent.json");
  if (fs.existsSync(agentJson)) {
    try {
      const raw = fs.readFileSync(agentJson, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        spec = parsed as WorkerAgentSpecJson;
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

  return { slug, dir, spec, systemPrompt, updatedMs, errors };
}
