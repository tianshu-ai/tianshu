// Tests for the workspace:// → /api/p/files/raw rewrite. Pure
// string handling; the chat UI plugs the result into ReactMarkdown
// `urlTransform` and `<img src>`.

import { describe, expect, it } from "vitest";
import { rewriteWorkspaceUri } from "./workspace-uri";

describe("rewriteWorkspaceUri", () => {
  it("rewrites the canonical empty-authority shape", () => {
    expect(rewriteWorkspaceUri("workspace:///scratch/cover.png")).toBe(
      "/api/p/files/raw?path=%2Fscratch%2Fcover.png",
    );
  });

  it("tolerates the two-slash alias the LLM sometimes emits", () => {
    expect(rewriteWorkspaceUri("workspace://scratch/cover.png")).toBe(
      "/api/p/files/raw?path=%2Fscratch%2Fcover.png",
    );
  });

  it("rewrites the workspace root itself", () => {
    expect(rewriteWorkspaceUri("workspace:///")).toBe(
      "/api/p/files/raw?path=%2F",
    );
  });

  it("URL-encodes spaces and other path-unsafe characters", () => {
    expect(
      rewriteWorkspaceUri("workspace:///projects/big report (v2).md"),
    ).toBe("/api/p/files/raw?path=%2Fprojects%2Fbig%20report%20(v2).md");
  });

  it("passes data: URIs through unchanged", () => {
    const dataUrl = "data:image/png;base64,iVBORw0K";
    expect(rewriteWorkspaceUri(dataUrl)).toBe(dataUrl);
  });

  it("passes http(s) URLs through unchanged", () => {
    expect(rewriteWorkspaceUri("https://example.com/x.png")).toBe(
      "https://example.com/x.png",
    );
    expect(rewriteWorkspaceUri("http://localhost/foo")).toBe(
      "http://localhost/foo",
    );
  });

  it("leaves non-workspace bare paths alone (broken image stays visible)", () => {
    // The whole point of the workspace:// scheme is that *only* it
    // gets rewritten. Bare ./, /, or absolute host paths are NOT
    // repaired here — a broken image surfaces a real bug rather
    // than silently pointing somewhere wrong.
    expect(rewriteWorkspaceUri("./scratch/x.png")).toBe("./scratch/x.png");
    expect(rewriteWorkspaceUri("/scratch/x.png")).toBe("/scratch/x.png");
    expect(rewriteWorkspaceUri("/Users/yu/.tianshu/x.png")).toBe(
      "/Users/yu/.tianshu/x.png",
    );
    expect(rewriteWorkspaceUri("scratch/x.png")).toBe("scratch/x.png");
  });

  it("returns empty / falsy inputs unchanged", () => {
    expect(rewriteWorkspaceUri("")).toBe("");
  });
});
