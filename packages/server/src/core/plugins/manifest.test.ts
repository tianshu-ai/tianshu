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
        composerActions: [
          {
            id: "attach",
            icon: "Paperclip",
            tooltip: "Attach file",
            component: "UploadButton",
            order: 100,
          },
        ],
        apiRoutes: [{ method: "GET", path: "/list", handler: "listFiles" }],
        wsMessages: [{ type: "files.subscribe", handler: "handleSubscribe" }],
        commands: [{ id: "files.newProject", title: "New project" }],
      },
    });
    expect(m.contributes!.topBarButtons![0]!.id).toBe("files.toggle");
    expect(m.contributes!.apiRoutes![0]!.path).toBe("/list");
    expect(m.contributes!.composerActions![0]!.component).toBe("UploadButton");
    expect(m.contributes!.composerActions![0]!.icon).toBe("Paperclip");
    expect(m.contributes!.composerActions![0]!.order).toBe(100);
  });

  it("attachmentRenderers[].id, component, mimePattern are required; order optional", () => {
    expect(() =>
      parseManifest({
        id: "xx",
        version: "1.0.0",
        displayName: "X",
        contributes: {
          attachmentRenderers: [{ id: "image" /* missing component, mimePattern */ }],
        },
      }),
    ).toThrow();

    const m = parseManifest({
      id: "xx",
      version: "1.0.0",
      displayName: "X",
      contributes: {
        attachmentRenderers: [
          { id: "image", component: "ImageAttachment", mimePattern: "image/*" },
          { id: "pdf", component: "PdfAttachment", mimePattern: "application/pdf", order: 50 },
          { id: "any", component: "FileAttachment", mimePattern: "*/*", order: 999 },
        ],
      },
    });
    const renderers = m.contributes!.attachmentRenderers!;
    expect(renderers).toHaveLength(3);
    expect(renderers[0]!.mimePattern).toBe("image/*");
    expect(renderers[2]!.order).toBe(999);
  });

  it("attachmentRenderers[].mimePattern rejects garbage", () => {
    expect(() =>
      parseManifest({
        id: "xx",
        version: "1.0.0",
        displayName: "X",
        contributes: {
          attachmentRenderers: [
            { id: "r", component: "R", mimePattern: "not a mime" },
          ],
        },
      }),
    ).toThrow(/mimePattern/);
  });

  // ADR-0004 — capability + sandboxes ----------------------------------

  it("provides[] / requires[] accept only KNOWN_CAPABILITIES strings", () => {
    expect(() =>
      parseManifest({
        id: "xx",
        version: "1.0.0",
        displayName: "X",
        provides: ["sandbox.code"], // not in KNOWN_CAPABILITIES
        contributes: {
          sandboxes: [
            { id: "main", kind: "shell", displayName: "X", module: "R" },
          ],
        },
      }),
    ).toThrow(/not a known capability/);

    expect(() =>
      parseManifest({
        id: "xx",
        version: "1.0.0",
        displayName: "X",
        requires: ["sandbox.shell", "sandbox.shell"], // dup
      }),
    ).toThrow(/listed more than once/);
  });

  it("provides[sandbox.shell] requires a backing sandboxes[] entry of kind=shell", () => {
    expect(() =>
      parseManifest({
        id: "xx",
        version: "1.0.0",
        displayName: "X",
        provides: ["sandbox.shell"],
        // no sandboxes[] contribution
      }),
    ).toThrow(/without a backing sandboxes/);
  });

  it("sandboxes[].kind only accepts \"shell\" in v0", () => {
    expect(() =>
      parseManifest({
        id: "xx",
        version: "1.0.0",
        displayName: "X",
        contributes: {
          sandboxes: [
            { id: "main", kind: "vm", displayName: "X", module: "R" },
          ],
        },
      }),
    ).toThrow(/kind/);
  });

  it("accepts a microsandbox-style manifest declaring sandbox.shell + browser.cdp", () => {
    const m = parseManifest({
      id: "microsandbox",
      version: "0.1.0",
      displayName: "MicroSandbox",
      provides: ["sandbox.shell", "browser.cdp"],
      requires: [],
      server: { entry: "@tianshu-builtin/plugin-microsandbox/server" },
      client: { entry: "@tianshu-builtin/plugin-microsandbox/client" },
      contributes: {
        sandboxes: [
          { id: "main", kind: "shell", displayName: "MicroSandbox", module: "MicroSandboxRunner" },
        ],
      },
    });
    expect(m.provides).toEqual(["sandbox.shell", "browser.cdp"]);
    expect(m.contributes!.sandboxes![0]!.module).toBe("MicroSandboxRunner");
  });

  it("composerActions[].id and component are required; icon/tooltip/order optional", () => {
    expect(() =>
      parseManifest({
        id: "xx",
        version: "1.0.0",
        displayName: "X",
        contributes: {
          composerActions: [{ id: "attach" /* missing component */ }],
        },
      }),
    ).toThrow(/component/);

    // Minimal valid entry — only id + component.
    const m = parseManifest({
      id: "xx",
      version: "1.0.0",
      displayName: "X",
      contributes: {
        composerActions: [{ id: "attach", component: "UploadButton" }],
      },
    });
    expect(m.contributes!.composerActions![0]!.id).toBe("attach");
    expect(m.contributes!.composerActions![0]!.icon).toBeUndefined();
  });

  it("configSchema: parses optional `group` with badge", () => {
    const m = parseManifest({
      id: "xxx",
      version: "1.0.0",
      displayName: "X",
      configSchema: {
        fields: [
          {
            kind: "boolean",
            key: "echo.enabled",
            label: "Enable",
            default: true,
            group: {
              id: "worker-type-echo",
              label: "Echo runtime",
              badge: "worker type · echo",
              description: "v0.2 demo worker.",
            },
          },
          {
            kind: "number",
            key: "echo.delayMs",
            label: "Delay",
            default: 30000,
            group: { id: "worker-type-echo", label: "Echo runtime" },
          },
          {
            kind: "string",
            key: "unrelated",
            label: "Other",
            // No group — stays flat in the rendered form.
          },
        ],
      },
    });
    const fields = m.configSchema!.fields;
    expect(fields[0]!.group?.id).toBe("worker-type-echo");
    expect(fields[0]!.group?.badge).toBe("worker type · echo");
    expect(fields[0]!.group?.description).toBe("v0.2 demo worker.");
    expect(fields[1]!.group?.id).toBe("worker-type-echo");
    expect(fields[1]!.group?.badge).toBeUndefined();
    expect(fields[2]!.group).toBeUndefined();
  });

  it("configSchema: rejects malformed group", () => {
    expect(() =>
      parseManifest({
        id: "xxx",
        version: "1.0.0",
        displayName: "X",
        configSchema: {
          fields: [
            {
              kind: "boolean",
              key: "k",
              label: "L",
              group: { id: "g" /* missing label */ },
            },
          ],
        },
      }),
    ).toThrow(/group/);
  });
});
