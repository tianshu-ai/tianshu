// AgentHarness / AgentLane adapter — wraps the new pi-agent-core 1.0
// Agent class into the old 0.87 interface that handler.ts expects.
// This is the Phase 3 real migration: no vendored code, all new Agent.

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, Models, Usage } from "@earendil-works/pi-ai";
import type { Context } from "./context.js";
import { type CompactionSettings, type CompactionPreparation, estimateTokens, estimateContextTokens } from "./compaction.js";
import type { Entry, Session, Storage } from "./session-types.js";
import type { JsonValue } from "@earendil-works/pi-ai";

// ─── HarnessEvent ──────────────────────────────────────────────
// Mapped from AgentEvent to the old HarnessEvent shape that
// handler.ts dispatches to WebSocket clients.
export type HarnessEvent = {
  type: string;
  lane?: string;
  recovery?: boolean;
  [key: string]: any;
};

// ─── AgentLane adapter ─────────────────────────────────────────
export interface AgentLane {
  readonly name: string;
  prompt(text: string, images: ImageContent[] | undefined, context: Context): Promise<any>;
  prompt(message: AgentMessage | AgentMessage[], context: Context): Promise<any>;
  followUp(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<any>;
  abort(context: Context): Promise<any>;
  waitForIdle(context: Context): Promise<void>;
  compact(options: { customInstructions?: string } | undefined, context: Context): Promise<any>;
  steer(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<any>;
  getModel(context: Context): Promise<Model<Api> | undefined>;
  setModel(model: { provider: string; modelId: string }, context: Context): Promise<void>;
  getActiveTools(context: Context): Promise<string[]>;
  setActiveTools(names: string[], context: Context): Promise<void>;
  getThinkingLevel(context: Context): Promise<string>;
  setThinkingLevel(level: string, context: Context): Promise<void>;
  findEntries(query: any, context: Context): Promise<Entry[]>;
  findEntry(query: any, context: Context): Promise<Entry | undefined>;
  appendMessage(message: AgentMessage, context: Context): Promise<string>;
  appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string>;
  recordUsage(usage: Usage, options: any, context: Context): Promise<any>;
  inspectExecution(context: Context): Promise<any>;
  getTipId(context: Context): Promise<string | null>;
  runWhenIdle(callback: (context: Context) => void | Promise<void>, context: Context): Promise<void>;
  requestAbort(operationId: string, context: Context): Promise<any>;
}

// ─── AgentHarness adapter ──────────────────────────────────────
export interface AgentHarnessEvents {
  on(type: string, listener: (event: any, context: Context) => void | Promise<void>): () => void;
}

export interface AgentHarnessHooks {
  on(name: string, handler: (event: any, context: Context) => any, options?: { id?: string }): () => void;
}

export interface AgentHarness {
  lane(name: string, context: Context): Promise<AgentLane>;
  lane(name: string, options: any, context: Context): Promise<AgentLane>;
  getCompactionSettings(context: Context): Promise<CompactionSettings>;
  setCompactionSettings(settings: CompactionSettings, context: Context): Promise<void>;
  getStreamOptions(context: Context): Promise<any>;
  setStreamOptions(options: any, context: Context): Promise<void>;
  setTools(tools: any[], context: Context): Promise<void>;
  getTools(context: Context): Promise<any[]>;
  close(context: Context): Promise<void>;
  readonly events: AgentHarnessEvents;
  readonly hooks: AgentHarnessHooks;
}

// ─── Event mapping: AgentEvent → HarnessEvent ──────────────────
function mapAgentEvent(event: AgentEvent): HarnessEvent {
  switch (event.type) {
    case "agent_start":
      return { type: "run_start", lane: "main", runId: "run-" + Date.now(), startedAt: Date.now() };
    case "agent_end":
      return { type: "run_end", lane: "main", runId: "run", status: "completed", endedAt: Date.now(), fromTipId: null, tipId: null };
    case "turn_start":
      return { type: "turn_start", lane: "main", runId: "run", turnId: "turn-" + Date.now() };
    case "turn_end":
      return { type: "turn_end", lane: "main", runId: "run", turnId: "turn", message: event.message, toolResults: event.toolResults };
    case "message_start":
      return { type: "message_start", lane: "main", message: event.message };
    case "message_update":
      return { type: "message_update", lane: "main", runId: "run", message: event.message, event: event.assistantMessageEvent };
    case "message_end":
      return { type: "message_end", lane: "main", message: event.message };
    case "tool_execution_start":
      return { type: "tool_start", lane: "main", runId: "run", turnId: "turn", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_execution_update":
      return { type: "tool_update", lane: "main", runId: "run", turnId: "turn", toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult };
    case "tool_execution_end":
      return { type: "tool_end", lane: "main", runId: "run", turnId: "turn", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, terminate: false };
    default:
      return { type: (event as any).type, lane: "main" };
  }
}

// ─── Lane adapter implementation ───────────────────────────────
class AgentLaneAdapter implements AgentLane {
  readonly name = "main";
  private agent: Agent;
  private session: Session;
  private sessionId: string;
  private allTools: AgentTool<any>[];
  private harnessAdapter: AgentHarnessAdapter | null = null;
  private _compactedThisTurn = false;

  constructor(agent: Agent, session: Session, sessionId: string, allTools: AgentTool<any>[]) {
    this.agent = agent;
    this.session = session;
    this.sessionId = sessionId;
    this.allTools = allTools;
  }

  /** Link to parent harness adapter for hook dispatch. */
  setHarness(h: AgentHarnessAdapter) { this.harnessAdapter = h; }

  async prompt(textOrMsg: string | AgentMessage | AgentMessage[], imagesOrCtx?: ImageContent[] | Context, _context?: Context): Promise<any> {
    if (typeof textOrMsg === "string") {
      await this.agent.prompt(textOrMsg, imagesOrCtx as ImageContent[]);
    } else {
      await this.agent.prompt(textOrMsg as AgentMessage | AgentMessage[]);
    }
    return { ok: true, value: { operationId: "op-" + Date.now() } };
  }

  async followUp(message: string | AgentMessage, _images?: ImageContent[], _context?: Context): Promise<any> {
    const msg: AgentMessage = typeof message === "string"
      ? { role: "user", content: message } as any
      : message;
    this.agent.followUp(msg);
    return { ok: true, value: { entryId: "entry-" + Date.now() } };
  }

  async abort(_context?: Context): Promise<any> {
    this.agent.abort();
    return { ok: true, value: { operationId: "op", steer: [], followUp: [] } };
  }

  async waitForIdle(_context?: Context): Promise<void> {
    await this.agent.waitForIdle();
  }

  async compact(_options?: { customInstructions?: string }, context?: Context): Promise<any> {
    if (!this.harnessAdapter || this._compactedThisTurn) {
      return { ok: false, error: { _tag: "NothingToCompact" } };
    }
    const messages = this.agent.state.messages as AgentMessage[];
    if (messages.length < 10) {
      return { ok: false, error: { _tag: "NothingToCompact" } };
    }

    // Find cut point: keep last keepRecentTokens worth of messages
    const settings = await this.harnessAdapter.getCompactionSettings();
    const keepTokens = settings.keepRecentTokens || 20000;
    let tailTokens = 0;
    let cutIndex = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      tailTokens += estimateTokens(messages[i]);
      if (tailTokens > keepTokens) {
        cutIndex = i + 1;
        break;
      }
    }
    if (cutIndex <= 1) {
      return { ok: false, error: { _tag: "NothingToCompact" } };
    }

    const toSummarize = messages.slice(0, cutIndex);
    const retainedTail = messages.slice(cutIndex);
    const tokensBefore = estimateContextTokens(messages as AgentMessage[]).tokens;

    // Build CompactionPreparation for the before_compaction hook
    const preparation: CompactionPreparation = {
      messagesToSummarize: toSummarize,
      turnPrefixMessages: [],
      retainedTail,
      isSplitTurn: false,
      tokensBefore,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings,
    };

    // Fire before_compaction hooks (structured-compaction.ts)
    let summary: string | undefined;
    const hookHandlers = this.harnessAdapter.getHookHandlers("before_compaction");
    if (hookHandlers && hookHandlers.size > 0) {
      const ctx: Context = context ?? { abortSignal: undefined };
      for (const handler of hookHandlers) {
        try {
          const result = await handler({ preparation }, ctx);
          if (typeof result === "string" && result.trim()) {
            summary = result;
            break;
          }
          // structured-compaction returns CompactResult via event mutation
          if (result && typeof result === "object" && (result as any).summary) {
            summary = (result as any).summary;
            break;
          }
        } catch (err) {
          console.warn(`[harness-adapter] before_compaction hook failed:`, err);
        }
      }
    }

    if (!summary) {
      // Fallback: basic summary from message content
      const texts: string[] = [];
      for (const msg of toSummarize) {
        const m = msg as any;
        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === "text" && c.text) texts.push(c.text.slice(0, 200));
          }
        }
      }
      summary = `[Compacted ${toSummarize.length} messages] ` + texts.slice(-5).join(" ... ");
    }

