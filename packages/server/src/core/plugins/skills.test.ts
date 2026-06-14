import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  filterSkillsForTenant,
  loadSkillsForPlugin,
  type LoadedSkill,
} from "./skills.js";

let pluginDir: string;

beforeEach(() => {
  pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-skill-"));
  fs.mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(pluginDir, { recursive: true, force: true });
});

function writeSkill(name: string, body: string): void {
  fs.writeFileSync(path.join(pluginDir, "skills", `${name}.md`), body);
}

describe("loadSkillsForPlugin", () => {
  it("parses minimal frontmatter (name + description)", () => {
    writeSkill(
      "alpha",
      `---
name: alpha-skill
description: Alpha skill, useful for testing.
---

The body of the alpha skill.`,
    );
    const r = loadSkillsForPlugin({
      pluginId: "p",
      pluginDir,
      contributions: [{ id: "alpha", path: "skills/alpha.md" }],
    });
    expect(r.failures).toEqual([]);
    expect(r.skills[0]!.name).toBe("alpha-skill");
    expect(r.skills[0]!.description).toBe("Alpha skill, useful for testing.");
    expect(r.skills[0]!.body).toBe("The body of the alpha skill.");
    expect(r.skills[0]!.when).toBeUndefined();
  });

  it("parses when block with toolPresent + capabilityPresent", () => {
    writeSkill(
      "beta",
      `---
name: beta
description: Beta.
when:
  toolPresent: exec
  capabilityPresent: sandbox.shell
---
body`,
    );
    const r = loadSkillsForPlugin({
      pluginId: "p",
      pluginDir,
      contributions: [{ id: "beta", path: "skills/beta.md" }],
    });
    expect(r.failures).toEqual([]);
    expect(r.skills[0]!.when).toEqual({
      toolPresent: "exec",
      capabilityPresent: "sandbox.shell",
    });
  });

  it("missing file → failure (other skills still load)", () => {
    writeSkill("ok", `---\nname: ok\ndescription: ok.\n---\nbody`);
    const r = loadSkillsForPlugin({
      pluginId: "p",
      pluginDir,
      contributions: [
        { id: "ok", path: "skills/ok.md" },
        { id: "missing", path: "skills/does-not-exist.md" },
      ],
    });
    expect(r.skills).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.reason).toMatch(/not found/);
  });

  it("missing name → failure", () => {
    writeSkill("nameless", `---\ndescription: Has no name.\n---\nbody`);
    const r = loadSkillsForPlugin({
      pluginId: "p",
      pluginDir,
      contributions: [{ id: "nameless", path: "skills/nameless.md" }],
    });
    expect(r.skills).toEqual([]);
    expect(r.failures[0]!.reason).toMatch(/missing `name`/);
  });

  it("unclosed frontmatter → failure", () => {
    writeSkill(
      "broken",
      `---\nname: x\ndescription: y\nbody never closes`,
    );
    const r = loadSkillsForPlugin({
      pluginId: "p",
      pluginDir,
      contributions: [{ id: "broken", path: "skills/broken.md" }],
    });
    expect(r.failures[0]!.reason).toMatch(/no closing/);
  });

  it("no frontmatter → still requires name; fails", () => {
    writeSkill("naked", `just a body`);
    const r = loadSkillsForPlugin({
      pluginId: "p",
      pluginDir,
      contributions: [{ id: "naked", path: "skills/naked.md" }],
    });
    expect(r.failures[0]!.reason).toMatch(/missing `name`/);
  });
});

