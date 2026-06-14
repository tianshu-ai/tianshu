// buildToolset behaviour after the meta-tool migration.
//
// Skills are announced in the system prompt via <available_skills>
// and loaded via the unified `read_skill(name)` meta-tool the
// host registers when the toolset has any skills attached. (Plugin
// / host skill files don't live anywhere read_file or
// tenant_config_read can reach, so a name-keyed meta-tool is the
// simplest single-surface API.)
// These tests lock in the assembler's plugin-tool wiring + the
// read_skill registration policy.

import { describe, expect, it } from "vitest";
import type { AgentTool } from "@tianshu/plugin-sdk";
import { Type } from "typebox";
import { buildToolset, type BuildToolContext } from "./index.js";

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const fakeContext: BuildToolContext = {
  tenantId: "t",
  userId: "u",
  capabilities: { get: () => undefined, has: () => false },
  userHomeDir: "/tmp/u",
  tenantHomeDir: "/tmp/t",
  log: noopLog,
};

function fakeTool(name: string): AgentTool {
  return {
    schema: {
      name,
      description: `Tool ${name}.`,
      parameters: Type.Object({}),
    },
    execute: () => ({ ok: true, text: name }),
  };
}

describe("buildToolset", () => {
  it("returns an empty toolset when no plugins contribute", async () => {
    const ts = await buildToolset({
      pluginTools: [],
      toolContext: fakeContext,
    });
    expect(ts.schemas).toHaveLength(0);
    expect(ts.executors).toEqual({});
  });

  it("does NOT register the legacy load_skill meta-tool", async () => {
    const ts = await buildToolset({
      pluginTools: [],
      toolContext: fakeContext,
    });
    expect(ts.executors.load_skill).toBeUndefined();
  });

  it("registers read_skill iff the toolset has skills attached", async () => {
    const tsNone = await buildToolset({
      pluginTools: [],
      toolContext: fakeContext,
    });
    expect(tsNone.executors.read_skill).toBeUndefined();

    const tsWithSkills = await buildToolset({
      pluginTools: [],
      toolContext: fakeContext,
      skills: [
        {
          source: { pluginId: "workboard", contributionId: "howto" },
          filePath: "/abs/skills/howto.md",
          name: "workboard-howto",
          description: "how to use the board",
          body: "## body\nuse it well",
        },
      ],
    });
    expect(typeof tsWithSkills.executors.read_skill).toBe("function");
    const r = (await tsWithSkills.executors.read_skill!({
      name: "workboard-howto",
    })) as { ok: boolean; text: string };
    expect(r.ok).toBe(true);
    expect(r.text).toContain("workboard-howto");
    expect(r.text).toContain("use it well");
  });

  it("read_skill rejects unknown names with a helpful message", async () => {
    const ts = await buildToolset({
      pluginTools: [],
      toolContext: fakeContext,
      skills: [
        {
          source: { pluginId: "x", contributionId: "a" },
          filePath: "/x/a.md",
          name: "alpha",
          description: "a",
          body: "",
        },
      ],
    });
    const r = (await ts.executors.read_skill!({
      name: "no-such",
    })) as { ok: boolean; text: string };
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/unknown skill/);
    expect(r.text).toMatch(/alpha/);
  });

  it("registers each plugin tool by schema name", async () => {
    const ts = await buildToolset({
      pluginTools: [
        { pluginId: "p", tool: fakeTool("alpha") },
        { pluginId: "p", tool: fakeTool("beta") },
      ],
      toolContext: fakeContext,
    });
    expect(ts.schemas.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(typeof ts.executors.alpha).toBe("function");
  });

  it("hides a tool whose available() returns false", async () => {
    const tool: AgentTool = {
      schema: {
        name: "hidden",
        description: "x",
        parameters: Type.Object({}),
      },
      available: () => false,
      execute: () => ({ ok: true, text: "x" }),
    };
    const ts = await buildToolset({
      pluginTools: [{ pluginId: "p", tool }],
      toolContext: fakeContext,
    });
    expect(ts.schemas).toHaveLength(0);
  });

  it("skips a name collision and warns instead of overwriting", async () => {
    const log = {
      ...noopLog,
      warn: () => {
        warnCount++;
      },
    };
    let warnCount = 0;
    const ts = await buildToolset({
      pluginTools: [
        { pluginId: "p1", tool: fakeTool("alpha") },
        { pluginId: "p2", tool: fakeTool("alpha") },
      ],
      toolContext: { ...fakeContext, log },
    });
    expect(ts.schemas).toHaveLength(1);
    expect(warnCount).toBe(1);
  });
});