    // Do NOT write compaction entry through pi-compat session.mutate().
    // The pi-compat storage format doesn't match tianshu's SQLite
    // messages table, causing retainedTail messages to leak into the
    // chat display. handler.ts's maybeAutoCompact will detect the
    // compaction via tryAutoCompact's return value and handle the
    // tianshu-side persistence (history_compacted event + refresh).

    // Update agent state: replace messages with summary + tail
    const newMessages: AgentMessage[] = [
      { role: "user", content: `[Previous context summary]: ${summary}`, timestamp: Date.now() } as any,
      ...retainedTail,
    ];
    this.agent.state.messages = newMessages;

    this._compactedThisTurn = true;
    console.log(`[harness-adapter] compact OK: ${toSummarize.length} summarized, ${retainedTail.length} kept, tokensBefore=${tokensBefore}`);

    return {
      ok: true,
      value: {
        compaction: { summary, retainedTail },
        tokensBefore,
      },
    };
  }

  async steer(message: string | AgentMessage, _images?: ImageContent[], _context?: Context): Promise<any> {
    const msg: AgentMessage = typeof message === "string"
      ? { role: "user", content: message } as any
      : message;
    this.agent.steer(msg);
    return { ok: true, value: { entryId: "entry-" + Date.now() } };
  }

  async getModel(_context?: Context): Promise<Model<Api> | undefined> {
    return this.agent.state.model;
  }

  async setModel(model: { provider: string; modelId: string }, _context?: Context): Promise<void> {
    // handler passes { provider, modelId } — merge into existing
    // model to preserve api, baseUrl, cost, etc.
    const current = this.agent.state.model;
    this.agent.state.model = {
      ...current,
      provider: model.provider,
      id: model.modelId,
    } as any;
  }

  async getActiveTools(_context?: Context): Promise<string[]> {
    return this.agent.state.tools.map((t: any) => t.name);
  }

  async setActiveTools(names: string[], _context?: Context): Promise<void> {
    this.agent.state.tools = this.allTools.filter(t => names.includes(t.name));
  }

  async getThinkingLevel(_context?: Context): Promise<string> {
    return this.agent.state.thinkingLevel;
  }

  async setThinkingLevel(level: string, _context?: Context): Promise<void> {
    this.agent.state.thinkingLevel = level as any;
  }

  async findEntries(query: any, context: Context): Promise<Entry[]> {
    return this.session.findEntries(query, context);
  }

  async findEntry(query: any, context: Context): Promise<Entry | undefined> {
    return this.session.findEntry(query, context);
  }

  async appendMessage(message: AgentMessage, context: Context): Promise<string> {
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.session.mutate(async (mutation) => {
      await mutation.commit([{
        kind: "entry",
        entry: { id, parentId: null, type: "message", message },
      } as any], context);
    }, context);
    return id;
  }

  async appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string> {
    const result = await this.session.mutate(async (mutation) => {
      return (mutation as any).appendCustomEntry?.(customType, data) ?? `custom_${Date.now()}`;
    }, context);
    return typeof result === "string" ? result : `custom_${Date.now()}`;
  }

  async recordUsage(usage: Usage, options: any, context: Context): Promise<any> {
    // Usage recording through session mutation
    try {
      await this.session.mutate(async (mutation: any) => {
        mutation.recordUsage?.(usage, options);
      }, context);
    } catch { /* best effort */ }
    return { ok: true, value: { usageId: `usage_${Date.now()}` } };
  }

  async inspectExecution(_context?: Context): Promise<any> {
    return {
      lane: "main",
      tipId: null,
      configuredModel: this.agent.state.model,
      current: this.agent.state.isStreaming ? {
        id: "op-current",
        kind: "run",
        startedAt: Date.now(),
        status: "running",
      } : null,
      lastOperationId: null,
    };
  }

  async getTipId(_context?: Context): Promise<string | null> {
    return null;
  }

  async runWhenIdle(callback: (context: Context) => void | Promise<void>, context: Context): Promise<void> {
    await this.agent.waitForIdle();
    await callback(context);
  }

  async requestAbort(operationId: string, _context?: Context): Promise<any> {
    this.agent.abort();
    return { ok: true, value: { operationId, newlyRequested: true, steer: [], followUp: [] } };
  }
}

