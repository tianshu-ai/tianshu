// Solution store (ADR-0008, Phase 2) — extract / list / get /
// save / delete / diff. No Apply: a solution is an inert file
// tree on disk until a later phase reconciles it into reality.
//
// On-disk layout (per tenant, ADR-0008 §2):
//   <home>/_tenant/solutions/<slug>/
//     solution.json
//     main-agent/prompt.md          (optional)
//     workers/<slug>/SOUL.md        (optional)
//
// The reserved slug `current` is a live mirror of reality: reading
// it always re-extracts, and it can't be saved or deleted.

import fs from "node:fs";
import path from "node:path";

import type {
  SolutionDetail,
  SolutionDiff,
  SolutionDiffEntry,
  SolutionSpec,
  SolutionSpecInput,
  SolutionPromptBlock,
  SolutionSummary,
  SolutionWorker,
} from "@tianshu-ai/plugin-sdk";

import type { TenantContext } from "../core/index.js";
import { getTenantSolutionsDir } from "../core/paths.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import { buildWorkforceSnapshot } from "./snapshot.js";

const CURRENT_SLUG = "current";
const SOLUTION_FILE = "solution.json";

interface StoreDeps {
  ctx: TenantContext;
  pluginRegistry: PluginRegistry;
  tianshuVersion: string;
}

// ─── slug hygiene ──────────────────────────────────────────────

/** Solution slugs become directory names, so constrain them to a
 *  filesystem-safe shape and reject traversal attempts. */
function assertValidSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
    throw new Error(
      `invalid solution slug "${slug}" — use lowercase letters, digits, hyphen, underscore (max 64 chars)`,
    );
  }
}

function solutionDir(deps: StoreDeps, slug: string): string {
  return path.join(getTenantSolutionsDir(deps.ctx.tenantId, deps.ctx.home), slug);
}

// ─── extraction (reality → solution) ───────────────────────────

/** Build a SolutionSpec (+ resolved bodies) from the current
 *  workforce snapshot. Doesn't write anything — callers decide
 *  whether to persist. */
function specFromReality(
  deps: StoreDeps,
  userId: string,
  slug: string,
  name: string,
  description: string,
): { spec: SolutionSpec; tenantPrompt: string | null; workerPrompts: Record<string, string> } {
  const snap = buildWorkforceSnapshot({
    ctx: deps.ctx,
    userId,
    pluginRegistry: deps.pluginRegistry,
    tianshuVersion: deps.tianshuVersion,
  });
  const now = Date.now();

  // Tenant prompt override: reality has no explicit override field
  // yet (that lands with Apply), so we extract the workspace-context
  // block as the closest editable proxy. null when absent.
  const tenantPromptBlock = snap.main.blocks.find(
    (b) => b.kind === "workspace-context",
  );
  const tenantPrompt = tenantPromptBlock ? tenantPromptBlock.text : null;

  const workerPrompts: Record<string, string> = {};
  const workers: SolutionWorker[] = snap.workers.map((w) => {
    if (w.systemPrompt.trim().length > 0) {
      workerPrompts[w.slug] = w.systemPrompt;
    }
    return {
      slug: w.slug,
      kind: w.kind,
      name: w.name,
      description: w.description,
      modelId: w.modelId,
      enabled: w.enabled,
      systemPromptPath:
        w.systemPrompt.trim().length > 0
          ? `workers/${w.slug}/SOUL.md`
          : null,
      // Reality reports the *effective* tool/skill sets. For an
      // extracted solution we record them as explicit allow-lists
      // so the captured solution reproduces the same surface.
      toolsAllow: w.tools.map((t) => t.name),
      skillsAllow: w.skills.map((s) => s.name),
      source: w.source,
    };
  });

  const spec: SolutionSpec = {
    schema: "tianshu.solution.v1",
    slug,
    name,
    description,
    createdAt: now,
    updatedAt: now,
    extractedFrom: {
      tenantId: deps.ctx.tenantId,
      tianshuVersion: deps.tianshuVersion,
      extractedAt: now,
    },
    plugins: {
      enabled: snap.plugins
        .filter((p) => p.state === "active")
        .map((p) => p.id),
    },
    mainAgent: {
      tenantPromptPath: tenantPrompt ? "main-agent/prompt.md" : null,
      // Reality's main agent is unrestricted; capture null so the
      // solution doesn't accidentally narrow it.
      skillsAllow: null,
      skillsDeny: [],
      toolsAllow: null,
    },
    workers,
  };
  return { spec, tenantPrompt, workerPrompts };
}

