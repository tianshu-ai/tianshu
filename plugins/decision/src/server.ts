// Decision Model plugin — routes user messages through a decision model
// before the agent processes them. Supports local sidecar, Cloudflare
// Workers AI, and any Jev/SystemOne-compatible endpoint.

import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  PluginRouteHandler,
  AgentTool,
  AgentToolContext,
  ToolResult,
} from "@tianshu-ai/plugin-sdk";
import { Type } from "typebox";
import type { Request, Response } from "express";

// ─── Types ───────────────────────────────────────────────────────

interface DecisionConfig {
  driver: "local" | "cloudflare" | "custom";
  endpoint: string;
  model: string;
  confidenceThreshold: number;
  enabled: boolean;
  // API key for custom endpoints (e.g. SiliconFlow)
  apiKey?: string;
  // Cloudflare-specific
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
}

interface SystemOneRequest {
  model: string;
  state: string | Record<string, unknown>;
  questions: Record<string, {
    type: "choice" | "score" | "noul";
    instructions?: string;
    criteria?: Record<string, string> | string[];
  }>;
}

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: number[];
}

interface NoulAnswer {
  type: "noul";
  probability?: number;
  noul?: number; // SiliconFlow/Kev format
}

type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
  _latencyMs?: number;
}

// ─── Decision Service ────────────────────────────────────────────

function readConfig(ctx: PluginContext): DecisionConfig {
  const raw = (ctx.pluginConfig ?? {}) as Record<string, unknown>;
  return {
    driver: (raw.driver as string) as DecisionConfig["driver"] || "local",
    endpoint: (raw.endpoint as string) || "http://127.0.0.1:8710/v1/systemone",
    model: (raw.model as string) || "clef-flash",
    confidenceThreshold: parseFloat(String(raw.confidenceThreshold ?? "0.85")),
    enabled: raw.enabled !== false,
    apiKey: raw.apiKey as string | undefined,
    cloudflareAccountId: raw.cloudflareAccountId as string | undefined,
    cloudflareApiToken: raw.cloudflareApiToken as string | undefined,
  };
}

async function callDecisionModel(
  config: DecisionConfig,
  request: SystemOneRequest,
  log: PluginContext["log"],
): Promise<SystemOneResponse> {
  const t0 = Date.now();

  if (config.driver === "cloudflare") {
    if (!config.cloudflareAccountId || !config.cloudflareApiToken) {
      throw new Error("Cloudflare account ID and API token are required");
    }
    const model = config.model === "clef" ? "@cf/cloudflare/clef" : "@cf/cloudflare/clef-flash";
    const url = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/${model}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.cloudflareApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloudflare API error ${res.status}: ${text}`);
    }
    const data = await res.json() as SystemOneResponse;
    data._latencyMs = Date.now() - t0;
    return data;
  }

  // Local or custom endpoint
  const url = config.endpoint;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Decision model error ${res.status}: ${text}`);
  }
  const data = await res.json() as SystemOneResponse;
  if (!data._latencyMs) data._latencyMs = Date.now() - t0;
  return data;
}

// ─── Agent Tool: decide ──────────────────────────────────────────

