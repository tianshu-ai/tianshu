// Build a read-only snapshot of one tenant's agent configuration
// for the Workforce Studio plugin.
//
// We compose the same pieces the runtime composes when it actually
// runs a turn (system prompt builder, tool registry, skill loader,
// worker fs loader) so the studio shows what the model actually
// sees — not an idealised contract document.
//
// Kept inside packages/server/ rather than the studio plugin so
// the plugin doesn't pull in `pluginRegistry` / `ctx` internals;
// instead it gets a clean capability surface
// (`host.workforceSnapshot.build()`) registered in index.ts.

import fs from "node:fs";
import path from "node:path";

import type {
  WorkforceOrigin,
  WorkforcePluginInfo,
  WorkforceSkillEntry,
  WorkforceSnapshot,
  WorkforceToolEntry,
  WorkforceWorkerAgent,
} from "@tianshu-ai/plugin-sdk";

import type { TenantContext } from "../core/index.js";
import {
  type WorkerAgentFsRecord,
  loadWorkerAgents,
} from "../core/worker-agents-fs.js";
import { defaultSystemPrompt } from "../chat/system-prompt.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import type { LoadedSkill } from "../core/plugins/skills.js";

interface BuildSnapshotArgs {
  ctx: TenantContext;
  userId: string;
  pluginRegistry: PluginRegistry;
  tianshuVersion: string;
}

/**
 * Build a {@link WorkforceSnapshot} for the calling user.
 *
 * Why we compose vs. expose helpers individually:
 *
 *   - `pluginRegistry.toolsForTenant()` already filters for active
 *     plugins; we just attach `since` from `toolCatalogForTenant()`
 *     so the studio can display "since 0.3.42" badges.
 *   - `pluginRegistry.skillsForTenant()` already returns LoadedSkill
 *     entries with the full body kept in memory, so the studio can
 *     dump real file contents into its zip export without us
 *     re-reading the fs.
 *   - Worker prompt composition (`req.systemPrompt` branch in
 *     agent-loop.ts) is more involved than the host default — for
 *     Phase 1 we report the worker's stored SOUL.md as-is and tag
 *     it as the "static" prompt. A full "runtime-composed" worker
 *     prompt requires extracting the worker-prompt builder, which
 *     is Phase 2 work. The README in the zip warns about this.
 */
