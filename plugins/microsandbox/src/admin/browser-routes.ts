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
import { McpToolset } from "@tianshu/plugin-sdk";

export interface BrowserRoutesDeps {
  /** Same accessor pattern as the sandbox routes — lets the routes
   *  module stay decoupled from plugin activation timing. */
  getRunner(): SandboxRunner | null;
}

/**
 * Cap viewport sizes the runner is willing to set. Matches Xvfb's
 * `-screen 0 2400x1800x24` framebuffer in browser.yaml; overshooting
 * means xrandr silently truncates.
 */
const VIEWPORT_MIN_W = 640;
const VIEWPORT_MIN_H = 480;
const VIEWPORT_MAX_W = 2400;
const VIEWPORT_MAX_H = 1800;

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

  // POST /api/p/microsandbox/browser/resize
  //
  // Three-layer dynamic resize, copy of the closed-source tianshu
  // approach (see `/api/browser/resize` in the predecessor):
  //   (1) xrandr --fb resizes the Xvfb framebuffer so noVNC isn't
  //       letterboxed or cropped.
  //   (2) wmctrl re-fits the chromium X11 window to the new
  //       framebuffer.
  //   (3) Playwright MCP browser_resize (== page.setViewportSize)
  //       tells chromium to re-layout its inner viewport — without
  //       this the X11 window changes but the page content stays
  //       at its launch size and looks like "app only fills part of
  //       the panel".
  // Layer (3) also wins if the sandbox image is missing xrandr/
  // wmctrl, because Playwright manages the viewport at the chrome
  // level on its own. Layers (1)+(2) are best-effort.
  //
  // The host BrowserViewportPanel POSTs here as the user finishes
  // dragging the panel resize handle (debounced client-side). We
  // also stash the latest viewport on the BrowserSidecar so the
  // browser tool can re-apply it after navigation.
  const postBrowserResize = async (req: Request, res: Response) => {
    const sidecar = getSidecar();
    if (!sidecar) {
      res.status(503).json({ ok: false, error: "no_sidecar" });
      return;
    }
    const runner = deps.getRunner();
    const body = (req.body ?? {}) as { width?: number; height?: number };
    const w = clampInt(Number(body.width), VIEWPORT_MIN_W, VIEWPORT_MAX_W);
    const h = clampInt(Number(body.height), VIEWPORT_MIN_H, VIEWPORT_MAX_H);
    if (!w || !h) {
      res.status(400).json({ ok: false, error: "viewport_required" });
      return;
    }

    // (1) + (2): X11 layer — best-effort, errors non-fatal.
    let x11Note: string | undefined;
    if (runner && typeof (runner as { exec?: unknown }).exec === "function") {
      const script =
        `DISPLAY=:99 xrandr --fb ${w}x${h} 2>/dev/null || true; ` +
        `WID=$(DISPLAY=:99 wmctrl -l 2>/dev/null | grep -iE 'chromium|chrome|google' | awk '{print $1; exit}'); ` +
        `if [ -n "$WID" ]; then DISPLAY=:99 wmctrl -i -r "$WID" -e "0,0,0,${w},${h}" 2>/dev/null || true; fi`;
      try {
        await runner.exec({ command: script, timeoutMs: 10_000 });
      } catch (err) {
        x11Note =
          err instanceof Error ? err.message : String(err);
      }
    }

    // (3): chromium viewport via Playwright MCP. This is what
    // actually re-layouts the page content. Done after the X11
    // resize so chrome doesn't fight us by trying to re-fit to
    // the smaller window first.
    let mcpNote: string | undefined;
    const mcpPort = sidecar.mcpHostPort();
    if (mcpPort) {
      try {
        // Spin up a single-shot McpToolset bound to the tenant's
        // Playwright MCP, call browser_resize, drop. The toolset
        // handles the Host-header pinning + SDK transport setup.
        const ts = new McpToolset({
          name: "playwright-resize",
          prefix: "",
          resolve: () => `http://127.0.0.1:${mcpPort}/mcp`,
          upstreamHost: "localhost:3200",
        });
        await ts.refresh();
        const tool = ts.listTools().find((t) => t.schema.name === "browser_resize");
        if (tool) {
          await tool.execute(
            { width: w, height: h },
            // Stub the per-call context the SDK expects — we don't
            // care about logging beyond x11Note here.
            {
              pluginId: "microsandbox",
              tenantId: "unknown",
              userId: "unknown",
              capabilities: { get: () => undefined, has: () => false },
              userHomeDir: "",
              tenantHomeDir: "",
              log: { info: () => {}, warn: () => {}, error: () => {} },
            },
          );
        } else {
          mcpNote = "browser_resize not advertised by upstream MCP";
        }
      } catch (err) {
        mcpNote = err instanceof Error ? err.message : String(err);
      }
    } else {
      mcpNote = "MCP port not yet detected";
    }

    // Cache the latest viewport so the agent's browser tool can
    // re-apply it automatically after each goto (chrome resets
    // viewport on navigation).
    sidecar.setLastViewport({ width: w, height: h });

    res.json({
      ok: true,
      applied: { width: w, height: h },
      ...(x11Note ? { x11Note } : {}),
      ...(mcpNote ? { mcpNote } : {}),
    });
  };

  return {
    getBrowserStatus,
    postBrowserRestart,
    postBrowserResize,
  };
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