// ─── Harness adapter implementation ────────────────────────────
class AgentHarnessAdapter implements AgentHarness {
  private agent: Agent;
  private session: Session;
  private sessionId: string;
  private allTools: AgentTool<any>[];
  private _compactionSettings: CompactionSettings = {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  };
  /** @internal exposed for lane compact event emission */
  eventListeners = new Map<string, Set<(event: any, context: Context) => void | Promise<void>>>();
  private hookHandlers = new Map<string, Set<(event: any, context: Context) => any>>();
  private unsubscribe: (() => void) | null = null;

  constructor(agent: Agent, session: Session, sessionId: string, allTools: AgentTool<any>[]) {
    this.agent = agent;
    this.session = session;
    this.sessionId = sessionId;
    this.allTools = allTools;

    // Bridge new Agent events to old HarnessEvent listeners
    this.unsubscribe = agent.subscribe(async (agentEvent: AgentEvent) => {
      const harnessEvent = mapAgentEvent(agentEvent);
      const ctx: Context = { abortSignal: agent.signal };

      // Dispatch the mapped event
      const listeners = this.eventListeners.get(harnessEvent.type);
      if (listeners) {
        for (const fn of listeners) {
          try { await fn(harnessEvent, ctx); } catch { /* best effort */ }
        }
      }

      // Synthesize `entry_added` after `message_end` — the old harness
      // emitted this AFTER committing the entry to storage. handler.ts
      // uses it (not message_end) to push the final message to WS.
      if (agentEvent.type === "message_end") {
        const msg = agentEvent.message;
        const role = (msg as any).role;
        // Skip system messages — they carry prompt/tool declarations
        // and must NOT be persisted as chat entries or shown to users.
        if (role === "system") return;
        const entryId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // Persist to session storage first
        try {
          await session.mutate(async (mutation) => {
            await mutation.commit([{
              kind: "entry",
              entry: { id: entryId, parentId: null, type: "message", message: msg },
            } as any], ctx);
          }, ctx);
        } catch { /* best effort persistence */ }

        // Then emit entry_added so handler reads back the persisted row
        const entryAddedListeners = this.eventListeners.get("entry_added");
        if (entryAddedListeners) {
          const entryAddedEvent: HarnessEvent = {
            type: "entry_added",
            lane: "main",
            entry: { id: entryId, type: "message", message: msg },
          };
          for (const fn of entryAddedListeners) {
            try { await fn(entryAddedEvent, ctx); } catch { /* best effort */ }
          }
        }
      }
    });
  }

