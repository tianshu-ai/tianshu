import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getTenantMainSkillsDir,
  getTenantSharedSkillsDir,
  getTenantWorkerSkillsDir,
  getTenantSharedDir,
} from "./paths.js";
import { loadTenantSkills } from "./tenant-skills.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-tenant-skills-"));
  tmpDirs.push(dir);
  return dir;
}

function writeSkill(dir: string, name: string, body: string): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), body, "utf8");
}

const FRONTMATTER = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: "${desc}"\n---\n\nbody`;

describe("loadTenantSkills (main scope)", () => {
  it("returns nothing when neither layer exists", () => {
    const home = freshHome();
    expect(
      loadTenantSkills({ tenantId: "t1", scope: { kind: "main" }, home }),
    ).toEqual([]);
  });

  it("merges shared + main, with main winning on dir-name collisions", () => {
    const home = freshHome();
    fs.mkdirSync(getTenantSharedDir("t1", home), { recursive: true });
    const sharedDir = getTenantSharedSkillsDir("t1", home);
    const mainDir = getTenantMainSkillsDir("t1", home);
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.mkdirSync(mainDir, { recursive: true });
    writeSkill(sharedDir, "alpha", FRONTMATTER("alpha", "shared alpha"));
    writeSkill(sharedDir, "beta", FRONTMATTER("beta", "shared beta"));
    writeSkill(mainDir, "alpha", FRONTMATTER("alpha", "main alpha"));

    const skills = loadTenantSkills({
      tenantId: "t1",
      scope: { kind: "main" },
      home,
    });
    const byName = new Map(skills.map((s) => [s.name, s.description]));
    expect(byName.get("alpha")).toBe("main alpha");
    expect(byName.get("beta")).toBe("shared beta");
    expect(skills).toHaveLength(2);
  });

  it("ignores non-directory entries and missing SKILL.md", () => {
    const home = freshHome();
    const sharedDir = getTenantSharedSkillsDir("t1", home);
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, "loose-file.md"), "ignored");
    fs.mkdirSync(path.join(sharedDir, "no-skill-md"));
    writeSkill(sharedDir, "real", FRONTMATTER("real", "valid"));

    const skills = loadTenantSkills({
      tenantId: "t1",
      scope: { kind: "main" },
      home,
    });
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });

  it("captures parser failures via the optional sink", () => {
    const home = freshHome();
    const sharedDir = getTenantSharedSkillsDir("t1", home);
    fs.mkdirSync(sharedDir, { recursive: true });
    writeSkill(sharedDir, "broken", "no frontmatter at all");

    const failures: { reason: string }[] = [];
    loadTenantSkills({
      tenantId: "t1",
      scope: { kind: "main" },
      home,
      onFailure: (f) => failures.push({ reason: f.reason }),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(/missing `name`/);
  });
});

describe("loadTenantSkills (worker scope)", () => {
  it("merges shared + worker-kind, kind wins on collisions", () => {
    const home = freshHome();
    const sharedDir = getTenantSharedSkillsDir("t1", home);
    const llmDir = getTenantWorkerSkillsDir("t1", "llm", home);
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.mkdirSync(llmDir, { recursive: true });
    writeSkill(sharedDir, "alpha", FRONTMATTER("alpha", "shared"));
    writeSkill(llmDir, "alpha", FRONTMATTER("alpha", "llm-only"));
    writeSkill(llmDir, "beta", FRONTMATTER("beta", "llm extra"));

    const skills = loadTenantSkills({
      tenantId: "t1",
      scope: { kind: "worker", workerKind: "llm" },
      home,
    });
    const byName = new Map(skills.map((s) => [s.name, s.description]));
    expect(byName.get("alpha")).toBe("llm-only");
    expect(byName.get("beta")).toBe("llm extra");
  });

  it("falls back to shared layer when workerKind is empty", () => {
    const home = freshHome();
    const sharedDir = getTenantSharedSkillsDir("t1", home);
    fs.mkdirSync(sharedDir, { recursive: true });
    writeSkill(sharedDir, "alpha", FRONTMATTER("alpha", "shared"));

    const skills = loadTenantSkills({
      tenantId: "t1",
      scope: { kind: "worker", workerKind: "" },
      home,
    });
    expect(skills.map((s) => s.name)).toEqual(["alpha"]);
  });
});

describe("loadTenantSkills (multi-tenant isolation)", () => {
  it("never leaks skills across tenants", () => {
    const home = freshHome();
    const aSharedDir = getTenantSharedSkillsDir("tenantA", home);
    const bSharedDir = getTenantSharedSkillsDir("tenantB", home);
    fs.mkdirSync(aSharedDir, { recursive: true });
    fs.mkdirSync(bSharedDir, { recursive: true });
    writeSkill(aSharedDir, "a-skill", FRONTMATTER("a-skill", "for A"));
    writeSkill(bSharedDir, "b-skill", FRONTMATTER("b-skill", "for B"));

    const aSkills = loadTenantSkills({
      tenantId: "tenantA",
      scope: { kind: "main" },
      home,
    });
    const bSkills = loadTenantSkills({
      tenantId: "tenantB",
      scope: { kind: "main" },
      home,
    });
    expect(aSkills.map((s) => s.name)).toEqual(["a-skill"]);
    expect(bSkills.map((s) => s.name)).toEqual(["b-skill"]);
  });
});