export function buildWorkforceSnapshot(
  args: BuildSnapshotArgs,
): WorkforceSnapshot {
  const { ctx, userId, pluginRegistry, tianshuVersion } = args;

  // --- Plugin inventory (drives the provenance bucket for each
  //     tool/skill, and is itself surfaced in the studio so an
  //     operator can see what's actually installed).
  const entries = pluginRegistry.listForTenant(ctx.tenantId);
  const originByPlugin = new Map<string, WorkforceOrigin>();
  originByPlugin.set("core", "core");
  for (const e of entries) {
    originByPlugin.set(
      e.manifest.id,
      e.source === "builtin" ? "builtin-plugin" : "tenant-plugin",
    );
  }
  const resolveOrigin = (pluginId: string): WorkforceOrigin =>
    originByPlugin.get(pluginId) ?? "core";

  // --- Tool catalog (with since metadata) ---
  const catalog = pluginRegistry.toolCatalogForTenant(ctx.tenantId);
  const sinceByName = new Map<string, string | null>();
  for (const c of catalog) sinceByName.set(c.toolName, c.since ?? null);

  const toolsAll: WorkforceToolEntry[] = pluginRegistry
    .toolsForTenant(ctx.tenantId)
    .map(({ pluginId, tool }) => ({
      name: tool.schema.name,
      description:
        typeof tool.schema.description === "string"
          ? tool.schema.description
          : "",
      // tool.schema.parameters is JSON-schema-shaped; cast to
      // unknown so the SDK type doesn't pull in the agent-core
      // schema namespace.
      parameters: (tool.schema as { parameters?: unknown }).parameters ?? null,
      pluginId,
      since: sinceByName.get(tool.schema.name) ?? null,
      origin: resolveOrigin(pluginId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // --- Skills (with body) ---
  const allSkills = pluginRegistry.skillsForTenant(ctx.tenantId);
  const skillsAll: WorkforceSkillEntry[] = allSkills.map((s) =>
    toSkillEntry(s, resolveOrigin),
  );

  // --- Main agent ---
  // The host doesn't have a one-call helper to assemble plugin
  // fragments + skills + brand for arbitrary callers, but
  // defaultSystemPrompt is itself a pure function over
  // (ctx, userId, skills, fragments). We can pass in the
  // skill catalog directly; plugin fragments are also accessible
  // via the registry.
  const mainSkills = filterScope(allSkills, "main");
  const fragments = pluginRegistry.systemPromptFragmentsForTenant
    ? pluginRegistry.systemPromptFragmentsForTenant(ctx.tenantId)
    : [];
  const mainSystemPrompt = defaultSystemPrompt(
    ctx,
    userId,
    mainSkills,
    fragments,
  );
  const brandName = ctx.config.branding?.name ?? "Tianshu";
  const defaultModelId = ctx.config.defaultModel ?? null;

  // --- Workers ---
  const fsRecords = loadWorkerAgents(ctx.tenantId, ctx.home);
  const workers: WorkforceWorkerAgent[] = fsRecords.map((r) =>
    toWorkerEntry(r, toolsAll, skillsAll),
  );

  // --- Plugin inventory rows ---
  // We count tools/skills per plugin so the studio can show a
  // "weight" ("contributes 12 tools, 4 skills"). The counts are
  // derived from the same catalogs the agent sees, not the
  // manifest's declared contributes[] — a plugin can declare
  // tools that fail to register (missing module export) and we
  // want to surface what actually made it through.
  const toolCountByPlugin = new Map<string, number>();
  for (const t of toolsAll) {
    toolCountByPlugin.set(
      t.pluginId,
      (toolCountByPlugin.get(t.pluginId) ?? 0) + 1,
    );
  }
  const skillCountByPlugin = new Map<string, number>();
  for (const s of skillsAll) {
    skillCountByPlugin.set(
      s.pluginId,
      (skillCountByPlugin.get(s.pluginId) ?? 0) + 1,
    );
  }
  const plugins: WorkforcePluginInfo[] = entries
    .map((e) => ({
      id: e.manifest.id,
      displayName: e.manifest.displayName ?? e.manifest.id,
      version: e.manifest.version ?? "0.0.0",
      description: e.manifest.description ?? "",
      origin:
        e.source === "builtin"
          ? ("builtin-plugin" as const)
          : ("tenant-plugin" as const),
      // Map the registry's PluginState onto a closed enum the SDK
      // can present. "loading" only appears mid-activation; by
      // the time we read the entry it's almost always settled.
      state: mapPluginState(e.state),
      failureReason: e.state === "failed" ? e.failedReason ?? null : null,
      toolCount: toolCountByPlugin.get(e.manifest.id) ?? 0,
      skillCount: skillCountByPlugin.get(e.manifest.id) ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    tenantId: ctx.tenantId,
    userId,
    generatedAt: Date.now(),
    tianshuVersion,
    plugins,
    main: {
      brandName,
      defaultModelId,
      systemPrompt: mainSystemPrompt,
      tools: toolsAll, // main sees the full catalog
      skills: mainSkills.map((s) => toSkillEntry(s, resolveOrigin)),
    },
    workers,
  };
}

function mapPluginState(
  state: string,
): "active" | "failed" | "disabled" | "loading" {
  if (state === "active" || state === "failed" || state === "disabled") {
    return state;
  }
  return "loading";
}

function filterScope(
  skills: readonly LoadedSkill[],
  audience: "main" | "worker",
): LoadedSkill[] {
  return skills.filter((s) => !s.scope || s.scope === audience);
}

function toSkillEntry(
  s: LoadedSkill,
  resolveOrigin: (pluginId: string) => WorkforceOrigin,
): WorkforceSkillEntry {
  return {
    name: s.name,
    description: s.description,
    pluginId: s.source.pluginId,
    scope: s.scope,
    // Make the export-relative path predictable. Strip a leading
    // absolute path prefix so the zip layout reads like
    // `skills/<pluginId>/<contributionId>.md`. The original
    // filePath is still useful for debugging — keep the file name
    // so callers can correlate, but a stable shape matters more.
    relativePath: `${s.source.pluginId}/${path.basename(s.filePath)}`,
    body: s.body ?? safeReadFile(s.filePath),
    origin: resolveOrigin(s.source.pluginId),
  };
}

function safeReadFile(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (err) {
    return `<!-- failed to read ${p}: ${
      err instanceof Error ? err.message : String(err)
    } -->`;
  }
}

function toWorkerEntry(
  r: WorkerAgentFsRecord,
  toolsAll: readonly WorkforceToolEntry[],
  skillsAll: readonly WorkforceSkillEntry[],
): WorkforceWorkerAgent {
  const spec = r.spec;
  const toolsAllow = spec.toolsAllow ?? null;
  // null toolsAllow = "no restriction"; otherwise filter the host
  // catalog down to what's listed. WORKER_DENY_TOOLS isn't applied
  // here yet because that list is owned by the workboard plugin —
  // Phase 2 will surface it via a new capability.
  const tools =
    toolsAllow === null
      ? toolsAll.slice()
      : toolsAll.filter((t) => toolsAllow.includes(t.name));
  const skillsAllow = spec.skillsAllow ?? null;
  const skills =
    skillsAllow === null
      ? // Workers see worker-scoped + unscoped skills.
        skillsAll.filter((s) => !s.scope || s.scope === "worker")
      : skillsAll.filter((s) => skillsAllow.includes(s.name));
  return {
    slug: r.slug,
    name: spec.displayName ?? r.slug,
    description: spec.description ?? null,
    kind: spec.kind ?? "unknown",
    source: spec.source ?? "user",
    enabled: spec.enabled !== false,
    modelId: spec.modelId ?? null,
    systemPrompt: r.systemPrompt ?? "",
    tools,
    skills,
  };
}
