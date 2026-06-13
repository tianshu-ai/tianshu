import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgentDirs } from "./agent-seeds.js";
import { getTenantConfigDir } from "./paths.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-agent-seeds-"));
  tmpDirs.push(dir);
  return dir;
}

function freshPluginDir(seedSubdirs: Record<string, Record<string, string>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-plugin-seeds-"));
  tmpDirs.push(dir);
  for (const [seedName, files] of Object.entries(seedSubdirs)) {
    const seedDir = path.join(dir, seedName);
    fs.mkdirSync(seedDir, { recursive: true });
    for (const [fname, content] of Object.entries(files)) {
      const fp = path.join(seedDir, fname);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
  }
  return dir;
}

describe("seedAgentDirs", () => {
  it("copies missing seeds and reports inserted", () => {
    const home = freshHome();
    const pluginDir = freshPluginDir({
      "echo-demo": { "agent.json": '{"kind":"echo"}' },
      "default-llm": {
        "agent.json": '{"kind":"llm"}',
        "SOUL.md": "you are a worker",
      },
    });
    const r = seedAgentDirs({
      tenantId: "t1",
      pluginId: "workboard",
      pluginDir,
      seeds: [
        { id: "echo-demo", path: "echo-demo" },
        { id: "default-llm", path: "default-llm" },
      ],
      home,
    });
    expect(r.inserted.sort()).toEqual(["default-llm", "echo-demo"]);
    expect(r.preserved).toEqual([]);
    const tenantWorkers = path.join(getTenantConfigDir("t1", home), "workers");
    expect(
      fs.readFileSync(path.join(tenantWorkers, "echo-demo", "agent.json"), "utf8"),
    ).toContain('"kind":"echo"');
    expect(
      fs.readFileSync(
        path.join(tenantWorkers, "default-llm", "SOUL.md"),
        "utf8",
      ),
    ).toContain("worker");
  });

  it("preserves an existing slot (user edit wins)", () => {
    const home = freshHome();
    // Pre-populate the tenant slot with the user's edited version.
    const tenantWorkers = path.join(getTenantConfigDir("t1", home), "workers");
    fs.mkdirSync(path.join(tenantWorkers, "echo-demo"), { recursive: true });
    fs.writeFileSync(
      path.join(tenantWorkers, "echo-demo", "agent.json"),
      '{"kind":"echo","displayName":"User-edited echo"}',
    );

    const pluginDir = freshPluginDir({
      "echo-demo": { "agent.json": '{"kind":"echo","displayName":"Builtin"}' },
    });
    const r = seedAgentDirs({
      tenantId: "t1",
      pluginId: "workboard",
      pluginDir,
      seeds: [{ id: "echo-demo", path: "echo-demo" }],
      home,
    });
    expect(r.preserved).toEqual(["echo-demo"]);
    expect(r.inserted).toEqual([]);
    expect(
      fs.readFileSync(
        path.join(tenantWorkers, "echo-demo", "agent.json"),
        "utf8",
      ),
    ).toContain("User-edited");
  });

  it("rejects bad ids and missing paths via warnings", () => {
    const home = freshHome();
    const pluginDir = freshPluginDir({});
    const warns: string[] = [];
    const r = seedAgentDirs({
      tenantId: "t1",
      pluginId: "broken",
      pluginDir,
      seeds: [
        { id: "Bad Id With Spaces", path: "x" },
        { id: "no-such", path: "no-such-dir" },
      ],
      home,
      onWarn: (m) => warns.push(m),
    });
    expect(r.inserted).toEqual([]);
    expect(r.invalid).toEqual(["no-such"]);
    expect(warns.length).toBe(2);
  });

  it("isolates seeds per tenant", () => {
    const home = freshHome();
    const pluginDir = freshPluginDir({
      "echo-demo": { "agent.json": '{"kind":"echo"}' },
    });
    const seeds = [{ id: "echo-demo", path: "echo-demo" }];
    seedAgentDirs({
      tenantId: "tenantA",
      pluginId: "workboard",
      pluginDir,
      seeds,
      home,
    });
    seedAgentDirs({
      tenantId: "tenantB",
      pluginId: "workboard",
      pluginDir,
      seeds,
      home,
    });
    expect(
      fs.existsSync(
        path.join(getTenantConfigDir("tenantA", home), "workers", "echo-demo"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(getTenantConfigDir("tenantB", home), "workers", "echo-demo"),
      ),
    ).toBe(true);
  });
});
