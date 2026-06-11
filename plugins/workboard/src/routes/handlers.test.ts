// Validation tests for `validateAssignableWorker`. The full HTTP
// path is integration-tested via the parent server suite; here we
// pin the rules at the helper level so a regression in the policy
// shows up close to the policy.

import { describe, expect, it } from "vitest";
import type { WorkerAgent } from "../db/agents.js";
import { validateAssignableWorker } from "./handlers.js";

function agent(
  p: Partial<WorkerAgent> & Pick<WorkerAgent, "id" | "kind">,
): WorkerAgent {
  return {
    name: p.name ?? p.id,
    description: p.description ?? null,
    enabled: p.enabled ?? true,
    source: p.source ?? "user",
    builtinKey: p.builtinKey ?? null,
    ownerUserId: p.ownerUserId ?? null,
    tenantId: p.tenantId ?? "t1",
    modelId: p.modelId ?? null,
    systemPrompt: p.systemPrompt ?? null,
    toolsAllow: p.toolsAllow ?? null,
    skills: p.skills ?? null,
    overridesAt: p.overridesAt ?? null,
    createdAt: p.createdAt ?? Date.now(),
    updatedAt: p.updatedAt ?? Date.now(),
    ...p,
  } as WorkerAgent;
}

describe("validateAssignableWorker", () => {
  it("passes when both workerAgentId and workerRole are null", () => {
    expect(
      validateAssignableWorker([agent({ id: "a", kind: "llm" })], {
        workerAgentId: null,
        workerRole: null,
      }),
    ).toBeNull();
  });

  it("rejects an unknown agent id", () => {
    const err = validateAssignableWorker(
      [agent({ id: "a", kind: "llm" })],
      { workerAgentId: "ghost", workerRole: null },
    );
    expect(err?.code).toBe("agent_not_found");
  });

  it("rejects a disabled agent with a helpful message", () => {
    const err = validateAssignableWorker(
      [agent({ id: "a", kind: "llm", name: "Default LLM", enabled: false })],
      { workerAgentId: "a", workerRole: null },
    );
    expect(err?.code).toBe("agent_disabled");
    expect(err?.message).toContain("Default LLM");
  });

  it("passes for an enabled agent (and ignores workerRole)", () => {
    // Pinning wins over role: even if the role wouldn't match any
    // enabled agent, the explicit agent id is the source of truth.
    expect(
      validateAssignableWorker(
        [agent({ id: "a", kind: "llm", enabled: true })],
        { workerAgentId: "a", workerRole: "echo" },
      ),
    ).toBeNull();
  });

  it("rejects a role with no enabled worker", () => {
    const err = validateAssignableWorker(
      [
        agent({ id: "a", kind: "llm", enabled: false }),
        agent({ id: "b", kind: "echo", enabled: true }),
      ],
      { workerAgentId: null, workerRole: "llm" },
    );
    expect(err?.code).toBe("no_enabled_worker_for_role");
  });

  it("passes when at least one enabled agent matches the role", () => {
    expect(
      validateAssignableWorker(
        [
          agent({ id: "a", kind: "llm", enabled: true }),
          agent({ id: "b", kind: "echo", enabled: true }),
        ],
        { workerAgentId: null, workerRole: "llm" },
      ),
    ).toBeNull();
  });

  it("disabled agents of the same role don't count", () => {
    // Two llm agents, both off. Role technically exists in the
    // registry, but no live worker can claim — should still reject.
    const err = validateAssignableWorker(
      [
        agent({ id: "a", kind: "llm", enabled: false }),
        agent({ id: "b", kind: "llm", enabled: false }),
      ],
      { workerAgentId: null, workerRole: "llm" },
    );
    expect(err?.code).toBe("no_enabled_worker_for_role");
  });
});
