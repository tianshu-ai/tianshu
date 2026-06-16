import { describe, expect, it } from "vitest";
import { formatDiagnostics } from "./format.js";

describe("formatDiagnostics", () => {
  it("returns empty string for no diagnostics", () => {
    expect(formatDiagnostics([])).toBe("");
  });

  it("formats a single error with line/col 1-indexed", () => {
    const out = formatDiagnostics([
      {
        severity: 1,
        message: "Type 'string' is not assignable to type 'number'.",
        code: "TS2322",
        source: "ts",
        range: {
          start: { line: 11, character: 4 },
          end: { line: 11, character: 8 },
        },
      },
    ]);
    expect(out).toBe(
      "ERROR [12:5] [ts] TS2322: Type 'string' is not assignable to type 'number'.",
    );
  });

  it("sorts errors before warnings, then by line", () => {
    const out = formatDiagnostics([
      {
        severity: 2,
        message: "warn one",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
      {
        severity: 1,
        message: "err two",
        range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } },
      },
      {
        severity: 1,
        message: "err one",
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
      },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toContain("err one");
    expect(lines[1]).toContain("err two");
    expect(lines[2]).toContain("warn one");
  });

  it("respects errorsOnly", () => {
    const out = formatDiagnostics(
      [
        {
          severity: 2,
          message: "ignored warning",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
        },
        {
          severity: 1,
          message: "kept error",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
        },
      ],
      { errorsOnly: true },
    );
    expect(out).toContain("kept error");
    expect(out).not.toContain("ignored warning");
  });

  it("caps at maxEntries and shows a more-line", () => {
    const diags = Array.from({ length: 25 }, (_, i) => ({
      severity: 1 as const,
      message: `err ${i}`,
      range: {
        start: { line: i, character: 0 },
        end: { line: i, character: 1 },
      },
    }));
    const out = formatDiagnostics(diags, { maxEntries: 5 });
    const lines = out.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe("(... 20 more)");
  });

  it("squashes embedded newlines so each diagnostic is one line", () => {
    const out = formatDiagnostics([
      {
        severity: 1,
        message: "first line\n  second line\n    third line",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
      },
    ]);
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("first line second line third line");
  });

  it("handles missing source / code gracefully", () => {
    const out = formatDiagnostics([
      {
        severity: 1,
        message: "bare error",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
      },
    ]);
    expect(out).toBe("ERROR [1:1]: bare error");
  });
});
