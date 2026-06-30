// Validation for SolutionSpecInput.mainAgent.customFragments.
//
// Regression guard for the "silently dropped fragment" bug: a client
// sending `{title, text}` (wrong field name) or omitting `id`/`body`
// used to pass save() and then vanish from the round-tripped spec.
// saveSolution() now rejects such input up front via
// validateCustomFragmentsInput(); these tests pin the messages.

import { describe, it, expect } from "vitest";
import { validateCustomFragmentsInput } from "./solutions.js";

type Frag = Parameters<typeof validateCustomFragmentsInput>[0];

describe("validateCustomFragmentsInput", () => {
  it("accepts well-formed fragments", () => {
    expect(() =>
      validateCustomFragmentsInput([
        { id: "marker", title: "Marker", body: "hello" },
      ]),
    ).not.toThrow();
  });

  it("accepts empty array and undefined (nothing to validate)", () => {
    expect(() => validateCustomFragmentsInput([])).not.toThrow();
    expect(() => validateCustomFragmentsInput(undefined)).not.toThrow();
  });

  it("rejects the `text`-instead-of-`body` mistake with an actionable message", () => {
    expect(() =>
      validateCustomFragmentsInput([
        { title: "Stress-test marker", text: "..." } as unknown as Frag[number],
      ]),
    ).toThrow(/uses "text".*must be "body"/);
  });

  it("rejects `content` / `value` misnaming too", () => {
    expect(() =>
      validateCustomFragmentsInput([
        { id: "x", title: "t", content: "..." } as unknown as Frag[number],
      ]),
    ).toThrow(/uses "content".*must be "body"/);
  });

  it("rejects a missing/empty body", () => {
    expect(() =>
      validateCustomFragmentsInput([
        { id: "x", title: "t", body: "   " } as unknown as Frag[number],
      ]),
    ).toThrow(/missing a non-empty "body"/);
  });

  it("rejects a missing id when body is present", () => {
    expect(() =>
      validateCustomFragmentsInput([
        { title: "t", body: "real body" } as unknown as Frag[number],
      ]),
    ).toThrow(/missing a non-empty "id"/);
  });

  it("rejects a non-array", () => {
    expect(() =>
      validateCustomFragmentsInput({} as unknown as Frag),
    ).toThrow(/must be an array/);
  });

  it("reports the offending index", () => {
    expect(() =>
      validateCustomFragmentsInput([
        { id: "ok", title: "ok", body: "fine" },
        { id: "bad", title: "bad", text: "oops" } as unknown as Frag[number],
      ]),
    ).toThrow(/customFragments\[1\]/);
  });
});
