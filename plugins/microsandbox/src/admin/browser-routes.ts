// HTTP route handlers for the Browser admin page (N+5.1 scaffold).
//
// Pure read-through over the runner's BrowserSidecar plus a
// best-effort restart endpoint. The chromium / Xvfb / noVNC stack
// itself isn't shipped yet — those routes report "not running"
// today, and become meaningful once the Sandboxfile that includes
// the browser layer lands in N+5.2.
//
// Why this is a separate file (not folded into routes.ts):
// - admin/routes.ts is already 600+ lines and four conceptual
//   surfaces (sandboxfile / builds / shell / live). Sandwiching a
//   fifth area in that file makes future readers thumb past 90%
//   irrelevant code to find browser logic.
// - These routes also have a different liveness story: the sidecar
//   may exist but report "no chromium running yet". The route
//   shape reflects that explicitly via { ready, ports, lastError }
//   instead of bolting onto the existing sandbox status response.

import type { Request, Response } from "express";
import type { BrowserSidecar, SandboxRunner } from "@tianshu/plugin-sdk";

export interface BrowserRoutesDeps {
  /** Same accessor pattern as the sandbox routes — lets the routes
   *  module stay decoupled from plugin activation timing. */
  getRunner(): SandboxRunner | null;
}

/** Public payload returned by GET /browser/status. Stable shape so
 *  the admin page can render meaningfully through every state of
 *  the upcoming chromium rollout (no sidecar → sidecar but no
 *  chromium → chromium up). */
export interface BrowserStatusPayload {
  /** True iff every required port forward is detected. v0.1 always
   *  reports false because the chromium stack ships in N+5.2. */
  ready: boolean;
  /** Whatever subset of port forwards the sidecar has seen. Port
   *  values are host ports; the agent's `browser.cdp` consumer
   *  builds `http://localhost:<port>` URLs from these. */
  ports: {
    cdp: number | null;
    mcp: number | null;
    vnc: number | null;
  };
  /** Per-tenant viewport last reported by the BrowserPanel
   *  ResizeObserver, when present. Used by the agent's browser
   *  tools to set Playwright's viewport before navigating. */
  lastViewport: { width: number; height: number } | null;
  /** Human-readable hint shown by the admin page when ready=false.
   *  Helps users tell "build the browser layer" from "browser is
   *  starting up" without grepping logs. */
  hint?: string;
}

export function buildBrowserRoutes(deps: BrowserRoutesDeps) {
  const getSidecar = (): BrowserSidecar | null => {
    const runner = deps.getRunner();
    return runner?.browser ?? null;
  };

  const getBrowserStatus = async (_req: Request, res: Response) => {
    const sidecar = getSidecar();
    if (!sidecar) {
      const payload: BrowserStatusPayload = {
        ready: false,
        ports: { cdp: null, mcp: null, vnc: null },
        lastViewport: null,
        hint: "Sandbox runner not active — start it via the Sandbox admin page.",
      };
      res.json(payload);
      return;
    }
    const cdp = sidecar.cdpHostPort();
    const mcp = sidecar.mcpHostPort();
    const vnc = sidecar.vncHostPort();
    const ready = cdp !== undefined && mcp !== undefined && vnc !== undefined;
    const payload: BrowserStatusPayload = {
      ready,
      ports: {
        cdp: cdp ?? null,
        mcp: mcp ?? null,
        vnc: vnc ?? null,
      },
      lastViewport: sidecar.getLastViewport() ?? null,
      hint: ready
        ? undefined
        : "Browser stack not running. Add chromium + Playwright MCP + noVNC to your Sandboxfile and rebuild (lands in a follow-up PR).",
    };
    res.json(payload);
  };

  const postBrowserRestart = async (_req: Request, res: Response) => {
    const sidecar = getSidecar();
    if (!sidecar) {
      res.status(503).json({
        ok: false,
        error: "no_sidecar",
        message: "Sandbox runner not active.",
      });
      return;
    }
    try {
      const ok = await sidecar.restart();
      res.json({
        ok,
        // restart() returning false is a normal v0.1 outcome — chromium
        // isn't running so there's nothing to restart. We surface that
        // verbatim so the admin page can show a "no-op" badge.
        message: ok
          ? "browser restarted"
          : "no chromium stack running; ship the browser sandbox layer first",
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "restart_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    getBrowserStatus,
    postBrowserRestart,
  };
}