// ─── persistence ───────────────────────────────────────────────

function writeSolution(
  deps: StoreDeps,
  spec: SolutionSpec,
  tenantPrompt: string | null,
  workerPrompts: Record<string, string>,
): void {
  const dir = solutionDir(deps, spec.slug);
  // Fresh-write the whole dir so stale sidecars from a previous
  // version don't linger. Cheap because solutions are small.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  if (tenantPrompt && spec.mainAgent.tenantPromptPath) {
    const p = path.join(dir, spec.mainAgent.tenantPromptPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, tenantPrompt, "utf8");
  }
  for (const w of spec.workers) {
    if (w.systemPromptPath && workerPrompts[w.slug] !== undefined) {
      const p = path.join(dir, w.systemPromptPath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, workerPrompts[w.slug]!, "utf8");
    }
  }
  fs.writeFileSync(
    path.join(dir, SOLUTION_FILE),
    JSON.stringify(spec, null, 2),
    "utf8",
  );
}

function readSpec(deps: StoreDeps, slug: string): SolutionSpec | null {
  const file = path.join(solutionDir(deps, slug), SOLUTION_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.schema) {
      return parsed as SolutionSpec;
    }
  } catch {
    /* fallthrough to null */
  }
  return null;
}

function resolveDetail(
  deps: StoreDeps,
  userId: string,
  spec: SolutionSpec,
  tenantPromptOverride?: string | null,
): SolutionDetail {
  const dir = solutionDir(deps, spec.slug);
  let tenantPrompt: string | null = tenantPromptOverride ?? null;
  if (tenantPromptOverride === undefined && spec.mainAgent.tenantPromptPath) {
    tenantPrompt = safeRead(path.join(dir, spec.mainAgent.tenantPromptPath));
  }
  const workerPrompts: Record<string, string> = {};
  for (const w of spec.workers) {
    if (w.systemPromptPath) {
      const body = safeRead(path.join(dir, w.systemPromptPath));
      if (body !== null) workerPrompts[w.slug] = body;
    }
  }
  return {
    spec,
    tenantPrompt,
    workerPrompts,
    mainBlocks: buildMainBlocks(deps, userId, spec, tenantPrompt),
    isCurrent: spec.slug === CURRENT_SLUG,
  };
}

/** Build the main-agent block list for the Solution view's block
 *  editor. Read-only host / plugin blocks come from current
 *  reality as reference; the editable workspace / tenant-prompt
 *  block carries the solution's own value (when set) so the
 *  operator edits the solution, not reality. */
function buildMainBlocks(
  deps: StoreDeps,
  userId: string,
  spec: SolutionSpec,
  tenantPrompt: string | null,
): SolutionPromptBlock[] {
  const snap = buildWorkforceSnapshot({
    ctx: deps.ctx,
    userId,
    pluginRegistry: deps.pluginRegistry,
    tianshuVersion: deps.tianshuVersion,
  });
  const out: SolutionPromptBlock[] = [];
  for (const b of snap.main.blocks) {
    // The workspace-context block is the editable proxy for the
    // solution's tenant prompt override: show the solution's
    // stored value when present, otherwise reality's text.
    if (b.kind === "workspace-context") {
      out.push({
        kind: "tenant-prompt",
        title: "Main agent prompt (tenant override)",
        source: "tenant",
        origin: "tenant",
        editable: true,
        text: tenantPrompt ?? b.text,
        note: "Editable. This text is injected into the main agent prompt for this solution.",
      });
      continue;
    }
    out.push({
      kind: b.kind,
      title: b.title,
      source: b.source,
      origin: b.origin,
      editable: false,
      text: b.text,
      note: b.note,
    });
  }
  return out;
}

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// ─── public capability impl ────────────────────────────────────

