import { describe, expect, it } from "vitest";

// Placeholder smoke test for the web package. Real component tests will
// arrive with the chat UI PR.
describe("smoke", () => {
  it("strings concat", () => {
    expect("天" + "枢").toBe("天枢");
  });
});