function buildDecideTool(ctx: PluginContext): AgentTool {
  return {
    schema: {
      name: "decide",
      description:
        "Ask the decision model a structured question. Returns typed answers " +
        "with probabilities. Use for classification, routing, scoring, or " +
        "yes/no judgments. Much faster and cheaper than using the LLM for " +
        "simple decisions.\n\n" +
        "Question types:\n" +
        "- choice: pick one from named options\n" +
        "- score: rate on an ordered scale\n" +
        "- noul: yes/no probability",
      parameters: Type.Object({
        state: Type.String({
          description: "The context/evidence to evaluate (text or JSON string)",
        }),
        questions: Type.Record(
          Type.String(),
          Type.Object({
            type: Type.Union([
              Type.Literal("choice"),
              Type.Literal("score"),
              Type.Literal("noul"),
            ]),
            instructions: Type.Optional(Type.String()),
            criteria: Type.Optional(Type.Unknown()),
          }),
          { description: "Questions to evaluate. Keys are answer IDs." },
        ),
      }),
    },
    execute: async (raw): Promise<ToolResult> => {
      const p = raw as { state: string; questions: Record<string, unknown> };
      const config = readConfig(ctx);
      if (!config.enabled) {
        return { ok: false, text: "Decision model is not enabled. Configure it in Settings." };
      }
      try {
        const response = await callDecisionModel(config, {
          model: config.model,
          state: p.state,
          questions: p.questions as SystemOneRequest["questions"],
        }, ctx.log);

        // Format readable output
        const lines: string[] = [`Decision (${response._latencyMs ?? "?"}ms):`];
        for (const [qid, answer] of Object.entries(response.answers)) {
          if (answer.type === "choice") {
            const a = answer as ChoiceAnswer;
            const probs = Object.entries(a.probabilities)
              .sort(([, a], [, b]) => b - a)
              .map(([k, v]) => `${k}=${(v * 100).toFixed(1)}%`)
              .join(", ");
            lines.push(`  ${qid}: ${a.choice} (${(a.confidence * 100).toFixed(1)}%) [${probs}]`);
          } else if (answer.type === "score") {
            const a = answer as ScoreAnswer;
            lines.push(`  ${qid}: score=${a.score.toFixed(2)}`);
          } else if (answer.type === "noul") {
            const a = answer as NoulAnswer;
            const prob = a.probability ?? a.noul ?? 0;
            lines.push(`  ${qid}: ${(prob * 100).toFixed(1)}% likely`);
          }
        }
        return {
          ok: true,
          text: lines.join("\n"),
          data: response,
        };
      } catch (err: any) {
        return { ok: false, text: `Decision model error: ${err.message}` };
      }
    },
  };
}

// ─── REST routes ─────────────────────────────────────────────────

function buildRoutes(ctx: PluginContext): Record<string, PluginRouteHandler> {
  const healthCheck: PluginRouteHandler = async (_req: Request, res: Response) => {
    const config = readConfig(ctx);
    if (config.driver === "local" || config.driver === "custom") {
      try {
        const healthUrl = config.endpoint.replace(/\/v1\/systemone$/, "/health");
        const r = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
        const data = await r.json();
        res.json({ status: "ok", driver: config.driver, endpoint: config.endpoint, upstream: data });
      } catch (err: any) {
        res.json({ status: "unavailable", driver: config.driver, endpoint: config.endpoint, error: err.message });
      }
    } else {
      res.json({ status: "ok", driver: config.driver, model: config.model });
    }
  };

  const evaluate: PluginRouteHandler = async (req: Request, res: Response) => {
    const config = readConfig(ctx);
    if (!config.enabled) {
      res.status(503).json({ error: "Decision model not enabled" });
      return;
    }
    try {
      const body = req.body as SystemOneRequest;
      if (!body.state || !body.questions) {
        res.status(400).json({ error: "state and questions are required" });
        return;
      }
      const response = await callDecisionModel(config, {
        model: config.model,
        state: body.state,
        questions: body.questions,
      }, ctx.log);
      res.json(response);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  const getConfig: PluginRouteHandler = (_req: Request, res: Response) => {
    const config = readConfig(ctx);
    // Don't expose secrets
    res.json({
      driver: config.driver,
      endpoint: config.driver !== "cloudflare" ? config.endpoint : undefined,
      model: config.model,
      confidenceThreshold: config.confidenceThreshold,
      enabled: config.enabled,
      hasCloudflareCredentials: !!(config.cloudflareAccountId && config.cloudflareApiToken),
    });
  };

  return { healthCheck, evaluate, getConfig };
}

// ─── Plugin lifecycle ────────────────────────────────────────────

const plugin: PluginServerModule = {
  async activate(ctx: PluginContext): Promise<PluginServerExports> {
    const config = readConfig(ctx);
    ctx.log.info(`decision plugin activated: driver=${config.driver}, model=${config.model}, enabled=${config.enabled}`);

    return {
      tools: {
        DecideTool: buildDecideTool(ctx),
      },
      routes: buildRoutes(ctx),
    };
  },
  async deactivate() {
    /* nothing to tear down */
  },
};

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
