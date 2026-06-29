// Build a read-only snapshot of one tenant's agent configuration
// for the Workforce Studio plugin.
//
// We compose the same pieces the runtime composes when it actually
// runs a turn (system prompt builder, tool registry, skill loader,
// worker fs loader) so the studio shows what the model actually
// sees — not an idealised contract document.
//
// As of `feat/workforce-studio-views`, the main-agent's system
// prompt is reported in two forms:
//
//   - `blocks: WorkforcePromptBlock[]` — block-by-block, tagged
//     with `source` + `origin` + `editable` so the studio's
//     Develop view can render an editor / read-only structure.
//   - `systemPrompt: string` — exactly the text the model sees
//     on its next turn, produced by `defaultSystemPrompt` and
//     surfaced verbatim in the Rendered view.
//
// We could approximate `systemPrompt` by concatenating the
// blocks here, but we explicitly call the host's renderer so the
// Rendered view stays the source of truth — any future change to
// `defaultSystemPrompt` (separator, ordering, trimming) carries
// over without us having to keep this file in sync.

import fs from "node:fs";
import path from "node:path";

import type {
  WorkforceOrigin,
  WorkforcePluginInfo,
  WorkforcePromptBlock,
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
import {
  defaultSystemPrompt,
  formatAvailableSkillsBlock,
  formatExecutionBiasBlock,
  formatMainAgentContextBlock,
  formatPluginPromptFragments,
  formatRuntimeContextBlock,
  formatUserOnboardingBlock,
  formatWorkerAgentContextBlock,
  userMdExists,
} from "../chat/system-prompt.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import type { LoadedSkill } from "../core/plugins/skills.js";
import { loadTenantSkills } from "../core/tenant-skills.js";

interface BuildSnapshotArgs {
  ctx: TenantContext;
  userId: string;
  pluginRegistry: PluginRegistry;
  tianshuVersion: string;
}

/**
 * Build a {@link WorkforceSnapshot} for the calling user.
 */
export function buildWorkforceSnapshot(
  args: BuildSnapshotArgs,
): WorkforceSnapshot {
  const { ctx, userId, pluginRegistry, tianshuVersion } = args;

  // --- Plugin inventory ---
  const entries = pluginRegistry.listForTenant(ctx.tenantId);
  const originByPlugin = new Map<string, WorkforceOrigin>();
  originByPlugin.set("core", "core");
  for (const e of entries) {
    originByPlugin.set(
      e.manifest.id,
      e.source === "builtin" ? "builtin-plugin" : "tenant-plugin",
    );
  }
  const resolveOrigin = (pluginId: string): WorkforceOrigin => {
    const known = originByPlugin.get(pluginId);
    if (known) return known;
    // Tenant-authored skills carry synthetic source ids like
    // "tenant-shared" / "tenant-main" / "tenant-worker-<slug>"
    // (see core/tenant-skills.ts). They're tenant-owned, not a
    // plugin or host contribution — bucket them as tenant so the
    // studio shows them as editable / excludable.
    if (pluginId.startsWith("tenant-")) return "tenant-plugin";
    return "core";
  };

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
      parameters: (tool.schema as { parameters?: unknown }).parameters ?? null,
      pluginId,
      since: sinceByName.get(tool.schema.name) ?? null,
      origin: resolveOrigin(pluginId),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // --- Skills (with body) ---
  // Mirror what the agent loop actually composes: plugin / host
  // skills (mirrored, with tenant-config paths) PLUS the tenant's
  // own skills under _tenant/config/skills + main/skills. Earlier
  // this only pulled `skillsForTenant` (plugin-only), which is why
  // tenant skills like the seeded `skill-creator` never showed up
  // in the studio even though the agent sees them every turn.
  const pluginSkills = pluginRegistry.mirroredSkillsForTenant(ctx.tenantId);
  const tenantMainSkills = loadTenantSkills({
    tenantId: ctx.tenantId,
    scope: { kind: "main" },
    onFailure: (f) =>
      console.warn(
        `[workforce-snapshot tenant-skills:${f.scope}] ${f.filePath}: ${f.reason}`,
      ),
  });
  // De-dupe by skill name; tenant skills win on collision (same
  // precedence as the agent loop's merge order).
  const skillByName = new Map<string, LoadedSkill>();
  for (const s of pluginSkills) skillByName.set(s.name, s);
  for (const s of tenantMainSkills) skillByName.set(s.name, s);
  const allSkills = [...skillByName.values()];
  const skillsAll: WorkforceSkillEntry[] = allSkills.map((s) =>
    toSkillEntry(s, resolveOrigin),
  );

  // --- Main agent ---
  const mainSkills = filterScope(allSkills, "main");
  const fragments = pluginRegistry.systemPromptFragmentsForTenant(ctx.tenantId);
  const fragmentsByPlugin = new Map<
    string,
    { pluginDisplayName: string; texts: string[] }
  >();
  for (const f of fragments) {
    const cur = fragmentsByPlugin.get(f.pluginId);
    if (cur) {
      cur.texts.push(f.text);
    } else {
      fragmentsByPlugin.set(f.pluginId, {
        pluginDisplayName: f.pluginDisplayName,
        texts: [f.text],
      });
    }
  }
  const brandName = ctx.config.branding?.name ?? "Tianshu";
  const defaultModelId = ctx.config.defaultModel ?? null;
  const userHomeDir = ctx.userHomeDir(userId);

  // Rendered prompt — the literal text the model sees. We hand
  // this off to `defaultSystemPrompt` rather than reconstructing
  // it from blocks so the Rendered view doesn't drift if the
  // host's renderer changes spacing / ordering / trimming.
  const renderedSystemPrompt = defaultSystemPrompt(
    ctx,
    userId,
    mainSkills,
    fragments,
  );

  // Block decomposition — same ordering `defaultSystemPrompt`
  // emits, called out into individually-labelled chunks so the
  // Develop view can render them as an accordion with origin /
  // editable badges.
  const blocks: WorkforcePromptBlock[] = [];
  blocks.push({
    kind: "brand",
    title: "Brand intro",
    source: "host",
    origin: "host",
    editable: false,
    text: `You are ${brandName}, an open-source AI assistant.`,
    note: "Generated from the tenant's branding config — change the brand name via tenant config.",
  });
  blocks.push({
    kind: "runtime-context",
    title: "Runtime context",
    source: "host",
    origin: "host",
    editable: false,
    text: formatRuntimeContextBlock({ tenantId: ctx.tenantId, userId }),
    note: "Time, timezone, host OS, tenant + user identity. Refreshed every turn at runtime.",
  });
  blocks.push({
    kind: "execution-bias",
    title: "Execution bias",
    source: "host",
    origin: "host",
    editable: false,
    text: formatExecutionBiasBlock(),
    note: "Host-level behaviour rules — same text the workers receive.",
  });
  const ctxBlock = formatMainAgentContextBlock(ctx.workspaceDir, userHomeDir);
  if (ctxBlock) {
    blocks.push({
      kind: "workspace-context",
      title: "Workspace context",
      source: "workspace",
      origin: "workspace",
      editable: true,
      text: ctxBlock,
      note: "Sourced from the tenant's _tenant/AGENTS.md / SOUL.md / MEMORY.md + the user's USER.md. Edit the underlying files to change.",
    });
  }
  blocks.push({
    kind: "reply-style",
    title: "Reply-style rule",
    source: "host",
    origin: "host",
    editable: false,
    text: `Reply concisely. When you make changes, briefly say what you changed.`,
  });
  // One block per plugin fragment, so the studio shows the
  // tenant exactly which plugin contributed which paragraph.
  for (const [pluginId, info] of fragmentsByPlugin) {
    const text = formatPluginPromptFragments(
      fragments.filter((f) => f.pluginId === pluginId),
    );
    if (!text) continue;
    blocks.push({
      kind: "plugin-fragment",
      title: `${info.pluginDisplayName} guidance`,
      source: `plugin:${pluginId}`,
      origin: resolveOrigin(pluginId),
      editable: false,
      text,
      note: `Managed by plugin \`${pluginId}\` — disable the plugin to drop these rules.`,
    });
  }
  const skillsBlock = formatAvailableSkillsBlock(mainSkills);
  if (skillsBlock) {
    blocks.push({
      kind: "available-skills",
      title: "Available skills catalogue",
      source: "host",
      origin: "host",
      editable: false,
      text: skillsBlock,
      note: "Auto-generated from every enabled skill. Toggle individual skills in the Skills panel.",
    });
  }
  blocks.push({
    kind: "user-onboarding",
    title: "User onboarding rule",
    source: "host",
    origin: "host",
    editable: false,
    text: formatUserOnboardingBlock(userMdExists(userHomeDir)),
    note: "Curates the per-user USER.md file. Behaviour adapts to whether USER.md is populated.",
  });

  // --- Workers ---
  const fsRecords = loadWorkerAgents(ctx.tenantId, ctx.home);
  const workers: WorkforceWorkerAgent[] = fsRecords.map((r) =>
    toWorkerEntry(r, toolsAll, skillsAll, ctx, userId),
  );

  // --- Plugin inventory rows ---
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
      blocks,
      systemPrompt: renderedSystemPrompt,
      tools: toolsAll,
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
  ctx: TenantContext,
  userId: string,
): WorkforceWorkerAgent {
  const spec = r.spec;
  const toolsAllow = spec.toolsAllow ?? null;
  const tools =
    toolsAllow === null
      ? toolsAll.slice()
      : toolsAll.filter((t) => toolsAllow.includes(t.name));
  const skillsAllow = spec.skillsAllow ?? null;
  const skills =
    skillsAllow === null
      ? skillsAll.filter((s) => !s.scope || s.scope === "worker")
      : skillsAll.filter((s) => skillsAllow.includes(s.name));

  // Worker block decomposition: SOUL.md (editable) + worker
  // context block (workspace-sourced). The rendered worker
  // prompt is composed in agent-loop.ts and pulls in much more
  // (execution bias, plugin fragments, skill block) — but Phase
  // 1 stays narrow because the worker prompt builder hasn't
  // been refactored out yet.
  const soul = r.systemPrompt ?? "";
  const blocks: WorkforcePromptBlock[] = [];
  if (soul.trim().length > 0) {
    blocks.push({
      kind: "worker-soul",
      title: "Worker SOUL.md",
      source: "workspace",
      origin: "workspace",
      editable: true,
      text: soul,
      note: `Sourced from _tenant/config/workers/${r.slug}/SOUL.md.`,
    });
  }
  const workerCtxBlock = formatWorkerAgentContextBlock(
    ctx.workspaceDir,
    ctx.userHomeDir(userId),
    r.slug,
  );
  if (workerCtxBlock) {
    blocks.push({
      kind: "worker-context",
      title: "Worker workspace context",
      source: "workspace",
      origin: "workspace",
      editable: true,
      text: workerCtxBlock,
      note: "Sourced from the worker's own AGENTS.md / MEMORY.md + the user's USER.md.",
    });
  }

  return {
    slug: r.slug,
    name: spec.displayName ?? r.slug,
    description: spec.description ?? null,
    kind: spec.kind ?? "unknown",
    source: spec.source ?? "user",
    enabled: spec.enabled !== false,
    modelId: spec.modelId ?? null,
    blocks,
    systemPrompt: soul,
    tools,
    skills,
  };
}