  readonly events: AgentHarnessEvents = {
    on: (type: string, listener: (event: any, context: Context) => void | Promise<void>): (() => void) => {
      if (!this.eventListeners.has(type)) {
        this.eventListeners.set(type, new Set());
      }
      this.eventListeners.get(type)!.add(listener);
      return () => { this.eventListeners.get(type)?.delete(listener); };
    },
  };

  readonly hooks: AgentHarnessHooks = {
    on: (name: string, handler: (event: any, context: Context) => any, _options?: { id?: string }): (() => void) => {
      if (!this.hookHandlers.has(name)) {
        this.hookHandlers.set(name, new Set());
      }
      this.hookHandlers.get(name)!.add(handler);
      return () => { this.hookHandlers.get(name)?.delete(handler); };
    },
  };

  /** Expose hook handlers for lane's compact() to fire. */
  getHookHandlers(name: string): Set<(event: any, context: Context) => any> | undefined {
    return this.hookHandlers.get(name);
  }

  async lane(name: string, optionsOrContext?: any, maybeContext?: Context): Promise<AgentLane> {
    const l = new AgentLaneAdapter(this.agent, this.session, this.sessionId, this.allTools);
    l.setHarness(this);
    return l;
  }

  async getCompactionSettings(_context?: Context): Promise<CompactionSettings> {
    return this._compactionSettings;
  }

  async setCompactionSettings(settings: CompactionSettings, _context?: Context): Promise<void> {
    this._compactionSettings = settings;
  }

  async getStreamOptions(_context?: Context): Promise<any> {
    return {};
  }

  async setStreamOptions(_options: any, _context?: Context): Promise<void> {
    // no-op — Agent handles stream options internally
  }

  async setTools(tools: any[], _context?: Context): Promise<void> {
    this.agent.state.tools = tools;
    this.allTools = tools;
  }

  async getTools(_context?: Context): Promise<any[]> {
    return this.agent.state.tools;
  }

