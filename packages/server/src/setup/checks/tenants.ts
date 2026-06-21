// Tenant + user + plugin enablement topology.
//
// Replaces the "Builtin plugins" section with a more honest view:
//   ✓ tenant 'default'
//      users: dev
//      plugins: files, workboard
//   ✓ tenant 'alpha'
//      users: alice, bob
//      plugins: files
//
// Why this shape: pre-this-commit doctor either listed plugins
// without saying *for whom* (the original `✓ files`) or listed
// plugins by tenant per row (the previous fix). Both leave the
// tenant→user linkage invisible. Users running multi-tenant /
// multi-user installs (the actual purpose of the multi-tenant
// architecture) had to mentally cross-reference Plugin Manager
// UI + tenant config. Cli-agent had no visibility either.
//
// The cli-agent's `run_doctor` returns this same structured shape
// (severity/text/detail), so the agent can answer "what's enabled
// where?" by reading one tool result instead of grepping configs.

import fs from "node:fs";
import path from "node:path";
import { CheckGroup } from "../render.js";
import { getBuiltinConfigDir } from "../../core/plugins/discovery.js";
import {
  loadGlobalConfig,
  loadTenantConfig,
  type PluginsConfig,
  type ProviderEntry,
} from "../../core/config.js";
import { getTianshuHome } from "../../core/paths.js";
import { loadKnownModels } from "./known-models.js";

// Mirror of pi-ai's register-builtins set. Used to validate the
// `api` field on per-tenant provider overrides; the global-level
// check lives in checks/providers.ts and uses the same set
// (intentionally duplicated rather than imported — the two
// checks have different surrounding context and we want them to
// fail / pass independently).
const KNOWN_API_TYPES = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
]);

export interface TenantsCheckOpts {
  /** Override builtinConfig dir (test seam / monorepo dev override). */
  builtinConfigDir?: string;
  /** Override TIANSHU_HOME root for test isolation. */
  home?: string;
}

