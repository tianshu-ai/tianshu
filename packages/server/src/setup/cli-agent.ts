// CLI agent — runs an interactive chat loop in the terminal after
// `tianshu setup --wizard` finishes provisioning the LLM. Lets the
// user finish the rest of setup (enabling plugins, creating
// tenants, configuring web-search keys, etc.) by talking to the
// agent rather than learning a CLI surface.
//
// Why CLI rather than browser:
// the user is already in a terminal having just run the wizard;
// jumping to a browser breaks the flow. The CLI agent shares a
// minimal toolset (tenant / config / doctor) but does NOT spin up
// the full plugin runtime — those tools cover everything the
// post-setup phase needs.
//
// Out of scope:
// - full chat history (this is a one-shot setup conversation)
// - sandbox exec (microsandbox lives in plugin-land; if the user
//   needs the microsandbox npm dep installed, the agent tells
//   them which `npm install` step likely failed)
// - workboard (worker spawn is overkill for setup)
//
// Tools shipped (12): tenant_list, tenant_create, user_create,
//   plugin_enable, plugin_disable, config_read, config_write,
//   run_doctor, read_service_logs, read_env_file,
//   build_sandbox, use_sandbox_build. Plus the implicit "done"
//   sentinel.

import * as p from "@clack/prompts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  Tool,
  ToolCall,
  ToolResultMessage,
  Context,
} from "@earendil-works/pi-ai";
import { GlobalOps } from "../core/global-ops.js";
import {
  buildModel,
  getDefaultModel,
  resolveApiKey,
} from "../core/llm.js";
import {
  loadGlobalConfig,
  writeGlobalConfig,
  writeTenantConfig,
  TenantConfigForbiddenFieldError,
  type GlobalConfig,
} from "../core/config.js";
import {
  getTenantsRoot,
  getTianshuHome,
  getGlobalConfigPath,
} from "../core/paths.js";
import {
  applyPluginSecretPatch,
  loadPluginSecrets,
} from "../core/plugins/index.js";
import { collectDoctorReport } from "./doctor.js";
import * as launchd from "./launchd.js";
import { findRepoRoot } from "./repo-root.js";

export interface CliAgentOpts {
  home?: string;
  /** Stop after this many user/assistant turns (defaults to 25). Hard cap to
   *  prevent runaway loops; not surfaced to the user. */
  maxTurns?: number;
  /** Base URL of a running tianshu server (e.g. http://localhost:3110).
   *  When set, the agent gets HTTP-based tools (plugin_patch,
   *  build_sandbox, etc.) that route through the server's plugin
   *  runtime instead of editing files directly. */
  serverUrl?: string;
}

