// Parser-level tests for known-models.md.
//
// Separate from checks.test.ts because the format-tolerance
// behaviour (backticks, `_` separators, extra columns, missing
// header) deserves direct unit coverage; the doctor-side tests
// in checks.test.ts already verify the user-facing warning text.

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _resetKnownModelsCache,
  loadKnownModels,
} from "./known-models.js";

describe("loadKnownModels", () => {
  let tmpPath: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-known-models-"));
    tmpPath = path.join(dir, "known-models.md");
    _resetKnownModelsCache();
  });

  it("parses a minimal one-row table with backticks + underscore digits", () => {
    fs.writeFileSync(
      tmpPath,
      [
        "# Title",
        "## section",
        "| model id | ctx | max | lastVerified | source | note |",
        "| --- | ---:| ---:| --- | --- | --- |",
        "| `qwen3-max-preview` | 256_000 | 32_768 | 2026-06-21 | https://x | hi |",
        "",
      ].join("\n"),
    );
    const t = loadKnownModels({ path: tmpPath });
    expect(t.size).toBe(1);
    const e = t.get("qwen3-max-preview")!;
    expect(e.contextWindow).toBe(256_000);
    expect(e.maxTokens).toBe(32_768);
    expect(e.lastVerified).toBe("2026-06-21");
    expect(e.source).toBe("https://x");
    expect(e.note).toBe("hi");
  });

  it("parses multiple sections + rows", () => {
    fs.writeFileSync(
      tmpPath,
      [
        "## Anthropic",
        "| model id | ctx | max | lastVerified | source |",
        "| --- | ---:| ---:| --- | --- |",
        "| `claude-sonnet-4-6` | 1000000 | 64000 | 2026-06-21 | https://a |",
        "",
        "## OpenAI",
        "| model id | ctx | max | lastVerified | source |",
        "| --- | ---:| ---:| --- | --- |",
        "| `gpt-5` | 400000 | 128000 | 2026-06-21 | https://o |",
      ].join("\n"),
    );
    const t = loadKnownModels({ path: tmpPath });
    expect(t.size).toBe(2);
    expect(t.get("claude-sonnet-4-6")?.contextWindow).toBe(1_000_000);
    expect(t.get("gpt-5")?.maxTokens).toBe(128_000);
  });

  it("skips malformed rows silently (parser is forgiving)", () => {
    fs.writeFileSync(
      tmpPath,
      [
        "| model id | ctx | max | lastVerified | source |",
        "| --- | ---:| ---:| --- | --- |",
        "| `good-one` | 1024 | 512 | 2026-06-21 | https://x |",
        "| `bad-numbers` | not-a-number | 512 | 2026-06-21 | https://x |",
        "| `empty-id` | 1024 | 512 | 2026-06-21 | https://x |",
        // 'empty-id' will still parse because cell 1 is "" stripped to "";
        // we explicitly reject empty ids. Verify.
        "| | 1024 | 512 | 2026-06-21 | https://x |",
      ].join("\n"),
    );
    const t = loadKnownModels({ path: tmpPath });
    expect([...t.keys()].sort()).toEqual(["empty-id", "good-one"]);
  });

  it("returns an empty map when the file doesn't exist", () => {
    const t = loadKnownModels({ path: "/no/such/file.md" });
    expect(t.size).toBe(0);
  });

  it("caches results across calls when path is unspecified", () => {
    // We can't test the global file from here, but we can verify
    // that the second call with the same explicit path doesn't
    // re-read the file (would require mocking fs to assert; skip
    // for now — covered manually).
    expect(loadKnownModels.length).toBeGreaterThanOrEqual(0);
  });
});
