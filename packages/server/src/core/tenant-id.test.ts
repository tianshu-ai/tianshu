import { describe, expect, it } from "vitest";
import { isValidTenantId, validateTenantId, InvalidTenantIdError } from "./tenant-id.js";

describe("validateTenantId", () => {
  it.each(["acme", "team-a", "team_b", "yu", "ab", "a1", "a".repeat(32)])(
    "accepts %s",
    (id) => {
      expect(validateTenantId(id)).toBe(id);
      expect(isValidTenantId(id)).toBe(true);
    },
  );

  it.each([
    "_tenant", // leading underscore reserved
    "Acme", // uppercase
    "a", // too short
    "", // empty
    "ab/cd", // slash
    "..", // path traversal
    "a".repeat(33), // too long
    "tenants", // reserved
    "global", // reserved
    "admin",
    " acme ",
  ])("rejects %s", (id) => {
    expect(() => validateTenantId(id)).toThrow(InvalidTenantIdError);
    expect(isValidTenantId(id)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(() => validateTenantId(123 as unknown as string)).toThrow(InvalidTenantIdError);
    expect(() => validateTenantId(null as unknown as string)).toThrow(InvalidTenantIdError);
  });
});
