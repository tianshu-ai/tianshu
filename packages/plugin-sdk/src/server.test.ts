import { describe, expect, it } from "vitest";
import { okResult, errorResult, type ToolResult } from "./server.js";

describe("okResult / errorResult helpers", () => {
  it("okResult builds { ok: true, text }", () => {
    const r: ToolResult = okResult("done");
    expect(r).toEqual({ ok: true, text: "done" });
  });

  it("errorResult builds { ok: false, text }", () => {
    const r: ToolResult = errorResult("bad");
    expect(r).toEqual({ ok: false, text: "bad" });
  });

  it("preserves an optional `data` payload", () => {
    expect(okResult("done", { foo: 1 })).toEqual({
      ok: true,
      text: "done",
      data: { foo: 1 },
    });
    expect(errorResult("bad", { code: 42 })).toEqual({
      ok: false,
      text: "bad",
      data: { code: 42 },
    });
  });

  it("does not leak `data: undefined` when the caller omits it", () => {
    const r = okResult("done");
    expect("data" in r).toBe(false);
  });
});
