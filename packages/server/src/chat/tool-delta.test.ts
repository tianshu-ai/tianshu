// Unit coverage for the boot-time tool-delta detector.
//
// We pin:
//   - parseVersion / compareVersions correctness on edge cases
//     (prereleases, double-digit minors, malformed strings)
//   - computeSessionToolDeltas: NULL stamps, up-to-date stamps,
//     stamps strictly older than current, tools with future-since,
//     tools with no since, single vs many new tools.
//   - renderToolDeltaNote: produces a non-empty string and includes
//     every tool name / description.

import { describe, it, expect } from "vitest";
import {
  compareVersions,
  computeSessionToolDeltas,
  parseVersion,
  renderToolDeltaNote,
  type ToolCatalogEntry,
} from "./tool-delta.js";

describe("parseVersion", () => {
  it("accepts X.Y.Z", () => {
    expect(parseVersion("0.3.20")).toEqual({ numeric: [0, 3, 20], pre: "" });
  });
  it("accepts X.Y.Z-prerelease", () => {
    expect(parseVersion("0.4.0-rc1")).toEqual({ numeric: [0, 4, 0], pre: "rc1" });
  });
  it("rejects ranges, aliases, empty", () => {
    expect(parseVersion("~0.3.0")).toBeNull();
    expect(parseVersion(">=0.3.0")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });
  it("rejects partial X.Y", () => {
    expect(parseVersion("0.3")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexicographically", () => {
    // 0.3.10 > 0.3.2 numerically but the other way around lex'ly
    expect(compareVersions("0.3.10", "0.3.2")).toBe(1);
  });
  it("handles equal versions", () => {
    expect(compareVersions("0.3.20", "0.3.20")).toBe(0);
  });
  it("sorts prereleases below the stable release", () => {
    expect(compareVersions("0.4.0", "0.4.0-rc1")).toBe(1);
    expect(compareVersions("0.4.0-rc1", "0.4.0-rc2")).toBe(-1);
  });
  it("treats malformed values as -Infinity", () => {
    expect(compareVersions(null, "0.0.1")).toBe(-1);
    expect(compareVersions("0.0.1", undefined)).toBe(1);
    expect(compareVersions(null, null)).toBe(0);
  });
});

const CATALOG_FIXTURE: ToolCatalogEntry[] = [
  {
    toolName: "task_list",
    pluginId: "workboard",
    since: "0.1.0",
    description: "List tasks on the workboard.",
  },
  {
    toolName: "worker_analytics",
    pluginId: "workboard",
    since: "0.3.20",
    description: "Read-only summary of recent worker task runs.",
  },
  {
    toolName: "mystery_tool",
    pluginId: "future",
    since: "0.4.0",
    description: "Hasn't shipped yet.",
  },
  {
    toolName: "no_since",
    pluginId: "legacy",
    // No since at all — should never be flagged as new.
  },
  {
    toolName: "garbage_since",
    pluginId: "broken",
    since: "not-a-version",
    description: "Manifest error — should be silently dropped.",
  },
];

describe("computeSessionToolDeltas", () => {
  it("returns nothing for sessions stamped at currentVersion", () => {
    const out = computeSessionToolDeltas({
      currentVersion: "0.3.20",
      catalog: CATALOG_FIXTURE,
      sessions: [{ sessionId: "s1", createdUnderAppVersion: "0.3.20" }],
    });
    expect(out).toEqual([]);
  });

  it("returns nothing for NULL-stamped sessions", () => {
    const out = computeSessionToolDeltas({
      currentVersion: "0.3.20",
      catalog: CATALOG_FIXTURE,
      sessions: [{ sessionId: "s1", createdUnderAppVersion: null }],
    });
    expect(out).toEqual([]);
  });

  it("flags exactly the new tools whose since > stamp && since <= current", () => {
    const out = computeSessionToolDeltas({
      currentVersion: "0.3.20",
      catalog: CATALOG_FIXTURE,
      sessions: [{ sessionId: "s1", createdUnderAppVersion: "0.3.17" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe("s1");
    const names = out[0].newTools.map((t) => t.toolName);
    // worker_analytics shipped in 0.3.20, after the session's 0.3.17 stamp.
    expect(names).toContain("worker_analytics");
    // task_list shipped in 0.1.0, well before 0.3.17.
    expect(names).not.toContain("task_list");
    // mystery_tool ships in 0.4.0, ahead of currentVersion — must
    // not appear (manifest error / pre-release leak).
    expect(names).not.toContain("mystery_tool");
    // no_since: ancient by convention, never flagged.
    expect(names).not.toContain("no_since");
    // garbage_since: malformed, silently dropped.
    expect(names).not.toContain("garbage_since");
  });

  it("handles a stamp from before the legacy floor", () => {
    // Session opened on 0.0.0 (essentially: it pre-dates everything).
    // Should flag all valid-since tools whose since <= currentVersion.
    const out = computeSessionToolDeltas({
      currentVersion: "0.3.20",
      catalog: CATALOG_FIXTURE,
      sessions: [{ sessionId: "s1", createdUnderAppVersion: "0.0.0" }],
    });
    expect(out).toHaveLength(1);
    const names = out[0].newTools.map((t) => t.toolName);
    expect(names).toEqual(["task_list", "worker_analytics"]);
  });

  it("processes multiple sessions independently", () => {
    const out = computeSessionToolDeltas({
      currentVersion: "0.3.20",
      catalog: CATALOG_FIXTURE,
      sessions: [
        { sessionId: "old", createdUnderAppVersion: "0.3.17" },
        { sessionId: "current", createdUnderAppVersion: "0.3.20" },
        { sessionId: "null", createdUnderAppVersion: null },
        { sessionId: "ancient", createdUnderAppVersion: "0.0.5" },
      ],
    });
    const map = Object.fromEntries(
      out.map((d) => [d.sessionId, d.newTools.map((t) => t.toolName)]),
    );
    expect(map).toEqual({
      old: ["worker_analytics"],
      ancient: ["task_list", "worker_analytics"],
    });
  });

  it("treats downgrades (stamp > current) as up-to-date", () => {
    const out = computeSessionToolDeltas({
      currentVersion: "0.3.20",
      catalog: CATALOG_FIXTURE,
      sessions: [{ sessionId: "fromfuture", createdUnderAppVersion: "0.5.0" }],
    });
    expect(out).toEqual([]);
  });
});

describe("renderToolDeltaNote", () => {
  it("emits a non-empty multi-line string mentioning every tool", () => {
    const note = renderToolDeltaNote({
      fromVersion: "0.3.17",
      toVersion: "0.3.20",
      newTools: [
        {
          toolName: "worker_analytics",
          pluginId: "workboard",
          since: "0.3.20",
          description: "Read-only summary of recent worker task runs.",
        },
        {
          toolName: "other_tool",
          pluginId: "foo",
          since: "0.3.18",
          // No description on purpose.
        },
      ],
    });
    expect(note).toContain("0.3.17");
    expect(note).toContain("0.3.20");
    expect(note).toContain("worker_analytics");
    expect(note).toContain("Read-only summary");
    expect(note).toContain("other_tool");
    expect(note.split("\n").length).toBeGreaterThan(3);
  });

  it("truncates long descriptions", () => {
    const desc = "x".repeat(300);
    const note = renderToolDeltaNote({
      fromVersion: "0.0.0",
      toVersion: "0.1.0",
      newTools: [
        { toolName: "t", pluginId: "p", since: "0.1.0", description: desc },
      ],
    });
    // 100 char cap with ellipsis
    expect(note).toMatch(/x{97}\.\.\./);
  });

  it("uses singular vs plural correctly", () => {
    const one = renderToolDeltaNote({
      fromVersion: "0",
      toVersion: "1",
      newTools: [{ toolName: "t", pluginId: "p", since: "1.0.0" }],
    });
    expect(one).toContain("New tool available");
    const many = renderToolDeltaNote({
      fromVersion: "0",
      toVersion: "1",
      newTools: [
        { toolName: "t1", pluginId: "p", since: "1.0.0" },
        { toolName: "t2", pluginId: "p", since: "1.0.0" },
      ],
    });
    expect(many).toContain("New tools available");
  });
});
