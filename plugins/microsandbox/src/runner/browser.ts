// BrowserSidecar implementation backing the `browser.cdp` capability.
//
// This is the N+5.1 scaffold: we expose a sidecar object so the host
// auto-registers `browser.cdp`, but the chromium / Xvfb / x11vnc /
// noVNC / Playwright MCP stack is not yet wired into the sandbox
// image. Every getter returns undefined until the runtime stack is
// detected inside the live VM. That detection lives in a follow-up
// PR (N+5.2 builds the image, N+5.3 the live wiring).
//
// Why ship the sidecar before the chromium it backs:
// 1. It pins the `browser.cdp` provider to *this* plugin in the
//    capability registry. Any `requires: [browser.cdp]` plugin
//    landing later sees a defined provider — even if temporarily
//    inert — instead of "no provider" failures.
// 2. The admin Browser page can render meaningful state ("not
//    running yet, build a Sandboxfile that includes chromium")
//    rather than 404'ing on missing routes.
// 3. Tests can mount a fake sidecar via the same interface.

import type { BrowserSidecar } from "@tianshu/plugin-sdk";

/**
 * Sidecar that reports "browser stack not present" while still
 * satisfying the `BrowserSidecar` shape. Values come from probing
 * the live sandbox at status() time (added in N+5.3); for now we
 * never find a port and `restart()` is a no-op that logs.
 */
export class MicrosandboxBrowserSidecar implements BrowserSidecar {
  private lastViewport: { width: number; height: number } | undefined;

  /** Updated when the live runner detects chromium is up; null
   *  while the v0.1 stub returns nothing. */
  private detectedCdpPort: number | undefined;
  private detectedMcpPort: number | undefined;
  private detectedVncPort: number | undefined;

  cdpHostPort(): number | undefined {
    return this.detectedCdpPort;
  }

  mcpHostPort(): number | undefined {
    return this.detectedMcpPort;
  }

  vncHostPort(): number | undefined {
    return this.detectedVncPort;
  }

  setLastViewport(v: { width: number; height: number }): void {
    this.lastViewport = v;
  }

  getLastViewport(): { width: number; height: number } | undefined {
    return this.lastViewport;
  }

  async restart(): Promise<boolean> {
    // N+5.3 will exec into the sandbox and `supervisorctl restart
    // chromium playwright-mcp`. For now we honestly say we
    // couldn't restart a stack that isn't running.
    return false;
  }

  /** Internal: the runner calls this when port forwards become
   *  visible. Kept narrow on purpose — the BrowserSidecar surface
   *  exposed to other plugins stays read-only. */
  __setDetectedPorts(ports: {
    cdp?: number;
    mcp?: number;
    vnc?: number;
  }): void {
    this.detectedCdpPort = ports.cdp;
    this.detectedMcpPort = ports.mcp;
    this.detectedVncPort = ports.vnc;
  }
}
