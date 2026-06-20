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
//   needs `npx microsandbox install`, the agent just tells them)
// - workboard (worker spawn is overkill for setup)
//
// Tools shipped (8): tenant_list, tenant_create, user_create,
//   plugin_enable, plugin_disable, config_read, config_write,
//   run_doctor. Plus the implicit "done" sentinel.

import * as p from "@clack/prompts";
import fs from "node:fs";
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
import { loadGlobalConfig, type GlobalConfig } from "../core/config.js";
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

  1. Call run_doctor to see what's set up.
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

WEB SEARCH (web-search plugin):
- API keys go to SECRETS, not regular config. Use \`secret_write\`
  with pluginId='web-search' and key='tavilyApiKey' (Tavily) or
  'braveApiKey' (Brave). DO NOT use \`config_write\` for these.
  config.json is committable, secrets/ is not.
- Check \`secret_list\` first to see what's already configured
  before asking the user for a key.

MICROSANDBOX (sandbox-based plugins: microsandbox, browser):
- microsandbox uses TWO sandbox roles, both built from snapshot
  templates: 'task' (per-task ephemeral sandboxes for the
  workboard's exec/coding work) and 'browser' (the long-lived
  sandbox hosting the headless Chromium + playwright-mcp
  sidecar).
- Both must be built and pointed at separately. The build flow is:
  1. \`build_sandbox role=task ...\` to bake a task snapshot.
  2. \`build_sandbox role=browser ...\` to bake a browser snapshot.
  3. \`use_sandbox_build buildId=... role=task\` to publish.
  4. \`use_sandbox_build buildId=... role=browser\` to publish.
- These tools are NOT exposed in the setup wizard — only
  available once \`tianshu dev\` is running and the user is in
  the chat shell. Tell the user this; don't try to call them.
- If \`run_doctor\` says microsandbox runtime binary is missing,
  tell the user: 'run \`npx microsandbox install\` in another
  terminal, then start the server with \`tianshu dev\` and ask
  the chat agent to build sandboxes for both task and browser
  roles.'

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
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
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

function buildTools(
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
        const patch = (args.patch as Record<string, unknown>) ?? {};
        const keys = Object.keys(patch).join(", ") || "(empty patch)";
        return `Patch tenant '${String(args.tenantId ?? "?")}' config (keys: ${keys})`;
      },
      schema: {
        name: "config_write",
        description:
          "Write a tenant config (~/.tianshu/tenants/<id>/config.json) by merging the supplied object into the existing file. Top-level keys in the patch overwrite the existing values; non-mentioned keys are preserved. Use this to set web-search API keys, change defaultModel, etc.",
        parameters: {
          type: "object",
          properties: {
            tenantId: { type: "string" },
            patch: {
              type: "object",
              description:
                "Object to merge into the existing config (top-level shallow merge).",
            },
          },
          required: ["tenantId", "patch"],
        } as never,
      },
      execute: async (args) => {
        const tenantId = String(args.tenantId);
        const patch = (args.patch as Record<string, unknown>) ?? {};
        const cfgPath = path.join(
          getTenantsRoot(home),
          tenantId,
          "config.json",
        );
        const cfg = readJsonOrEmpty(cfgPath);
        const merged = { ...cfg, ...patch };
        writeJsonAtomic(cfgPath, merged);
        return JSON.stringify({ tenantId, patched: Object.keys(patch) });
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
  };
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
