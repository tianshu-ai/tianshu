// Browser admin routes for the OpenShell plugin.
// Mirrors microsandbox's browser-routes.ts — same API shape so the
// admin Browser page works identically for both sandbox backends.

import type { Request, Response } from "express";
import type { BrowserSidecar, SandboxRunner } from "@tianshu-ai/plugin-sdk";
import { McpToolset } from "@tianshu-ai/plugin-sdk";

export interface BrowserRoutesDeps {
  getRunner(): SandboxRunner | null;
}

const VIEWPORT_MIN_W = 640;
const VIEWPORT_MIN_H = 480;
const VIEWPORT_MAX_W = 2400;
const VIEWPORT_MAX_H = 1800;

export interface BrowserStatusPayload {
  ready: boolean;
  ports: {
    cdp: number | null;
    mcp: number | null;
    vnc: number | null;
  };
  lastViewport: { width: number; height: number } | null;
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
    const ready = cdp !== undefined && mcp !== undefined;
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
        : "Browser stack not running inside the sandbox. It will start automatically on the next sandbox create/reset.",
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
        message: ok
          ? "browser restarted"
          : "restart not yet implemented for openshell; use reset_sandbox",
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: "restart_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

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

    // X11 layer — best-effort.
    let x11Note: string | undefined;
    if (runner && typeof (runner as { exec?: unknown }).exec === "function") {
      const script =
        `DISPLAY=:99 xrandr --fb ${w}x${h} 2>/dev/null || true; ` +
        `WID=$(DISPLAY=:99 wmctrl -l 2>/dev/null | grep -iE 'chromium|chrome|google' | awk '{print $1; exit}'); ` +
        `if [ -n "$WID" ]; then DISPLAY=:99 wmctrl -i -r "$WID" -e "0,0,0,${w},${h}" 2>/dev/null || true; fi`;
      try {
        await runner.exec({ command: script, timeoutMs: 10_000 });
      } catch (err) {
        x11Note = err instanceof Error ? err.message : String(err);
      }
    }

    // Playwright MCP browser_resize.
    let mcpNote: string | undefined;
    const mcpPort = sidecar.mcpHostPort();
    if (mcpPort) {
      try {
        const ts = new McpToolset({
          name: "playwright-resize",
          prefix: "",
          resolve: () => `http://127.0.0.1:${mcpPort}/mcp`,
        });
        await ts.refresh();
        const tool = ts
          .listTools()
          .find((t) => t.schema.name === "browser_resize");
        if (tool) {
          await tool.execute(
            { width: w, height: h },
            {
              pluginId: "openshell",
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
