import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMergedWorkerAgents } from "./fs-worker-agents.js";
import type { WorkerAgent } from "./db/agents.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function freshTenantHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-fs-worker-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "workspace", "_tenant", "config", "workers"), {
    recursive: true,
  });
  return dir;
}

function writeWorker(
  tenantHome: string,
  slug: string,
  spec: object,
  soul?: string,
): void {
  const dir = path.join(
    tenantHome,
    "workspace",
    "_tenant",
    "config",
    "workers",
    slug,
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify(spec));
  if (soul) fs.writeFileSync(path.join(dir, "SOUL.md"), soul);
}

function dbAgent(over: Partial<WorkerAgent>): WorkerAgent {
  const now = Date.now();
  return {
    id: over.id ?? "id-" + Math.random().toString(36).slice(2, 8),
    tenantId: over.tenantId ?? "t1",
    kind: over.kind ?? "llm",
    name: over.name ?? "x",
    description: null,
    modelId: null,
    systemPrompt: null,
    toolsAllow: null,
    skills: null,
    source: over.source ?? "user",
    builtinKey: over.builtinKey ?? null,
    ownerUserId: null,
    enabled: over.enabled ?? true,
    overridesAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("loadMergedWorkerAgents", () => {
  it("returns DB rows untouched when no fs workers exist", () => {
    const home = freshTenantHome();
    const r = loadMergedWorkerAgents({
      tenantId: "t1",
      tenantHomeDir: home,
      dbAgents: [
        dbAgent({ id: "a", name: "Alpha" }),
        dbAgent({ id: "b", name: "Beta" }),
      ],
    });
    expect(r.agents.map((a) => a.name)).toEqual(["Alpha", "Beta"]);
    expect(r.fsErrors).toEqual([]);
  });

  it("fs workers shadow DB rows by builtin_key", () => {
    const home = freshTenantHome();
    writeWorker(home, "echo-demo", {
      kind: "echo",
      displayName: "fs Echo",
      enabled: true,
      source: "builtin",
    });
    const r = loadMergedWorkerAgents({
      tenantId: "t1",
      tenantHomeDir: home,
      dbAgents: [
        dbAgent({
          id: "uuid-old-echo",
          name: "db Echo",
          kind: "echo",
          source: "builtin",
          builtinKey: "echo-demo",
        }),
        dbAgent({ id: "uuid-other", name: "Survivor", kind: "llm" }),
      ],
    });
    const names = r.agents.map((a) => a.name).sort();
    expect(names).toEqual(["Survivor", "fs Echo"]);
    // Slug becomes the runtime id.
    expect(r.agents.find((a) => a.name === "fs Echo")!.id).toBe("echo-demo");
  });

  it("loads SOUL.md as systemPrompt", () => {
    const home = freshTenantHome();
    writeWorker(
      home,
      "default-llm",
      { kind: "llm", displayName: "Default LLM" },
      "you are a worker",
    );
    const r = loadMergedWorkerAgents({
      tenantId: "t1",
      tenantHomeDir: home,
      dbAgents: [],
    });
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0]!.systemPrompt).toBe("you are a worker");
    expect(r.agents[0]!.modelId).toBeNull();
  });

  it("surfaces parse errors for broken agent.json without crashing", () => {
    const home = freshTenantHome();
    const dir = path.join(
      home,
      "workspace",
      "_tenant",
      "config",
      "workers",
      "broken",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.json"), "{not json");
    const r = loadMergedWorkerAgents({
      tenantId: "t1",
      tenantHomeDir: home,
      dbAgents: [],
    });
    expect(r.agents).toHaveLength(0);
    expect(r.fsErrors).toHaveLength(1);
    expect(r.fsErrors[0]!.slug).toBe("broken");
    expect(r.fsErrors[0]!.reasons.join(" ")).toMatch(/parse failed/);
  });

  it("treats missing kind as a hard error and skips the worker", () => {
    const home = freshTenantHome();
    writeWorker(home, "no-kind", { displayName: "x" });
    const r = loadMergedWorkerAgents({
      tenantId: "t1",
      tenantHomeDir: home,
      dbAgents: [],
    });
    expect(r.agents).toHaveLength(0);
    expect(r.fsErrors[0]!.slug).toBe("no-kind");
  });
});
