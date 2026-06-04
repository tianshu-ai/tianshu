import { describe, expect, it } from "vitest";
import { parseManifest, PluginManifestError } from "./manifest.js";

describe("parseManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const m = parseManifest({
      id: "files",
      version: "1.0.0",
      displayName: "Workspace Files",
    });
    expect(m.id).toBe("files");
    expect(m.contributes).toBeUndefined();
  });

  it("rejects bad ids", () => {
    expect(() =>
      parseManifest({ id: "_files", version: "1.0.0", displayName: "X" }),
    ).toThrow(PluginManifestError);
    expect(() =>
      parseManifest({ id: "Files", version: "1.0.0", displayName: "X" }),
    ).toThrow(PluginManifestError);
    expect(() =>
      parseManifest({ id: "x", version: "1.0.0", displayName: "X" }),
    ).toThrow(PluginManifestError);
  });

  it("rejects bad semver", () => {
    expect(() =>
      parseManifest({ id: "files", version: "v1", displayName: "X" }),
    ).toThrow(PluginManifestError);
  });

  it("validates contributes recursively and accumulates issues", () => {
    let err: PluginManifestError | null = null;
    try {
      parseManifest({
        id: "files",
        version: "1.0.0",
        displayName: "X",
        contributes: {
          topBarButtons: [{ id: "a" /* missing icon */ }],
          apiRoutes: [{ method: "FOO", path: "/x", handler: "h" }],
          rightPanels: [{ id: "r" /* missing displayName + component */ }],
        },
      });
    } catch (e) {
      err = e as PluginManifestError;
    }
    expect(err).toBeInstanceOf(PluginManifestError);
    expect(err!.issues.some((i) => i.includes("icon"))).toBe(true);
    expect(err!.issues.some((i) => i.includes("method"))).toBe(true);
    expect(err!.issues.some((i) => i.includes("displayName"))).toBe(true);
    expect(err!.issues.some((i) => i.includes("component"))).toBe(true);
  });

  it("rejects api route paths that don't start with /", () => {
    let err: PluginManifestError | null = null;
    try {
      parseManifest({
        id: "files",
        version: "1.0.0",
        displayName: "X",
        contributes: {
          apiRoutes: [{ method: "GET", path: "no-leading-slash", handler: "h" }],
        },
      });
    } catch (e) {
      err = e as PluginManifestError;
    }
    expect(err).toBeInstanceOf(PluginManifestError);
    expect(err!.issues.some((i) => i.includes("path"))).toBe(true);
  });

  it("accepts a fully populated manifest", () => {
    const m = parseManifest({
      id: "files",
      version: "1.0.0",
      displayName: "Workspace Files",
      description: "Browse files.",
      author: "tianshu-ai",
      license: "Apache-2.0",
      permissions: ["workspace.read"],
      client: { entry: "@tianshu-builtin/plugin-files/client" },
      server: { entry: "@tianshu-builtin/plugin-files/server" },
      contributes: {
        topBarButtons: [
          { id: "files.toggle", icon: "FolderOpen", tooltip: "Files", opensPanel: "files.main", order: 50 },
        ],
        rightPanels: [{ id: "files.main", displayName: "Files", component: "FilesPanel" }],
        sidebarSections: [
          {
            id: "files.recent",
            displayName: "Recent",
            component: "FilesSidebarRecent",
            after: "workers",
            order: 10,
          },
        ],
        apiRoutes: [{ method: "GET", path: "/list", handler: "listFiles" }],
        wsMessages: [{ type: "files.subscribe", handler: "handleSubscribe" }],
        commands: [{ id: "files.newProject", title: "New project" }],
      },
    });
    expect(m.contributes!.topBarButtons![0]!.id).toBe("files.toggle");
    expect(m.contributes!.apiRoutes![0]!.path).toBe("/list");
  });
});
