// Stub types for AgentHarness / AgentLane / HarnessEvent.
// These preserve the existing runtime interface signatures so the
// code compiles against pi-agent-core 1.0. The actual runtime
// implementation still comes from the old harness code path.
// Phase 3 rewrite will replace these with the new Agent class.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";
import type { Context } from "./context.js";
import type { CompactionSettings } from "./compaction.js";
import type { Entry, Session } from "./session-types.js";
import type { JsonValue } from "@earendil-works/pi-ai";

// ─── AgentLane ─────────────────────────────────────────────────
export interface AgentLane {
  readonly name: string;
  prompt(text: string, images: ImageContent[] | undefined, context: Context): Promise<any>;
  prompt(message: AgentMessage | AgentMessage[], context: Context): Promise<any>;
  followUp(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<any>;
  abort(context: Context): Promise<any>;
  waitForIdle(context: Context): Promise<void>;
  compact(options: { customInstructions?: string } | undefined, context: Context): Promise<any>;
  steer(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<any>;
  getModel(context: Context): Promise<any>;
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

// ─── AgentHarness ──────────────────────────────────────────────
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

// AgentHarness as a runtime value (constructor). The actual
// implementation is injected at startup from the old pi-agent-core
// harness runtime. This stub satisfies TypeScript's value-position
// checks while the compat layer is active.
export const AgentHarness: {
  create(options: any, context: Context): Promise<{ harness: AgentHarness; open: any[] }>;
} = undefined as any; // Placeholder — wired at boot

// ─── HarnessEvent ──────────────────────────────────────────────
export type HarnessEvent = {
  type: string;
  lane?: string;
  recovery?: boolean;
  [key: string]: any;
};