export function listSolutions(
  deps: StoreDeps,
  userId: string,
): SolutionSummary[] {
  const root = getTenantSolutionsDir(deps.ctx.tenantId, deps.ctx.home);
  const out: SolutionSummary[] = [];
  // Always surface `current` first, materialising it on the fly.
  const current = extractSolution(deps, userId, {
    slug: CURRENT_SLUG,
    name: "Current (live mirror)",
    description: "Auto-extracted snapshot of the running system.",
  });
  out.push(toSummary(current.spec, true));

  if (fs.existsSync(root)) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === CURRENT_SLUG) continue;
      if (e.name.startsWith(".")) continue;
      const spec = readSpec(deps, e.name);
      if (spec) out.push(toSummary(spec, false));
    }
  }
  // Named solutions sorted by recency; `current` stays pinned at
  // the top regardless.
  const [head, ...rest] = out;
  rest.sort((a, b) => b.updatedAt - a.updatedAt);
  return head ? [head, ...rest] : rest;
}

function toSummary(spec: SolutionSpec, isCurrent: boolean): SolutionSummary {
  return {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    updatedAt: spec.updatedAt,
    workerCount: spec.workers.length,
    pluginCount: spec.plugins.enabled.length,
    isCurrent,
    kind: spec.extractedFrom ? "extracted" : "authored",
  };
}

export function getSolution(
  deps: StoreDeps,
  userId: string,
  slug: string,
): SolutionDetail | null {
  if (slug === CURRENT_SLUG) {
    return extractSolution(deps, userId, {
      slug: CURRENT_SLUG,
      name: "Current (live mirror)",
      description: "Auto-extracted snapshot of the running system.",
    });
  }
  assertValidSlug(slug);
  const spec = readSpec(deps, slug);
  return spec ? resolveDetail(deps, userId, spec) : null;
}

export function extractSolution(
  deps: StoreDeps,
  userId: string,
  args: { slug: string; name?: string; description?: string },
): SolutionDetail {
  const slug = args.slug || CURRENT_SLUG;
  assertValidSlug(slug);
  const { spec, tenantPrompt, workerPrompts } = specFromReality(
    deps,
    userId,
    slug,
    args.name ?? slug,
    args.description ?? "",
  );
  // The live mirror is regenerated on every read; we don't persist
  // it (no point writing a file we always recompute). Named
  // extractions are written to disk.
  if (slug !== CURRENT_SLUG) {
    writeSolution(deps, spec, tenantPrompt, workerPrompts);
  }
  // Pass the extracted tenantPrompt through so the block builder
  // shows it directly (the live mirror isn't on disk to re-read).
  return resolveDetail(deps, userId, spec, tenantPrompt);
}

export function saveSolution(
  deps: StoreDeps,
  userId: string,
  input: SolutionSpecInput,
): SolutionDetail {
  if (input.slug === CURRENT_SLUG) {
    throw new Error("the reserved `current` solution cannot be saved");
  }
  assertValidSlug(input.slug);
  const existing = readSpec(deps, input.slug);
  const now = Date.now();
  const workerPrompts: Record<string, string> = {};
  const workers: SolutionWorker[] = input.workers.map((w) => {
    const hasPrompt = !!w.systemPrompt && w.systemPrompt.trim().length > 0;
    if (hasPrompt) workerPrompts[w.slug] = w.systemPrompt!;
    return {
      slug: w.slug,
      kind: w.kind,
      name: w.name,
      description: w.description,
      modelId: w.modelId,
      enabled: w.enabled,
      systemPromptPath: hasPrompt ? `workers/${w.slug}/SOUL.md` : null,
      toolsAllow: w.toolsAllow,
      skillsAllow: w.skillsAllow,
      source: w.source,
    };
  });
  const hasTenantPrompt =
    !!input.mainAgent.tenantPrompt &&
    input.mainAgent.tenantPrompt.trim().length > 0;
  const spec: SolutionSpec = {
    schema: "tianshu.solution.v1",
    slug: input.slug,
    name: input.name,
    description: input.description,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // Hand-saves clear the extraction provenance — once edited, the
    // solution is authored, not a faithful capture.
    extractedFrom: null,
    plugins: input.plugins,
    mainAgent: {
      tenantPromptPath: hasTenantPrompt ? "main-agent/prompt.md" : null,
      skillsAllow: input.mainAgent.skillsAllow,
      skillsDeny: input.mainAgent.skillsDeny,
      toolsAllow: input.mainAgent.toolsAllow,
    },
    workers,
  };
  writeSolution(
    deps,
    spec,
    hasTenantPrompt ? input.mainAgent.tenantPrompt : null,
    workerPrompts,
  );
  return resolveDetail(deps, userId, spec);
}

