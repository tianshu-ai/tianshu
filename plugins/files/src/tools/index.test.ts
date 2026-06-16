// Sanity tests for the AgentTool wrappers around the fs tool
// implementations. The detailed per-tool behaviour (path traversal,
// truncation, line cap, etc.) is owned by path-helper.test.ts and
// the per-tool helpers; here we just verify the wrappers route
// args correctly and surface the executor's `{ ok, text }` shape.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "@tianshu/plugin-sdk";
import {
  ListDirTool,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GlobTool,
} from "./index.js";

let userHome: string;
beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-files-tools-"));
});
afterEach(() => {
  fs.rmSync(userHome, { recursive: true, force: true });
});

function makeCtx(): AgentToolContext {
  return {
    pluginId: "files",
    tenantId: "acme",
    userId: "u1",
    capabilities: { get: () => undefined, has: () => false },
    userHomeDir: userHome,
    tenantHomeDir: "/tmp/tenant-root",
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("files plugin tools", () => {
  it("write_file then read_file round-trips through the executor wrapper", async () => {
    const w = (await WriteFileTool.execute(
      { path: "/foo.txt", content: "hello world" },
      makeCtx(),
    )) as { ok: boolean };
    expect(w.ok).toBe(true);
    const r = (await ReadFileTool.execute(
      { path: "/foo.txt" },
      makeCtx(),
    )) as { ok: boolean; text: string };
    expect(r.ok).toBe(true);
    expect(r.text).toContain("hello world");
  });

  it("edit_file replaces a unique substring via the wrapper (single-edit shorthand)", async () => {
    fs.writeFileSync(path.join(userHome, "a.txt"), "alpha beta gamma");
    const out = (await EditFileTool.execute(
      { path: "/a.txt", old_text: "beta", new_text: "BETA" },
      makeCtx(),
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(path.join(userHome, "a.txt"), "utf8")).toBe(
      "alpha BETA gamma",
    );
  });

  it("edit_file applies a batch atomically", async () => {
    fs.writeFileSync(
      path.join(userHome, "b.txt"),
      "<!-- TODO: section A -->\n<!-- TODO: section B -->",
    );
    const out = (await EditFileTool.execute(
      {
        path: "/b.txt",
        edits: [
          { old_text: "<!-- TODO: section A -->", new_text: "<h2>A</h2>\n<p>...</p>" },
          { old_text: "<!-- TODO: section B -->", new_text: "<h2>B</h2>\n<p>...</p>" },
        ],
      },
      makeCtx(),
    )) as { ok: boolean; edits?: unknown[] };
    expect(out.ok).toBe(true);
    expect(out.edits).toHaveLength(2);
    const after = fs.readFileSync(path.join(userHome, "b.txt"), "utf8");
    expect(after).toContain("<h2>A</h2>");
    expect(after).toContain("<h2>B</h2>");
    expect(after).not.toContain("<!-- TODO");
  });

  it("edit_file rolls back the whole batch if any edit fails", async () => {
    fs.writeFileSync(path.join(userHome, "c.txt"), "alpha beta gamma");
    const out = (await EditFileTool.execute(
      {
        path: "/c.txt",
        edits: [
          { old_text: "alpha", new_text: "AAA" },
          // missing target — batch must abort with the file
          // untouched, not partially-applied.
          { old_text: "delta", new_text: "DDD" },
        ],
      },
      makeCtx(),
    )) as { ok: boolean; failedEditIndex?: number };
    expect(out.ok).toBe(false);
    expect(out.failedEditIndex).toBe(2);
    expect(fs.readFileSync(path.join(userHome, "c.txt"), "utf8")).toBe(
      "alpha beta gamma",
    );
  });

  // Fuzzy-match coverage — these used to fail outright before
  // the replacer chain landed (sst/opencode-style). The unit
  // tests in `replacers.test.ts` lock down the per-strategy
  // behaviour; these check that edit_file actually plumbs the
  // strategies into a successful disk write.

  it("edit_file matches old_text after whitespace-only drift in the file", async () => {
    // File has two spaces; model sent one. Pre-fuzzy this
    // failed with "old_text not found".
    fs.writeFileSync(
      path.join(userHome, "ws.ts"),
      "const  x  =  1;\n",
    );
    const out = (await EditFileTool.execute(
      {
        path: "/ws.ts",
        edits: [{ old_text: "const x = 1;", new_text: "const x = 2;" }],
      },
      makeCtx(),
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(
      fs.readFileSync(path.join(userHome, "ws.ts"), "utf8"),
    ).toBe("const x = 2;\n");
  });

  it("edit_file matches old_text when the model omits trailing whitespace", async () => {
    // File has trailing spaces on each line; model didn't
    // bother. LineTrimmedReplacer handles this.
    fs.writeFileSync(
      path.join(userHome, "trail.md"),
      "foo  \nbar  \n",
    );
    const out = (await EditFileTool.execute(
      {
        path: "/trail.md",
        edits: [{ old_text: "foo\nbar", new_text: "BAZ\nQUX" }],
      },
      makeCtx(),
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    // Trailing-whitespace contract: we replace the file's
    // version (with the trailing spaces), so the result is
    // "BAZ\nQUX" without trailing spaces — that's the model's
    // intent.
    expect(
      fs.readFileSync(path.join(userHome, "trail.md"), "utf8"),
    ).toBe("BAZ\nQUX\n");
  });

  it("edit_file with replace_all=true rewrites every occurrence", async () => {
    // Renaming a symbol across a file is the canonical
    // replace_all use case.
    fs.writeFileSync(
      path.join(userHome, "rename.ts"),
      "const foo = 1;\nfoo + foo;\nbar(foo);\n",
    );
    const out = (await EditFileTool.execute(
      {
        path: "/rename.ts",
        edits: [
          { old_text: "foo", new_text: "baz", replace_all: true },
        ],
      },
      makeCtx(),
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(
      fs.readFileSync(path.join(userHome, "rename.ts"), "utf8"),
    ).toBe("const baz = 1;\nbaz + baz;\nbar(baz);\n");
  });

  it("edit_file without replace_all refuses ambiguous matches", async () => {
    // Counterpart to the replace_all test: same file, no
    // replace_all, must fail with a uniqueness error rather
    // than silently picking one occurrence.
    fs.writeFileSync(
      path.join(userHome, "ambig.ts"),
      "const foo = 1;\nfoo + foo;\n",
    );
    const out = (await EditFileTool.execute(
      {
        path: "/ambig.ts",
        edits: [{ old_text: "foo", new_text: "baz" }],
      },
      makeCtx(),
    )) as { ok: boolean; text: string };
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/3 places/);
    expect(out.text).toMatch(/replace_all/);
  });

  it("list_dir returns the entries it created", async () => {
    fs.writeFileSync(path.join(userHome, "x.txt"), "x");
    fs.mkdirSync(path.join(userHome, "sub"));
    const out = (await ListDirTool.execute({}, makeCtx())) as {
      entries?: Array<{ name: string }>;
    };
    expect(out.entries?.map((e) => e.name).sort()).toEqual(["sub", "x.txt"]);
  });

  it("glob matches via the wrapper", async () => {
    fs.writeFileSync(path.join(userHome, "a.md"), "");
    fs.writeFileSync(path.join(userHome, "b.md"), "");
    fs.writeFileSync(path.join(userHome, "c.txt"), "");
    const out = (await GlobTool.execute(
      { pattern: "**/*.md" },
      makeCtx(),
    )) as { matches?: string[] };
    expect(out.matches?.sort()).toEqual([
      "workspace:///a.md",
      "workspace:///b.md",
    ]);
  });

  it("each tool exports the expected schema name", () => {
    expect(ListDirTool.schema.name).toBe("list_dir");
    expect(ReadFileTool.schema.name).toBe("read_file");
    expect(WriteFileTool.schema.name).toBe("write_file");
    expect(EditFileTool.schema.name).toBe("edit_file");
    expect(GlobTool.schema.name).toBe("glob");
  });
});

describe("host.lsp diagnostics integration", () => {
  // Stub LspCapability captures inputs and returns whatever
  // canned result the test set up. We don't run a real LS —
  // that's covered by lsp/manager.test.ts. The wiring this
  // test pins down is:
  //   - plugin tool calls ctx.capabilities.get("host.lsp")
  //   - hands it the absolute path + post-edit contents
  //   - appends `\n\n<diag.text>` to result.text
  //   - falls through cleanly when capability missing or empty
  function ctxWithLsp(
    impl: (input: {
      filePath: string;
      contents: string;
    }) => Promise<{
      text: string;
      hasErrors: boolean;
      unavailable?: string;
    }>,
  ): AgentToolContext {
    return {
      ...makeCtx(),
      capabilities: {
        get: <T>(name: string): T | undefined =>
          name === "host.lsp"
            ? ({ diagnoseAfterEdit: impl } as unknown as T)
            : undefined,
        has: (name: string) => name === "host.lsp",
      },
    };
  }

  it("appends LSP diagnostics to write_file result text", async () => {
    const calls: Array<{ filePath: string; contents: string }> = [];
    const ctx = ctxWithLsp(async ({ filePath, contents }) => {
      calls.push({ filePath, contents });
      return {
        text:
          "src/x.ts:1:14 error TS2322: Type 'string' is not assignable to type 'number'.\n" +
          "  1 errors, 0 warnings",
        hasErrors: true,
      };
    });
    const out = (await WriteFileTool.execute(
      {
        path: "/src/x.ts",
        content: "const n: number = \"oops\";\n",
      },
      ctx,
    )) as { ok: boolean; text: string };
    expect(out.ok).toBe(true);
    expect(out.text).toContain("wrote");
    expect(out.text).toContain("TS2322");
    expect(out.text).toContain("1 errors, 0 warnings");
    expect(calls).toHaveLength(1);
    // Manager wants the absolute path; resolveInUserHome maps
    // the workspace-relative arg to the real fs location.
    expect(calls[0]!.filePath).toBe(path.join(userHome, "src/x.ts"));
    expect(calls[0]!.contents).toBe("const n: number = \"oops\";\n");
  });

  it("appends LSP diagnostics to edit_file result text by re-reading from disk", async () => {
    fs.writeFileSync(
      path.join(userHome, "y.ts"),
      "export const ok: string = \"hi\";\n",
    );
    const captured: Array<{ filePath: string; contents: string }> = [];
    const ctx = ctxWithLsp(async ({ filePath, contents }) => {
      captured.push({ filePath, contents });
      return { text: "y.ts: clean\n  0 errors, 0 warnings", hasErrors: false };
    });
    const out = (await EditFileTool.execute(
      {
        path: "/y.ts",
        edits: [
          {
            old_text: "export const ok: string",
            new_text: "export const ok: number",
          },
        ],
      },
      ctx,
    )) as { ok: boolean; text: string };
    expect(out.ok).toBe(true);
    expect(out.text).toContain("y.ts: clean");
    expect(captured).toHaveLength(1);
    // For edit_file the wrapper re-reads from disk — the contents
    // we just wrote should round-trip exactly.
    expect(captured[0]!.contents).toContain("ok: number");
  });

  it("surfaces capability `unavailable` as a [lsp] note instead of dropping it", async () => {
    const ctx = ctxWithLsp(async () => ({
      text: "",
      hasErrors: false,
      unavailable:
        "typescript-language-server not on PATH; npm i -g typescript-language-server failed (offline)",
    }));
    const out = (await WriteFileTool.execute(
      { path: "/foo.ts", content: "export const x = 1;\n" },
      ctx,
    )) as { ok: boolean; text: string };
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/\[lsp\] diagnostics unavailable:/);
    expect(out.text).toContain("typescript-language-server");
  });

  it("omits diagnostics block entirely when capability returns clean + no unavailable", async () => {
    const ctx = ctxWithLsp(async () => ({
      text: "",
      hasErrors: false,
    }));
    const out = (await WriteFileTool.execute(
      { path: "/foo.txt", content: "hello" },
      ctx,
    )) as { ok: boolean; text: string };
    expect(out.ok).toBe(true);
    expect(out.text).not.toMatch(/\[lsp\]/);
    expect(out.text).not.toContain("\n\n");
  });

  it("skips LSP entirely when host doesn't provide host.lsp", async () => {
    // makeCtx() default capabilities are empty — the wrapper
    // should still return a clean result, no LSP-related text.
    const out = (await WriteFileTool.execute(
      { path: "/foo.txt", content: "hello" },
      makeCtx(),
    )) as { ok: boolean; text: string };
    expect(out.ok).toBe(true);
    expect(out.text).not.toMatch(/\[lsp\]/);
  });

  it("never breaks the edit when the capability throws", async () => {
    fs.writeFileSync(path.join(userHome, "z.txt"), "x");
    const ctx = ctxWithLsp(async () => {
      throw new Error("boom");
    });
    const out = (await WriteFileTool.execute(
      { path: "/z.txt", content: "hello" },
      ctx,
    )) as { ok: boolean; text: string };
    expect(out.ok).toBe(true);
    expect(out.text).toContain("wrote");
    // No LSP block; failure was swallowed.
    expect(out.text).not.toMatch(/\[lsp\]/);
  });
});