export function checkTenants(opts: TenantsCheckOpts = {}): CheckGroup {
  const lines: CheckGroup["lines"] = [];
  const home = opts.home ?? getTianshuHome();

  // What plugins are *available* (manifest on disk). We need this
  // both to render unknown-plugin warnings (config references a
  // plugin id that doesn't exist anymore) and to compute the
  // "all available" baseline.
  const availablePlugins = readAvailablePlugins(opts);
  if (availablePlugins.error) {
    lines.push({
      severity: "warning",
      text: "couldn't enumerate plugins",
      detail: availablePlugins.error,
    });
  }
  const availableSet = new Set(availablePlugins.ids);

  // Now the tenants pass.
  const tenantIds = listTenants(home);
  if (tenantIds.length === 0) {
    lines.push({
      severity: "warning",
      text: "no tenants on disk",
      detail:
        "Run `tianshu tenant create default` (or let the wizard auto-create one).",
    });
    return { title: "Tenants & plugins", lines };
  }

  const globalCfg = safeLoadGlobalConfig(home);

  for (const tenantId of tenantIds) {
    const tenantCfg = safeLoadTenantConfig(tenantId, home);
    const merged = mergePlugins(globalCfg.plugins, tenantCfg.plugins);

    const enabled: string[] = [];
    const disabled: string[] = [];
    const unknown: string[] = [];
    for (const [pluginId, entry] of Object.entries(merged)) {
      if (!availableSet.has(pluginId)) {
        unknown.push(pluginId);
        continue;
      }
      if (entry?.enabled === true) enabled.push(pluginId);
      else disabled.push(pluginId);
    }
    // Plugins that exist on disk but aren't mentioned at all in
    // either global or tenant config are effectively disabled.
    // Render them in the disabled bucket so the user (and agent)
    // can see "available but not configured for this tenant".
    for (const id of availablePlugins.ids) {
      if (!(id in merged)) disabled.push(id);
    }

    const users = listUsers(home, tenantId);

    // Header line per tenant.
    lines.push({
      severity: "ok",
      text: `tenant '${tenantId}'`,
      detail: tenantCfg.defaultModel
        ? `defaultModel override: ${tenantCfg.defaultModel}`
        : undefined,
    });

    // Tenant-level provider catalog validation. Only fires when the
    // tenant actually overrides `models` — default tenants that
    // inherit global don't need their own check (the global pass in
    // checks/providers.ts handles that). We surface bad `api` values
    // here because that's the field cli-agent / hand-edits get wrong
    // most often (e.g. "openai-chat" instead of "openai-completions");
    // pi-ai's runtime error "No API provider registered for api: <bad>"
    // used to land silently (see fix(chat): surface LLM errors) — even
    // now that it surfaces, doctor catching it pre-flight lets the
    // setup agent propose a fix before the user even tries chatting.
    if (tenantCfg.models?.providers) {
      for (const [provId, prov] of Object.entries(tenantCfg.models.providers)) {
        const p = prov as ProviderEntry;
        if (!p.api) {
          lines.push({
            severity: "warning",
            text: `  ${provId}: \`api\` field missing`,
            detail: `Add "api": "openai-completions" (or the right one) under tenant '${tenantId}' models.providers.${provId}.`,
          });
        } else if (!KNOWN_API_TYPES.has(p.api)) {
          const suggestion = suggestApiType(p.api);
          lines.push({
            severity: "warning",
            text: `  ${provId}: unknown \`api\` value "${p.api}"`,
            detail:
              (suggestion ? `Did you mean "${suggestion}"? ` : "") +
              `pi-ai accepts: ${[...KNOWN_API_TYPES].sort().join(", ")}. ` +
              `Edit tenant '${tenantId}' config: models.providers.${provId}.api.`,
          });
        }
        // Same ctx/max sanity as checks/providers.ts but scoped
        // to this tenant. Mirroring rather than importing because
        // the doctor sections are intentionally independent.
        const known = loadKnownModels();
        for (const m of p.models ?? []) {
          // Skip image-gen models — their ctx/max semantics
          // differ from chat models (see checks/providers.ts
          // for the full rationale).
          if (m.mode === "image-gen") {
            continue;
          }
          const fullId = `${provId}/${m.id}`;
          const ctx = m.contextWindow;
          const mx = m.maxTokens;
          const ref = known.get(m.id);
          if (typeof ctx === "number" && typeof mx === "number" && mx > ctx) {
            lines.push({
              severity: "blocker",
              text: `  ${fullId}: maxTokens (${mx}) > contextWindow (${ctx})`,
              detail:
                "Output cap can't exceed the whole window. Almost certainly a swap or stale value.",
            });
          } else {
            if (typeof ctx !== "number") {
              lines.push({
                severity: "warning",
                text: `  ${fullId}: contextWindow not set`,
                detail:
                  "Falls back to 128_000." +
                  (ref ? ` Known: ${ref.contextWindow} (verified ${ref.lastVerified}).` : ""),
              });
            } else if (ref && ctx < ref.contextWindow) {
              lines.push({
                severity: "warning",
                text: `  ${fullId}: contextWindow=${ctx} below known ceiling`,
                detail: `docs/known-models.md records ${ref.contextWindow} (verified ${ref.lastVerified}).`,
              });
            }
            if (typeof mx !== "number") {
              lines.push({
                severity: "warning",
                text: `  ${fullId}: maxTokens not set`,
                detail:
                  "Falls back to 4_096 output tokens." +
                  (ref ? ` Known: ${ref.maxTokens} (verified ${ref.lastVerified}).` : ""),
              });
            } else if (mx < 4096) {
              lines.push({
                severity: "warning",
                text: `  ${fullId}: maxTokens=${mx} looks low`,
                detail: "Most modern models support ≥8192 output tokens." +
                  (ref ? ` Known: ${ref.maxTokens} (verified ${ref.lastVerified}).` : ""),
              });
            } else if (ref && mx < ref.maxTokens) {
              lines.push({
                severity: "warning",
                text: `  ${fullId}: maxTokens=${mx} below known ceiling`,
                detail: `docs/known-models.md records ${ref.maxTokens} (verified ${ref.lastVerified}).`,
              });
            }
          }
        }
      }
    }
    lines.push({
      severity: "ok",
      text: `  users (${users.length}): ${users.length > 0 ? users.join(", ") : "(none)"}`,
    });
    lines.push({
      severity: "ok",
      text: `  enabled plugins (${enabled.length}): ${enabled.length > 0 ? enabled.sort().join(", ") : "(none)"}`,
    });

    // Workboard cross-checks. When workboard is enabled, every LLM
    // worker that doesn't pin its own `modelId` in its agent.json
    // falls back to the resolved tenant defaultModel. So:
    //   - workboard enabled + no defaultModel resolvable
    //     → warning (workers will fail to start LLM runs)
    //   - workboard enabled + tenant overrides `models` (replace)
    //     but doesn't set defaultModel → the auto-pick from
    //     mergeConfigs takes over (first provider's first model);
    //     surface it so the user knows.
    // Doctor's earlier sections cover the global-tenant defaultModel
    // wiring; this block is the *workboard-specific* angle ("why
    // does this matter? because workers depend on it.").
    if (enabled.includes("workboard")) {
      // We don't have the merged ResolvedConfig handy here —
      // mergeConfigs lives in core/config but doctor sections are
      // intentionally lightweight — so we replicate the relevant
      // bit: tenant.defaultModel ?? auto-pick(tenant.models) ??
      // global.defaultModel.
      const resolvedDefault =
        tenantCfg.defaultModel ??
        autoPickFromModels(tenantCfg.models) ??
        globalCfg.defaultModel;
      if (!resolvedDefault) {
        lines.push({
          severity: "warning",
          text: `  workboard: no defaultModel resolvable for this tenant`,
          detail:
            "LLM worker agents without a per-worker `modelId` in their agent.json will fail to start. Set tenant.defaultModel, or set global.defaultModel and let this tenant inherit it.",
        });
      }
    }

    // Per-worker model resolution. When workboard is enabled, list
    // each LLM worker on disk along with the model it'll actually
    // run (per-worker modelId pin > resolved tenant defaultModel),
    // and flag two trouble shapes:
    //   - pin references a model not in the catalog (worker won't
    //     start; blocker, like the global defaultModel check)
    //   - LLM worker with no resolvable model (no pin + no
    //     defaultModel anywhere) — blocker for the same reason
    // No subjective recommendations here — just facts. The setup
    // agent can pick up the listing and offer recommendations
    // on demand, but doctor doesn't second-guess the user's
    // model choice.
    if (enabled.includes("workboard")) {
      const resolvedDefault =
        tenantCfg.defaultModel ??
        autoPickFromModels(tenantCfg.models) ??
        globalCfg.defaultModel;
      const knownModelIds = collectKnownModelIds(globalCfg, tenantCfg);
      const workers = readWorkerAgents(home, tenantId);
      for (const w of workers) {
        if (w.kind !== "llm") continue;
        if (!w.enabled) continue;
        if (w.modelId) {
          if (knownModelIds.has(w.modelId)) {
            lines.push({
              severity: "ok",
              text: `  worker '${w.slug}': pinned model ${w.modelId}`,
              detail: w.description ?? undefined,
            });
          } else {
            lines.push({
              severity: "blocker",
              text: `  worker '${w.slug}': pinned model not in catalog`,
              detail: `agent.json sets modelId="${w.modelId}" but no provider/model with that id is configured. Either fix the pin, drop modelId so the worker uses tenant defaultModel, or add the provider+model to the catalog. Known: ${[...knownModelIds].sort().slice(0, 6).join(", ")}${knownModelIds.size > 6 ? ", …" : ""}.`,
            });
          }
        } else if (resolvedDefault) {
          lines.push({
            severity: "ok",
            text: `  worker '${w.slug}': inherits ${resolvedDefault}`,
            detail: w.description ?? undefined,
          });
        } else {
          // No pin and no fallback. Covered by the broader
          // "workboard: no defaultModel resolvable" warning above,
          // but per-worker line makes the impact concrete.
          lines.push({
            severity: "blocker",
            text: `  worker '${w.slug}': no model resolvable`,
            detail: `agent.json has no modelId and no defaultModel chain resolves. Set tenant.defaultModel or global.defaultModel, or pin a modelId on this worker.`,
          });
        }
      }
    }

    // Flag the deprecated `worker:` config block. The schema kept it
    // around for backwards compat but the field has no runtime
    // consumers; warn so users don't think they're configuring
    // anything by setting it.
    if (tenantCfg.worker !== undefined) {
      const keys = Object.keys(tenantCfg.worker).join(", ") || "(empty)";
      lines.push({
        severity: "warning",
        text: `  deprecated 'worker' field set (keys: ${keys})`,
        detail:
          "The `worker.{count,pollMs,model}` field has no runtime effect. Workboard sizes the pool from agent-seeds and reads each worker's modelId from its agent.json (falling back to tenant defaultModel). Safe to delete from this tenant config.",
      });
    }

    if (disabled.length > 0) {
      lines.push({
        severity: "ok",
        text: `  disabled plugins (${disabled.length}): ${disabled.sort().join(", ")}`,
      });
    }
    if (unknown.length > 0) {
      lines.push({
        severity: "warning",
        text: `  unknown plugins in config (${unknown.length}): ${unknown.sort().join(", ")}`,
        detail:
          "Config references plugins that don't exist on disk. Either install them, or remove the entries.",
      });
    }
  }

  return { title: "Tenants & plugins", lines };
}

