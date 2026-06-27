// WebSocket chat handler — wires together the tenant context, the
// message store, pi-agent-core's runAgentLoop, and the plugin tool
// surface.
//
// Per-turn flow:
//   1. user prompt arrives → maybe-compact → persist user message
//   2. hand the prompt to piRunAgentLoop with the tenant's tools
//      and skills, plus a config that caps assistant turns at
//      MAX_TURNS
//   3. emit() callback bridges pi events to the WS protocol:
//        text_delta deltas → stream_delta
//        toolcall_start → tool_call (UI shows chips early)
//        message_end (assistant) → persist + message_added
//        message_end (toolResult) → persist + tool_result + message_added
//        agent_end → stream_end
//
// MAX_TURNS exists because a model that decides to call its tools
// in a loop with no productive progress would otherwise burn budget
// forever. shouldStopAfterTurn enforces it.

import {
  AgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  Session as PiSession,
  estimateContextTokens,
  shouldCompact,
  type AgentHarnessEvent,
  type AgentHarnessOwnEvent,
  type AgentMessage,
  type CompactionSettings,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHomeDir } from "./require-home-dir.js";
import {
  defaultSystemPrompt,
  type PluginPromptFragment,
} from "./system-prompt.js";
import {
  shouldCompactBranch,
  tryAutoCompact,
  type AutoCompactDecision,
  type ShouldCompactBranchInput,
} from "./compact-decision.js";
// Re-export the compaction-decision API at the handler boundary so
// callers that imported it from handler.ts (agent-loop.ts, tests)
// keep working without churn.
export {
  shouldCompactBranch,
  tryAutoCompact,
  type AutoCompactDecision,
  type ShouldCompactBranchInput,
};
// Re-export prompt builders so callers that imported them from
// handler.ts (agent-loop.ts, tests) keep working without churn.
export {
  defaultSystemPrompt,
  formatAvailableSkillsBlock,
  formatExecutionBiasBlock,
  formatMainAgentContextBlock,
  formatPluginPromptFragments,
  formatRuntimeContextBlock,
  formatWorkerAgentContextBlock,
  formatWorkspaceContextBlock,
  substituteUserIdPlaceholders,
  type PluginPromptFragment,
} from "./system-prompt.js";
import type { WebSocket } from "ws";
import {
  buildModel,
  findModel,
  getDefaultModel,
  resolveApiKey,
  type ResolvedModelInfo,
  type TenantContext,
} from "../core/index.js";
import { buildToolset } from "../tools/index.js";
import { adaptToolset, isAdapterError } from "./agent-tool-adapter.js";
import { dumpSystemPrompt } from "./dump-system-prompt.js";
import { SqliteSessionRepo } from "./sqlite-session-repo.js";
import {
  drainPending as drainInbox,
  renderForPrompt as renderInboxForPrompt,
  markDeliveredFromMessage,
} from "./session-inbox.js";
import {
  registerActiveHarness,
  registerUserSendChannel,
} from "./active-harnesses.js";
import { SqliteSessionStorage } from "./sqlite-session-storage.js";
import { makeStubExecutionEnv } from "./stub-execution-env.js";
import {
  filterSkillsForTenant,
  loadSkillsForPlugin,
  type LoadedSkill,
} from "../core/plugins/skills.js";
import { loadTenantSkills } from "../core/tenant-skills.js";
import { fileURLToPath } from "node:url";
import {
  ensureActiveSession,
  listMessagesForSessionPage,
  listMessagesForUser,
  listMessagesForUserPage,
  loadAgentHistoryForSession,
  type ChatMessage,
  type ChatSession,
} from "./messages.js";
import {
  flushToolDeltaForSession,
  peekToolCatalogDelta,
} from "./flush-tool-delta.js";
import { CompactSkippedError, compactSession } from "./compact.js";
import {
  toWire,
  type ClientMsg,
  type ServerMsg,
  type ToWireOpts,
  type WireAttachment,
  type WireMessage,
} from "./ws-protocol.js";
import {
  cacheGet,
  cachePut,
  fitToLimit,
  imageFitCacheKey,
} from "./image-fit.js";

const MAX_TURNS = 16;

export interface ChatHandlerOpts {
  ctx: TenantContext;
  userId: string;
  socket: WebSocket;
  /**
   * Plugin registry for this tenant. The chat handler asks it for
   * the current `toolsForTenant()` and a `hostCapabilities()`
   * handle each agent turn, so plugin enable/disable flips are
   * picked up without restarting the session.
   */
  pluginRegistry?: import("../core/plugins/registry.js").PluginRegistry;
  /** Tenant root dir on the host — fed into AgentToolContext. */
  homeDir?: string;
}

