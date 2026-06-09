// Pure-logic tests for the renderer picker. We don't render React
// here — the dispatcher itself is small enough that breaking it
// would be obvious manually; the matching rules are where regressions
// hide.

import { describe, expect, it } from "vitest";
import {
  collectRenderers,
  mimeMatches,
  pickRenderer,
} from "./attachment-renderers";
import type { PluginListEntry } from "./api";

function plugin(
  id: string,
  state: PluginListEntry["state"],
  renderers: Array<{
    id: string;
    mimePattern: string;
    component: string;
    order?: number;
  }>,
): PluginListEntry {
  return {
    id,
    version: "1.0.0",
    displayName: id,
    description: null,
    source: "builtin",
    state,
    failedReason: null,
    contributes: { attachmentRenderers: renderers },
    configSchema: null,
    config: {},
    clientEntry: `@tianshu-builtin/plugin-${id}/client`,
    capabilities: { provided: [], requires: [], missing: [] },
  };
}

describe("mimeMatches", () => {
  it("type/subtype strict match (case-insensitive)", () => {
    expect(mimeMatches("application/pdf", "application/pdf")).toBe(true);
    expect(mimeMatches("application/pdf", "APPLICATION/PDF")).toBe(true);
    expect(mimeMatches("application/pdf", "image/png")).toBe(false);
  });

  it("type wildcard `image/*`", () => {
    expect(mimeMatches("image/*", "image/png")).toBe(true);
    expect(mimeMatches("image/*", "image/svg+xml")).toBe(true);
    expect(mimeMatches("image/*", "video/mp4")).toBe(false);
  });

  it("catchall `*/*`", () => {
    expect(mimeMatches("*/*", "anything/at-all")).toBe(true);
    expect(mimeMatches("*/*", "image/png")).toBe(true);
  });

  it("ignores RFC 6838 parameters", () => {
    expect(mimeMatches("text/html", "text/html; charset=utf-8")).toBe(true);
    expect(mimeMatches("text/*", "text/plain;charset=us-ascii")).toBe(true);
  });

  it("rejects malformed mime types", () => {
    expect(mimeMatches("image/png", "garbage")).toBe(false);
  });
});

describe("collectRenderers", () => {
  it("flattens active plugins, sorted by order then by plugin/contrib id", () => {
    const a = plugin("alpha", "active", [
      { id: "wide", mimePattern: "*/*", component: "W", order: 999 },
      { id: "image", mimePattern: "image/*", component: "I", order: 100 },
    ]);
    const b = plugin("beta", "active", [
      { id: "image", mimePattern: "image/*", component: "B", order: 100 },
    ]);
    const out = collectRenderers([a, b]);
    expect(out.map((r) => `${r.pluginId}.${r.id}`)).toEqual([
      "alpha.image",
      "beta.image",
      "alpha.wide",
    ]);
  });

  it("skips disabled / failed plugins", () => {
    const ok = plugin("ok", "active", [
      { id: "x", mimePattern: "*/*", component: "X" },
    ]);
    const broken = plugin("broken", "failed", [
      { id: "y", mimePattern: "*/*", component: "Y" },
    ]);
    const off = plugin("off", "disabled", [
      { id: "z", mimePattern: "*/*", component: "Z" },
    ]);
    const out = collectRenderers([ok, broken, off]);
    expect(out).toHaveLength(1);
    expect(out[0]!.pluginId).toBe("ok");
  });
});

describe("pickRenderer", () => {
  it("returns the first matching renderer in order", () => {
    const list = collectRenderers([
      plugin("files", "active", [
        { id: "image", mimePattern: "image/*", component: "I", order: 100 },
        { id: "any", mimePattern: "*/*", component: "F", order: 999 },
      ]),
    ]);
    expect(pickRenderer(list, "image/png")?.component).toBe("I");
    expect(pickRenderer(list, "application/pdf")?.component).toBe("F");
  });

  it("returns null when nothing matches", () => {
    const list = collectRenderers([
      plugin("files", "active", [
        { id: "image", mimePattern: "image/*", component: "I" },
      ]),
    ]);
    expect(pickRenderer(list, "application/pdf")).toBeNull();
  });
});
