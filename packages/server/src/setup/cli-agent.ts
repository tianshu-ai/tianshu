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
import { collectDoctorReport } from "./doctor.js";

export interface CliAgentOpts {
  home?: string;
  /** Stop after this many user/assistant turns (defaults to 25). Hard cap to
   *  prevent runaway loops; not surfaced to the user. */
  maxTurns?: number;
}

const SETUP_SYSTEM_PROMPT = `You are the tianshu setup auto-fixer.

The user just finished configuring an LLM provider. Their job is
done — they shouldn't have to keep typing. Your job is to detect
and fix the remaining setup gaps automatically, then hand them a
working system.

Workflow you must follow on the FIRST turn:

  1. Call run_doctor to see what's set up.
  2. Read the report. Auto-fix every gap that is fixable without
     asking the user (a 'safe auto-fix' is enabling the standard
     plugins for the default tenant: files, workboard,
     microsandbox, web-search). Call plugin_enable / config_write
     etc. as needed. Don't ask permission for safe fixes — just
     do them.
  3. After fixing, call run_doctor a second time and verify the
     warnings cleared.
  4. Send ONE summary message to the user listing:
     - What you auto-fixed (with checkmarks)
     - What remains that needs THEIR input (e.g. web-search needs
       a Tavily/Brave API key; microsandbox runtime might be
       missing and needs \`npx microsandbox install\`)
     - One concrete next step (or 'All done, run tianshu dev').

When the user replies, help them with whatever they ask:
- Enable / disable plugins
- Create a new tenant or user
- Edit config (e.g. add a Tavily key for web-search)
- Re-run run_doctor on demand

Style: brief, direct, no fluff. Run tools rather than asking the
user to copy-paste commands. Confirm destructive actions (e.g.
never delete a tenant without confirmation).

When the user says they're done / satisfied / wants to exit, run
run_doctor one last time, summarise, then end with:
"All set. Run 'tianshu dev' (or 'npm run dev' in a checkout)
to start the server."`;

interface ToolHandler {
  schema: Tool;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

function buildTools(home: string): Record<string, ToolHandler> {
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
      schema: {
        name: "plugin_enable",
        description:
          "Enable a built-in plugin (files | workboard | microsandbox | web-search) inside a tenant. Persists to that tenant's config.json.",
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
        return JSON.stringify({ tenantId, pluginId, enabled: true });
      },
    },
    plugin_disable: {
      schema: {
        name: "plugin_disable",
        description:
          "Disable a plugin in the given tenant. The plugin entry is kept (so config like API keys aren't lost) but `enabled` flips to false.",
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
        return JSON.stringify({ tenantId, pluginId, enabled: false });
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

  const tools = buildTools(home);
  const toolSchemas = Object.values(tools).map((t) => t.schema);
  const messages: Message[] = [];

  p.log.info(
    `Setup auto-fix running on ${info.id}. The agent will diagnose, fix what it can, and report. Type 'exit' / Ctrl-C any time.`,
  );

  // Kick the agent off with the auto-fix workflow described in
  // the system prompt. The user shouldn't have to type the first
  // word; the agent diagnoses + fixes + reports.
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "Begin: run the setup auto-fix workflow now (run_doctor → enable standard plugins for the default tenant if missing → run_doctor again → summarise what you fixed and what still needs input).",
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
          p.log.step(`${call.name}(${shortArgs(call.arguments)}) → ok`);
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
