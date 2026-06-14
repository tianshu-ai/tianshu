import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkWritable,
  getTenantConfigRoot,
  resolveInTenantConfig,
  toTenantConfigUri,
  TenantConfigPathError,
  type AgentScope,
} from "./tenant-config-helper.js";
import {
  executeTenantConfigList,
} from "./tenant-config-list.js";
import {
  executeTenantConfigRead,
} from "./tenant-config-read.js";
import {
  executeTenantConfigWrite,
} from "./tenant-config-write.js";
import {
  executeTenantConfigEdit,
} from "./tenant-config-edit.js";
import {
  executeTenantConfigDelete,
} from "./tenant-config-delete.js";
import {
  executeTenantConfigGlob,
} from "./tenant-config-glob.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function freshTenantHome(): string {
  // Mirror the layout the host expects: <tenantHome>/workspace/_tenant/config/
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-tcfg-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "workspace", "_tenant", "config"), {
    recursive: true,
  });
  return dir;
}

const MAIN: AgentScope = { kind: "main" };
const WORKER_LLM: AgentScope = { kind: "worker", workerKind: "llm" };
const WORKER_ECHO: AgentScope = { kind: "worker", workerKind: "echo" };

describe("resolveInTenantConfig + URI helpers", () => {
  it("accepts URI, leading slash, and bare paths equivalently", () => {
    const home = freshTenantHome();
    const root = getTenantConfigRoot(home);
    const a = resolveInTenantConfig(home, "tenant-config:///main/skills/x");
    const b = resolveInTenantConfig(home, "/main/skills/x");
    const c = resolveInTenantConfig(home, "main/skills/x");
    expect(a).toBe(path.join(root, "main", "skills", "x"));
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("rejects '..' segments", () => {
    const home = freshTenantHome();
    expect(() =>
      resolveInTenantConfig(home, "/main/../../etc/passwd"),
    ).toThrow(TenantConfigPathError);
  });

  it("toTenantConfigUri round-trips a path under root", () => {
    const home = freshTenantHome();
    const abs = path.join(getTenantConfigRoot(home), "main", "skills", "x", "SKILL.md");
    expect(toTenantConfigUri(home, abs)).toBe(
      "tenant-config:///main/skills/x/SKILL.md",
    );
  });
});

describe("checkWritable scope rules", () => {
  it("main may write under skills/ and main/skills/", () => {
    const home = freshTenantHome();
    const root = getTenantConfigRoot(home);
    expect(
      checkWritable(home, path.join(root, "skills", "x", "SKILL.md"), MAIN).ok,
    ).toBe(true);
    expect(
      checkWritable(home, path.join(root, "main", "skills", "x", "SKILL.md"), MAIN).ok,
    ).toBe(true);
  });

  it("main MAY write under workers/<slug>/ (any sub-path)", () => {
    const home = freshTenantHome();
    const root = getTenantConfigRoot(home);
    expect(
      checkWritable(
        home,
        path.join(root, "workers", "sonnet-researcher", "agent.json"),
        MAIN,
      ).ok,
    ).toBe(true);
    expect(
      checkWritable(
        home,
        path.join(root, "workers", "sonnet-researcher", "SOUL.md"),
        MAIN,
      ).ok,
    ).toBe(true);
    expect(
      checkWritable(
        home,
        path.join(root, "workers", "sonnet-researcher", "skills", "foo"),
        MAIN,
      ).ok,
    ).toBe(true);
  });

  it("main may NOT write to a top-level non-allowlisted path", () => {
    const home = freshTenantHome();
    const root = getTenantConfigRoot(home);
    expect(
      checkWritable(home, path.join(root, "MEMORY.md"), MAIN).ok,
    ).toBe(false);
    expect(
      checkWritable(home, path.join(root, "unknown-section"), MAIN).ok,
    ).toBe(false);
  });

  it("worker may write only its own kind/slug layer (skills only)", () => {
    const home = freshTenantHome();
    const root = getTenantConfigRoot(home);
    expect(
      checkWritable(
        home,
        path.join(root, "workers", "llm", "skills", "x"),
        WORKER_LLM,
      ).ok,
    ).toBe(true);
    expect(
      checkWritable(
        home,
        path.join(root, "workers", "echo", "skills", "x"),
        WORKER_LLM,
      ).ok,
    ).toBe(false);
    expect(
      checkWritable(home, path.join(root, "main", "skills", "x"), WORKER_ECHO)
        .ok,
    ).toBe(false);
    // Workers can NOT touch their own agent.json or SOUL.md
    // (would race with the loader mid-run).
    expect(
      checkWritable(
        home,
        path.join(root, "workers", "llm", "agent.json"),
        WORKER_LLM,
      ).ok,
    ).toBe(false);
  });

  it("worker with explicit slug uses slug, not kind", () => {
    const home = freshTenantHome();
    const root = getTenantConfigRoot(home);
    const scope: AgentScope = {
      kind: "worker",
      workerKind: "llm",
      slug: "sonnet-researcher",
    };
    expect(
      checkWritable(
        home,
        path.join(root, "workers", "sonnet-researcher", "skills", "x"),
        scope,
      ).ok,
    ).toBe(true);
    expect(
      checkWritable(home, path.join(root, "workers", "llm", "skills", "x"), scope)
        .ok,
    ).toBe(false);
  });

  it("rejects writes to root", () => {
    const home = freshTenantHome();
    const root = getTenantConfigRoot(home);
    expect(checkWritable(home, root, MAIN).ok).toBe(false);
    // main/<not skills>/ is not in the allow-list either.
    expect(
      checkWritable(home, path.join(root, "main", "MEMORY.md"), MAIN).ok,
    ).toBe(false);
  });
});

describe("tenant_config_write + read round-trip", () => {
  it("main writes a SKILL.md under main/skills and reads it back", () => {
    const home = freshTenantHome();
    const w = executeTenantConfigWrite(home, MAIN, {
      path: "main/skills/foo/SKILL.md",
      content: "---\nname: foo\ndescription: \"x\"\n---\nbody",
    });
    expect(w.ok).toBe(true);
    expect(w.scope).toBe("main");

    const r = executeTenantConfigRead(home, {
      path: "tenant-config:///main/skills/foo/SKILL.md",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("name: foo");
  });

  it("worker write rejected when path lies outside its kind layer", () => {
    const home = freshTenantHome();
    const w = executeTenantConfigWrite(home, WORKER_LLM, {
      path: "main/skills/foo/SKILL.md",
      content: "x",
    });
    expect(w.ok).toBe(false);
    expect(w.text).toMatch(/not writable/);
  });

  it("worker can write to its own kind layer", () => {
    const home = freshTenantHome();
    const w = executeTenantConfigWrite(home, WORKER_LLM, {
      path: "workers/llm/skills/bar/SKILL.md",
      content: "---\nname: bar\ndescription: \"x\"\n---\n",
    });
    expect(w.ok).toBe(true);
    expect(w.scope).toBe("worker:llm");
  });
});

describe("tenant_config_edit", () => {
  it("replaces an exact substring exactly once", () => {
    const home = freshTenantHome();
    executeTenantConfigWrite(home, MAIN, {
      path: "skills/foo/SKILL.md",
      content: "alpha beta gamma",
    });
    const r = executeTenantConfigEdit(home, MAIN, {
      path: "skills/foo/SKILL.md",
      old_text: "beta",
      new_text: "BETA",
    });
    expect(r.ok).toBe(true);
    const after = executeTenantConfigRead(home, {
      path: "skills/foo/SKILL.md",
    });
    expect(after.text).toContain("alpha BETA gamma");
  });

  it("refuses when old_text appears multiple times", () => {
    const home = freshTenantHome();
    executeTenantConfigWrite(home, MAIN, {
      path: "skills/foo/SKILL.md",
      content: "x x",
    });
    const r = executeTenantConfigEdit(home, MAIN, {
      path: "skills/foo/SKILL.md",
      old_text: "x",
      new_text: "y",
    });
    expect(r.ok).toBe(false);
    // Post-batch refactor: the failure surface has moved from
    // `occurrences` to `failedEditIndex` + a count embedded in
    // the error text. The single-edit shorthand still trips the
    // same path — just under edit #1.
    expect(r.failedEditIndex).toBe(1);
    expect(r.text).toMatch(/appears 2 times/);
  });

  it("applies a batch of edits atomically and reports a delta", () => {
    const home = freshTenantHome();
    executeTenantConfigWrite(home, MAIN, {
      path: "skills/foo/SKILL.md",
      content: "alpha beta gamma",
    });
    const r = executeTenantConfigEdit(home, MAIN, {
      path: "skills/foo/SKILL.md",
      edits: [
        { old_text: "alpha", new_text: "AAA" },
        { old_text: "gamma", new_text: "CCC" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.edits).toHaveLength(2);
    const after = executeTenantConfigRead(home, {
      path: "skills/foo/SKILL.md",
    });
    expect(after.text).toContain("AAA beta CCC");
  });

  it("rolls back the whole batch when one edit fails (atomicity)", () => {
    const home = freshTenantHome();
    executeTenantConfigWrite(home, MAIN, {
      path: "skills/foo/SKILL.md",
      content: "alpha beta gamma",
    });
    const r = executeTenantConfigEdit(home, MAIN, {
      path: "skills/foo/SKILL.md",
      edits: [
        { old_text: "alpha", new_text: "AAA" },
        // `delta` doesn't exist — batch must abort and leave the
        // file untouched, even though the first edit was valid.
        { old_text: "delta", new_text: "DDD" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.failedEditIndex).toBe(2);
    const after = executeTenantConfigRead(home, {
      path: "skills/foo/SKILL.md",
    });
    expect(after.text).toContain("alpha beta gamma");
    expect(after.text).not.toContain("AAA");
  });
});

describe("tenant_config_delete", () => {
  it("removes a single file", () => {
    const home = freshTenantHome();
    executeTenantConfigWrite(home, MAIN, {
      path: "skills/foo/SKILL.md",
      content: "x",
    });
    const d = executeTenantConfigDelete(home, MAIN, {
      path: "skills/foo/SKILL.md",
    });
    expect(d.ok).toBe(true);
  });

  it("requires recursive=true for a non-empty directory", () => {
    const home = freshTenantHome();
    executeTenantConfigWrite(home, MAIN, {
      path: "skills/foo/SKILL.md",
      content: "x",
    });
    const noRec = executeTenantConfigDelete(home, MAIN, {
      path: "skills/foo",
    });
    expect(noRec.ok).toBe(false);
    const yesRec = executeTenantConfigDelete(home, MAIN, {
      path: "skills/foo",
      recursive: true,
    });
    expect(yesRec.ok).toBe(true);
  });

  it("rejects deletes outside the agent's scope", () => {
    const home = freshTenantHome();
    executeTenantConfigWrite(home, MAIN, {
      path: "main/skills/foo/SKILL.md",
      content: "x",
    });
    const d = executeTenantConfigDelete(home, WORKER_LLM, {
      path: "main/skills/foo/SKILL.md",
    });
    expect(d.ok).toBe(false);
  });
});

describe("tenant_config_list + glob", () => {
  it("lists immediate entries", async () => {
    const home = freshTenantHome();
    executeTenantConfigWrite(home, MAIN, {
      path: "main/skills/foo/SKILL.md",
      content: "x",
    });
    executeTenantConfigWrite(home, MAIN, {
      path: "skills/bar/SKILL.md",
      content: "x",
    });
    const r = executeTenantConfigList(home, { path: "/" });
    expect(r.ok).toBe(true);
    const names = (r.entries ?? []).map((e) => e.name).sort();
    expect(names).toEqual(["main", "skills"]);
  });

  it("globs match SKILL.md across the tree", async () => {
    const home = freshTenantHome();
    executeTenantConfigWrite(home, MAIN, {
      path: "main/skills/foo/SKILL.md",
      content: "x",
    });
    executeTenantConfigWrite(home, MAIN, {
      path: "skills/bar/SKILL.md",
      content: "x",
    });
    const r = await executeTenantConfigGlob(home, {
      pattern: "**/SKILL.md",
    });
    expect(r.ok).toBe(true);
    expect(r.matches).toHaveLength(2);
  });
});
