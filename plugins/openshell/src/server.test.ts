// Smoke tests for the openshell plugin server entry. We don't
// actually exec the OpenShell CLI in unit tests — the binary may
// not be installed on the host, and even if it is, talking to a
// real gateway is integration-level. Instead we verify the
// activate() hook returns the right module shape so the host's
// capability wiring picks the runner up under sandbox.shell.

import { describe, expect, it } from "vitest";
import serverEntry from "./server.js";

describe("openshell plugin server entry", () => {
  it("exposes activate + deactivate", () => {
    expect(typeof serverEntry.activate).toBe("function");
    expect(typeof serverEntry.deactivate).toBe("function");
  });

  it("activate returns the expected sandboxes + tools shape", async () => {
    // workspaceDir is derived into stateDir by walking one up; we
    // point it at /tmp/... so the plugin doesn't try to write to a
    // real tenant root during the unit test.
    const fakeCtx = {
      pluginId: "openshell",
      tenantId: "test-tenant",
      workspaceDir: "/tmp/test-tianshu-openshell/workspace",
      pluginConfig: {
        // Point at non-existent binaries so the background
        // ensureSandbox() promise fails immediately rather than
        // spending the test budget waiting for a gateway-spawn
        // timeout. We only care about the shape of activate's
        // return value here.
        openshellBin: "/usr/bin/false",
        gatewayBin: "/usr/bin/false",
      },
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    } as unknown as Parameters<typeof serverEntry.activate>[0];
    const exports = await serverEntry.activate(fakeCtx);
    try {
      // sandbox.shell capability backed by OpenShellRunner under
      // the manifest's `module: "OpenShellRunner"` key.
      expect(exports.sandboxes).toBeDefined();
      expect(exports.sandboxes?.OpenShellRunner).toBeDefined();
      expect((exports.sandboxes?.OpenShellRunner as { id: string }).id).toBe(
        "openshell.main",
      );
      expect(
        (exports.sandboxes?.OpenShellRunner as { kind: string }).kind,
      ).toBe("shell");

      // Three MVP tools.
      expect(exports.tools).toBeDefined();
      expect(exports.tools?.ExecTool).toBeDefined();
      expect(exports.tools?.ResetSandboxTool).toBeDefined();
      expect(exports.tools?.GetSandboxStatusTool).toBeDefined();

      // No browser sidecar in MVP.
      const runner = exports.sandboxes?.OpenShellRunner as {
        browser?: unknown;
      };
      expect(runner.browser).toBeUndefined();
    } finally {
      // The activate() call schedules a background ensureSandbox()
      // which will fail (no openshell binary in test env). That's
      // fine — we only assert it doesn't throw synchronously. The
      // background promise's `.catch` swallows it.
      await serverEntry.deactivate?.();
    }
  });
});