const SETUP_SYSTEM_PROMPT = `You are the tianshu setup assistant.

The user just finished configuring an LLM provider. Your job is
to walk them through the remaining setup decisions — not to
silently auto-configure things behind their back. Every state-
changing tool call (tenant_create, user_create, plugin_enable,
plugin_disable, config_write) is intercepted by the CLI and the
user is asked to confirm before it runs. Plan accordingly: don't
batch 10 actions in one turn; propose a small, named change,
call the tool, then continue based on what the user accepts.

Workflow on the FIRST turn:

  1. Call run_doctor to see what's set up. If doctor reports the server isn't running or isn't responding, call read_service_logs to see *why* before suggesting fixes.
  2. Look at the report and write ONE message to the user:
     - In plain language, summarise what's already working.
     - List what looks like it should be set up next (e.g.
       'workboard plugin is disabled', 'microsandbox runtime
       binary not found', 'no Tavily API key for web-search').
     - For each item, propose the action you'd like to take and
       which tool call you'd run. Don't run them yet.
     - End by asking the user which they want to do first, or
       whether to skip ahead.

From turn 2 onward:
  - Run one tool at a time, narrate why before each one (the CLI
    will pop a confirmation — the user already sees the
    one-liner you described, but your message gives the reason).
  - After a tool runs, narrate what happened (one short line)
    and propose the next step.
  - If the user declines a confirmation, drop that idea and
    move on — don't retry the same tool with the same args.

Style: brief, direct, no fluff. Don't ask the user to copy-paste
shell commands; either run a tool, or tell them clearly what
they need to do outside this CLI (e.g. 'run \`npx microsandbox
install\` in another terminal then re-run setup').

Domain knowledge you must apply when relevant:

GLOBAL VS TENANT CONFIG (config_read / config_write):
- Two scopes live side by side:
  * GLOBAL = ~/.tianshu/config.json. System-wide. Controls server port,
    logging, the *baseline* provider catalog (models.providers), the
    baseline default model, autoCreateDefault. New tenants inherit
    everything in here unless they override.
  * TENANT = ~/.tianshu/tenants/<id>/config.json. Per-tenant. Can
    override the overridable subset: plugins (enable/disable per
    tenant), models (a tenant-specific catalog that wholesale-
    replaces global's), defaultModel, branding, apiKeys, mcp.
    Tenants CAN'T set server.port / logging / autoCreateDefault —
    those are GlobalOnlyConfig; writeTenantConfig rejects them.
- Which one to write to when a user asks for something:
  * "add a provider" / "set the default model" / "server settings"
    → GLOBAL, unless the user explicitly says "for tenant X".
    GLOBAL is the right default for first-time setup and most
    config changes; new tenants will inherit from there.
  * "enable / disable a plugin for me" or "for my tenant"
    → TENANT. Plugin enablement is per-tenant.
  * "my tenant should use a different model than everyone else"
    → TENANT. Set defaultModel on the tenant; also set
    models.providers on the tenant if the model isn't in global.
  * Bad \`api\` value flagged by run_doctor: the doctor output
    tells you which scope ('LLM providers' section = global,
    'Tenants & plugins' section = tenant) — fix it at the same
    scope it was reported.
- Both scopes use shallow top-level merge: \`config_write\` reads the
  existing file, spreads it, overlays your patch, writes back. So
  a patch like \`{"defaultModel": "x"}\` only touches that one key.
- Trying to set a global-only field on a tenant returns
  \`error: tenant_forbidden_field\` with a hint. Switch to
  which='global' and retry.

WEB SEARCH (web-search plugin):
- API keys go to SECRETS, not regular config. Use \`secret_write\`
  with pluginId='web-search' and key='tavilyApiKey' (Tavily) or
  'braveApiKey' (Brave). DO NOT use \`config_write\` for these.
  config.json is committable, secrets/ is not.
- Check \`secret_list\` first to see what's already configured
  before asking the user for a key.

PROVIDERS / MODELS (config.json's \`models.providers\` map):
- The \`api\` field MUST be a value pi-ai recognises. The only
  ones in current use are:
  * \`openai-completions\` — use for OpenAI itself AND for any
    OpenAI-compatible vendor: dashscope, deepseek, moonshot,
    siliconflow, together, groq, llama-server, ollama, anything
    that exposes \`/v1/chat/completions\`. The name is
    confusingly historical — it points at \`/v1/chat/completions\`
    not the legacy \`/v1/completions\`. Use this whenever the
    upstream advertises "OpenAI-compatible".
  * \`anthropic-messages\` — Anthropic native API (\`/v1/messages\`).
  * \`google-generative-ai\` — Google Gemini native API.
  * \`openai-responses\` — OpenAI's newer Responses API. Only
    use when the user explicitly wants it; the default for
    OpenAI itself is still \`openai-completions\`.
  Common typos to NEVER write: "openai-chat" (does not exist),
  "chat-completions" (does not exist), "openai" (no api type).
- A typical OpenAI-compatible provider entry looks like:
    "qwen": {
      "api": "openai-completions",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "sk-...",
      "group": "Cloud",
      "models": [
        { "id": "qwen3-max-preview", "name": "Qwen3 Max Preview",
          "contextWindow": 256000, "maxTokens": 8192 }
      ]
    }
  baseUrl is the *prefix* before /chat/completions — NOT the full
  endpoint URL. pi-ai appends the path itself.
- defaultModel must point at a model that exists in the catalog:
  "defaultModel": "qwen/qwen3-max-preview" matches
  models.providers.qwen.models[].id = "qwen3-max-preview".
  If the tenant overrides \`models\` but doesn't set defaultModel,
  the server auto-picks the first provider's first model, but
  setting defaultModel explicitly is clearer and survives catalog
  edits.
- apiKey can be a literal string (default since 2026-06; lands
  in config.json which is chmod 600) or a \`\${ENV_VAR}\`
  placeholder if the user opted into --use-env mode.

WORKBOARD WORKERS (workboard plugin):
- When the user enables workboard, the LLM worker pool starts up
  with one worker per enabled \`agent.json\` in the tenant's
  agent-seeds bundle. There is no "worker count" setting at the
  config level — if the user wants more workers, they add more
  agent.json files. The cli-agent doesn't manage agent files
  directly; that's the user / chat agent's job.
- Each LLM worker picks its model in this order:
    1. \`modelId\` field in the worker's own agent.json (per-worker
       override; rare)
    2. resolved tenant defaultModel (\`tenant.defaultModel\` else
       auto-pick from tenant.models else global.defaultModel)
- If \`run_doctor\` says "workboard: no defaultModel resolvable",
  set tenant.defaultModel (via \`config_write\` which='tenant')
  or global.defaultModel (which='global'). Don't try to find a
  worker-specific setting; there isn't one.
- The schema still carries a \`worker: { count, pollMs, model }\`
  field for backwards compat. It has NO runtime effect; doctor
  flags it as deprecated. Do not write to it. If a user asks to
  "configure worker count / polling / model", explain that those
  are not real settings in this build, and steer them toward
  what actually matters: tenant.defaultModel for which model the
  workers use, and the agent-seeds bundle for how many workers
  there are.

MICROSANDBOX (sandbox-based plugins: microsandbox, browser):
- microsandbox uses TWO sandbox role pointers: 'task' (per-task
  ephemeral sandboxes for the workboard's exec/coding work) and
  'browser' (the long-lived sandbox hosting the headless Chromium
  + playwright-mcp sidecar). They share an underlying snapshot —
  one snapshot can serve both roles.
- The two relevant tools — build_sandbox and use_sandbox_build —
  ARE available here in the setup wizard. Use them when the user
  asks to set up / rebuild / refresh sandboxes. Don't tell them
  they have to go to the chat shell.
- Standard setup flow when a user wants sandboxes ready. This
  is a TWO-snapshot layered build, NOT one big monolith. Why:
  the task pool runs lots of short-lived sandboxes and shouldn't
  carry Chromium's ~2.5 GB; the browser sandbox is long-lived
  and DOES need Chromium. Layering also reuses apt cache between
  the two builds, saving the second pull.
    1. build_sandbox(template='task-runner') → returns
       {buildId: B1, snapshotName: S1}. WARN THE USER FIRST: this
       takes 5-7 min; the wizard's UI hangs on a single spinner.
    2. use_sandbox_build(buildId=B1, role='task') → publishes
       S1 as the task-pool snapshot.
    3. build_sandbox(template='task-runner-with-browser',
       fromSnapshot=S1) → returns {buildId: B2, snapshotName: S2}.
       Another 3-5 min spinner. Skipping fromSnapshot here is a
       hard error; the build_sandbox tool guards against it but
       you should know.
    4. use_sandbox_build(buildId=B2, role='browser') → publishes
       S2 as the long-lived browser sandbox.
  After step 4 the user can immediately use the chat / workboard.
  If the user explicitly wants a no-browser setup, stop after
  step 2 and tell them they can build the browser layer later.
- If \`run_doctor\` reports "microsandbox SDK not available" or
  "Sandbox class missing", the platform-specific NAPI binding
  didn't install. You can NOT build sandboxes yet. Tell the user:
  'run \`npm install\` from the tianshu checkout root and watch
  for any error in the output — the binding ships as an optional
  dependency (\`@superradcompany/microsandbox-<triple>\`), and
  optional dep failures are silent by default.' Do NOT recommend
  \`npx microsandbox install\` — in current msb versions that's
  \`msb install <image>\` (a different command, different purpose)
  and will fail with a missing-argument error. Don't try to call
  build_sandbox before the SDK is present; the server will return
  runner_not_ready (503).
- Template choice cheat-sheet:
  * task-runner → first build in the standard layered flow.
    Also the only build needed if the user wants no browser.
  * task-runner-with-browser → second build, layered on top of
    the task-runner snapshot via fromSnapshot=<S1's snapshotName>.
    Without fromSnapshot it errors out (build_sandbox catches
    that and returns missing_from_snapshot).
  * browser → the monolithic alternative (full stack, ~3.2 GB,
    no layering). Use only if the user specifically wants a
    single-snapshot setup; the layered flow is preferred.
- If the wizard installed a launchd agent but the server isn't
  responding (run_doctor reports "Server port free" or "port in
  use, no HTTP response", or the user says "server didn't come
  up"), call \`read_service_logs\` *first*. The actual error
  message from npm/node will be in there. Don't guess; don't
  ask the user to run \`tail\`. Common patterns to look for:
  * "command not found: npm" → launchd's PATH doesn't have npm.
    Check whether \`which npm\` from the user's shell points
    somewhere unusual (volta, fnm, asdf). The fix is to bump
    PATH in the plist's EnvironmentVariables and reinstall via
    \`tianshu setup --wizard\`.
  * "EADDRINUSE" → port collision. Run \`run_doctor\` to confirm
    and ask the user to pick a different PORT/WEB_PORT in .env.
  * "Cannot find module" / "ENOENT package.json" → wizard
    captured the wrong WorkingDirectory. Check
    \`~/Library/LaunchAgents/ai.tianshu.dev*.plist\`.
  * "API key not set" / "references env var but it's empty"
    → first call \`config_read\` and check the providers'
    apiKey field. As of 2026-06 the wizard's default is to
    write the literal key into config.json (chmod 600), NOT
    into .env. So if config.json shows a placeholder like
    \`"\${ANTHROPIC_API_KEY}"\` and the user expected the key
    to just work, propose the fix: edit config.json directly
    (use the \`config_write\` tool) with the actual key. Only
    fall back to \`read_env_file\` if the user explicitly
    chose --use-env mode (apiKey is a placeholder by design)
    or the config shows a literal key but doctor still says
    it's empty (config.json malformed).
    Don't ask the user to grep their own files.
  * Empty logs but lastExitStatus \!= 0 → the process was
    killed pre-stdio (signal). The hint field in
    read_service_logs's result will spell this out.
  Then propose the *specific* fix to the user before mutating
  anything.

When the user says they're done / satisfied / wants to exit, run
run_doctor one last time, summarise, then end with:
"All set. Run 'tianshu dev' (or 'npm run dev' in a checkout)
to start the server."`;

