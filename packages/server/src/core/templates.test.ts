// Templates-on-disk shape tests.
//
// These are deliberately not "seed a tenant and assert" tests — that's
// covered in db-pool / global-ops. We're locking down the *templates*
// themselves so the workspace scaffold (ADR-0001 §3) can't drift from
// the prompt and the README without someone noticing.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { getTemplatesDir, TENANT_TEMPLATE, USER_TEMPLATE } from "./templates.js";

describe("workspace templates", () => {
  const root = getTemplatesDir();
  const tenantDir = path.join(root, TENANT_TEMPLATE);
  const userDir = path.join(root, USER_TEMPLATE);

  it("ships SOUL.md, MEMORY.md, README.md, config/ in the tenant template", () => {
    for (const f of ["SOUL.md", "MEMORY.md", "README.md"]) {
      expect(fs.existsSync(path.join(tenantDir, f))).toBe(true);
    }
    expect(fs.statSync(path.join(tenantDir, "config")).isDirectory()).toBe(true);
  });

  it("does not ship projects/, tmp/, trash/, uploads/ at the tenant level", () => {
    // After 2026-06-05 projects moved to user level. _tenant/ never
    // had tmp/trash/uploads anyway. Lock all four down so neither
    // resurfaces by accident.
    for (const f of ["projects", "tmp", "trash", "uploads"]) {
      expect(
        fs.existsSync(path.join(tenantDir, f)),
        `tenant template should not contain ${f}/`,
      ).toBe(false);
    }
  });

  it("ships USER.md, README.md, and the four user dirs in the user template", () => {
    for (const f of ["USER.md", "README.md"]) {
      expect(fs.existsSync(path.join(userDir, f))).toBe(true);
    }
    for (const d of ["projects", "uploads", "tmp", "trash"]) {
      expect(
        fs.statSync(path.join(userDir, d)).isDirectory(),
        `user template should contain ${d}/ directory`,
      ).toBe(true);
    }
  });

  it("user template README references the four dirs by name", () => {
    const readme = fs.readFileSync(path.join(userDir, "README.md"), "utf8");
    for (const d of ["projects/", "uploads/", "tmp/", "trash/"]) {
      expect(readme).toContain(d);
    }
  });
});