export function removeSolution(
  deps: StoreDeps,
  _userId: string,
  slug: string,
): void {
  if (slug === CURRENT_SLUG) {
    throw new Error("the reserved `current` solution cannot be deleted");
  }
  assertValidSlug(slug);
  fs.rmSync(solutionDir(deps, slug), { recursive: true, force: true });
}

// ─── diff ──────────────────────────────────────────────────────

export function diffSolution(
  deps: StoreDeps,
  userId: string,
  args: { slug: string; against: string },
): SolutionDiff {
  const base = getSolution(deps, userId, args.slug);
  if (!base) throw new Error(`solution "${args.slug}" not found`);
  let targetSpec: SolutionSpec;
  let targetLabel: string;
  if (args.against === "reality") {
    targetSpec = extractSolution(deps, userId, {
      slug: CURRENT_SLUG,
      name: "reality",
      description: "",
    }).spec;
    targetLabel = "reality";
  } else {
    const t = getSolution(deps, userId, args.against);
    if (!t) throw new Error(`solution "${args.against}" not found`);
    targetSpec = t.spec;
    targetLabel = args.against;
  }
  return {
    baseLabel: args.slug,
    targetLabel,
    entries: computeDiff(base.spec, targetSpec),
  };
}

/** Flatten the two specs to comparable maps and diff field-by-
 *  field. We compare the configuration surface (plugins, main
 *  agent allow-lists, worker specs) and deliberately ignore
 *  volatile metadata (timestamps, extractedFrom). */
function computeDiff(
  base: SolutionSpec,
  target: SolutionSpec,
): SolutionDiffEntry[] {
  const flat = (s: SolutionSpec): Record<string, string> => {
    const m: Record<string, string> = {};
    m["plugins.enabled"] = JSON.stringify([...s.plugins.enabled].sort());
    m["mainAgent.skillsAllow"] = JSON.stringify(s.mainAgent.skillsAllow);
    m["mainAgent.skillsDeny"] = JSON.stringify(s.mainAgent.skillsDeny);
    m["mainAgent.toolsAllow"] = JSON.stringify(s.mainAgent.toolsAllow);
    for (const w of s.workers) {
      const k = `workers.${w.slug}`;
      m[`${k}.modelId`] = JSON.stringify(w.modelId);
      m[`${k}.enabled`] = JSON.stringify(w.enabled);
      m[`${k}.toolsAllow`] = JSON.stringify(
        w.toolsAllow ? [...w.toolsAllow].sort() : null,
      );
      m[`${k}.skillsAllow`] = JSON.stringify(
        w.skillsAllow ? [...w.skillsAllow].sort() : null,
      );
    }
    return m;
  };
  const a = flat(base);
  const b = flat(target);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const entries: SolutionDiffEntry[] = [];
  for (const key of [...keys].sort()) {
    const before = a[key] ?? null;
    const after = b[key] ?? null;
    if (before === after) continue;
    entries.push({
      path: key,
      op: before === null ? "add" : after === null ? "remove" : "change",
      before,
      after,
    });
  }
  return entries;
}
