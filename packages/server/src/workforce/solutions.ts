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
  SolutionPluginOption,
  SolutionResourceOption,
  SolutionWorkerView,
  SolutionSummary,
  SolutionWorker,
} from "@tianshu-ai/plugin-sdk";

import type { TenantContext } from "../core/index.js";
import {
  getTenantConfigDir,
  getTenantMainConfigDir,
  getTenantSolutionsDir,
} from "../core/paths.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import { loadMainAgentConfig } from "../core/main-agent-config.js";
import { loadTenantConfig, writeTenantConfig } from "../core/config.js";
import { buildWorkforceSnapshot } from "./snapshot.js";

const CURRENT_SLUG = "current";
const SOLUTION_FILE = "solution.json";
const ACTIVE_FILE = ".active"; // pointer: slug of the live solution

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

// ─── active pointer ────────────────────────────────────────────
// `_tenant/solutions/.active` holds the slug of the currently-
// live solution (the one last activated). Absent = no solution
// activated yet (fresh tenant runs pure host defaults).

function activePointerPath(deps: StoreDeps): string {
  return path.join(
    getTenantSolutionsDir(deps.ctx.tenantId, deps.ctx.home),
    ACTIVE_FILE,
  );
}

export function getActiveSlug(deps: StoreDeps): string | null {
  try {
    const raw = fs.readFileSync(activePointerPath(deps), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function setActiveSlug(deps: StoreDeps, slug: string): void {
  const p = activePointerPath(deps);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, slug, "utf8");
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

  // Applied-solution config is the source of truth for what the
  // live agent actually runs (Apply wrote it; the chat path reads
  // it every turn). The `current` mirror must reflect THAT, not
  // the host defaults. Read the same main-agent.json the chat
  // path reads.
  const mainConfig = loadMainAgentConfig(deps.ctx.tenantId, deps.ctx.home);

  // Tenant prompt: prefer the applied override; fall back to the
  // workspace-context block (host AGENTS/USER.md proxy) only when
  // no solution has set an explicit override.
  let tenantPrompt: string | null = mainConfig.tenantPrompt;
  if (tenantPrompt == null) {
    const tenantPromptBlock = snap.main.blocks.find(
      (b) => b.kind === "workspace-context",
    );
    tenantPrompt = tenantPromptBlock ? tenantPromptBlock.text : null;
  }

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
      // Fresh extract uses host defaults for every worker host
      // block — no override until the operator sets one.
      overrides: { executionBias: null },
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
      skillsAllow: null,
      // Reflect the applied solution's deny lists so the `current`
      // mirror shows what the live agent actually has (the badge
      // counts + the picker exclusions match reality).
      skillsDeny: [...mainConfig.skillsDeny],
      toolsAllow: null,
      toolsDeny: [...mainConfig.toolsDeny],
      // Host-block overrides: point at the sidecar path when the
      // applied config has an override body; resolveDetail /
      // buildMainView surface the actual text.
      overrides: {
        executionBias: mainConfig.overrides.executionBias
          ? "main-agent/execution-bias.md"
          : null,
        replyStyle: mainConfig.overrides.replyStyle
          ? "main-agent/reply-style.md"
          : null,
        userOnboarding: mainConfig.overrides.userOnboarding
          ? "main-agent/user-onboarding.md"
          : null,
      },
      customFragments: mainConfig.customFragments.map((f) => ({
        id: f.id,
        title: f.title,
        path: `main-agent/fragments/${f.id}.md`,
      })),
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
  extra?: {
    overrideBodies?: {
      executionBias: string | null;
      replyStyle: string | null;
      userOnboarding: string | null;
    };
    fragmentBodies?: Record<string, string>;
    /** Per-worker host-block override bodies, keyed by worker
     *  slug. */
    workerOverrideBodies?: Record<string, { executionBias: string | null }>;
  },
): void {
  const dir = solutionDir(deps, spec.slug);
  // Fresh-write the whole dir so stale sidecars from a previous
  // version don't linger. Cheap because solutions are small.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const writeRel = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
  };

  if (tenantPrompt && spec.mainAgent.tenantPromptPath) {
    writeRel(spec.mainAgent.tenantPromptPath, tenantPrompt);
  }
  // Host-block override sidecars.
  const ob = extra?.overrideBodies;
  if (ob) {
    if (spec.mainAgent.overrides.executionBias && ob.executionBias) {
      writeRel(spec.mainAgent.overrides.executionBias, ob.executionBias);
    }
    if (spec.mainAgent.overrides.replyStyle && ob.replyStyle) {
      writeRel(spec.mainAgent.overrides.replyStyle, ob.replyStyle);
    }
    if (spec.mainAgent.overrides.userOnboarding && ob.userOnboarding) {
      writeRel(spec.mainAgent.overrides.userOnboarding, ob.userOnboarding);
    }
  }
  // Custom fragment sidecars.
  const fb = extra?.fragmentBodies ?? {};
  for (const frag of spec.mainAgent.customFragments) {
    const body = fb[frag.id];
    if (body !== undefined) writeRel(frag.path, body);
  }
  for (const w of spec.workers) {
    if (w.systemPromptPath && workerPrompts[w.slug] !== undefined) {
      writeRel(w.systemPromptPath, workerPrompts[w.slug]!);
    }
    // Per-worker host-block override sidecars.
    const wob = extra?.workerOverrideBodies?.[w.slug];
    if (w.overrides?.executionBias && wob?.executionBias) {
      writeRel(w.overrides.executionBias, wob.executionBias);
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
  workerPromptsOverride?: Record<string, string>,
): SolutionDetail {
  const dir = solutionDir(deps, spec.slug);
  let tenantPrompt: string | null = tenantPromptOverride ?? null;
  if (tenantPromptOverride === undefined && spec.mainAgent.tenantPromptPath) {
    tenantPrompt = safeRead(path.join(dir, spec.mainAgent.tenantPromptPath));
  }
  // Worker prompts: prefer the in-memory override (used by the
  // `current` mirror, which isn't persisted to disk so the
  // sidecars don't exist), else read each worker's SOUL sidecar.
  const workerPrompts: Record<string, string> = {};
  if (workerPromptsOverride) {
    Object.assign(workerPrompts, workerPromptsOverride);
  } else {
    for (const w of spec.workers) {
      if (w.systemPromptPath) {
        const body = safeRead(path.join(dir, w.systemPromptPath));
        if (body !== null) workerPrompts[w.slug] = body;
      }
    }
  }
  // Resolve override sidecars + custom fragment bodies so the
  // block builder can show overridden text + custom blocks.
  const ov = spec.mainAgent.overrides ?? {
    executionBias: null,
    replyStyle: null,
    userOnboarding: null,
  };
  const overrideText = {
    executionBias: ov.executionBias
      ? safeRead(path.join(dir, ov.executionBias))
      : null,
    replyStyle: ov.replyStyle ? safeRead(path.join(dir, ov.replyStyle)) : null,
    userOnboarding: ov.userOnboarding
      ? safeRead(path.join(dir, ov.userOnboarding))
      : null,
  };
  const customFragments = (spec.mainAgent.customFragments ?? []).map((f) => ({
    id: f.id,
    title: f.title,
    body: safeRead(path.join(dir, f.path)) ?? "",
  }));
  // Resolve each worker's host-block override sidecars so the
  // worker view can show overridden text on the editable block.
  const workerOverrideText: Record<string, { executionBias: string | null }> =
    {};
  for (const w of spec.workers) {
    const eb = w.overrides?.executionBias
      ? safeRead(path.join(dir, w.overrides.executionBias))
      : null;
    workerOverrideText[w.slug] = { executionBias: eb };
  }
  const view = buildMainView(deps, userId, {
    tenantPrompt,
    overrideText,
    customFragments,
    workerOverrideText,
  });
  return {
    spec,
    tenantPrompt,
    workerPrompts,
    mainBlocks: view.blocks,
    workerViews: view.workerViews,
    availablePlugins: view.availablePlugins,
    availableSkills: view.availableSkills,
    availableTools: view.availableTools,
    isCurrent: spec.slug === CURRENT_SLUG,
    isActive: spec.slug !== CURRENT_SLUG && getActiveSlug(deps) === spec.slug,
  };
}

/** Build the main-agent view (block list + skill/tool catalogues)
 *  for the Solution editor in one snapshot pass. Read-only host /
 *  plugin blocks come from current reality as reference; the
 *  editable tenant-prompt block carries the solution's own value
 *  when set. The catalogues drive the deny picker — plugin/host
 *  entries are locked, tenant-owned ones are excludable. */
function buildMainView(
  deps: StoreDeps,
  userId: string,
  edits: {
    tenantPrompt: string | null;
    overrideText: {
      executionBias: string | null;
      replyStyle: string | null;
      userOnboarding: string | null;
    };
    customFragments: Array<{ id: string; title: string; body: string }>;
    /** Per-worker host-block override bodies, keyed by worker slug.
     *  null = host default. */
    workerOverrideText?: Record<string, { executionBias: string | null }>;
  },
): {
  blocks: SolutionPromptBlock[];
  availableSkills: SolutionResourceOption[];
  availableTools: SolutionResourceOption[];
  workerViews: Record<string, SolutionWorkerView>;
  availablePlugins: SolutionPluginOption[];
} {
  const snap = buildWorkforceSnapshot({
    ctx: deps.ctx,
    userId,
    pluginRegistry: deps.pluginRegistry,
    tianshuVersion: deps.tianshuVersion,
  });
  // Map reality block kinds to the override key they persist
  // under. Only these host blocks are overridable (Yu's list:
  // execution bias, reply style, user onboarding).
  const overridableKind: Record<
    string,
    "executionBias" | "replyStyle" | "userOnboarding"
  > = {
    "execution-bias": "executionBias",
    "reply-style": "replyStyle",
    "user-onboarding": "userOnboarding",
  };
  const blocks: SolutionPromptBlock[] = [];
  for (const b of snap.main.blocks) {
    if (b.kind === "workspace-context") {
      blocks.push({
        kind: "tenant-prompt",
        title: "Main agent prompt (tenant override)",
        source: "tenant",
        origin: "tenant",
        editable: true,
        text: edits.tenantPrompt ?? b.text,
        note: "Editable. This text is injected into the main agent prompt for this solution.",
      });
      continue;
    }
    const ovKey = overridableKind[b.kind];
    if (ovKey) {
      const override = edits.overrideText[ovKey];
      const overridden = override !== null && override !== undefined;
      blocks.push({
        kind: b.kind,
        title: b.title,
        source: "host",
        origin: "host",
        editable: true,
        text: overridden ? override : b.text,
        defaultText: b.text,
        overrideKey: ovKey,
        overridden,
        note: overridden
          ? "Overridden for this solution. Reset to fall back to the host default."
          : "Host default. Click Override to replace it for this solution.",
      });
      continue;
    }
    blocks.push({
      kind: b.kind,
      title: b.title,
      source: b.source,
      origin: b.origin,
      editable: false,
      text: b.text,
      note: b.note,
    });
  }
  // Append user-authored custom fragments as their own editable
  // blocks at the end of the main-agent prompt.
  for (const f of edits.customFragments) {
    blocks.push({
      kind: "custom-fragment",
      title: f.title || "Custom fragment",
      source: "tenant",
      origin: "tenant",
      editable: true,
      text: f.body,
      customFragmentId: f.id,
      note: "Custom fragment you added. Injected into the main agent prompt for this solution.",
    });
  }
  // A resource is "locked" (can't be excluded) ONLY when it comes
  // from a plugin — built-in or tenant-installed. Yu: "anything
  // that isn't from a plugin can be excluded." So core / host
  // tools and tenant-authored skills are all excludable; only
  // plugin contributions are pinned in.
  //
  // Caveat: tenant-authored skills are bucketed under
  // "tenant-plugin" in resolveOrigin (the WorkforceOrigin enum
  // has no dedicated tenant-owned value yet), which would
  // wrongly lock them. We special-case the synthetic tenant-*
  // skill source ids by passing the real pluginId in here and
  // treating tenant-authored ones as unlocked.
  const lockedOrigin = (o: string, pluginId: string): boolean => {
    if (pluginId.startsWith("tenant-")) return false; // tenant-authored
    return o === "builtin-plugin" || o === "tenant-plugin";
  };
  const availableSkills: SolutionResourceOption[] = snap.main.skills
    .map((s) => ({
      name: s.name,
      description: s.description,
      origin: normaliseOrigin(s.origin),
      pluginId: s.pluginId,
      locked: lockedOrigin(s.origin, s.pluginId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const availableTools: SolutionResourceOption[] = snap.main.tools
    .map((t) => ({
      name: t.name,
      description: t.description,
      origin: normaliseOrigin(t.origin),
      pluginId: t.pluginId,
      locked: lockedOrigin(t.origin, t.pluginId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Per-worker views: reuse each worker's snapshot block list +
  // its own tool/skill catalogue. The SOUL block is editable; the
  // rest mirror reality (read-only host/plugin reference). The
  // deny pickers operate on the worker's own effective set.
  const workerViews: Record<string, SolutionWorkerView> = {};
  for (const w of snap.workers) {
    const wOverride = edits.workerOverrideText?.[w.slug]?.executionBias ?? null;
    workerViews[w.slug] = {
      blocks: w.blocks.map((b) => {
        // Worker SOUL block: editable persona text.
        if (b.kind === "worker-soul") {
          return {
            kind: b.kind,
            title: b.title,
            source: b.source,
            origin: b.origin,
            editable: true,
            text: b.text,
            note: b.note,
          };
        }
        // Worker execution-bias: per-worker overridable host block
        // (B model — independent of the main agent's override).
        if (b.kind === "execution-bias") {
          const overridden = wOverride !== null && wOverride !== undefined;
          return {
            kind: b.kind,
            title: b.title,
            source: "host",
            origin: "host",
            editable: true,
            text: overridden ? wOverride : b.text,
            defaultText: b.text,
            overrideKey: "executionBias" as const,
            overridden,
            note: overridden
              ? "Overridden for this worker. Reset to fall back to the host default."
              : "Host default (same text the main agent gets). Override to customise it for this worker only.",
          };
        }
        // Everything else stays read-only reference.
        return {
          kind: b.kind,
          title: b.title,
          source: b.source,
          origin: b.origin,
          editable: false,
          text: b.text,
          note: b.note,
        };
      }),
      availableSkills: w.skills
        .map((s) => ({
          name: s.name,
          description: s.description,
          origin: normaliseOrigin(s.origin),
          pluginId: s.pluginId,
          locked: lockedOrigin(s.origin, s.pluginId),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      availableTools: w.tools
        .map((t) => ({
          name: t.name,
          description: t.description,
          origin: normaliseOrigin(t.origin),
          pluginId: t.pluginId,
          locked: lockedOrigin(t.origin, t.pluginId),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  const availablePlugins: SolutionPluginOption[] = snap.plugins
    .map((p) => ({
      id: p.id,
      displayName: p.displayName,
      description: p.description,
      origin: p.origin,
      state: p.state,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    blocks,
    availableSkills,
    availableTools,
    workerViews,
    availablePlugins,
  };
}

function normaliseOrigin(
  o: string,
): "core" | "builtin-plugin" | "tenant-plugin" | "host" {
  if (
    o === "core" ||
    o === "builtin-plugin" ||
    o === "tenant-plugin" ||
    o === "host"
  ) {
    return o;
  }
  return "host";
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
  const activeSlug = getActiveSlug(deps);
  const out: SolutionSummary[] = [];
  // Always surface `current` first, materialising it on the fly.
  const current = extractSolution(deps, userId, {
    slug: CURRENT_SLUG,
    name: "Current (live mirror)",
    description: "Auto-extracted snapshot of the running system.",
  });
  out.push(toSummary(current.spec, true, false));

  if (fs.existsSync(root)) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === CURRENT_SLUG) continue;
      if (e.name.startsWith(".")) continue;
      const spec = readSpec(deps, e.name);
      if (spec) out.push(toSummary(spec, false, spec.slug === activeSlug));
    }
  }
  // Named solutions sorted by recency; `current` stays pinned at
  // the top regardless.
  const [head, ...rest] = out;
  rest.sort((a, b) => b.updatedAt - a.updatedAt);
  return head ? [head, ...rest] : rest;
}

function toSummary(
  spec: SolutionSpec,
  isCurrent: boolean,
  isActive: boolean,
): SolutionSummary {
  return {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    updatedAt: spec.updatedAt,
    workerCount: spec.workers.length,
    pluginCount: spec.plugins.enabled.length,
    isCurrent,
    isActive,
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
  // Pass the extracted tenantPrompt + workerPrompts through so the
  // block builder shows them directly (the live mirror isn't on
  // disk to re-read).
  return resolveDetail(deps, userId, spec, tenantPrompt, workerPrompts);
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
  // Validate custom fragments up front. Previously a fragment with a
  // missing/empty `body` (e.g. a client that sent `{title, text}`
  // instead of `{id, title, body}`) was silently dropped by the
  // `.filter(nonEmpty(f.body))` below — the save "succeeded" but the
  // fragment vanished, only discoverable by diffing the round-trip.
  // Fail loudly instead so the caller (Studio HTTP → 4xx JSON, or the
  // agent `solution` tool → error text) learns exactly what's wrong.
  validateCustomFragmentsInput(input.mainAgent.customFragments);
  const existing = readSpec(deps, input.slug);
  const now = Date.now();
  const workerPrompts: Record<string, string> = {};
  const workerOverrideBodies: Record<
    string,
    { executionBias: string | null }
  > = {};
  const nonEmptyStr = (s: string | null | undefined): boolean =>
    !!s && s.trim().length > 0;
  const workers: SolutionWorker[] = input.workers.map((w) => {
    const hasPrompt = !!w.systemPrompt && w.systemPrompt.trim().length > 0;
    if (hasPrompt) workerPrompts[w.slug] = w.systemPrompt!;
    // Per-worker host-block override: non-empty body → override
    // (sidecar path), else host default (null).
    const ebBody = w.overrides?.executionBias ?? null;
    const hasEb = nonEmptyStr(ebBody);
    workerOverrideBodies[w.slug] = { executionBias: ebBody };
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
      overrides: {
        executionBias: hasEb
          ? `workers/${w.slug}/execution-bias.md`
          : null,
      },
      source: w.source,
    };
  });
  const hasTenantPrompt =
    !!input.mainAgent.tenantPrompt &&
    input.mainAgent.tenantPrompt.trim().length > 0;
  // Host-block overrides: a non-empty body means "override this
  // block"; empty / null falls back to the host default (path
  // null).
  const ovIn = input.mainAgent.overrides;
  const nonEmpty = (s: string | null): boolean =>
    !!s && s.trim().length > 0;
  const overrides = {
    executionBias: nonEmpty(ovIn.executionBias)
      ? "main-agent/execution-bias.md"
      : null,
    replyStyle: nonEmpty(ovIn.replyStyle)
      ? "main-agent/reply-style.md"
      : null,
    userOnboarding: nonEmpty(ovIn.userOnboarding)
      ? "main-agent/user-onboarding.md"
      : null,
  };
  // Custom fragments: drop any with an empty body. id is the
  // stable slug supplied by the UI; sanitise it for fs safety.
  const fragmentBodies: Record<string, string> = {};
  const customFragments = input.mainAgent.customFragments
    .filter((f) => nonEmpty(f.body))
    .map((f) => {
      const id = sanitiseFragmentId(f.id);
      fragmentBodies[id] = f.body;
      return {
        id,
        title: f.title || id,
        path: `main-agent/fragments/${id}.md`,
      };
    });
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
      toolsDeny: input.mainAgent.toolsDeny,
      overrides,
      customFragments,
    },
    workers,
  };
  writeSolution(
    deps,
    spec,
    hasTenantPrompt ? input.mainAgent.tenantPrompt : null,
    workerPrompts,
    {
      overrideBodies: {
        executionBias: ovIn.executionBias,
        replyStyle: ovIn.replyStyle,
        userOnboarding: ovIn.userOnboarding,
      },
      fragmentBodies,
      workerOverrideBodies,
    },
  );
  return resolveDetail(deps, userId, spec);
}

/**
 * Validate the `customFragments` array of a SolutionSpecInput before
 * save. Throws a precise, caller-facing error instead of letting a
 * malformed fragment be silently filtered out downstream.
 *
 * Required per item: a non-empty `id` (stable slug) and a non-empty
 * `body` (the fragment text). We special-case the historically common
 * mistake of sending `text` instead of `body` so the message is
 * actionable rather than a generic "body required".
 */
export function validateCustomFragmentsInput(
  fragments: SolutionSpecInput["mainAgent"]["customFragments"] | undefined,
): void {
  if (fragments == null) return;
  if (!Array.isArray(fragments)) {
    throw new Error(
      "mainAgent.customFragments must be an array of { id, title, body }.",
    );
  }
  fragments.forEach((f, i) => {
    const where = `mainAgent.customFragments[${i}]`;
    if (f == null || typeof f !== "object") {
      throw new Error(`${where} must be an object { id, title, body }.`);
    }
    const rec = f as Record<string, unknown>;
    const hasBody = typeof rec.body === "string" && rec.body.trim().length > 0;
    // Wrong field name is the usual culprit (clients guessing the
    // shape). Detect `text`/`content` and point at the fix directly.
    if (!hasBody) {
      const misnamed = ["text", "content", "value"].find(
        (k) => typeof rec[k] === "string" && (rec[k] as string).trim().length > 0,
      );
      if (misnamed) {
        throw new Error(
          `${where} uses "${misnamed}" for the fragment text; the field must be "body". ` +
            `Expected shape: { id, title, body }.`,
        );
      }
      throw new Error(
        `${where} is missing a non-empty "body". Expected shape: { id, title, body }. ` +
          `To drop a fragment, omit it from the array entirely.`,
      );
    }
    if (typeof rec.id !== "string" || rec.id.trim().length === 0) {
      throw new Error(
        `${where} is missing a non-empty "id" (a stable slug used for the ` +
          `fragment's sidecar filename). Expected shape: { id, title, body }.`,
      );
    }
  });
}

function sanitiseFragmentId(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned.length > 0 ? cleaned : `frag-${Date.now()}`;
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
  // If the deleted solution was active, clear the pointer.
  if (getActiveSlug(deps) === slug) {
    try {
      fs.rmSync(activePointerPath(deps), { force: true });
    } catch {
      /* best effort */
    }
  }
}

// ─── diff ──────────────────────────────────────────────────────

/** Apply a named solution to reality (ADR-0008 Phase 3,
 *  non-destructive subset). Writes the main-agent config (prompt
 *  override + host-block overrides + custom fragments + skill/
 *  tool deny) and each worker's files (agent.json + SOUL.md)
 *  back into the tenant config tree. The chat path + worker
 *  loader read these every turn, so it takes effect without a
 *  restart. Does NOT touch plugin enable/disable (Phase 4). */
export async function applySolution(
  deps: StoreDeps,
  userId: string,
  slug: string,
): Promise<{ ok: true; appliedWorkers: string[] }> {
  if (slug === CURRENT_SLUG) {
    throw new Error("the `current` mirror is reality — nothing to apply");
  }
  assertValidSlug(slug);
  const detail = getSolution(deps, userId, slug);
  if (!detail) throw new Error(`solution "${slug}" not found`);
  const { spec, tenantPrompt, workerPrompts } = detail;
  const home = deps.ctx.home;
  const tenantId = deps.ctx.tenantId;

  // --- Main-agent config ---
  const mainDir = getTenantMainConfigDir(tenantId, home);
  fs.mkdirSync(mainDir, { recursive: true });
  const writeMain = (rel: string, body: string) => {
    const p = path.join(mainDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
  };
  const dir = solutionDir(deps, slug);
  const ov = spec.mainAgent.overrides;
  const readSol = (rel: string | null): string | null =>
    rel ? safeRead(path.join(dir, rel)) : null;
  const executionBias = readSol(ov?.executionBias ?? null);
  const replyStyle = readSol(ov?.replyStyle ?? null);
  const userOnboarding = readSol(ov?.userOnboarding ?? null);

  if (tenantPrompt && tenantPrompt.trim()) writeMain("prompt.md", tenantPrompt);
  if (executionBias) writeMain("execution-bias.md", executionBias);
  if (replyStyle) writeMain("reply-style.md", replyStyle);
  if (userOnboarding) writeMain("user-onboarding.md", userOnboarding);
  const fragmentEntries = (spec.mainAgent.customFragments ?? []).map((f) => {
    const body = readSol(f.path) ?? "";
    if (body.trim()) writeMain(`fragments/${f.id}.md`, body);
    return { id: f.id, title: f.title, path: `fragments/${f.id}.md`, body };
  });
  const mainAgentJson = {
    schema: "tianshu.main-agent.v1" as const,
    tenantPromptPath:
      tenantPrompt && tenantPrompt.trim() ? "prompt.md" : null,
    overrides: {
      executionBias: executionBias ? "execution-bias.md" : null,
      replyStyle: replyStyle ? "reply-style.md" : null,
      userOnboarding: userOnboarding ? "user-onboarding.md" : null,
    },
    customFragments: fragmentEntries
      .filter((f) => f.body.trim())
      .map((f) => ({ id: f.id, title: f.title, path: f.path })),
    skillsDeny: spec.mainAgent.skillsDeny ?? [],
    toolsDeny: spec.mainAgent.toolsDeny ?? [],
  };
  writeMain("main-agent.json", JSON.stringify(mainAgentJson, null, 2));

  // --- Workers ---
  const workersRoot = path.join(getTenantConfigDir(tenantId, home), "workers");
  const appliedWorkers: string[] = [];
  for (const w of spec.workers) {
    const wDir = path.join(workersRoot, w.slug);
    fs.mkdirSync(wDir, { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(path.join(wDir, "agent.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") existing = parsed;
    } catch {
      /* fresh worker */
    }
    // Per-worker host-block override: read the solution sidecar and
    // write it into the worker's live config dir; record a pointer
    // in agent.json so the runtime loader can find it. Empty / no
    // override clears the pointer (falls back to host default).
    const ebBody = readSol(w.overrides?.executionBias ?? null);
    const hasEb = !!ebBody && ebBody.trim().length > 0;
    if (hasEb) {
      fs.writeFileSync(path.join(wDir, "execution-bias.md"), ebBody, "utf8");
    } else {
      // Drop a stale override file so reverting an override on
      // re-apply actually reverts behaviour.
      try {
        fs.rmSync(path.join(wDir, "execution-bias.md"), { force: true });
      } catch {
        /* ignore */
      }
    }
    const agentJson = {
      ...existing,
      kind: w.kind,
      displayName: w.name,
      description: w.description,
      modelId: w.modelId,
      enabled: w.enabled,
      toolsAllow: w.toolsAllow,
      skillsAllow: w.skillsAllow,
      overrides: { executionBias: hasEb ? "execution-bias.md" : null },
      source: w.source,
    };
    fs.writeFileSync(
      path.join(wDir, "agent.json"),
      JSON.stringify(agentJson, null, 2),
      "utf8",
    );
    const soul = workerPrompts[w.slug];
    if (soul && soul.trim()) {
      fs.writeFileSync(path.join(wDir, "SOUL.md"), soul, "utf8");
    }
    appliedWorkers.push(w.slug);
  }

  // --- Plugins (enable/disable per the solution) ---
  // Write the solution's plugin enable-set into tenant config: any
  // plugin in spec.plugins.enabled → enabled:true, every other
  // known plugin → enabled:false. Dependency edges are NOT
  // considered (per Yu: just apply the config as-is). Then
  // invalidate the registry so the change takes effect.
  const wanted = new Set(spec.plugins.enabled);
  const cfg = loadTenantConfig(tenantId, home);
  const plugins: Record<
    string,
    { enabled?: boolean; config?: Record<string, unknown> }
  > = { ...(cfg.plugins ?? {}) };
  // Every plugin the studio knows about (from the snapshot's
  // availablePlugins, surfaced on the solution). Flip each to the
  // solution's intent.
  const known = new Set<string>([
    ...Object.keys(plugins),
    ...spec.plugins.enabled,
  ]);
  for (const id of known) {
    const existing = plugins[id] ?? {};
    plugins[id] = { ...existing, enabled: wanted.has(id) };
  }
  writeTenantConfig(tenantId, { ...cfg, plugins }, home);
  await deps.pluginRegistry.invalidate(tenantId);

  return { ok: true, appliedWorkers };
}

/** Activate a solution: apply its config to reality AND mark it
 *  as the live one (the `.active` pointer). User-facing "go
 *  live" action. */
export async function activateSolution(
  deps: StoreDeps,
  userId: string,
  slug: string,
): Promise<{ ok: true; appliedWorkers: string[]; activeSlug: string }> {
  const result = await applySolution(deps, userId, slug);
  setActiveSlug(deps, slug);
  return { ...result, activeSlug: slug };
}

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
    m["mainAgent.skillsDeny"] = JSON.stringify([...s.mainAgent.skillsDeny].sort());
    m["mainAgent.toolsAllow"] = JSON.stringify(s.mainAgent.toolsAllow);
    m["mainAgent.toolsDeny"] = JSON.stringify([...(s.mainAgent.toolsDeny ?? [])].sort());
    // Override presence (not bodies — we diff structure, not
    // prose) + custom fragment ids.
    const ov = s.mainAgent.overrides;
    m["mainAgent.overrides.executionBias"] = ov?.executionBias ? "set" : "";
    m["mainAgent.overrides.replyStyle"] = ov?.replyStyle ? "set" : "";
    m["mainAgent.overrides.userOnboarding"] = ov?.userOnboarding ? "set" : "";
    m["mainAgent.customFragments"] = JSON.stringify(
      (s.mainAgent.customFragments ?? []).map((f) => f.id).sort(),
    );
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
      // Override presence (structure, not prose) for the worker's
      // host blocks.
      m[`${k}.overrides.executionBias`] = w.overrides?.executionBias
        ? "set"
        : "";
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