describe("filterSkillsForTenant", () => {
  function make(when?: LoadedSkill["when"]): LoadedSkill {
    return {
      source: { pluginId: "p", contributionId: "x" },
      filePath: "/tmp/x.md",
      name: "x",
      description: "x",
      body: "",
      when,
    };
  }

  it("no `when` → always passes", () => {
    const out = filterSkillsForTenant([make()], {
      hasTool: () => false,
      hasCapability: () => false,
    });
    expect(out).toHaveLength(1);
  });

  it("toolPresent gate", () => {
    const s = make({ toolPresent: "exec" });
    expect(
      filterSkillsForTenant([s], {
        hasTool: (n) => n === "exec",
        hasCapability: () => false,
      }),
    ).toHaveLength(1);
    expect(
      filterSkillsForTenant([s], {
        hasTool: () => false,
        hasCapability: () => false,
      }),
    ).toHaveLength(0);
  });

  it("capabilityPresent gate", () => {
    const s = make({ capabilityPresent: "sandbox.shell" });
    expect(
      filterSkillsForTenant([s], {
        hasTool: () => false,
        hasCapability: (n) => n === "sandbox.shell",
      }),
    ).toHaveLength(1);
  });

  it("both gates must pass when both set", () => {
    const s = make({ toolPresent: "exec", capabilityPresent: "sandbox.shell" });
    expect(
      filterSkillsForTenant([s], {
        hasTool: (n) => n === "exec",
        hasCapability: () => false,
      }),
    ).toHaveLength(0);
    expect(
      filterSkillsForTenant([s], {
        hasTool: (n) => n === "exec",
        hasCapability: (n) => n === "sandbox.shell",
      }),
    ).toHaveLength(1);
  });
});

describe("mirrorSkillsToTenantConfig", () => {
  let tenantConfigDir: string;
  beforeEach(() => {
    tenantConfigDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tianshu-skill-mirror-"),
    );
  });
  afterEach(() => {
    fs.rmSync(tenantConfigDir, { recursive: true, force: true });
  });

  function fakeSkill(over: Partial<LoadedSkill> = {}): LoadedSkill {
    return {
      source: { pluginId: "p1", contributionId: "alpha" },
      filePath: "/orig/alpha.md",
      name: "alpha",
      description: "first",
      body: "# Alpha\n\nbody body body",
      ...over,
    };
  }

  it("writes SKILL.md under skills/_host/<pid>/<id>/ and rebinds filePath", async () => {
    const { mirrorSkillsToTenantConfig } = await import("./skills.js");
    const out = mirrorSkillsToTenantConfig({
      tenantConfigDir,
      skills: [fakeSkill()],
      log: { info: () => {}, warn: () => {} },
    });
    expect(out).toHaveLength(1);
    const expectedAbs = path.join(
      tenantConfigDir,
      "skills",
      "_host",
      "p1",
      "alpha",
      "SKILL.md",
    );
    expect(out[0]!.filePath).toBe(expectedAbs);
    expect(fs.existsSync(expectedAbs)).toBe(true);
    const written = fs.readFileSync(expectedAbs, "utf8");
    expect(written).toContain("name: alpha");
    expect(written).toContain("description: first");
    expect(written).toContain("body body body");
  });

  it("emits scope frontmatter when present", async () => {
    const { mirrorSkillsToTenantConfig } = await import("./skills.js");
    const out = mirrorSkillsToTenantConfig({
      tenantConfigDir,
      skills: [fakeSkill({ scope: "worker" })],
      log: { info: () => {}, warn: () => {} },
    });
    const txt = fs.readFileSync(out[0]!.filePath, "utf8");
    expect(txt).toMatch(/scope: worker/);
  });

  it("is idempotent — second call doesn't rewrite when content is unchanged", async () => {
    const { mirrorSkillsToTenantConfig } = await import("./skills.js");
    const skill = fakeSkill();
    const out1 = mirrorSkillsToTenantConfig({
      tenantConfigDir,
      skills: [skill],
      log: { info: () => {}, warn: () => {} },
    });
    const mtime1 = fs.statSync(out1[0]!.filePath).mtimeMs;
    // Wait one tick so a re-write would necessarily bump mtime.
    await new Promise((r) => setTimeout(r, 10));
    mirrorSkillsToTenantConfig({
      tenantConfigDir,
      skills: [skill],
      log: { info: () => {}, warn: () => {} },
    });
    const mtime2 = fs.statSync(out1[0]!.filePath).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });
});

describe("isMirroredSkillPath", () => {
  it("matches paths under skills/_host/", async () => {
    const { isMirroredSkillPath } = await import("./skills.js");
    expect(isMirroredSkillPath("skills/_host/p/x/SKILL.md")).toBe(true);
    expect(isMirroredSkillPath("/skills/_host/p/x/SKILL.md")).toBe(true);
    expect(isMirroredSkillPath("skills/foo/SKILL.md")).toBe(false);
    expect(isMirroredSkillPath("workers/coder/skills/x/SKILL.md")).toBe(false);
  });
});
