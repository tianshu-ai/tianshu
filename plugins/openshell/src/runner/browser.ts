// OpenShell BrowserSidecar — manages the Chromium + Playwright MCP
// stack inside the Docker sandbox. Port-forwarded to the host via
// openshell's `--forward` flag at sandbox create time.
//
// Architecture:
//   - Sandbox create passes `--forward <mcpPort> --forward <cdpPort>
//     --forward <vncPort>` so the guest services are reachable from
//     the host at `localhost:<port>`.
//   - After sandbox reaches Ready, `startBrowserStack()` execs a
//     startup script that launches Xvfb, Chromium (via playwright),
//     Playwright MCP server, and optionally x11vnc + noVNC.
//   - The sidecar tracks the forwarded ports and exposes them
//     through the standard BrowserSidecar interface so the host's
//     McpToolset can connect.

import type {
  BrowserSidecar,
  BrowserSidecarHealth,
} from "@tianshu-ai/plugin-sdk";

/** Port offsets from the gateway port. Deterministic per-tenant
 *  because each tenant already has a unique gateway port. */
export const BROWSER_PORT_OFFSETS = {
  mcp: 1000, // Playwright MCP (Streamable HTTP)
  cdp: 1001, // Chrome DevTools Protocol
  vnc: 1002, // noVNC HTTP
} as const;

export interface BrowserPorts {
  mcp: number;
  cdp: number;
  vnc: number;
}

export function deriveBrowserPorts(gatewayPort: number): BrowserPorts {
  return {
    mcp: gatewayPort + BROWSER_PORT_OFFSETS.mcp,
    cdp: gatewayPort + BROWSER_PORT_OFFSETS.cdp,
    vnc: gatewayPort + BROWSER_PORT_OFFSETS.vnc,
  };
}

/**
 * BrowserSidecar backed by a Playwright MCP server inside an
 * OpenShell Docker sandbox. Ports are forwarded at sandbox create
 * time; the stack is started via `sandbox exec` after the sandbox
 * reaches Ready.
 */
export class OpenShellBrowserSidecar implements BrowserSidecar {
  private lastViewport: { width: number; height: number } | undefined;
  private ports: BrowserPorts | undefined;
  private stackRunning = false;

  /** Called by the runner after sandbox create to record the
   *  forwarded ports. */
  setPorts(ports: BrowserPorts): void {
    this.ports = ports;
  }

  /** Called by the runner after successfully starting the browser
   *  stack inside the sandbox. */
  setStackRunning(running: boolean): void {
    this.stackRunning = running;
  }

  cdpHostPort(): number | undefined {
    return this.stackRunning ? this.ports?.cdp : undefined;
  }

  mcpHostPort(): number | undefined {
    return this.stackRunning ? this.ports?.mcp : undefined;
  }

  vncHostPort(): number | undefined {
    return this.stackRunning ? this.ports?.vnc : undefined;
  }

  setLastViewport(v: { width: number; height: number }): void {
    this.lastViewport = v;
  }

  getLastViewport(): { width: number; height: number } | undefined {
    return this.lastViewport;
  }

  async restart(): Promise<boolean> {
    // Restart is handled by the runner (re-exec the startup script).
    // The runner calls restartBrowserStack() which sets
    // stackRunning appropriately.
    return false;
  }

  async health(): Promise<BrowserSidecarHealth> {
    const port = this.ports?.cdp;
    const t0 = Date.now();
    if (!this.stackRunning || port === undefined) {
      return {
        ok: false,
        latencyMs: 0,
        error: this.ports
          ? "Browser stack not started"
          : "No browser ports configured (sandbox may need reset)",
        suggestion: this.ports
          ? "The browser stack failed to start inside the sandbox. " +
            "Check sandbox logs or call reset_sandbox."
          : "Call reset_sandbox to recreate with browser port forwards.",
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
            "call browser_restart to re-spawn chromium + Playwright MCP.",
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
      return {
        ok: false,
        latencyMs,
        cdpHostPort: port,
        error: aborted
          ? "CDP probe timed out (>2.5s)"
          : refused
            ? `CDP not reachable: ${msg}`
            : `CDP probe failed: ${msg}`,
        suggestion: aborted
          ? "sandbox may be wedged — try reset_sandbox."
          : refused
            ? "chromium looks down. Call browser_restart; if that fails, reset_sandbox."
            : "call browser_restart; reset_sandbox if the next probe still fails.",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
