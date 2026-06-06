import { describe, expect, it } from "vitest";
import type { LoadedSkill } from "../core/plugins/skills.js";
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

function makeSkill(name: string, body = "BODY"): LoadedSkill {
  return {
    source: { pluginId: "p", contributionId: name },
    filePath: `/tmp/${name}.md`,
    name,
    description: `Skill ${name} description.`,
    body,
  };
}

describe("buildToolset skill meta-tool", () => {
  it("registers no `load_skill` when there are no skills", async () => {
    const ts = await buildToolset({
      pluginTools: [],
      skills: [],
      toolContext: fakeContext,
    });
    expect(ts.schemas).toHaveLength(0);
    expect(ts.executors.load_skill).toBeUndefined();
  });

  it("registers load_skill when at least one skill is present", async () => {
    const skills = [makeSkill("alpha"), makeSkill("beta")];
    const ts = await buildToolset({
      pluginTools: [],
      skills,
      toolContext: fakeContext,
    });
    const meta = ts.schemas.find((s) => s.name === "load_skill");
    expect(meta).toBeDefined();
    expect(meta!.description).toContain("alpha:");
    expect(meta!.description).toContain("beta:");
  });

  it("load_skill executor returns the skill body, framed by name + description", async () => {
    const ts = await buildToolset({
      pluginTools: [],
      skills: [makeSkill("alpha", "alpha body")],
      toolContext: fakeContext,
    });
    const out = (await ts.executors.load_skill!({ name: "alpha" })) as {
      ok: boolean;
      text: string;
    };
    expect(out.ok).toBe(true);
    expect(out.text).toContain("# alpha");
    expect(out.text).toContain("alpha body");
  });

  it("load_skill on unknown name returns ok=false with available list", async () => {
    const ts = await buildToolset({
      pluginTools: [],
      skills: [makeSkill("alpha")],
      toolContext: fakeContext,
    });
    const out = (await ts.executors.load_skill!({ name: "bogus" })) as {
      ok: boolean;
      text: string;
    };
    expect(out.ok).toBe(false);
    expect(out.text).toContain("alpha");
  });
});
