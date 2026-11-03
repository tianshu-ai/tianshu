// WorkBuddyWorker — LLM worker with WorkBuddy-specific skill injection.
//
// Same as LLMWorker but automatically prepends WorkBuddy CDP automation
// context to the system prompt. The agent uses Playwright on the bridge
// to interact with WorkBuddy AI desktop app.

import fs from "node:fs";
import path from "node:path";
import type {
  AgentLoopRunner,
  AgentLoopRunnerRequest,
  PluginLogger,
  TaskSandboxPool,
  TenantDbHandle,
} from "@tianshu-ai/plugin-sdk";
import type { Task } from "../db/tasks.js";
import { LLMWorker, type LLMWorkerConfig } from "./pool.js";

const SKILL_FILE = "skills/workbuddy-agent.md";

function loadWorkBuddySkill(): string {
  const dir = (import.meta as any).dirname ?? __dirname;
  const candidates = [
    path.join(dir, "..", "..", SKILL_FILE),
    path.join(dir, "..", SKILL_FILE),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, "utf8"); } catch { /* next */ }
  }
  return "";
}

const workbuddySkillContent = loadWorkBuddySkill();

export function createWorkBuddyWorker(cfg: LLMWorkerConfig): LLMWorker {
  // Prepend WorkBuddy skill to the system prompt
  const basePrompt = cfg.systemPrompt || "";
  const enhancedPrompt = workbuddySkillContent
    ? `${workbuddySkillContent}\n\n---\n\n${basePrompt}`
    : basePrompt;

  const worker = new LLMWorker({
    ...cfg,
    systemPrompt: enhancedPrompt,
  });
  // Override kind so sidebar shows "workbuddy" instead of "llm"
  (worker as any).kind = "workbuddy";
  return worker;
}
