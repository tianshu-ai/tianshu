// Tests for the prepareArguments stream-truncation detector.
//
// The detector turns Anthropic/Bedrock tool_use stream truncation
// (where the framework receives `{}` for a tool that requires
// arguments) into a diagnostic error the model can act on, instead
// of the default "must have required property X" wording that
// looks like a model mistake.

import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import type { Tool as PiTool } from "@earendil-works/pi-ai";
import { adaptToolset } from "./agent-tool-adapter.js";

function fakeSchema(): PiTool {
  return {
    name: "task_create",
    description: "create tasks",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({ title: Type.String() }), {
        minItems: 1,
      }),
    }),
  };
}

describe("adaptToolset prepareArguments stream-truncation detector", () => {
  it("throws a diagnostic error when the model passed zero args (full truncation)", () => {
    const adapted = adaptToolset({
      schemas: [fakeSchema()],
      executors: {
        task_create: () => ({ ok: true, text: "ran" }),
      },
    });
    const tool = adapted.tools[0]!;
    expect(() => tool.prepareArguments?.({})).toThrow(
      /tool_use input stream may have been truncated/,
    );
    expect(() => tool.prepareArguments?.(null as unknown as object)).toThrow(
      /truncated/,
    );
  });

  it("throws a softer message when only some required fields are missing", () => {
    const schema: PiTool = {
      name: "write_file",
      description: "write",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
      }),
    };
    const adapted = adaptToolset({
      schemas: [schema],
      executors: { write_file: () => ({ ok: true, text: "" }) },
    });
    const tool = adapted.tools[0]!;
    expect(() =>
      tool.prepareArguments?.({ path: "/foo.txt" }),
    ).toThrow(/missing required field `content`.*truncated/s);
  });

  it("passes through valid arguments unchanged", () => {
    const adapted = adaptToolset({
      schemas: [fakeSchema()],
      executors: { task_create: () => ({ ok: true, text: "" }) },
    });
    const tool = adapted.tools[0]!;
    const valid = { tasks: [{ title: "x" }] };
    // Same reference returned signals "no transformation"; the
    // adapter contract just needs us not to throw.
    expect(tool.prepareArguments?.(valid)).toBe(valid);
  });

  it("ignores schemas that have no required fields (every key optional)", () => {
    const schema: PiTool = {
      name: "noop",
      description: "noop",
      parameters: Type.Object({
        foo: Type.Optional(Type.String()),
      }),
    };
    const adapted = adaptToolset({
      schemas: [schema],
      executors: { noop: () => ({ ok: true, text: "" }) },
    });
    const tool = adapted.tools[0]!;
    expect(tool.prepareArguments?.({})).toEqual({});
  });

  it("retry advice mentions skeleton-then-fill so the model has a path forward", () => {
    const adapted = adaptToolset({
      schemas: [fakeSchema()],
      executors: { task_create: () => ({ ok: true, text: "" }) },
    });
    const tool = adapted.tools[0]!;
    let msg = "";
    try {
      tool.prepareArguments?.({});
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/skeleton-then-fill/);
    expect(msg).toMatch(/edit_file/);
  });
});

describe("repeat-truncation escalation", () => {
  it("escalates to a fatal-flavored message on second truncation of same tool", () => {
    const adapted = adaptToolset({
      schemas: [
        {
          name: "write_file",
          description: "write",
          parameters: Type.Object({
            path: Type.String(),
            content: Type.String(),
          }),
        },
      ],
      executors: { write_file: () => ({ ok: true, text: "" }) },
    });
    const tool = adapted.tools[0]!;
    // 1st: permissive hint. We use `{path: '/x'}` (partial
    // truncation — content missing) since that's the dominant
    // shape in the wild; the detector still flags it as a
    // truncation candidate, just with the partial wording.
    let first = "";
    try {
      tool.prepareArguments?.({ path: "/x.md" });
    } catch (err) {
      first = err instanceof Error ? err.message : String(err);
    }
    expect(first).toMatch(/missing required field/);
    expect(first).not.toMatch(/STOP calling/);
    // 2nd: prescriptive
    let second = "";
    try {
      tool.prepareArguments?.({ path: "/x.md" });
    } catch (err) {
      second = err instanceof Error ? err.message : String(err);
    }
    expect(second).toMatch(/truncated again \(attempt 2\)/);
    expect(second).toMatch(/STOP calling `write_file`/);
    expect(second).toMatch(/skeleton/);
    expect(second).toMatch(/edit_file/);
  });

  it("escalation is per-tool: write_file's count doesn't bleed into edit_file", () => {
    const adapted = adaptToolset({
      schemas: [
        {
          name: "write_file",
          description: "write",
          parameters: Type.Object({
            path: Type.String(),
            content: Type.String(),
          }),
        },
        {
          name: "edit_file",
          description: "edit",
          parameters: Type.Object({
            path: Type.String(),
            edits: Type.Array(Type.Object({})),
          }),
        },
      ],
      executors: {
        write_file: () => ({ ok: true, text: "" }),
        edit_file: () => ({ ok: true, text: "" }),
      },
    });
    const writeTool = adapted.tools.find((t) => t.name === "write_file")!;
    const editTool = adapted.tools.find((t) => t.name === "edit_file")!;
    // burn write_file's permissive slot
    expect(() => writeTool.prepareArguments?.({ path: "/x" })).toThrow(
      /missing required field/,
    );
    // edit_file's first miss should still get the permissive
    // wording (counter is per-tool, not global)
    let editMsg = "";
    try {
      editTool.prepareArguments?.({ path: "/x" });
    } catch (err) {
      editMsg = err instanceof Error ? err.message : String(err);
    }
    expect(editMsg).toMatch(/missing required field/);
    expect(editMsg).not.toMatch(/STOP calling/);
  });

  it("non-writer tools get the generic split-it-up advice on repeat", () => {
    const adapted = adaptToolset({
      schemas: [
        {
          name: "task_create",
          description: "create",
          parameters: Type.Object({
            tasks: Type.Array(Type.Object({})),
          }),
        },
      ],
      executors: { task_create: () => ({ ok: true, text: "" }) },
    });
    const tool = adapted.tools[0]!;
    expect(() => tool.prepareArguments?.({})).toThrow();
    let msg = "";
    try {
      tool.prepareArguments?.({});
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/STOP retrying/);
    expect(msg).toMatch(/Split the request/);
    expect(msg).not.toMatch(/skeleton/);
  });
});