interface ToolHandler {
  schema: Tool;
  execute: (args: Record<string, unknown>) => Promise<string>;
  /** Tools that mutate state (write to disk, create resources)
   *  must say so. The CLI agent prompts the user for explicit
   *  confirmation before running a mutating tool, summarising
   *  the args in plain language. Read-only tools run silently. */
  mutating?: boolean;
  /** Optional human description used in the confirmation prompt.
   *  Receives the raw args and returns a single-line summary. */
  describe?: (args: Record<string, unknown>) => string;
}

/**
 * The user's identity for HTTP calls. The server-side dev
 * resolver chain accepts a `tianshu_identity=<tenant>/<user>`
 * cookie, so we forge one matching whatever tenant the agent is
 * targeting in each call. We always go in as the tenant's `dev`
 * user (the bootstrap user) since the wizard hasn't created
 * anyone else yet.
 */
function identityCookie(tenantId: string): string {
  return `tianshu_identity=${encodeURIComponent(`${tenantId}/dev`)}`;
}

/**
 * Make an HTTP request against the running server, returning the
 * parsed JSON body or throwing an Error with the response text.
 * Used by the HTTP-backed tools when the wizard has spun up a
 * server already.
 */
async function serverFetch(
  serverUrl: string,
  method: string,
  pathSegment: string,
  tenantId: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${serverUrl}${pathSegment}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: identityCookie(tenantId),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      throw new Error(
        `${method} ${pathSegment} → HTTP ${res.status}: ${text.slice(0, 400)}`,
      );
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exported for tests only — production callers go through
 * runSetupAgent, which constructs tools and the system prompt
 * together. Tests can grab a single tool's `execute` to verify
 * its behaviour in isolation.
 */
export function buildTools(
  home: string,
  serverUrl: string | undefined,
): Record<string, ToolHandler> {
  const ops = new GlobalOps({ home });
  return {
    tenant_list: {
      schema: {
        name: "tenant_list",
        description:
          "List all tenants on disk under ~/.tianshu/tenants/. Returns an array of tenant ids.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        } as never,
      },
      execute: async () => {
        const ids = ops.list();
        return JSON.stringify({ tenants: ids });
      },
    },
    tenant_create: {
      mutating: true,
      describe: (args) => `Create new tenant '${String(args.id ?? "?")}'`,
      schema: {
        name: "tenant_create",
        description:
          "Create a new tenant with the given id. Tenant ids must be a-z, 0-9, hyphen. Idempotent: returns the tenant whether or not it pre-existed.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "Tenant id (a-z 0-9 hyphen). Examples: 'work', 'sandbox', 'team-foo'.",
            },
          },
          required: ["id"],
        } as never,
      },
      execute: async (args) => {
        const id = String(args.id ?? "");
        const ctx = ops.exists(id) ? ops.open(id) : ops.create(id);
        return JSON.stringify({
          tenantId: ctx.tenantId,
          root: ctx.root,
          alreadyExisted: ops.exists(id),
        });
      },
    },
    user_create: {
      mutating: true,
      describe: (args) =>
        `Create user '${String(args.userId ?? "?")}' in tenant '${String(args.tenantId ?? "?")}'`,
      schema: {
        name: "user_create",
        description:
          "Create a user inside an existing tenant. Idempotent (re-creating a user is a no-op).",
        parameters: {
          type: "object",
          properties: {
            tenantId: { type: "string", description: "Tenant id." },
            userId: {
              type: "string",
              description: "User id (a-z 0-9 hyphen).",
            },
            displayName: {
              type: "string",
              description: "Optional display name.",
            },
          },
          required: ["tenantId", "userId"],
        } as never,
      },
      execute: async (args) => {
        const tenantId = String(args.tenantId);
        const userId = String(args.userId);
        const ctx = ops.open(tenantId);
        ops.ensureUser(ctx, {
          userId,
          provider: "dev",
          externalId: `${userId}@local`,
          displayName: args.displayName ? String(args.displayName) : undefined,
        });
        return JSON.stringify({ tenantId, userId });
      },
    },
    plugin_enable: {
      mutating: true,
      describe: (args) =>
        `Enable plugin '${String(args.pluginId ?? "?")}' in tenant '${String(args.tenantId ?? "?")}'`,
      schema: {
        name: "plugin_enable",
        description:
          "Enable a built-in plugin (files | workboard | microsandbox | web-search) inside a tenant. When the wizard has a running server, this routes through PATCH /api/plugins/:id so plugin lifecycle hooks fire (activation, registry refresh, plugins_changed broadcast) — the same path the admin UI uses. Without a server we fall back to editing the config.json directly; the plugin will activate next time the server boots.",
        parameters: {
          type: "object",
          properties: {
            tenantId: { type: "string" },
            pluginId: {
              type: "string",
              enum: ["files", "workboard", "microsandbox", "web-search"],
            },
          },
          required: ["tenantId", "pluginId"],
        } as never,
      },
      execute: async (args) => {
        const tenantId = String(args.tenantId);
        const pluginId = String(args.pluginId);
        if (serverUrl) {
          const r = await serverFetch(
            serverUrl,
            "PATCH",
            `/api/plugins/${encodeURIComponent(pluginId)}`,
            tenantId,
            { enabled: true },
          );
          return JSON.stringify({
            tenantId,
            pluginId,
            enabled: true,
            via: "http",
            response: r,
          });
        }
        const cfgPath = path.join(getTenantsRoot(home), tenantId, "config.json");
        const cfg = readJsonOrEmpty(cfgPath);
        cfg.plugins = (cfg.plugins as Record<string, unknown>) ?? {};
        const existing =
          ((cfg.plugins as Record<string, unknown>)[pluginId] as Record<
            string,
            unknown
          >) ?? {};
        (cfg.plugins as Record<string, unknown>)[pluginId] = {
          ...existing,
          enabled: true,
        };
        writeJsonAtomic(cfgPath, cfg);
        return JSON.stringify({
          tenantId,
          pluginId,
          enabled: true,
          via: "file",
        });
      },
    },
    plugin_disable: {
      mutating: true,
      describe: (args) =>
        `Disable plugin '${String(args.pluginId ?? "?")}' in tenant '${String(args.tenantId ?? "?")}'`,
      schema: {
        name: "plugin_disable",
        description:
          "Disable a plugin in the given tenant. Routes through PATCH /api/plugins/:id when a server is running so the plugin's deactivate hook fires; otherwise edits config.json directly.",
        parameters: {
          type: "object",
          properties: {
            tenantId: { type: "string" },
            pluginId: { type: "string" },
          },
          required: ["tenantId", "pluginId"],
        } as never,
      },
      execute: async (args) => {
        const tenantId = String(args.tenantId);
        const pluginId = String(args.pluginId);
        if (serverUrl) {
          const r = await serverFetch(
            serverUrl,
            "PATCH",
            `/api/plugins/${encodeURIComponent(pluginId)}`,
            tenantId,
            { enabled: false },
          );
          return JSON.stringify({
            tenantId,
            pluginId,
            enabled: false,
            via: "http",
            response: r,
          });
        }
        const cfgPath = path.join(getTenantsRoot(home), tenantId, "config.json");
        const cfg = readJsonOrEmpty(cfgPath);
        cfg.plugins = (cfg.plugins as Record<string, unknown>) ?? {};
        const existing =
          ((cfg.plugins as Record<string, unknown>)[pluginId] as Record<
            string,
            unknown
          >) ?? {};
        (cfg.plugins as Record<string, unknown>)[pluginId] = {
          ...existing,
          enabled: false,
        };
        writeJsonAtomic(cfgPath, cfg);
        return JSON.stringify({
          tenantId,
          pluginId,
          enabled: false,
          via: "file",
        });
      },
    },
    config_read: {
      schema: {
        name: "config_read",
        description:
          "Read a config file. `which='global'` for ~/.tianshu/config.json; `which='tenant'` requires `tenantId` and reads ~/.tianshu/tenants/<id>/config.json.",
        parameters: {
          type: "object",
          properties: {
            which: { type: "string", enum: ["global", "tenant"] },
            tenantId: { type: "string" },
          },
          required: ["which"],
        } as never,
      },
      execute: async (args) => {
        const which = String(args.which);
        if (which === "global") {
          const cfg = readJsonOrEmpty(getGlobalConfigPath(home));
          return JSON.stringify(cfg);
        }
        const tenantId = String(args.tenantId ?? "");
        if (!tenantId) return JSON.stringify({ error: "tenantId required" });
        const cfg = readJsonOrEmpty(
          path.join(getTenantsRoot(home), tenantId, "config.json"),
        );
        return JSON.stringify(cfg);
      },
    },
    config_write: {
      mutating: true,
      describe: (args) => {
        const which = String(args.which ?? "tenant");
        const patch = (args.patch as Record<string, unknown>) ?? {};
        const keys = Object.keys(patch).join(", ") || "(empty patch)";
        if (which === "global") {
          return `Patch ~/.tianshu/config.json (keys: ${keys})`;
        }
        return `Patch tenant '${String(args.tenantId ?? "?")}' config (keys: ${keys})`;
      },
      schema: {
        name: "config_write",
        description:
          "Write a config file by merging the supplied object into the existing file. Top-level keys in the patch overwrite existing values; non-mentioned keys are preserved (shallow merge).\n\n  which='global' → ~/.tianshu/config.json. Use this for cross-tenant settings: the server-wide provider catalog (models.providers), the default model, server-only fields (server.port, logging.level, autoCreateDefault), or to fix a bad `api` value doctor flagged on the global pass.\n  which='tenant' → ~/.tianshu/tenants/<id>/config.json. Use for per-tenant overrides: enabling/disabling plugins for one tenant, giving one tenant a different defaultModel, swapping in a tenant-specific provider catalog. Requires `tenantId`.\n\nGoes through the same write path the server uses (writeGlobalConfig / writeTenantConfig), so the tenant write enforces the OverridableConfig whitelist: trying to set server.port / logging on a tenant returns a TenantConfigForbiddenFieldError and the patch is rejected.",
        parameters: {
          type: "object",
          properties: {
            which: {
              type: "string",
              enum: ["global", "tenant"],
              description:
                "'global' = ~/.tianshu/config.json (system-wide). 'tenant' = ~/.tianshu/tenants/<id>/config.json (per-tenant). Defaults to 'tenant' for backward compatibility, but be explicit — the agent's earlier behaviour silently assumed tenant which was wrong when the user wanted a global change.",
            },
            tenantId: {
              type: "string",
              description: "Required when which='tenant'.",
            },
            patch: {
              type: "object",
              description:
                "Object to merge into the existing config (top-level shallow merge).",
            },
          },
          required: ["patch"],
        } as never,
      },
      execute: async (args) => {
        const which = String(args.which ?? "tenant");
        const patch = (args.patch as Record<string, unknown>) ?? {};
        if (which === "global") {
          // Read-merge-write so partial patches don't drop
          // existing keys (preserves the documented shallow-
          // merge semantics).
          const cfg = readJsonOrEmpty(getGlobalConfigPath(home)) as GlobalConfig;
          const merged = { ...cfg, ...patch } as GlobalConfig;
          writeGlobalConfig(merged, home);
          return JSON.stringify({
            which: "global",
            path: getGlobalConfigPath(home),
            patched: Object.keys(patch),
          });
        }
        // tenant
        const tenantId = String(args.tenantId ?? "");
        if (!tenantId) {
          return JSON.stringify({
            error: "missing_tenant_id",
            message:
              "which='tenant' requires tenantId. Pass which='global' if you meant the global config.",
          });
        }
        const cfgPath = path.join(
          getTenantsRoot(home),
          tenantId,
          "config.json",
        );
        const cfg = readJsonOrEmpty(cfgPath);
        const merged = { ...cfg, ...patch };
        try {
          writeTenantConfig(tenantId, merged, home);
        } catch (err) {
          if (err instanceof TenantConfigForbiddenFieldError) {
            return JSON.stringify({
              error: "tenant_forbidden_field",
              message: err.message,
              hint: "That field can only be set on the global config (which='global'). Tenants override the catalog of models / plugins / branding only.",
            });
          }
          throw err;
        }
        return JSON.stringify({
          which: "tenant",
          tenantId,
          patched: Object.keys(patch),
        });
      },
    },
    secret_list: {
      schema: {
        name: "secret_list",
        description:
          "List secret keys configured for a plugin in a tenant. Returns key names only — NEVER values. Reads via the same plugin-secrets module the plugin runtime uses at activation time, so what you see matches what the plugin will see.",
        parameters: {
          type: "object",
          properties: {
            tenantId: { type: "string" },
            pluginId: { type: "string" },
          },
          required: ["tenantId", "pluginId"],
        } as never,
      },
      execute: async (args) => {
        const tenantId = String(args.tenantId);
        const pluginId = String(args.pluginId);
        if (!ops.exists(tenantId)) {
          return JSON.stringify({
            tenantId,
            pluginId,
            keys: [],
            error: `tenant ${tenantId} does not exist`,
          });
        }
        const ctx = ops.open(tenantId);
        const secrets = loadPluginSecrets(ctx.secretsDir, pluginId);
        return JSON.stringify({
          tenantId,
          pluginId,
          keys: Object.keys(secrets),
        });
      },
    },
    secret_write: {
      mutating: true,
      describe: (args) =>
        `Set secret '${String(args.key ?? "?")}' for plugin '${String(args.pluginId ?? "?")}' in tenant '${String(args.tenantId ?? "?")}'`,
      schema: {
        name: "secret_write",
        description:
          "Set a plugin secret (API key, token) for a tenant. Goes through the same applyPluginSecretPatch the PATCH /api/plugins/:id route uses, so the file format, mode 0600, and atomic write semantics all match what the plugin runtime expects. Do NOT use config_write for API keys.\n\nWeb-search keys go here:\n  pluginId='web-search', key='tavilyApiKey' or 'braveApiKey'.\n\nNew secrets merge with existing ones; other keys for the same plugin are preserved.",
        parameters: {
          type: "object",
          properties: {
            tenantId: { type: "string" },
            pluginId: { type: "string" },
            key: {
              type: "string",
              description:
                "Dotted secret name. For web-search use 'tavilyApiKey' or 'braveApiKey'.",
            },
            value: { type: "string" },
          },
          required: ["tenantId", "pluginId", "key", "value"],
        } as never,
      },
      execute: async (args) => {
        const tenantId = String(args.tenantId);
        const pluginId = String(args.pluginId);
        const key = String(args.key);
        const value = String(args.value);
        if (serverUrl) {
          // PATCH /api/plugins/:id with { config: { <key>: <value> } }.
          // The route checks the plugin's manifest configSchema and
          // routes secret-typed fields to <tenant>/secrets/...
          // automatically. We send a patch with just our key; other
          // existing secrets / cleartext config are preserved.
          const r = await serverFetch(
            serverUrl,
            "PATCH",
            `/api/plugins/${encodeURIComponent(pluginId)}`,
            tenantId,
            { config: { [key]: value } },
          );
          return JSON.stringify({
            tenantId,
            pluginId,
            key,
            via: "http",
            response: r,
          });
        }
        const ctx = ops.exists(tenantId)
          ? ops.open(tenantId)
          : ops.create(tenantId);
        const result = applyPluginSecretPatch(ctx.secretsDir, pluginId, {
          [key]: value,
        });
        return JSON.stringify({
          tenantId,
          pluginId,
          keysAfter: Object.keys(result.secrets),
          changed: result.changed,
          via: "file",
        });
      },
    },
    run_doctor: {
      schema: {
        name: "run_doctor",
        description:
          "Run `tianshu doctor` and return the structured report. Use this to check setup state before suggesting next steps.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        } as never,
      },
      execute: async () => {
        const r = await collectDoctorReport({});
        return JSON.stringify({
          ok: r.blocker === 0,
          tally: { ok: r.ok, warning: r.warning, blocker: r.blocker },
          groups: r.groups.map((g) => ({
            title: g.title,
            lines: g.lines.map((l) => ({
              severity: l.severity,
              text: l.text,
              detail: l.detail,
            })),
          })),
        });
      },
    },
    read_service_logs: {
      schema: {
        name: "read_service_logs",
        description:
          "Read the launchd-managed dev server's stdout/stderr logs. " +
            "Use this when the wizard installed a launchd agent but the server " +
            "didn't pass the health check, or when `run_doctor` reports the " +
            "server isn't responding. Returns the most recent log lines along " +
            "with the agent's installed/loaded/pid status so you can correlate. " +
            "This is your *primary diagnostic tool* for boot failures — call it " +
            "before guessing what went wrong.",
        parameters: {
          type: "object",
          properties: {
            lines: {
              type: "number",
              description:
                "How many trailing lines to return per stream. Default 80. Bump to 200+ if you don't see the error in 80.",
            },
            stream: {
              type: "string",
              enum: ["err", "out", "both"],
              description:
                "Which stream(s) to read. Boot errors usually land in 'err' first; 'out' carries normal startup messages. Default 'both'.",
            },
          },
          required: [],
        } as never,
      },
      execute: async (args) => {
        const repoRoot = findRepoRoot();
        const label = launchd.resolveLabel(repoRoot);
        const status = launchd.readStatus(label);
        const { out, err } = launchd.logPathsFor(label);
        const linesArg = Number(args.lines);
        const lines = Number.isFinite(linesArg) && linesArg > 0 ? Math.min(linesArg, 1000) : 80;
        const streamArg = String(args.stream ?? "both");
        const stream =
          streamArg === "out" || streamArg === "err" || streamArg === "both"
            ? streamArg
            : "both";

        const result: {
          label: string;
          installed: boolean;
          loaded: boolean;
          pid: number | null;
          lastExitStatus: number | null;
          stdout?: { path: string; lines: string[] };
          stderr?: { path: string; lines: string[] };
          hint?: string;
        } = {
          label,
          installed: status.installed,
          loaded: status.loaded,
          pid: status.pid,
          lastExitStatus: status.lastExitStatus,
        };

        const tail = (file: string): string[] => {
          if (!fs.existsSync(file)) return [];
          try {
            const body = fs.readFileSync(file, "utf8");
            return body.split(/\r?\n/).slice(-lines).filter((l) => l.length > 0);
          } catch {
            return [];
          }
        };

        if (stream === "err" || stream === "both") {
          result.stderr = { path: err, lines: tail(err) };
        }
        if (stream === "out" || stream === "both") {
          result.stdout = { path: out, lines: tail(out) };
        }

        // If both streams are empty, give the agent an explicit
        // hint about what that means — saves it from guessing.
        const stdoutEmpty = !result.stdout || result.stdout.lines.length === 0;
        const stderrEmpty = !result.stderr || result.stderr.lines.length === 0;
        if (stdoutEmpty && stderrEmpty) {
          if (!status.installed) {
            result.hint =
              "Service isn't installed (no plist on disk). Tell the user to run `tianshu setup --wizard` and walk them through it.";
          } else if (!status.loaded) {
            result.hint =
              "Plist exists but launchd hasn't loaded it. Run `tianshu start` (or have the user run it). If start fails, the launchctl error is itself the diagnostic.";
          } else if (status.pid !== null) {
            result.hint =
              "Service is running (loaded + pid present) but logs are empty. Most likely the service just started and hasn't flushed yet — wait 10s and call read_service_logs again. If logs stay empty for a minute, the process may be wedged on something pre-stdio (e.g. waiting for stdin).";
          } else {
            result.hint =
              "Service is loaded but no pid — it crashed and launchd is between restarts (ThrottleInterval=30s). Wait, then read again, and look for the actual exit reason in lastExitStatus.";
          }
        } else if (
          stderrEmpty &&
          status.loaded &&
          status.pid === null &&
          status.lastExitStatus !== null &&
          status.lastExitStatus !== 0
        ) {
          result.hint = `Service exited (lastExitStatus=${status.lastExitStatus}) and stderr is empty. Look in stdout for the last messages before the exit; if those don't explain it, the process may have been killed by a signal (e.g. OOM → 137; SIGTERM → 143) rather than crashing with output.`;
        }

        return JSON.stringify(result);
      },
    },
    read_env_file: {
      schema: {
        name: "read_env_file",
        description:
          "List the keys (and value lengths, NOT values) in the .env file the dev server actually loads. Use this when run_doctor or read_service_logs reports a missing env var (e.g. 'ANTHROPIC_API_KEY references env var but it's empty') — you can see directly whether the key is present, whether the user accidentally put it in `~/.env` instead of the repo's `.env`, and whether the value is suspiciously short (<8 chars) or empty.\n\nReturns ONLY key names + length + a 4-char prefix for sanity, NEVER the full value, so it's safe to print to the user. The file path returned is the canonical path the server reads from (resolved by the same logic loadEnv() uses, so what you see matches what the running server sees).",
        parameters: {
          type: "object",
          properties: {
            keyFilter: {
              type: "string",
              description:
                "Optional substring — only return keys containing this string (case-insensitive). Example: 'API_KEY' to filter to provider keys.",
            },
          },
          required: [],
        } as never,
      },
      execute: async (args) => {
        const repoRoot = findRepoRoot();
        const envPath = path.join(repoRoot, ".env");
        const homeEnvPath = path.join(os.homedir(), ".env");
        const filter = args.keyFilter
          ? String(args.keyFilter).toLowerCase()
          : null;

        const summarize = (filepath: string) => {
          if (!fs.existsSync(filepath)) {
            return { path: filepath, exists: false, keys: [] as Array<Record<string, unknown>> };
          }
          let body: string;
          try {
            body = fs.readFileSync(filepath, "utf8");
          } catch (e) {
            return {
              path: filepath,
              exists: true,
              error: (e as Error).message,
              keys: [] as Array<Record<string, unknown>>,
            };
          }
          const keys: Array<Record<string, unknown>> = [];
          for (const rawLine of body.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const eq = line.indexOf("=");
            if (eq < 1) continue;
            const key = line.slice(0, eq).trim();
            // Strip surrounding quotes (single, double) so length
            // reflects what dotenv actually parses.
            let raw = line.slice(eq + 1).trim();
            if (
              (raw.startsWith('"') && raw.endsWith('"')) ||
              (raw.startsWith("'") && raw.endsWith("'"))
            ) {
              raw = raw.slice(1, -1);
            }
            if (filter && !key.toLowerCase().includes(filter)) continue;
            keys.push({
              key,
              length: raw.length,
              prefix: raw.slice(0, 4),
              empty: raw.length === 0,
              suspicious: raw.length > 0 && raw.length < 8,
            });
          }
          return { path: filepath, exists: true, keys };
        };

        const result = {
          // The canonical path the server *should* be reading.
          // This matches the wizard's writePath, which matches
          // load-env.ts's repo-root walk.
          serverEnv: summarize(envPath),
          // Common user mistake: put keys in ~/.env. We surface
          // it so the agent can spot it and tell the user to
          // move/copy the line.
          homeEnv:
            envPath === homeEnvPath ? null : summarize(homeEnvPath),
          note:
            "Values are NEVER returned. `length` and `prefix` are for diagnostic sanity only. If `serverEnv.keys` doesn't include the key the user expects but `homeEnv.keys` does, the user put it in the wrong file — tell them to move/copy the line into serverEnv.path.",
        };
        return JSON.stringify(result);
      },
    },
    build_sandbox: {
      mutating: true,
      describe: (args) => {
        const tpl = String(args.template ?? "task-runner-with-browser");
        const tenantId = String(args.tenantId ?? "default");
        return `Build a microsandbox snapshot from the '${tpl}' template (tenant '${tenantId}'). This downloads the base image, installs Chromium / LibreOffice / Node / Python inside the VM, and saves a snapshot. Cold builds take 5-10 min, cache hits 3-5 min. The wizard will block on this call until done.`;
      },
      schema: {
        name: "build_sandbox",
        description:
          "Build a microsandbox snapshot from a packaged template ('browser' or 'task-runner') and return its build id. This is the one-shot equivalent of the chat-shell `build_sandbox` tool: it (1) writes the chosen template into the user's Sandboxfile via PUT /api/p/microsandbox/sandboxfile, then (2) calls POST /api/p/microsandbox/builds to actually build the snapshot.\n\nUse this when the user asks to set up sandboxes during initial install. Cold build = 5-10 min (apt + Chromium + Playwright + LibreOffice tarball pulls); the wizard's whole UI will hang on the spinner. Tell the user that up front.\n\nAfter build, call use_sandbox_build with the returned buildId to publish the snapshot to a role pointer (browser / task / both).",

        parameters: {
          type: "object",
          properties: {
            tenantId: {
              type: "string",
              description:
                "Tenant whose Sandboxfile to write. Defaults to 'default'. The build runs against this tenant's user-home Sandboxfile.",
            },
            template: {
              type: "string",
              enum: ["task-runner", "browser", "task-runner-with-browser"],
              description:
                "Which packaged template to write into the Sandboxfile before building.\n\n* 'task-runner' — Node + Python + LibreOffice + office libs, no browser. ~700 MB. Foundation for the layered approach below; also the right choice for users who explicitly don't need a browser.\n* 'task-runner-with-browser' — *layered* template that adds Chromium + Playwright MCP + noVNC on top of an existing task-runner snapshot. MUST be built with `fromSnapshot` set to the snapshotName of a previously-built 'task-runner' (otherwise the build fails at the first apt step). This is the recommended browser-role snapshot for the standard two-step setup flow.\n* 'browser' — monolithic full-stack template (task-runner contents + browser stack from scratch). ~3.2 GB. Builds standalone with no fromSnapshot, but you pay the apt + LibreOffice install twice across builds. Generally avoid in setup; prefer the layered task-runner → task-runner-with-browser sequence.",
            },
            fromSnapshot: {
              type: "string",
              description:
                "Snapshot name (NOT buildId) to layer this build on top of. Required for template='task-runner-with-browser'; ignored otherwise. Get this from the `snapshotName` field of a previous build_sandbox(template='task-runner') response.",
            },
          },
          required: ["template"],
        } as never,
      },
      execute: async (args) => {
        if (!serverUrl) {
          return JSON.stringify({
            error: "server_not_running",
            message:
              "build_sandbox needs a running server (the wizard's HTTP plugin API). The wizard normally starts the server before running the agent; if you got here without a server, run `tianshu start` first.",
          });
        }
        const tenantId = String(args.tenantId ?? "default");
        const template = String(args.template);
        const fromSnapshot =
          typeof args.fromSnapshot === "string" && args.fromSnapshot.length > 0
            ? args.fromSnapshot
            : undefined;

        // Guardrail: task-runner-with-browser is layered. Without
        // fromSnapshot it will fail at the first apt step. Catch
        // that here so the agent gets an actionable error instead
        // of a generic BuildFailedError after 30 seconds of pulling.
        if (template === "task-runner-with-browser" && !fromSnapshot) {
          return JSON.stringify({
            error: "missing_from_snapshot",
            message:
              "template 'task-runner-with-browser' is layered — it must be built on top of an existing task-runner snapshot. First call build_sandbox(template='task-runner'), then call build_sandbox(template='task-runner-with-browser', fromSnapshot=<snapshotName from step 1>).",
          });
        }

        // Step 1: read the requested template body, write it into
        // the tenant's Sandboxfile. The plugin's PUT /sandboxfile
        // accepts the raw text and validates it. We resolve the
        // template path relative to the plugin's installed
        // location, which the server has already loaded.
        const templateBody = await fetchSandboxfileTemplate(
          serverUrl,
          tenantId,
          template,
        );
        if (typeof templateBody !== "string") {
          return JSON.stringify({
            error: "template_not_found",
            template,
            available:
              templateBody as { available: string[] } extends infer X ? X : never,
          });
        }
        await serverFetch(
          serverUrl,
          "PUT",
          "/api/p/microsandbox/sandboxfile",
          tenantId,
          { content: templateBody },
        );

        // Step 2: kick the build. We DON'T use the streaming
        // (?stream=1) endpoint here — the agent runs in a CLI
        // wizard and reading NDJSON line-by-line through fetch
        // doesn't buy anything; we just wait for the final
        // {type:"done"} or HTTP 500. Timeout is 20 min, well
        // above the worst observed cold build.
        const buildResp = await serverFetch(
          serverUrl,
          "POST",
          "/api/p/microsandbox/builds",
          tenantId,
          fromSnapshot ? { from_snapshot: fromSnapshot } : {},
          20 * 60_000,
        );
        // Non-streaming response shape: { build: { buildId, snapshotName, ... } }
        // (or { error, message } on failure, which serverFetch turns into a thrown Error)
        const build = (buildResp as { build?: BuildMetadataLite })?.build;
        if (!build || !build.buildId) {
          return JSON.stringify({
            error: "build_response_unexpected",
            response: buildResp,
          });
        }
        // Suggest the right next step based on which template
        // we just built. The standard layered flow is:
        //   task-runner  → publish to role='task',  then build
        //   task-runner-with-browser fromSnapshot=<task snapshot>
        //   → publish to role='browser'.
        let nextStep: string;
        if (template === "task-runner") {
          nextStep = `Call use_sandbox_build with buildId='${build.buildId}' and role='task' to publish this as the task-pool snapshot. Then call build_sandbox again with template='task-runner-with-browser' and fromSnapshot='${build.snapshotName}' to layer the browser stack on top.`;
        } else if (template === "task-runner-with-browser") {
          nextStep = `Call use_sandbox_build with buildId='${build.buildId}' and role='browser' to publish this as the long-lived browser sandbox snapshot. The task pointer should already be set from the task-runner step.`;
        } else {
          // monolithic 'browser'
          nextStep = `Call use_sandbox_build with buildId='${build.buildId}' and role='both' to publish this snapshot to both pointers.`;
        }
        return JSON.stringify({
          ok: true,
          buildId: build.buildId,
          snapshotName: build.snapshotName,
          baseImage: build.baseImage,
          durationMs: build.durationMs,
          template,
          fromSnapshot: fromSnapshot ?? null,
          tenantId,
          nextStep,
        });
      },
    },
    use_sandbox_build: {
      mutating: true,
      describe: (args) =>
        `Publish snapshot from build '${String(args.buildId ?? "?")}' to role '${String(args.role ?? "both")}' (tenant '${String(args.tenantId ?? "default")}')`,
      schema: {
        name: "use_sandbox_build",
        description:
          "Publish a built snapshot to a sandbox role pointer. Roles: 'browser' (long-lived chat sandbox with the Chromium sidecar), 'task' (per-task workboard runner pool), or 'both' (recommended when the user just wants everything to work).\n\nUnder the hood: POST /api/p/microsandbox/builds/use?build_id=...&role=...&reset=1. The reset flag bounces the live VM so it boots from the new snapshot — without it the pointer is durable but the running browser sandbox stays on the old snapshot until the next manual restart.\n\nCall this *after* build_sandbox returns a buildId. If the user asked you to 'set up sandboxes' or similar, the natural sequence is build_sandbox → use_sandbox_build with role='both'.",
        parameters: {
          type: "object",
          properties: {
            tenantId: {
              type: "string",
              description: "Tenant whose pointers to update. Defaults to 'default'.",
            },
            buildId: {
              type: "string",
              description:
                "Build id returned by build_sandbox. Looks like 'build-20260620-abc123'.",
            },
            role: {
              type: "string",
              enum: ["browser", "task", "both"],
              description:
                "Which role pointer(s) to update. 'browser' = the long-lived browser sandbox. 'task' = the per-task runner pool. 'both' = both, recommended unless the user is doing something specific.",
            },
            reset: {
              type: "boolean",
              description:
                "If true (default), bounce the live VM so it boots from the new snapshot immediately. Set false only if you want the pointer change without disrupting an in-flight session.",
            },
          },
          required: ["buildId", "role"],
        } as never,
      },
      execute: async (args) => {
        if (!serverUrl) {
          return JSON.stringify({
            error: "server_not_running",
            message: "use_sandbox_build needs a running server.",
          });
        }
        const tenantId = String(args.tenantId ?? "default");
        const buildId = String(args.buildId);
        const role = String(args.role);
        const reset = args.reset !== false; // default true
        if (!buildId) {
          return JSON.stringify({
            error: "missing_build_id",
            message: "buildId is required.",
          });
        }
        const qs = new URLSearchParams({
          build_id: buildId,
          role,
          ...(reset ? { reset: "1" } : {}),
        });
        const resp = await serverFetch(
          serverUrl,
          "POST",
          `/api/p/microsandbox/builds/use?${qs.toString()}`,
          tenantId,
          {},
          // VM bounce can take 20-40s; give it 90s for safety.
          90_000,
        );
        return JSON.stringify({
          ok: true,
          buildId,
          role,
          reset,
          tenantId,
          response: resp,
        });
      },
    },
  };
}