function readAvailablePlugins(
  opts: TenantsCheckOpts,
): { ids: string[]; error?: string } {
  let dir: string;
  try {
    dir = opts.builtinConfigDir ?? getBuiltinConfigDir();
  } catch (err) {
    return {
      ids: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const pluginsRoot = path.join(dir, "plugins");
  if (!fs.existsSync(pluginsRoot)) {
    return {
      ids: [],
      error: `${pluginsRoot} doesn't exist; \`npm run sync:plugins\` may not have run yet.`,
    };
  }
  const ids: string[] = [];
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pluginsRoot, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        id?: string;
      };
      if (m.id) ids.push(m.id);
    } catch {
      // skip; manifest sanity is the registry's job, not ours
    }
  }
  return { ids };
}

function listTenants(home: string): string[] {
  const tenantsDir = path.join(home, "tenants");
  if (!fs.existsSync(tenantsDir)) return [];
  try {
    return fs
      .readdirSync(tenantsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      // Soft-deleted tenants (`<id>.deleted.<ts>`) are
      // archaeology, not active state.
      .filter((d) => !d.name.includes(".deleted."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listUsers(home: string, tenantId: string): string[] {
  // Users live under <tenant>/workspace/users/<userId>/ — same
  // shape getTenantUsersDir() resolves. Mirror that here directly
  // so this check stays sync-safe and avoids a circular import
  // with paths.ts (which transitively pulls in the env loader).
  const usersDir = path.join(
    home,
    "tenants",
    tenantId,
    "workspace",
    "users",
  );
  if (!fs.existsSync(usersDir)) return [];
  try {
    return fs
      .readdirSync(usersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function safeLoadGlobalConfig(home: string) {
  try {
    return loadGlobalConfig(home);
  } catch {
    return {};
  }
}

function safeLoadTenantConfig(tenantId: string, home: string) {
  try {
    return loadTenantConfig(tenantId, home);
  } catch {
    return {};
  }
}

function mergePlugins(
  globalPlugins: PluginsConfig | undefined,
  tenantPlugins: PluginsConfig | undefined,
): PluginsConfig {
  return { ...(globalPlugins ?? {}), ...(tenantPlugins ?? {}) };
}

/**
 * Common typos / wrong guesses we've seen real users (and the
 * cli-agent before it learned the schema) emit. Same map as in
 * checks/providers.ts; intentionally duplicated to keep the two
 * checks independently testable.
 */
interface WorkerSummary {
  slug: string;
  kind: string;
  enabled: boolean;
  modelId: string | null;
  description: string | null;
}

/**
 * Read all worker agent.json files under a tenant's workspace.
 * Mirrors workboard's fs-worker-agents scan path (the *both*
 * possible roots; older installs had workspace/_tenant/ vs newer
 * _tenant/). We don't import the workboard module — doctor stays
 * plugin-agnostic — but we mirror its filesystem contract.
 */
function readWorkerAgents(home: string, tenantId: string): WorkerSummary[] {
  const tenantHome = path.join(home, "tenants", tenantId);
  const candidates = [
    path.join(tenantHome, "workspace", "_tenant", "config", "workers"),
    path.join(tenantHome, "_tenant", "config", "workers"),
  ];
  const root = candidates.find((p) => fs.existsSync(p));
  if (!root) return [];
  const out: WorkerSummary[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "agent.json");
      if (!fs.existsSync(file)) continue;
      try {
        const spec = JSON.parse(fs.readFileSync(file, "utf8")) as {
          kind?: string;
          enabled?: boolean;
          modelId?: string | null;
          description?: string | null;
        };
        out.push({
          slug: entry.name,
          kind: typeof spec.kind === "string" ? spec.kind : "unknown",
          enabled: spec.enabled !== false, // default true, matches workboard
          modelId: spec.modelId ?? null,
          description: spec.description ?? null,
        });
      } catch {
        // malformed agent.json — workboard's own loader will
        // surface the error at activation; doctor just skips.
      }
    }
  } catch {
    // unreadable directory; treat as no workers.
  }
  return out;
}

/**
 * Collect every "<providerId>/<modelId>" pair from both global
 * and tenant model catalogs. Tenant override semantics: tenant.models
 * wholesale-replaces global.models when set (matches mergeConfigs).
 */
function collectKnownModelIds(
  globalCfg: { models?: { providers?: Record<string, { models?: { id: string }[] }> } },
  tenantCfg: { models?: { providers?: Record<string, { models?: { id: string }[] }> } },
): Set<string> {
  const catalog = tenantCfg.models ?? globalCfg.models;
  const ids = new Set<string>();
  if (!catalog?.providers) return ids;
  for (const [provId, prov] of Object.entries(catalog.providers)) {
    for (const m of prov.models ?? []) {
      ids.add(`${provId}/${m.id}`);
    }
  }
  return ids;
}

/**
 * Mirror of mergeConfigs's tenant-models-override auto-pick rule.
 * Kept inline here (rather than importing the whole merge) so
 * doctor's section stays a thin read-only inspection.
 */
function autoPickFromModels(
  models: { providers?: Record<string, { models?: { id: string }[] }> } | undefined,
): string | undefined {
  if (!models?.providers) return undefined;
  const firstProvId = Object.keys(models.providers)[0];
  if (!firstProvId) return undefined;
  const firstProv = models.providers[firstProvId];
  const firstModelId = firstProv?.models?.[0]?.id;
  if (!firstModelId) return undefined;
  return `${firstProvId}/${firstModelId}`;
}

function suggestApiType(bad: string): string | null {
  const map: Record<string, string> = {
    "openai-chat": "openai-completions",
    "chat-completions": "openai-completions",
    "openai": "openai-completions",
    "openai-chat-completions": "openai-completions",
    "anthropic": "anthropic-messages",
    "claude": "anthropic-messages",
    "messages": "anthropic-messages",
    "google": "google-generative-ai",
    "gemini": "google-generative-ai",
    "bedrock": "bedrock-converse-stream",
  };
  return map[bad.toLowerCase()] ?? null;
}
