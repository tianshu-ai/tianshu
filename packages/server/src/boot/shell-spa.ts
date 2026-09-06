// Tenant-aware UI shell routing (ADR-0005).
//
// When a tenant enables a plugin with `uiShell`, all non-API browser
// requests for that tenant are served from the plugin's dist directory
// instead of the default @tianshu/web bundle. This middleware must be
// mounted BEFORE the default SPA fallback (static-spa.ts).
//
// Routing logic:
//
//   GET /tenants/:tenantId/...  (not /api/, not /ws)
//     → resolve tenantId
//     → look up active shell plugin for that tenant
//     → found? serve from plugin's dist/ (with SPA fallback if configured)
//     → not found? fall through to the default SPA handler
//
// Dev mode: if the shell plugin declares `uiShell.devServer.target`
// and we're not in production, proxy the request there instead of
// serving from dist/. This lets shell developers run their own vite
// with HMR.

import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import type { PluginRegistry } from "../core/plugins/index.js";
import { getTenantSharedDir, getUserHomeDir } from "../core/paths.js";

const TENANT_URL_RE = /^\/tenants\/([^/]+)\/users\/([^/]+)/;

/**
 * Mount the tenant-aware shell SPA middleware. Must be called BEFORE
 * `mountStaticSpa()` so shell plugins take precedence over the
 * default web bundle.
 */
export function mountShellSpa(
  app: Express,
  opts: {
    /** Lazy accessor — the registry isn't ready at boot time. */
    getRegistry: () => PluginRegistry;
  },
): void {
  const { getRegistry } = opts;

  // Cache resolved shell dist paths + express.static instances per
  // (tenantId, pluginId) to avoid re-resolving on every request.
  const staticCache = new Map<string, express.Handler>();

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    // Only intercept non-API, non-WS GET/HEAD requests.
    if (req.path.startsWith("/api/") || req.path === "/api") return next();
    if (req.path.startsWith("/ws")) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    // Extract tenantId and userId from URL.
    const match = TENANT_URL_RE.exec(req.path);
    if (!match) return next();
    const tenantId = match[1]!;
    const userId = match[2]!;

    // Look up the shell plugin for this tenant.
    let registry: PluginRegistry;
    try {
      registry = getRegistry();
    } catch {
      console.log(`[shell-spa] registry not ready`);
      return next(); // registry not ready yet
    }
    const shell = registry.uiShellForTenant(tenantId);
    if (!shell || !shell.manifest.uiShell) return next();

    const uiShell = shell.manifest.uiShell;

    // Dev mode proxy: if devServer.target is set and we're not in
    // production, proxy the request to the external dev server.
    if (
      uiShell.devServer?.target &&
      process.env.NODE_ENV !== "production"
    ) {
      try {
        const url = new URL(req.originalUrl, uiShell.devServer.target);
        const proxyRes = await fetch(url.toString(), {
          method: req.method,
          headers: req.headers as Record<string, string>,
        });
        res.status(proxyRes.status);
        for (const [k, v] of proxyRes.headers.entries()) {
          if (k.toLowerCase() !== "transfer-encoding") {
            res.setHeader(k, v);
          }
        }
        const body = await proxyRes.arrayBuffer();
        res.send(Buffer.from(body));
        return;
      } catch (err) {
        // Dev server not running — fall through to dist/ or default.
        console.warn(
          `[tianshu] shell plugin ${shell.manifest.id} devServer proxy failed:`,
          err instanceof Error ? err.message : String(err),
        );
        return next();
      }
    }

    // Resolve shell dist directory. Priority:
    //   1. Tenant-specific: <tenantSharedDir>/shell/  (agent writes here)
    //   2. Plugin default:  <pluginDir>/<uiShell.dist> (placeholder)
    const path = await import("node:path");
    const fs = await import("node:fs");

    // Check for shell content in priority order:
    //   1. User home:    <userHome>/_tenant/shell/  (write_file default)
    //   2. Tenant shared: <tenantShared>/shell/
    //   3. Plugin dist:   <pluginDir>/<uiShell.dist>  (placeholder)
    const userShellDir = path.join(getUserHomeDir(tenantId, userId), "_tenant", "shell");
    const tenantShellDir = path.join(getTenantSharedDir(tenantId), "shell");
    const pluginDistDir = path.resolve(shell.dir, uiShell.dist);

    // Pick whichever has an index.html
    let distDir: string;
    if (fs.existsSync(path.join(userShellDir, "index.html"))) {
      distDir = userShellDir;
    } else if (fs.existsSync(path.join(tenantShellDir, "index.html"))) {
      distDir = tenantShellDir;
    } else if (fs.existsSync(path.join(pluginDistDir, "index.html"))) {
      distDir = pluginDistDir;
    } else {
      // Neither has content — fall through to default SPA.
      return next();
    }
    const indexPath = path.join(distDir, "index.html");

    // Get or create a cached express.static handler for this dist.
    const cacheKey = `${tenantId}:${shell.manifest.id}`;
    if (!staticCache.has(cacheKey)) {
      staticCache.set(
        cacheKey,
        express.static(distDir, { index: false, fallthrough: true }),
      );
    }

    // Try serving the exact file first.
    const staticHandler = staticCache.get(cacheKey)!;
    staticHandler(req, res, () => {
      // File not found in dist/ — SPA fallback?
      if (uiShell.fallbackSpa !== false) {
        // Serve index.html for SPA routing.
        const indexBuf = fs.readFileSync(indexPath);
        res.type("html").send(indexBuf);
      } else {
        // Not a SPA; the file genuinely doesn't exist.
        next();
      }
    });
  });
}
