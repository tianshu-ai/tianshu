// Manager tests — pure logic only. Real LSP spawning is out of
// scope here (would need typescript-language-server + a tsconfig
// + real diagnostics; covered by an integration test in CI when
// the binaries are present).
//
// The pieces tested directly:
//   1. languageForFile() resolves by extension
//   2. Manager refuses files outside tenant root
//   3. enabled=false short-circuits diagnoseAfterEdit
//
// The pool / LRU / install paths require a spawnable binary or a
// stubbed LSPClient; left for a follow-up that doesn't need to
// fight a real LSP handshake.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LSPManager, languageForFile } from "./index.js";

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-lsp-mgr-"));
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("languageForFile", () => {
  it("matches typescript on .ts and .tsx", () => {
    expect(languageForFile("/x/foo.ts")?.id).toBe("typescript");
    expect(languageForFile("/x/foo.tsx")?.id).toBe("typescript");
    expect(languageForFile("/x/foo.mts")?.id).toBe("typescript");
  });

  it("matches gopls on .go", () => {
    expect(languageForFile("/x/main.go")?.id).toBe("gopls");
  });

  it("matches pyright on .py / .pyi", () => {
    expect(languageForFile("/x/foo.py")?.id).toBe("pyright");
    expect(languageForFile("/x/foo.pyi")?.id).toBe("pyright");
  });

  it("returns undefined for unknown extensions", () => {
    expect(languageForFile("/x/README.md")).toBeUndefined();
    expect(languageForFile("/x/Cargo.toml")).toBeUndefined();
    expect(languageForFile("/x/no-ext")).toBeUndefined();
  });

  it("is case-insensitive on the extension", () => {
    expect(languageForFile("/x/foo.TS")?.id).toBe("typescript");
  });
});

describe("LSPManager.diagnoseAfterEdit", () => {
  it("is a no-op when enabled=false", async () => {
    const mgr = new LSPManager({ enabled: false });
    const file = path.join(workspaceRoot, "x.ts");
    fs.writeFileSync(file, "const a: number = 1;");
    const r = await mgr.diagnoseAfterEdit({
      tenantId: "acme",
      tenantWorkspaceRoot: workspaceRoot,
      filePath: file,
      contents: "const a: number = 1;",
    });
    expect(r.text).toBe("");
    expect(r.hasErrors).toBe(false);
    expect(r.unavailable).toBeUndefined();
    expect(mgr.poolSize()).toBe(0);
    await mgr.shutdown();
  });

  it("returns empty text for files with no language match", async () => {
    const mgr = new LSPManager({ enabled: true });
    const file = path.join(workspaceRoot, "README.md");
    fs.writeFileSync(file, "# hi");
    const r = await mgr.diagnoseAfterEdit({
      tenantId: "acme",
      tenantWorkspaceRoot: workspaceRoot,
      filePath: file,
      contents: "# hi",
    });
    expect(r.text).toBe("");
    expect(r.unavailable).toBeUndefined();
    expect(mgr.poolSize()).toBe(0);
    await mgr.shutdown();
  });

  it("refuses files outside the tenant workspace boundary", async () => {
    const mgr = new LSPManager({ enabled: true });
    const otherTenant = fs.mkdtempSync(
      path.join(os.tmpdir(), "tianshu-lsp-other-"),
    );
    try {
      const file = path.join(otherTenant, "x.ts");
      fs.writeFileSync(file, "const a = 1;");
      const r = await mgr.diagnoseAfterEdit({
        tenantId: "acme",
        tenantWorkspaceRoot: workspaceRoot,
        filePath: file,
        contents: "const a = 1;",
      });
      expect(r.text).toBe("");
      expect(r.unavailable).toMatch(/outside the tenant/i);
      expect(mgr.poolSize()).toBe(0);
    } finally {
      fs.rmSync(otherTenant, { recursive: true, force: true });
      await mgr.shutdown();
    }
  });
});