export function attachChatHandler(opts: ChatHandlerOpts): void {
  const { ctx, userId, socket, pluginRegistry, homeDir } = opts;

  const send = (msg: ServerMsg) => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(msg));
  };

  send({ type: "connected", tenantId: ctx.tenantId, userId });

  // Surface any host-version drift since this user's last active
  // session was stamped — typically the host got upgraded while
  // they were offline. The agent loop's flushToolDeltaForSession
  // still does the side-effecting work (append history note + bump
  // session stamp) on the user's next prompt; the WS event here is
  // purely for the UI banner. Skipped silently when there's no
  // active session yet (brand-new user) or when the session is
  // already up to date.
  try {
    const activeSession = ensureActiveSession(ctx, userId);
    const drift = peekToolCatalogDelta({
      ctx,
      session: activeSession,
      pluginRegistry,
    });
    if (drift) {
      send({
        type: "tool_catalog_changed",
        fromVersion: drift.fromVersion,
        toVersion: drift.toVersion,
        newTools: drift.newTools,
      });
    }
  } catch (err) {
    // Best-effort — we never want a banner-probe failure to break
    // the chat connection itself.
    console.warn(
      `[chat] tool-catalog peek failed for ${ctx.tenantId}/${userId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Register this socket's send thunk so the session-inbox idle
  // runner can broadcast a background turn's stream to every
  // tab the user has open. unregister fires on `close` below.
  const unregisterUserChannel = registerUserSendChannel(
    ctx.tenantId,
    userId,
    send,
  );

  let aborter: AbortController | null = null;

  socket.on("message", (raw) => {
    let parsed: ClientMsg;
    try {
      parsed = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return;
    }

    switch (parsed.type) {
      case "hello":
        send({ type: "connected", tenantId: ctx.tenantId, userId });
        return;
      case "history": {
        const opts = makeWireOpts(ctx);
        // Caller can pin to a specific session (e.g. a channel
        // session in the sidebar). Default keeps the legacy
        // "all this user's main-session messages" behaviour.
        const page = parsed.sessionId
          ? listMessagesForSessionPage(ctx, parsed.sessionId, {
              limit: parsed.limit,
            })
          : listMessagesForUserPage(ctx, userId, {
              limit: parsed.limit,
            });
        send({
          type: "history",
          messages: page.messages.map((m) => toWire(m, opts)),
          hasMore: page.hasMore,
        });
        return;
      }
      case "history_more": {
        const opts = makeWireOpts(ctx);
        const page = parsed.sessionId
          ? listMessagesForSessionPage(ctx, parsed.sessionId, {
              limit: parsed.limit,
              before: parsed.before,
            })
          : listMessagesForUserPage(ctx, userId, {
              limit: parsed.limit,
              before: parsed.before,
            });
        send({
          type: "history_page",
          messages: page.messages.map((m) => toWire(m, opts)),
          hasMore: page.hasMore,
          before: parsed.before,
        });
        return;
      }
      case "prompt": {
        if (aborter) aborter.abort(); // single in-flight prompt per socket
        aborter = new AbortController();
        // Slash-command: `/compact` runs an immediate compaction
        // pass without sending a fresh user prompt. Recognised when
        // the typed body is exactly the marker plus optional
        // whitespace and (for parity with the legacy CLI) `!`.
        const trimmed = parsed.content.trim();
        if (trimmed === "/compact" || trimmed === "/compact!") {
          runManualCompact({
            ctx,
            userId,
            send,
            modelId: parsed.modelId,
            signal: aborter.signal,
          }).catch((err) => {
            send({
              type: "stream_error",
              reason: err instanceof Error ? err.message : String(err),
            });
          });
          return;
        }
        runPrompt({
          ctx,
          userId,
          send,
          content: parsed.content,
          modelId: parsed.modelId,
          attachments: parsed.attachments,
          signal: aborter.signal,
          pluginRegistry,
          homeDir,
        }).catch((err) => {
          send({
            type: "stream_error",
            reason: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      case "abort": {
        aborter?.abort();
        aborter = null;
        return;
      }
    }
  });

  socket.on("close", () => {
    aborter?.abort();
    aborter = null;
    unregisterUserChannel();
  });
}

interface RunPromptArgs {
  ctx: TenantContext;
  userId: string;
  send: (msg: ServerMsg) => void;
  content: string;
  modelId?: string;
  attachments?: WireAttachment[];
  signal: AbortSignal;
  pluginRegistry?: import("../core/plugins/registry.js").PluginRegistry;
  homeDir?: string;
  /**
   * Optional explicit session. When provided, runPrompt skips the
   *  `ensureActiveSession(userId)` lookup and uses this session
   *  directly. The channel router uses this so inbound platform
   *  messages land in a channel-scoped session instead of the
   *  user's webchat session. Caller is responsible for creating
   *  the row (see `channels/sessions.ts: ensureChannelSession`)
   *  before runPrompt picks it up.
   */
  session?: import("./messages.js").ChatSession;
}

export async function runPrompt(args: RunPromptArgs): Promise<void> {
  const { ctx, userId, send, content, modelId, attachments, signal, pluginRegistry, homeDir } = args;
  const wireOpts = makeWireOpts(ctx);
  const repo = new SqliteSessionRepo(ctx);

  // Caller-provided session wins; for the chat shell this stays
  // undefined and we fall back to the per-user active session.
  // The channel router uses this hook to feed inbound platform
  // messages into a channel-scoped session.
  let session = args.session ?? ensureActiveSession(ctx, userId);

  // Per-prompt tool-delta flush: if the host upgraded since this
  // session was opened and there are new builtin tools, drop a
  // synthetic system note into the session before we build the
  // model's history. See chat/flush-tool-delta.ts. Errors there
  // are best-effort — a failure here must never block the prompt.
  try {
    flushToolDeltaForSession({ ctx, session, pluginRegistry });
  } catch (err) {
    console.warn(
      `[flush-tool-delta] unexpected throw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Resolve the model up front — we need imageMaxBytes / context
  // window for both auto-compact and the LLM call below.
  const modelInfo = (modelId ? findModel(ctx.config, modelId) : undefined) ?? getDefaultModel(ctx.config);
  if (!modelInfo) {
    send({
      type: "stream_error",
      reason: "no models configured (set models in ~/.tianshu/config.json)",
    });
    return;
  }

  const piModel = buildModel(modelInfo);
  const apiKey = resolveApiKey(modelInfo);
  const userHome = ctx.userHomeDir(userId);

  // MCP toolsets (e.g. plugin-microsandbox's Playwright server)
  // expose a `tools/list` only after the upstream is reachable.
  // Plugin activation kicks off a fire-and-forget initial refresh,
  // but the upstream often isn't ready yet (sandbox still booting,
  // user-configured server still being saved). Without a per-turn
  // warmup the agent never sees these tools until someone hits
  // `/admin/mcp` to refresh by hand. Run the same opportunistic
  // refresh the admin route does, but with a tighter deadline so
  // we don't block a chat turn for too long when an upstream is
  // genuinely down.
  if (pluginRegistry) {
    try {
      await pluginRegistry.refreshStaleToolsets(ctx.tenantId, 1500);
    } catch {
      // refreshStaleToolsets already swallows per-toolset errors;
      // a thrown one would mean the registry itself faulted, which
      // we don't want to surface as a chat failure either — the
      // agent will simply see whatever toolset state we already
      // had.
    }
  }
  const pluginTools = pluginRegistry?.toolsForTenant(ctx.tenantId) ?? [];
  // Skill priority (later wins on the dedup key, which is the
  // directory name for tenant skills and the contribution id for
  // host/plugin skills): host+plugin (mirrored) → tenant scope.
  // Tenant scope wins by design — the user can override or shadow a
  // shipped skill by dropping a same-named directory under
  // `_tenant/config/{skills,main/skills}/`. The mirrored copies
  // live under `_tenant/config/skills/_host/<pid>/<id>/SKILL.md`
  // and carry tenant-config:/// filePaths so the system prompt's
  // <available_skills> block can advertise them in the same shape
  // as user-authored skills.
  const allSkills = [
    ...(pluginRegistry?.mirroredSkillsForTenant(ctx.tenantId) ?? []),
    ...loadTenantSkills({
      tenantId: ctx.tenantId,
      scope: { kind: "main" },
      onFailure: (f) =>
        console.warn(
          `[tenant-skills:${f.scope}] ${f.filePath}: ${f.reason}`,
        ),
    }),
  ];
  // Build a set of registered tool names from pluginTools' schemas.
  // We don't yet know what `available()` will say, so we use the
  // schema name; this slightly over-includes skills that depend on
  // a tool that ends up hidden, but the agent simply won't reach
  // for those. Conservative on the side of more visibility.
  const declaredToolNames = new Set(pluginTools.map(({ tool }) => tool.schema.name));
  const hostCaps = pluginRegistry?.hostCapabilities(ctx.tenantId) ?? emptyHostCapabilities();
  const skills = filterSkillsForTenant(allSkills, {
    hasTool: (n) => declaredToolNames.has(n),
    hasCapability: (n) => hostCaps.has(n as never),
    agentScope: "main",
  });
  // Plugin-contributed prompt fragments: short imperative
  // sentences declared in `manifest.contributes.systemPromptFragments`,
  // injected on every turn for every active plugin in the tenant.
  // Workers don't get these (the agent-loop's worker path uses a
  // separate prompt path).
  const pluginFragments =
    pluginRegistry?.systemPromptFragmentsForTenant(ctx.tenantId) ?? [];
  // Channel-session awareness: if this session is bound to a chat
  // platform (wechat / telegram / ...), feed the tagging into the
  // toolset (so channel-only tools become visible) AND into the
  // system prompt (so the agent knows what channel it's on). On
  // webchat sessions both stay null and channel tools stay hidden.
  const channelTag = ctx.db
    .prepare<
      [string],
      {
        channel_binding_id: string | null;
        channel_id: string | null;
        channel_chat_id: string | null;
      }
    >(
      `SELECT channel_binding_id, channel_id, channel_chat_id
         FROM sessions WHERE id = ?`,
    )
    .get(session.id);
  const channelSession =
    channelTag?.channel_binding_id &&
    channelTag.channel_id &&
    channelTag.channel_chat_id
      ? {
          bindingId: channelTag.channel_binding_id,
          channelId: channelTag.channel_id,
          chatId: channelTag.channel_chat_id,
        }
      : undefined;
  const channelFragments: PluginPromptFragment[] = channelSession
    ? [
        {
          pluginId: "core",
          pluginDisplayName: "Channel session",
          fragmentId: "channel-session-context",
          text: `You are responding inside a ${channelSession.channelId} conversation, not webchat. The user receives every assistant message you produce via the ${channelSession.channelId} platform. When you produce a deliverable file (image, screenshot, document, video), call \`channel_send_file({filePath, caption})\` to ship it through the platform's native media path — do NOT just paste a local filesystem path into your reply, the user can't open it. For text-only answers, reply normally; channel-specific tools (\`channel_*\`) are visible only inside channel sessions like this one.`,
        },
      ]
    : [];
  const toolset = await buildToolset({
    pluginTools,
    toolContext: {
      tenantId: ctx.tenantId,
      userId,
      capabilities: hostCaps,
      userHomeDir: userHome,
      tenantHomeDir: requireHomeDir(homeDir, ctx, "runPrompt"),
      // Main chat agent. Drives `tenant_config_write` boundary in
      // the files plugin: main may write to `main/skills/` and
      // shared `skills/`.
      agentScope: { kind: "main" },
      log: makeLogger(ctx.tenantId, userId, send),
      sessionId: session.id,
      channelSession,
    },
  });

  // Convert wire attachments into:
  //   * `images` — base64 ImageContent[] for vision-capable models
  //   * `prompt prefix` — a short text note for non-image files
  //                        pointing the agent at the path
  //
  // Non-image bytes never reach the LLM directly; the agent reads
  // them via tools (`read_file`, or shell `pdftotext` for pdfs).
  const { promptText: rawPromptText, images, originalAttachments } =
    await prepareUserInput(
      content,
      attachments,
      ctx.userHomeDir(userId),
      modelInfo,
    );

  // Drain the session inbox before the agent sees the user's
  // prompt. Anything dropped here while the session was idle
  // (e.g. a worker pool reporting task_done) is rendered as a
  // system-note prefix above the user's text. The agent thus
  // gets full context: "these messages arrived for you while
  // you were idle, AND here's the next thing the user said".
  const inboxDelivered = drainInbox(ctx, session.id);
  const inboxPrefix = renderInboxForPrompt(inboxDelivered);
  const promptText = inboxPrefix
    ? `${inboxPrefix}<user>\n${rawPromptText}\n</user>`
    : rawPromptText;

  // Build the harness session ourselves so we can keep a handle
  // on the storage — we need to stash sibling attachments on it
  // before the harness's user-message persistence fires, and we
  // hand it the model's vision profile so its `getPathToRoot`
  // reads + base64-encodes images on demand at LLM-call time.
  const storage = new SqliteSessionStorage(ctx, session.id, {
    imageInflate: {
      userHome,
      imageMaxBytes: modelInfo.imageMaxBytes,
      supportsImages: modelInfo.supportsImages,
    },
  });
  const piSession = new PiSession(storage);
  if (originalAttachments && originalAttachments.length > 0) {
    storage.pendingUserAttachments = {
      attachments: originalAttachments as unknown[],
    };
  }
  void repo;

  send({ type: "stream_start" });

  const adapted = adaptToolset(toolset);
  const systemPrompt = defaultSystemPrompt(
    ctx,
    userId,
    skills,
    [...channelFragments, ...pluginFragments],
  );
  dumpSystemPrompt({ ctx, role: "main", userId, systemPrompt });
  const harness = new AgentHarness({
    env: makeStubExecutionEnv(ctx.userHomeDir(userId)),
    session: piSession,
    tools: adapted.tools,
    systemPrompt,
    model: piModel,
    getApiKeyAndHeaders: async () => ({ apiKey }),
  });

  // External abort → harness.abort()
  const onAbort = () => void harness.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  // Register this harness in the process-local registry so the
  // session inbox can route a live `enqueue()` through
  // `harness.followUp(...)` instead of leaving the message stuck
  // in `pending` until the user types again. Cleared in finally.
  const unregisterHarness = registerActiveHarness(session.id, harness);

  let lastAssistantRow: ChatMessage | null = null;
  let assistantTurns = 0;
  let streamErrorSent = false;

  // Track tool calls the agent emitted but never produced a
  // tool_result for. Provider terminations / aborts can leave a
  // toolCall hanging — the UI shows a perpetual spinner. We
  // synthesise a failed tool_result for any leftover entry in
  // the finally block so the chip resolves.
  const outstandingToolCalls = new Map<
    string,
    { name: string }
  >();

  const unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
    const ev = event as { type?: string };
    if (ev.type === "tool_execution_start") {
      const tc = event as unknown as {
        toolCallId: string;
        toolName: string;
      };
      outstandingToolCalls.set(tc.toolCallId, { name: tc.toolName });
    } else if (ev.type === "tool_execution_end") {
      const te = event as unknown as { toolCallId: string };
      outstandingToolCalls.delete(te.toolCallId);
    }
    bridgeHarnessEventToWs(event, {
      ctx,
      session,
      send,
      wireOpts,
      onAssistantPersisted: (row) => {
        lastAssistantRow = row;
        assistantTurns++;
        if (assistantTurns >= MAX_TURNS) {
          void harness.abort();
        }
      },
      onStreamError: () => {
        streamErrorSent = true;
      },
    });
  });

  try {
    await harness.prompt(promptText, images.length > 0 ? { images } : undefined);
    await harness.waitForIdle();
  } catch (err) {
    if (!streamErrorSent) {
      send({
        type: "stream_error",
        reason: err instanceof Error ? err.message : String(err),
      });
      streamErrorSent = true;
    }
  } finally {
    // Resolve any tool-call chip the UI is still showing as
    // running. Provider termination after a `tool_call` event
    // but before the matching `tool_execution_end` strands the
    // chip in `running` state forever; emit a synthetic failed
    // result so the bubble renders an error and the run can
    // visually move on.
    for (const [callId, info] of outstandingToolCalls) {
      send({
        type: "tool_result",
        callId,
        name: info.name,
        ok: false,
        text: streamErrorSent
          ? "Tool call interrupted by stream error."
          : "Tool call did not return before the run ended.",
      });
    }
    outstandingToolCalls.clear();
    unsubscribe();
    unregisterHarness();
    signal.removeEventListener("abort", onAbort);
    if (storage) storage.pendingUserAttachments = null;
  }

  // Auto-compact: pi-agent-core ships compact() but no auto-trigger.
  // After every successful turn, decide whether to fire it.
  if (!streamErrorSent) {
    await maybeAutoCompact({
      session,
      piSession,
      harness,
      modelInfo,
      send,
      onSuccessRefresh: () => {
        // Refresh after compaction: same default page size as the
        // initial fetch. The compacted session is what the client
        // wants to see; we don't try to preserve the older paged-in
        // window because compaction logically replaces it.
        const page = listMessagesForUserPage(ctx, userId);
        send({
          type: "history",
          messages: page.messages.map((m) => toWire(m, makeWireOpts(ctx))),
          hasMore: page.hasMore,
        });
      },
    });
  }

  // Emit stream_end so the UI re-enables the send button.
  //
  // Skip the persisted row when its rendered text is empty —
  // those happen when the agent only emitted tool calls in the
  // final turn and never said anything user-facing. Showing
  // them produces a content-less bubble ("…") that just
  // confuses the user; the tool result chips above already
  // tell the story. Synthesise the placeholder branch instead
  // so the UI re-enables the send button without rendering an
  // empty bubble.
  const lastWire = lastAssistantRow ? toWire(lastAssistantRow, wireOpts) : null;
  const lastIsEmpty = !!lastWire && !hasVisibleAssistantText(lastWire);
  if (!streamErrorSent) {
    if (lastWire && !lastIsEmpty) {
      send({ type: "stream_end", message: lastWire });
    } else {
      // Synthetic placeholder so the UI doesn't get stuck.
      send({
        type: "stream_end",
        message: toWire(
          {
            id: `msg_empty_${Date.now()}`,
            sessionId: session.id,
            role: "assistant",
            content: "",
            createdAt: Date.now(),
          },
          wireOpts,
        ),
      });
    }
  }
}

