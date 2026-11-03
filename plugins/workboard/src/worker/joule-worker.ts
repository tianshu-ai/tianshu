// JouleWorker — LLM worker with Joule Desktop CDP skill injection.
//
// Same as LLMWorker but automatically prepends Joule Desktop automation
// context to the system prompt. The agent uses Python + websocket-client
// on the bridge to interact with SAP Joule Work Desktop via raw CDP.

import fs from "node:fs";
import path from "node:path";
import { LLMWorker, type LLMWorkerConfig } from "./pool.js";

const SKILL_FILE = "skills/joule-agent.md";

function loadJouleSkill(): string {
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

const jouleSkillContent = loadJouleSkill();

export function createJouleWorker(cfg: LLMWorkerConfig): LLMWorker {
  const basePrompt = cfg.systemPrompt || "";
  const enhancedPrompt = jouleSkillContent
    ? `${jouleSkillContent}\n\n---\n\n${basePrompt}`
    : basePrompt;

  const worker = new LLMWorker({
    ...cfg,
    systemPrompt: enhancedPrompt,
  });
  // Override kind so sidebar shows "joule" instead of "llm"
  (worker as any).kind = "joule";
  return worker;
}
