/**
 * Standard A2A Protocol (v1.0) support for the messenger plugin.
 *
 * Pairing and auth unchanged (existing JWT scoped tokens).
 * Two additions:
 *   GET  /.well-known/agent-card.json  → serves tenant+user agent card (plugin route)
 *   POST /a2a/receive                  → now also accepts standard A2A JSON-RPC
 *
 * Client: sendStandardA2AMessage() sends to external standard A2A agents.
 */

import {
  type AgentCard,
  type Message,
  Role,
  A2A_PROTOCOL_VERSION,
} from "@a2a-js/sdk";

// ── Build Agent Card (A2A v1.0 format) ─────────────────────────

import type { AgentCard as TianshuAgentCard } from "./schema.js";

export function buildAgentCard(
  publicUrl: string,
  card: TianshuAgentCard | null,
): AgentCard {
  const name = card?.name || "Tianshu Agent";
  const description = card?.description || "A tianshu AI agent";
  const skills = card?.skills?.length
    ? card.skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags || [],
        examples: s.examples || [],
        inputModes: card.defaultInputModes || ["text"],
        outputModes: card.defaultOutputModes || ["text"],
        securityRequirements: [],
      }))
    : [
        {
          id: "chat",
          name,
          description,
          tags: ["chat"],
          examples: [],
          inputModes: ["text"] as string[],
          outputModes: ["text"] as string[],
          securityRequirements: [],
        },
      ];

  return {
    name,
    description,
    supportedInterfaces: [
      {
        url: `${publicUrl}/api/p/messenger/a2a/receive`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: card?.provider || "tianshu-ai",
      url: card?.providerUrl || publicUrl,
    },
    version: card?.version || "1.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme" as const,
          value: { scheme: "bearer", bearerFormat: "JWT", description: "" },
        },
      },
    },
    securityRequirements: [],
    defaultInputModes: card?.defaultInputModes || ["text"],
    defaultOutputModes: card?.defaultOutputModes || ["text"],
    skills,
    documentationUrl: "",
    signatures: [],
  };
}

// ── Parse standard A2A JSON-RPC request ────────────────────────

export interface ParsedA2AMessage {
  /** JSON-RPC method, e.g. "message/send" */
  method: string;
  /** JSON-RPC id */
  id: string | number | null;
  /** Extracted text from message parts */
  text: string;
  /** Sender name from metadata */
  senderName: string;
  /** Context ID */
  contextId: string;
  /** Task ID */
  taskId: string;
}

/**
 * Try to parse a request body as standard A2A JSON-RPC.
 * Returns null if it's not a JSON-RPC request (i.e. it's legacy format).
 */
export function parseA2AJsonRpc(body: unknown): ParsedA2AMessage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.jsonrpc !== "2.0" || typeof b.method !== "string") return null;

  const params = b.params as Record<string, unknown> | undefined;
  if (!params) return null;

  const message = params.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const parts = message.parts as Array<Record<string, unknown>> | undefined;
  let text = "";
  if (Array.isArray(parts)) {
    for (const part of parts) {
      // Standard A2A JSON wire format: { text: "..." } or { content: { text: "..." } }
      if (typeof part.text === "string") {
        text += part.text;
      } else if (part.content && typeof part.content === "object") {
        const c = part.content as Record<string, unknown>;
        if (typeof c.value === "string") text += c.value;
      }
    }
  }

  const metadata = message.metadata as Record<string, unknown> | undefined;
  const senderName = (metadata?.senderName as string) || "A2A Agent";

  return {
    method: b.method as string,
    id: (b.id as string | number | null) ?? null,
    text,
    senderName,
    contextId: (message.contextId as string) || crypto.randomUUID(),
    taskId: (params.id as string) || crypto.randomUUID(),
  };
}

/**
 * Build a standard A2A JSON-RPC response for message/send (completed task).
 */
export function buildA2AJsonRpcResponse(
  id: string | number | null,
  taskId: string,
  contextId: string,
  replyText: string,
): object {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      id: taskId,
      contextId,
      status: {
        state: "completed",
        timestamp: new Date().toISOString(),
        message: {
          role: "agent",
          messageId: crypto.randomUUID(),
          parts: [{ text: replyText }],
        },
      },
      artifacts: [],
      history: [],
      metadata: {},
    },
  };
}

// ── Client: Send message to standard A2A agent ─────────────────

export async function sendStandardA2AMessage(
  endpoint: string,
  text: string,
  senderName: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Send a standard A2A JSON-RPC message/send request
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          role: "user",
          messageId: crypto.randomUUID(),
          parts: [{ text }],
          metadata: { senderName },
        },
      },
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}` };
    }

    const result = await r.json();
    if (result.error) {
      return { ok: false, error: result.error.message || JSON.stringify(result.error) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
