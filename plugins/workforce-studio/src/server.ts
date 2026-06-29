// Workforce Studio — server entry.
//
// Phase 1: read-only inspect + export. The studio reads the
// host's `host.workforceSnapshot` capability to build a complete
// picture of the tenant's agent configuration, then either
// returns it as JSON (admin page render) or streams it as a zip
// download (bundle export).
//
// Editing surfaces (worker create/delete/edit, main-agent prompt
// override, zip import, templates) land in later phases. The
// admin page UI is deliberately read-only here so we can ship
// Phase 1 fast and let Yu sanity-check the snapshot shape before
// we expose mutations.

import type { Request, Response } from "express";
import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  WorkforceSnapshot,
  WorkforceSnapshotCapability,
} from "@tianshu-ai/plugin-sdk";
import { buildZipBytes } from "./zip-builder.js";

function userIdFromReq(req: Request): string | null {
  const id = (req as Request & { ctx?: { userId?: string } }).ctx?.userId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const snapshotCap = ctx.capabilities.get<WorkforceSnapshotCapability>(
      "host.workforceSnapshot",
    );
    if (!snapshotCap) {
      // The host is too old / mis-wired. Fail activation loudly
      // so the plugin manager surfaces it rather than silently
      // returning 500 from every route.
      throw new Error(
        "workforce-studio requires host.workforceSnapshot capability; the host is too old or misconfigured.",
      );
    }

    return {
      routes: {
        // GET /snapshot → { ok, snapshot }
        getSnapshot: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          try {
            const snapshot = snapshotCap.build(userId);
            res.json({ ok: true, snapshot });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log.warn(
              `[workforce-studio] getSnapshot failed for ${userId}: ${msg}`,
            );
            res.status(500).json({ ok: false, error: msg });
          }
        },
        // GET /snapshot/zip → application/zip
        // We pick the filename so curl/Save-As look reasonable;
        // tenantId + ISO date make the file self-identifying.
        downloadZip: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          let snapshot: WorkforceSnapshot;
          try {
            snapshot = snapshotCap.build(userId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log.warn(
              `[workforce-studio] zip snapshot build failed for ${userId}: ${msg}`,
            );
            res.status(500).json({ ok: false, error: msg });
            return;
          }
          const zipBytes = buildZipBytes(snapshot);
          const filename = makeFilename(snapshot);
          res.setHeader("Content-Type", "application/zip");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${filename}"`,
          );
          res.setHeader("Content-Length", String(zipBytes.length));
          res.end(zipBytes);
        },
      },
    };
  },
};

function makeFilename(snapshot: WorkforceSnapshot): string {
  const date = new Date(snapshot.generatedAt)
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-");
  // Keep tenantId in the name so multi-tenant operators get
  // unambiguous archives when they download from several panels.
  return `workforce-${snapshot.tenantId}-${date}.zip`;
}

export default plugin;
// Named export so the host's plugin loader can pick either shape.
export { plugin };