  async close(_context?: Context): Promise<void> {
    this.agent.abort();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

// ─── AgentHarness.create factory ───────────────────────────────
export interface AgentHarnessCreateOptions {
  session: Session;
  models: Models;
  model: Model<Api>;
  tools?: AgentTool<any>[];
  toolContext?: any;
  systemPrompt?: string | ((toolContext: any, context: Context) => string | Promise<string>);
  streamOptions?: any;
  compaction?: CompactionSettings;
  steeringMode?: string;
  followUpMode?: string;
  toolExecution?: "sequential" | "parallel";
  thinkingLevel?: string;
  activeToolNames?: string[];
  toProviderMessages?: (messages: AgentMessage[], context: Context) => any[] | Promise<any[]>;
  [key: string]: any;
}

async function createAgentHarness(
  options: AgentHarnessCreateOptions,
  context: Context,
): Promise<{ harness: AgentHarness; open: any[] }> {
  const { session, models, model, tools = [], systemPrompt, compaction } = options;

  // Load messages from the last compaction point forward.
  // The old harness read from storage on demand starting at the
  // most recent compaction. Loading the full history (20k+ messages)
  // would blow past any context window.
  const allEntries = await session.findEntries(undefined, context);

  // Find the last compaction entry — everything before it is
  // already summarized and should not be loaded.
  let lastCompactionIdx = -1;
  for (let i = allEntries.length - 1; i >= 0; i--) {
    if (allEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      break;
    }
  }

  const messages: AgentMessage[] = [];
  const startIdx = lastCompactionIdx >= 0 ? lastCompactionIdx : 0;
  for (let i = startIdx; i < allEntries.length; i++) {
    const entry = allEntries[i];
    if (entry.type === "compaction") {
      // Compaction summary + retained tail replaces all prior history
      messages.push({ role: "user", content: `[Previous context summary]: ${entry.summary}` } as any);
      for (const msg of entry.retainedTail) {
        messages.push(msg);
      }
    } else if (entry.type === "message") {
      // Skip system messages — they carry prompt/tool declarations
      // that the Agent rebuilds from initialState.systemPrompt + tools
      if ((entry.message as any)?.role === "system") continue;
      messages.push(entry.message);
    }
  }

  // Resolve system prompt
  let resolvedPrompt = "";
  if (typeof systemPrompt === "function") {
    resolvedPrompt = await systemPrompt(options.toolContext, context);
  } else if (typeof systemPrompt === "string") {
    resolvedPrompt = systemPrompt;
  }

  // Create the stream function from Models
  const streamFn = models.streamSimple.bind(models) as any;

  // Wire toProviderMessages as convertToLlm.
  // The old harness called toProviderMessages as the COMPLETE
  // AgentMessage[] → Message[] conversion (progressive history
  // stubbing + tool result pruning). The new Agent's pipeline is:
  //   transformContext (AgentMessage[] → AgentMessage[])
  //   → convertToLlm (AgentMessage[] → Message[])
  // So toProviderMessages maps to convertToLlm, NOT transformContext.
  const userTransform = options.toProviderMessages;
  console.log(`[harness-adapter] toProviderMessages present: ${!!userTransform}`);
  const convertToLlm = userTransform
    ? async (msgs: AgentMessage[]): Promise<any[]> => {
        console.log(`[harness-adapter] convertToLlm called, ${msgs.length} messages in`);
        const result = userTransform(msgs, context);
        const out = result instanceof Promise ? await result : result;
        console.log(`[harness-adapter] convertToLlm done, ${(out as any[]).length} messages out`);
        return out;
      }
    : undefined;

  // Create Agent
  const agent = new Agent({
    initialState: {
      systemPrompt: resolvedPrompt,
      model,
      tools: tools as AgentTool<any>[],
      messages,
      thinkingLevel: (options.thinkingLevel ?? "off") as any,
    },
    streamFn,
    convertToLlm,
    getApiKey: options.getApiKey,
    beforeToolCall: options.beforeToolCall,
    afterToolCall: options.afterToolCall,
    steeringMode: (options.steeringMode ?? "all") as any,
    followUpMode: (options.followUpMode ?? "one-at-a-time") as any,
    sessionId: session.metadata?.id,
    toolExecution: options.toolExecution ?? "sequential",
  });

  // Persistence is handled inside AgentHarnessAdapter's subscribe
  // bridge (entry_added synthesis after message_end).

  const harness = new AgentHarnessAdapter(agent, session, session.metadata?.id ?? "", tools as AgentTool<any>[]);

  if (compaction) {
    await harness.setCompactionSettings(compaction, context);
  }

  return { harness, open: [] };
}

export const AgentHarness: {
  create(options: any, context: Context): Promise<{ harness: AgentHarness; open: any[] }>;
} = { create: createAgentHarness as any };
