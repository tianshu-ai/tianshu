import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateWorkerAgentsToFs } from "./migrate-worker-agents.js";
import type { WorkerAgent } from "./db/agents.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function freshTenantHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-migrate-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "workspace", "_tenant", "config", "workers"), {
    recursive: true,
  });
  return dir;
}

function row(over: Partial<WorkerAgent>): WorkerAgent {
  const now = Date.now();
  return {
    id: "id-" + Math.random().toString(36).slice(2, 8),
    tenantId: "t1",
    kind: "llm",
    name: "x",
    description: null,
    modelId: null,
    systemPrompt: null,
    toolsAllow: null,
    skills: null,
    source: "user",
    builtinKey: null,
    ownerUserId: null,
    enabled: true,
    overridesAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function workersDir(home: string): string {
  return path.join(home, "workspace", "_tenant", "config", "workers");
}

describe("migrateWorkerAgentsToFs", () => {
  it("dumps a builtin row using its builtin_key as slug", () => {
    const home = freshTenantHome();
    const r = migrateWorkerAgentsToFs({
      tenantHomeDir: path.join(home, "workspace"),
      dbAgents: [
        row({
          name: "Default LLM",
          kind: "llm",
          source: "builtin",
          builtinKey: "llm-default",
          modelId: "sap-proxy/claude-sonnet-4-6",
          systemPrompt: "you are a worker",
        }),
      ],
    });
    expect(r.migrated).toEqual(["llm-default"]);
    const dir = path.join(workersDir(home), "llm-default");
    const j = JSON.parse(
      fs.readFileSync(path.join(dir, "agent.json"), "utf8"),
    );
    expect(j.kind).toBe("llm");
    expect(j.modelId).toBe("sap-proxy/claude-sonnet-4-6");
    expect(j.source).toBe("builtin");
    expect(fs.readFileSync(path.join(dir, "SOUL.md"), "utf8")).toBe(
      "you are a worker",
    );
  });

  it("slugifies user rows by name", () => {
    const home = freshTenantHome();
    const r = migrateWorkerAgentsToFs({
      tenantHomeDir: path.join(home, "workspace"),
      dbAgents: [row({ name: "Sonnet Researcher" })],
    });
    expect(r.migrated).toEqual(["sonnet-researcher"]);
    expect(
      fs.existsSync(
        path.join(workersDir(home), "sonnet-researcher", "agent.json"),
      ),
    ).toBe(true);
  });

  it("preserves an existing fs slot (DB row stays shadowed)", () => {
    const home = freshTenantHome();
    fs.mkdirSync(path.join(workersDir(home), "echo-demo"), { recursive: true });
    fs.writeFileSync(
      path.join(workersDir(home), "echo-demo", "agent.json"),
      '{"kind":"echo"}',
    );
    const r = migrateWorkerAgentsToFs({
      tenantHomeDir: path.join(home, "workspace"),
      dbAgents: [
        row({
          name: "Echo demo",
          kind: "echo",
          source: "builtin",
          builtinKey: "echo-demo",
        }),
      ],
    });
    expect(r.migrated).toEqual([]);
    expect(r.preserved).toEqual(["echo-demo"]);
  });

  it("omits empty-string SOUL.md", () => {
    const home = freshTenantHome();
    migrateWorkerAgentsToFs({
      tenantHomeDir: path.join(home, "workspace"),
      dbAgents: [
        row({
          name: "Quiet",
          systemPrompt: "   ",
        }),
      ],
    });
    expect(
      fs.existsSync(path.join(workersDir(home), "quiet", "SOUL.md")),
    ).toBe(false);
  });
});
