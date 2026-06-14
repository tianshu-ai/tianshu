// buildToolset behaviour after the meta-tool migration.
//
// Skills are announced in the system prompt via <available_skills>
// and loaded via `tenant_config_read` against the <location> URI
// the registry stamps on each LoadedSkill. Plugin / host SKILL.md
// files are mirrored into the tenant config tree at boot so a
// single tool reaches all of them. These tests just lock in that
// the assembler stays focused on plugin-tool wiring.

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
