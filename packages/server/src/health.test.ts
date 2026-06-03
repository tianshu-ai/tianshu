import { describe, expect, it } from "vitest";

// Placeholder smoke test so `npm test` has something green to report
// on day 0. Real route-level tests with supertest will land alongside
// the agent runtime PR.
describe("smoke", () => {
  it("addition still works", () => {
    expect(1 + 1).toBe(2);
  });
});
