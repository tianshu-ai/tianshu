// buildToolset behaviour after the meta-tool migration.
//
// Skills are announced in the system prompt via <available_skills>
// and loaded via `tenant_config_read` against the <location> URI
// the registry stamps on each LoadedSkill. Plugin / host SKILL.md
// files are mirrored into the tenant config tree at boot so a
// single tool reaches all of them. These tests just lock in that
// the assembler stays focused on plugin-tool wiring.

import { describe, expect, it } from "vitest";
import type { AgentTool } from "@tianshu-ai/plugin-sdk";
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

  describe("tool error-guard wrapper", () => {
    it("catches a plugin-tool throw and rethrows with an actionable message", async () => {
      const throwing: AgentTool = {
        schema: {
          name: "bridge_myhost_exec",
          description: "x",
          parameters: Type.Object({}),
        },
        execute: () => {
          throw new Error("ECONNRESET: bridge socket closed");
        },
      };
      let warned: string | undefined;
      const log = {
        ...noopLog,
        warn: (msg: string) => {
          warned = msg;
        },
      };
      const ts = await buildToolset({
        pluginTools: [{ pluginId: "bridge", tool: throwing }],
        toolContext: { ...fakeContext, log },
      });
      const exec = ts.executors.bridge_myhost_exec!;
      await expect(exec({})).rejects.toThrow(/bridge_myhost_exec failed:.*ECONNRESET/);
      await expect(exec({})).rejects.toThrow(/bridge connection may have dropped/);
      expect(warned).toBeDefined();
      expect(warned).toContain("[tool-guard]");
      expect(warned).toContain("bridge:bridge_myhost_exec");
    });

    it("catches an async rejection from a plugin tool", async () => {
      const rejecting: AgentTool = {
        schema: {
          name: "bridge_win_exec",
          description: "x",
          parameters: Type.Object({}),
        },
        execute: async () => {
          await Promise.resolve();
          throw new Error("exited with code 1");
        },
      };
      const ts = await buildToolset({
        pluginTools: [{ pluginId: "bridge", tool: rejecting }],
        toolContext: fakeContext,
      });
      const exec = ts.executors.bridge_win_exec!;
      // Non-zero exit code path: hint should mention reading output.
      await expect(exec({})).rejects.toThrow(/exited with code 1/);
      await expect(exec({})).rejects.toThrow(/exited non-zero/);
    });

    it("lets successful tool results pass through untouched", async () => {
      const ts = await buildToolset({
        pluginTools: [{ pluginId: "p", tool: fakeTool("okTool") }],
        toolContext: fakeContext,
      });
      const exec = ts.executors.okTool!;
      const result = await exec({});
      expect(result).toEqual({ ok: true, text: "okTool" });
    });

    it("respects the abort signal before invoking the tool", async () => {
      const controller = new AbortController();
      controller.abort();
      const tool: AgentTool = {
        schema: {
          name: "neverCalled",
          description: "x",
          parameters: Type.Object({}),
        },
        execute: () => {
          throw new Error("should not run");
        },
      };
      const ts = await buildToolset({
        pluginTools: [{ pluginId: "p", tool }],
        toolContext: { ...fakeContext, signal: controller.signal },
      });
      await expect(ts.executors.neverCalled!({})).rejects.toThrow(/aborted by user/);
    });

    it("wraps host tools the same way", async () => {
      const ts = await buildToolset({
        pluginTools: [],
        toolContext: fakeContext,
        hostTools: [
          {
            schema: {
              name: "host_broken",
              description: "x",
              parameters: Type.Object({}),
            },
            executor: () => {
              throw new Error("internal glitch");
            },
          },
        ],
      });
      await expect(ts.executors.host_broken!({})).rejects.toThrow(/host_broken failed:.*internal glitch/);
    });
  });
});
