// Filesystem-backed worker-agent loader.
//
// Post-PR-C2 the legacy `worker_agents` SQLite table is gone;
// `<tenant>/_tenant/config/workers/<slug>/` is the only source.
// Each subdirectory is one worker:
//
//   <slug>/
//     agent.json    (required)
//     SOUL.md       (optional; system prompt)
//     skills/...    (optional; picked up by tenant-skills loader)
//
// The loader is plugin-local on purpose — plugins shouldn't reach
// into server internals.

import fs from "node:fs";
import path from "node:path";
import type { WorkerAgent } from "./types.js";

interface SpecJson {
  kind?: string;
  displayName?: string;
  description?: string | null;
  modelId?: string | null;
  toolsAllow?: string[] | null;
  skillsAllow?: string[] | null;
  enabled?: boolean;
  source?: "builtin" | "user";
  /** opencode workers only: enable LSP + formatters (opens sandbox
   *  egress to npm/GitHub so opencode can install language servers).
   *  Default false. */
  enableLsp?: boolean;
}

interface FsRecord {
  slug: string;
  spec: SpecJson;
  systemPrompt: string | null;
  updatedMs: number;
  errors: string[];
}

export interface LoadResult {
  agents: WorkerAgent[];
  /** Slugs whose fs record had errors — surfaced for logging. */
  fsErrors: Array<{ slug: string; reasons: string[] }>;
}

export function loadWorkerAgents(args: {
  tenantId: string;
  tenantHomeDir: string;
}): LoadResult {
  const fsRecords = scanFsWorkers(args.tenantHomeDir);
  const agents: WorkerAgent[] = [];
  const fsErrors: Array<{ slug: string; reasons: string[] }> = [];

  for (const r of fsRecords) {
    if (r.errors.length > 0) {
      fsErrors.push({ slug: r.slug, reasons: r.errors });
      if (!r.spec.kind) continue;
    }
    agents.push(toWorkerAgent(args.tenantId, r));
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, fsErrors };
}

/**
 * Locate the workers root that scanFsWorkers would use. Returns
 * null when no workers dir exists yet.
 */
function findWorkersRoot(tenantHomeDir: string): string | null {
  const candidates = [
    path.join(tenantHomeDir, "workspace", "_tenant", "config", "workers"),
    path.join(tenantHomeDir, "_tenant", "config", "workers"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Toggle `enabled` on a worker's agent.json. Used by the admin
 * route that backs the enable/disable button on the worker-agents
 * page. Returns the new enabled state on success, or null when the
 * slug doesn't exist on disk.
 *
 * The fs watcher in workboard's server.ts picks up the write and
 * triggers a pool rebuild, so the change takes effect on the next
 * task pickup without a process restart.
 */
export function setAgentEnabled(args: {
  tenantHomeDir: string;
  slug: string;
  enabled: boolean;
}): { ok: true; enabled: boolean } | { ok: false; error: string } {
  if (!/^[a-zA-Z0-9_-]+$/.test(args.slug)) {
    return { ok: false, error: "invalid slug" };
  }
  const root = findWorkersRoot(args.tenantHomeDir);
  if (!root) return { ok: false, error: "workers dir does not exist" };
  const dir = path.join(root, args.slug);
  const file = path.join(dir, "agent.json");
  if (!fs.existsSync(file)) {
    return { ok: false, error: `agent.json not found for slug ${args.slug}` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `read agent.json failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(raw);
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      return { ok: false, error: "agent.json must be an object" };
    }
  } catch (err) {
    return {
      ok: false,
      error: `agent.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  spec.enabled = args.enabled;
  try {
    fs.writeFileSync(file, JSON.stringify(spec, null, 2) + "\n", "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `write agent.json failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, enabled: args.enabled };
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
    enableLsp: spec.enableLsp === true,
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