/**
 * True iff the wire-encoded assistant message has at least one
 * visible text segment. Tool calls / tool results don't count
 * — they render as their own chips elsewhere; an assistant
 * "message" with only those segments is a content-less bubble
 * we should suppress.
 */
function hasVisibleAssistantText(m: WireMessage): boolean {
  if (m.role !== "assistant") return true;
  if (typeof m.text === "string" && m.text.trim().length > 0) return true;
  return false;
}

/**
 * Translate (text, wire-attachments) → a single text + ImageContent[]
 * suitable for `harness.prompt(text, { images })`.
 *
 *   * Image attachments → fitted to the model's byte budget +
 *     emitted as ImageContent[].
 *   * Non-image attachments → a one-liner prepended to the user
 *     text pointing the agent at the file path.
 *   * Vision-incapable model → every image is replaced by a
 *     [Attached image: name (no vision support)] note.
 */
async function prepareUserInput(
  content: string,
  attachments: WireAttachment[] | undefined,
  userHome: string,
  modelInfo: ResolvedModelInfo,
): Promise<{
  promptText: string;
  images: ImageContent[];
  originalAttachments: WireAttachment[];
}> {
  const atts = attachments ?? [];
  if (atts.length === 0) {
    return { promptText: content, images: [], originalAttachments: atts };
  }
  const fileLines: string[] = [];
  const images: ImageContent[] = [];
  for (const att of atts) {
    const isImage = att.mimeType.startsWith("image/");
    if (!isImage) {
      fileLines.push(
        `[Attached file: ${att.name ?? att.path} (${att.mimeType}) — readable at .${att.path}]`,
      );
      continue;
    }
    if (!modelInfo.supportsImages) {
      fileLines.push(
        `[Attached image (current model has no vision support): ${att.name ?? att.path}]`,
      );
      continue;
    }
    const abs = path.join(
      userHome,
      att.path.startsWith("/") ? att.path.slice(1) : att.path,
    );
    try {
      const stat = fs.statSync(abs);
      const cacheKey = imageFitCacheKey(
        abs,
        stat.mtimeMs,
        modelInfo.imageMaxBytes,
      );
      const cached = cacheGet(cacheKey);
      let buf: Buffer;
      let mimeType: string;
      if (cached) {
        buf = cached.buf;
        mimeType = cached.mimeType;
      } else {
        const raw = fs.readFileSync(abs);
        const fitted = await fitToLimit(
          raw,
          att.mimeType,
          modelInfo.imageMaxBytes,
        );
        buf = fitted.buf;
        mimeType = fitted.mimeType;
        cachePut(cacheKey, buf, mimeType);
      }
      images.push({
        type: "image",
        data: buf.toString("base64"),
        mimeType,
      });
    } catch (err) {
      const reason =
        (err as { message?: string } | null)?.message ?? "read failed";
      fileLines.push(
        `[Attached image: ${att.name ?? att.path} — read failed: ${reason}]`,
      );
    }
  }
  const prefix = fileLines.length > 0 ? fileLines.join("\n") + "\n\n" : "";
  return {
    promptText: prefix + content,
    images,
    originalAttachments: atts,
  };
}