interface BuildMetadataLite {
  buildId: string;
  snapshotName?: string;
  baseImage?: string;
  durationMs?: number;
}

/**
 * Fetch a packaged Sandboxfile template body from the running
 * server. The microsandbox plugin exposes this via
 * GET /sandboxfile/templates, returning a record of
 * { name → content }. We look up the requested name and return
 * its content (or, on miss, the list of available names so the
 * agent can correct itself).
 */
async function fetchSandboxfileTemplate(
  serverUrl: string,
  tenantId: string,
  name: string,
): Promise<string | { available: string[] }> {
  const resp = (await serverFetch(
    serverUrl,
    "GET",
    "/api/p/microsandbox/sandboxfile/templates",
    tenantId,
  )) as {
    templates?: Array<{
      id: string;
      displayName?: string;
      description?: string;
      content: string;
    }>;
  };
  const list = resp.templates ?? [];
  const hit = list.find((t) => t.id === name);
  if (hit) return hit.content;
  return { available: list.map((t) => t.id) };
}

function readJsonOrEmpty(filepath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonAtomic(filepath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  fs.renameSync(tmp, filepath);
}

/**
 * Run the post-wizard CLI agent loop. Resolves when the user exits
 * (Ctrl-C / "done" / "exit" / "bye") or when the configured turn cap
 * is hit.
 */
export async function runCliAgent(opts: CliAgentOpts = {}): Promise<void> {
  const home = opts.home ?? getTianshuHome();
  const maxTurns = opts.maxTurns ?? 25;

  let config: GlobalConfig;
  try {
    config = loadGlobalConfig(home);
  } catch {
    p.log.error(
      "Could not load ~/.tianshu/config.json; finish the wizard first.",
    );
    return;
  }
  const info = getDefaultModel(config);
  if (!info) {
    p.log.error("No default model configured; finish the wizard first.");
    return;
  }
  const apiKey = resolveApiKey(info);
  let model: Model<Api>;
  try {
    model = buildModel(info);
  } catch (err) {
    p.log.error(
      `buildModel failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const tools = buildTools(home, opts.serverUrl);
  const toolSchemas = Object.values(tools).map((t) => t.schema);
  const messages: Message[] = [];

  p.log.info(
    `Setup assistant running on ${info.id}. Every state-changing action will ask for your confirmation. Type 'exit' / Ctrl-C any time.`,
  );

  // Kick the agent off with the diagnose-and-propose workflow
  // described in the system prompt. Agent runs run_doctor and
  // proposes next actions; nothing state-changing happens until
  // the user explicitly confirms each one.
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "Begin: run run_doctor, then summarise what's working and propose the next setup decisions for me to choose from. Don't run any state-changing tools yet — wait for me to pick.",
      },
    ],
    timestamp: Date.now(),
  });

  let turns = 0;
  while (turns < maxTurns) {
    turns += 1;
    let assistant: AssistantMessage;
    const ctx: Context = {
      systemPrompt: SETUP_SYSTEM_PROMPT,
      messages,
      tools: toolSchemas,
    };
    try {
      assistant = await complete(model, ctx, { apiKey });
    } catch (err) {
      p.log.error(
        `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    messages.push(assistant);

    // Print any text the assistant emitted.
    const textParts = assistant.content.filter(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    if (textParts.length > 0) {
      p.log.message(textParts.map((c) => c.text).join("\n"), {
        symbol: "🌱",
      });
    } else {
      // Agent returned no text. Either the model short-circuited
      // the turn or it only emitted tool calls. Surface a
      // breadcrumb so the operator knows the turn happened.
      const toolNames = assistant.content
        .filter((c) => c.type === "toolCall")
        .map((c) => (c as { name: string }).name);
      if (toolNames.length === 0) {
        const debug =
          `stopReason=${assistant.stopReason}` +
          (assistant.errorMessage ? `, errorMessage=${assistant.errorMessage}` : "") +
          `, content=${JSON.stringify(assistant.content)}`;
        p.log.warn(`(model returned an empty turn; ${debug})`);
        // No useful response. Bail rather than spinning silently.
        p.outro(
          "The model didn't respond \u2014 it returned an empty message. " +
            "This usually means the proxy / endpoint stripped the response. " +
            "Try a different default model, or check the proxy logs.",
        );
        return;
      }
    }

    // Resolve any tool calls.
    const toolCalls = assistant.content.filter(
      (c): c is ToolCall => c.type === "toolCall",
    );
    if (toolCalls.length === 0) {
      // No tool calls → wait for user input.
      const reply = await p.text({
        message: "you:",
        placeholder: "(type your reply, or 'exit' to leave)",
      });
      if (p.isCancel(reply) || /^(exit|quit|bye|done)$/i.test(String(reply).trim())) {
        p.outro("All set. Start the server with `tianshu dev` or `npm run dev`.");
        return;
      }
      messages.push({
        role: "user",
        content: [{ type: "text", text: String(reply) }],
        timestamp: Date.now(),
      });
      continue;
    }

    // Execute every tool call in order.
    for (const call of toolCalls) {
      const handler = tools[call.name];
      let result: ToolResultMessage;
      if (!handler) {
        result = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [
            {
              type: "text",
              text: `unknown tool: ${call.name}`,
            },
          ],
          isError: true,
          timestamp: Date.now(),
        };
      } else {
        // For mutating tools, surface the intent and ask the user
        // for explicit confirmation before running. Read-only
        // tools (run_doctor, tenant_list, config_read) execute
        // silently — they don't change state.
        if (handler.mutating) {
          const summary = handler.describe
            ? handler.describe(call.arguments)
            : `${call.name}(${shortArgs(call.arguments)})`;
          const ok = await p.confirm({
            message: `\ud83d\udd11 Agent wants to: ${summary}`,
            initialValue: true,
          });
          if (p.isCancel(ok) || ok === false) {
            result = {
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [
                {
                  type: "text",
                  text: `User declined this action. Do not retry without asking. Move on or ask the user what to do instead.`,
                },
              ],
              isError: false,
              timestamp: Date.now(),
            };
            p.log.warn(`declined: ${summary}`);
            messages.push(result);
            continue;
          }
        }
        try {
          const out = await handler.execute(call.arguments);
          result = {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: out }],
            isError: false,
            timestamp: Date.now(),
          };
          // Surface what the agent did with enough context that
          // the user can audit it. Read-only tools just show
          // name + args; mutating tools were already confirmed
          // above, so we just confirm completion.
          if (handler.mutating) {
            const summary = handler.describe
              ? handler.describe(call.arguments)
              : `${call.name}(${shortArgs(call.arguments)})`;
            p.log.success(`done: ${summary}`);
          } else {
            p.log.step(
              `${call.name}(${shortArgs(call.arguments)})`,
            );
          }
        } catch (err) {
          result = {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
            isError: true,
            timestamp: Date.now(),
          };
          p.log.warn(
            `${call.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      messages.push(result);
    }
  }

  p.log.warn(
    `Reached ${maxTurns}-turn cap; exiting. You can re-enter with \`tianshu setup --wizard\`.`,
  );
}

function shortArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
}
