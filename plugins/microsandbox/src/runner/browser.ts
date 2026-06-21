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

import type {
  BrowserSidecar,
  BrowserSidecarHealth,
} from "@tianshu-ai/plugin-sdk";

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

  /**
   * GET http://127.0.0.1:<cdpHostPort>/json/version with a 2.5s
   * timeout. CDP's /json/version is the canonical liveness probe:
   * cheap (no JS execution), strict response shape, fails the
   * three ways we care about:
   *   - cdpHostPort not set      → "no port mapped, build a
   *                                browser-enabled snapshot"
   *   - connect refused / reset  → "chromium / supervisord died,
   *                                call browser_restart"
   *   - timeout                  → "sandbox itself is wedged,
   *                                ask orchestrator to reset_sandbox"
   * Anything else is reported verbatim with a generic suggestion.
   */
  async health(): Promise<BrowserSidecarHealth> {
    const port = this.detectedCdpPort;
    const t0 = Date.now();
    if (port === undefined) {
      return {
        ok: false,
        latencyMs: 0,
        error: "CDP host port is not mapped",
        suggestion:
          "build a sandbox snapshot that includes the browser stack " +
          "(template browser.yaml) before using browser_* tools.",
      };
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: ctl.signal,
        headers: { accept: "application/json" },
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        return {
          ok: false,
          latencyMs,
          cdpHostPort: port,
          error: `CDP /json/version returned HTTP ${res.status}`,
          suggestion:
            "call browser_restart to re-spawn chromium + Playwright MCP. " +
            "If the next probe still fails, ask the orchestrator to " +
            "reset_sandbox.",
        };
      }
      const json = (await res.json()) as {
        Browser?: string;
        webSocketDebuggerUrl?: string;
      };
      return {
        ok: true,
        latencyMs,
        cdpHostPort: port,
        browser: typeof json.Browser === "string" ? json.Browser : undefined,
      };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = ctl.signal.aborted;
      const refused =
        msg.includes("ECONNREFUSED") || msg.includes("connect ECONNRESET");
      const errorText = aborted
        ? "CDP probe timed out (>2.5s)"
        : refused
          ? `CDP not reachable: ${msg}`
          : `CDP probe failed: ${msg}`;
      const suggestion = aborted
        ? "sandbox is likely wedged — ask the orchestrator to reset_sandbox."
        : refused
          ? "chromium / supervisord on the guest looks down. Call " +
            "browser_restart; if that fails, reset_sandbox."
          : "call browser_restart; reset_sandbox if the next probe still fails.";
      return {
        ok: false,
        latencyMs,
        cdpHostPort: port,
        error: errorText,
        suggestion,
      };
    } finally {
      clearTimeout(timer);
    }
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