/**
 * Translate one harness event into the legacy chat WS protocol.
 * Every assistant / toolResult message that lands in the harness
 * session is re-broadcast here so the existing UI flow keeps
 * working unchanged.
 */
function bridgeHarnessEventToWs(
  event: AgentHarnessEvent,
  args: {
    ctx: TenantContext;
    session: ChatSession;
    send: (msg: ServerMsg) => void;
    wireOpts: ToWireOpts;
    onAssistantPersisted: (row: ChatMessage) => void;
    onStreamError: () => void;
  },
): void {
  const { ctx, session, send, wireOpts, onAssistantPersisted, onStreamError } =
    args;
  const e = event as AgentHarnessOwnEvent | { type: string };

  // Pi-low-level events first (text_delta etc).
  const lowType = (event as { type: string }).type;
  if (lowType === "message_update") {
    const upd = event as {
      type: "message_update";
      assistantMessageEvent: { type: string; delta?: string };
    };
    if (
      upd.assistantMessageEvent.type === "text_delta" &&
      typeof upd.assistantMessageEvent.delta === "string"
    ) {
      send({ type: "stream_delta", delta: upd.assistantMessageEvent.delta });
    }
    return;
  }
  if (lowType === "message_end") {
    const m = (event as { message: AgentMessage }).message;
    if (m.role === "assistant") {
      const row = readBackLatestMessage(ctx, session.id, "assistant");
      if (row) {
        // Always notify the run controller (lastAssistantRow gets
        // tracked here) so MAX_TURNS counting and the stream_end
        // selection in the caller stay correct, even if we
        // suppress the wire message below.
        onAssistantPersisted(row);
        const wire = toWire(row, wireOpts);
        // Suppress empty assistant messages (no user-visible
        // text segments). They show up as bare "…" bubbles
        // when the agent's final turn was tool-only — the tool
        // result chips above already tell the story. The same
        // filter is applied at stream_end below.
        if (hasVisibleAssistantText(wire)) {
          send({ type: "message_added", message: wire });
        }
      }
    } else if (m.role === "user") {
      const row = readBackLatestMessage(ctx, session.id, "user");
      if (row) {
        // pi just persisted a user message. If it carries inbox
        // markers, this is the proof we needed that the inbox
        // followUp was actually consumed — mark those rows
        // delivered now so they don't get redelivered as a
        // prefix on the next user prompt. See
        // session-inbox.ts's markDeliveredFromMessage.
        try {
          markDeliveredFromMessage(ctx, row.content);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            "[handler] markDeliveredFromMessage failed:",
            err instanceof Error ? err.message : err,
          );
        }
        send({ type: "message_added", message: toWire(row, wireOpts) });
      }
    } else if ((m as { role?: string }).role === "toolResult") {
      // SqliteSessionStorage just wrote the tool-result row;
      // forward it to the UI so the chip materialises into a
      // proper message in the transcript.
      const row = readBackLatestMessage(ctx, session.id, "tool");
      if (row) {
        send({ type: "message_added", message: toWire(row, wireOpts) });
      }
    }
    return;
  }

  // Pi's low-level tool events: tool_execution_start fires when
  // the harness begins running a tool, tool_execution_end after
  // it completes. We emit the legacy tianshu chip events around
  // them so the existing UI flow keeps working.
  if (lowType === "tool_execution_start") {
    const tc = event as unknown as {
      toolCallId: string;
      toolName: string;
      args: unknown;
    };
    send({
      type: "tool_call",
      callId: tc.toolCallId,
      name: tc.toolName,
      arguments: (tc.args as Record<string, unknown>) ?? {},
    });
    return;
  }
  if (lowType === "tool_execution_end") {
    const te = event as unknown as {
      toolCallId: string;
      toolName: string;
      result: { content: Array<{ type: string; text?: string }> } | undefined;
      isError?: boolean;
    };
    const blocks = te.result?.content ?? [];
    const text = blocks
      .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
      .join("");
    send({
      type: "tool_result",
      callId: te.toolCallId,
      name: te.toolName,
      ok: !te.isError,
      text,
    });
    return;
  }

  // Surface stream-level errors as the legacy stream_error so the
  // UI handles them the same way it always has.
  //
  // pi-agent-core encodes LLM failures (401, rate limit, network,
  // anything thrown by the streamFn) by setting stopReason="error"
  // + errorMessage on the final AssistantMessage — then it emits
  // a normal `agent_end`. If we don't introspect agent_end, the
  // server happily reports stream_end with an empty assistant body,
  // the UI re-enables the send button, and the user can't tell
  // why nothing came back. Caught 2026-06-21 on a tenant whose
  // qwen apiKey was placeholder text (`sk-4e8…581e`); dashscope
  // 401'd, pi flagged the assistant with stopReason="error", server
  // returned a silent empty bubble.
  if (lowType === "agent_end") {
    const messages = (event as { messages: AgentMessage[] }).messages;
    const last = messages[messages.length - 1];
    if (
      last &&
      last.role === "assistant" &&
      (last.stopReason === "error" || last.stopReason === "aborted")
    ) {
      const reason =
        last.errorMessage ??
        `assistant turn ended with stopReason=${last.stopReason}`;
      send({ type: "stream_error", reason });
      onStreamError();
    }
    return;
  }
  if (lowType === "settled") {
    return;
  }
}

