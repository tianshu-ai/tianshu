// Tenant-aware UI shell routing (ADR-0005).
//
// When a tenant enables a plugin with `uiShell`, all non-API browser
// requests for that tenant are served from the plugin's dist directory
// instead of the default @tianshu/web bundle. This middleware must be
// mounted BEFORE the default SPA fallback (static-spa.ts).
//
// Routing logic:
//
//   GET /shell/tenants/:tenantId/...  — custom shell UI
//   GET /tenants/:tenantId/...         — native UI (untouched)
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
import { getTenantSharedDir } from "../core/paths.js";

// Shell UI lives under /shell/tenants/:tenantId/... so it doesn't
// hijack the native UI at /tenants/:tenantId/...
const SHELL_URL_RE = /^\/shell\/tenants\/([^/]+)\//;

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

    // Extract tenantId from URL.
    const match = SHELL_URL_RE.exec(req.path);
    if (!match) return next();
    const tenantId = match[1]!;

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
    //   1. Tenant shared: <tenantShared>/shell/  (published UI)
    //   2. Plugin dist:   <pluginDir>/<uiShell.dist>  (placeholder)
    // Agent writes drafts to user home _tenant/shell/; the panel
    // "Publish" action copies them here.
    const tenantShellDir = path.join(getTenantSharedDir(tenantId), "shell");
    const pluginDistDir = path.resolve(shell.dir, uiShell.dist);

    // Pick whichever has an index.html
    let distDir: string;
    if (fs.existsSync(path.join(tenantShellDir, "index.html"))) {
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
        // Serve index.html for SPA routing, with injected session config.
        let html = fs.readFileSync(indexPath, "utf8");
        // Inject a global config object so the shell UI knows its
        // identity and dedicated session id without extra API calls.
        const userMatch = req.path.match(/\/users\/([^/]+)/);
        const pageUserId = userMatch?.[1] ?? "unknown";
        const shellSessionId = `shell_${tenantId}_${pageUserId}`;
        // Auto-create the dedicated shell session if it doesn't exist.
        // This runs on every index.html serve but the INSERT OR IGNORE
        // makes it idempotent.
        try {
          const entries = registry.listForTenant(tenantId);
          const shellEntry = entries.find(e => e.manifest.id === shell.manifest.id && e.ctx);
          if (shellEntry?.ctx) {
            shellEntry.ctx.db.prepare(
              `INSERT OR IGNORE INTO sessions (id, user_id, status, kind, created_at, title, channel_id)
               VALUES (?, ?, 'active', 'user', ?, 'Custom Shell', 'custom-ui')`,
            ).run(shellSessionId, pageUserId, Date.now());
          }
        } catch { /* best-effort; the /session API is the fallback */ }
        const configScript = `<script>window.__TIANSHU_SHELL__=${JSON.stringify({
          tenantId,
          userId: req.path.match(/\/users\/([^/]+)/)?.[1] ?? null,
          sessionId: shellSessionId,
          pluginId: shell.manifest.id,
        })};</script>`;
        // Inject before </head> or at the start of <body>
        if (html.includes("</head>")) {
          html = html.replace("</head>", configScript + "</head>");
        } else {
          html = configScript + html;
        }
        res.type("html").send(html);
      } else {
        // Not a SPA; the file genuinely doesn't exist.
        next();
      }
    });
  });
}
