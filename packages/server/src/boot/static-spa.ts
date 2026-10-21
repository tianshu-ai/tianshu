// Optional in-process static SPA hosting.
//
// Two deployment modes:
//
//   Dev (`npm run dev` from a checkout): vite hosts the web on its
//   own port (5183 by default). TIANSHU_WEB_DIST is unset, this
//   module is a no-op.
//
//   Production / global install: the wizard's launchd plist sets
//   TIANSHU_WEB_DIST to the bundled web dist directory and the
//   server hosts the static files itself \u2014 the user only needs
//   one port (3110) instead of two processes.
//
// Mount AFTER every `/api/*` and `/ws` handler so the SPA fallback
// catch-all only fires for non-API requests. The fallback (any
// unknown path \u2192 index.html) is what makes
// `/tenants/foo/users/bar/` work without a real route on the
// filesystem.
//
// Why we read index.html into a buffer rather than using
// `res.sendFile()`: under Express 5 + Node 22+'s send module,
// sendFile() with an absolute path consistently 404'd on our setup
// even though `existsSync(file)` returned true. We don't fully
// understand the resolution path send takes; bypassing it with a
// direct buffer write is simple and works the same on every Node
// version we test.

import type { Express } from "express";
import express from "express";

import { createLogger } from "../setup/logger.js";

const log = createLogger("static-spa");


/**
 * Mount the static web dist + SPA fallback when configured. Returns
 * true if hosting was activated, false in dev mode / on failure (so
 * the caller can log appropriately).
 */
export async function mountStaticSpa(app: Express): Promise<boolean> {
  const webDistRaw = process.env.TIANSHU_WEB_DIST;
  if (!webDistRaw || webDistRaw.length === 0) return false;

  try {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const webDist = path.resolve(webDistRaw);
    if (!fs.existsSync(path.join(webDist, "index.html"))) {
      // eslint-disable-next-line no-console
      log.warn(
        `[tianshu] TIANSHU_WEB_DIST=${webDist} but no index.html there; ` +
          "skipping static UI mount.",
      );
      return false;
    }
    // Two-layer handler:
    //   1. express.static handles `/index.html`, `/assets/*`, etc.
    //      fallthrough: true so requests it doesn't recognise
    //      cascade to the next middleware.
    //   2. SPA fallback: any GET request that wasn't /api or /ws
    //      and wasn't a static asset \u2192 serve the pre-read
    //      index.html bytes. The React router on the client decides
    //      what to render.
    app.use(express.static(webDist, {
      index: false,
      fallthrough: true,
      // Vite-built assets have content hashes in filenames — safe
      // to cache aggressively. Non-hashed files (rare) still get
      // revalidated via ETag.
      maxAge: "1y",
      immutable: true,
    }));
    const indexHtml = fs.readFileSync(path.join(webDist, "index.html"));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      if (req.path === "/api") return next();
      if (req.path.startsWith("/ws")) return next();
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      // Don't serve index.html for asset requests — stale hashes
      // from a previous build should 404, not return HTML.
      if (req.path.startsWith("/assets/")) return next();
      // Anything else \u2014 /, /tenants/x/users/y/, /admin/foo \u2014 gets
      // index.html. The SPA's router handles it.
      res.set("Cache-Control", "no-cache, no-store, must-revalidate").type("html").send(indexHtml);
    });
    // eslint-disable-next-line no-console
    log.info(`serving web UI from ${webDist}`);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    log.warn(
      `[tianshu] failed to mount static web dist: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Whether this process is the one hosting the SPA. Cheap probe,
 *  same check `mountStaticSpa` uses internally; callers that need
 *  to publish the URL out-of-band consult this. */
export function isSpaHosted(): boolean {
  return Boolean(
    process.env.TIANSHU_WEB_DIST && process.env.TIANSHU_WEB_DIST.length > 0,
  );
}