/** Read the most recently persisted message of a given role from
 *  `messages`. Used by the WS bridge to pick up the row the harness
 *  just wrote (so we can `toWire` it for the client). */
function readBackLatestMessage(
  ctx: TenantContext,
  sessionId: string,
  role: "user" | "assistant" | "tool",
): ChatMessage | null {
  const row = ctx.db
    .prepare<
      [string, string],
      {
        id: string;
        session_id: string;
        role: ChatMessage["role"];
        content: string;
        created_at: number;
      }
    >(
      `SELECT id, session_id, role, content, created_at
       FROM messages
       WHERE session_id = ? AND role = ? AND entry_type = 'message'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(sessionId, role);
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

/** Build a `ToWireOpts` bound to the current tenant config. The
 *  resolver lets `toWire` stamp `meta.contextWindow` on every
 *  assistant row without each caller having to do the lookup. */
function makeWireOpts(ctx: TenantContext): ToWireOpts {
  return {
    contextWindowFor: (modelId: string) => {
      const info = findModel(ctx.config, modelId);
      return info?.contextWindow;
    },
  };
}

async function maybeAutoCompact(args: {
  session: ChatSession;
  piSession: PiSession;
  harness: AgentHarness;
  modelInfo: ResolvedModelInfo;
  send: (msg: ServerMsg) => void;
  onSuccessRefresh: () => void;
}): Promise<void> {
  const { session, piSession, harness, modelInfo, send, onSuccessRefresh } = args;
  const decision = await tryAutoCompact({
    piSession,
    harness,
    contextWindow: modelInfo.contextWindow,
  });
  if (decision.error) {
    // Auto-compact failure on the chat path: surface as a
    // stream_error so the user knows next turn may be expensive.
    send({
      type: "stream_error",
      reason: `auto-compact failed: ${decision.error} (continuing without compact)`,
    });
    return;
  }
  if (!decision.compacted) return;
  send({
    type: "history_compacted",
    reason: "auto",
    // Old protocol carried oldSessionId/newSessionId because
    // the legacy compactSession forked. pi's compact() writes
    // a compaction entry into the SAME session — no fork — so
    // both ids point at the current one.
    oldSessionId: session.id,
    newSessionId: session.id,
    // Pi's compact() doesn't tell us how many entries it
    // summarised / kept. The UI uses these counts for a small
    // "📌 N messages compressed" badge; we leave them at 0
    // until pi exposes the figures.
    summarisedCount: 0,
    keptCount: 0,
    durationMs: 0,
    tokensBefore: decision.tokensBefore,
  });
  onSuccessRefresh();
}

async function runManualCompact(args: {
  ctx: TenantContext;
  userId: string;
  send: (msg: ServerMsg) => void;
  modelId?: string;
  signal: AbortSignal;
}): Promise<void> {
  const { ctx, userId, send, modelId, signal } = args;
  const session = ensureActiveSession(ctx, userId);
  const modelInfo =
    (modelId ? findModel(ctx.config, modelId) : undefined) ??
    getDefaultModel(ctx.config);
  if (!modelInfo) {
    send({
      type: "stream_error",
      reason: "no models configured",
    });
    return;
  }
  const { messages, rows } = loadAgentHistoryForSession(ctx, session.id, {
    api: modelInfo.api,
    provider: modelInfo.providerId,
    model: modelInfo.modelId,
  });
  if (messages.length === 0) {
    send({
      type: "stream_error",
      reason: "nothing to compact (no messages yet)",
    });
    return;
  }
  try {
    const result = await compactSession({
      ctx,
      userId,
      oldSession: session,
      pi: messages,
      rows,
      modelInfo,
      signal,
    });
    send({
      type: "history_compacted",
      reason: "manual",
      oldSessionId: result.oldSessionId,
      newSessionId: result.newSession.id,
      summarisedCount: result.summarisedCount,
      keptCount: result.keptCount,
      durationMs: result.durationMs,
    });
    // Push a refreshed history so the UI swaps to the new session
    // immediately (the fork ack + summary stub plus any kept tail).
    const page = listMessagesForUserPage(ctx, userId);
    send({
      type: "history",
      messages: page.messages.map((m) => toWire(m, makeWireOpts(ctx))),
      hasMore: page.hasMore,
    });
  } catch (err) {
    if (err instanceof CompactSkippedError) {
      send({ type: "stream_error", reason: `compact skipped: ${err.message}` });
      return;
    }
    send({
      type: "stream_error",
      reason: `compact failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Load skills shipped with the host repo (under `<repoRoot>/skills/`).
 * These are surfaced to every tenant alongside plugin-contributed
 * skills. Any with `when:` predicates are filtered later by
 * `filterSkillsForTenant`.
 *
 * Result is cached per process — host skills are read-only at
 * runtime, no need to re-stat per request.
 */
let hostSkillsCache: LoadedSkill[] | null = null;
export function loadHostSkills(): LoadedSkill[] {
  if (hostSkillsCache) return hostSkillsCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/chat/handler.js → ../../../skills, source/chat/handler.ts
  // → ../../../skills. Either way, three levels up gets us to the
  // server package root, which contains a `skills/` dir at build
  // time. We override via TIANSHU_HOST_SKILLS_DIR for tests.
  const fromEnv = process.env.TIANSHU_HOST_SKILLS_DIR;
  const skillsDir = fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(here, "..", "..", "skills");
  if (!fs.existsSync(skillsDir)) {
    hostSkillsCache = [];
    return hostSkillsCache;
  }
  // Treat host skills as if they came from a synthetic `tianshu`
  // plugin so log lines and plugin-id-derived names stay readable.
  const contributions = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => ({ id: d.name.replace(/\.md$/, ""), path: d.name }));
  const result = loadSkillsForPlugin({
    pluginId: "tianshu",
    pluginDir: skillsDir,
    contributions,
  });
  for (const f of result.failures) {
    // eslint-disable-next-line no-console
    console.warn(
      `[host-skills] ${f.source.contributionId} (${f.filePath}): ${f.reason}`,
    );
  }
  hostSkillsCache = result.skills;
  return hostSkillsCache;
}

// re-exported here so server/index.ts only imports from one barrel.
export type { ChatMessage };

function emptyHostCapabilities(): import("../core/plugins/registry.js").HostCapabilityHandle {
  return {
    get: () => undefined,
    has: () => false,
  };
}

function makeLogger(
  tenantId: string,
  userId: string,
  _send: (msg: ServerMsg) => void,
): import("@tianshu-ai/plugin-sdk").PluginLogger {
  // Tools log to the server console for now; future PR can route
  // structured tool logs to the chat UI as separate events.
  const prefix = `[tenant:${tenantId}][user:${userId}][tool]`;
  return {
    info: (msg, meta) => console.log(`${prefix} ${msg}`, meta ?? ""),
    warn: (msg, meta) => console.warn(`${prefix} ${msg}`, meta ?? ""),
    error: (msg, meta) => console.error(`${prefix} ${msg}`, meta ?? ""),
  };
}
