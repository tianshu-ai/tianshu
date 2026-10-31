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
  SolutionsCapability,
  SolutionSpecInput,
  WorkforceSnapshot,
  WorkforceSnapshotCapability,
  ExperienceHarvesterCapability,
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
    const solutionsCap = ctx.capabilities.get<SolutionsCapability>(
      "host.solutions",
    );
    if (!solutionsCap) {
      throw new Error(
        "workforce-studio requires host.solutions capability; the host is too old or misconfigured.",
      );
    }
    const harvesterCap = ctx.capabilities.get<ExperienceHarvesterCapability>(
      "host.experienceHarvester",
    );
    if (!harvesterCap) {
      throw new Error(
        "workforce-studio requires host.experienceHarvester capability; the host is too old or misconfigured.",
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
        // ── Solutions (ADR-0008 Phase 2) ──────────────────────
        // GET /solutions → { ok, solutions }
        listSolutions: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          try {
            res.json({ ok: true, solutions: solutionsCap.list(userId) });
          } catch (err) {
            sendError(ctx, res, err, "listSolutions", userId);
          }
        },
        // GET /solutions/:slug → { ok, solution }
        getSolution: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          const slug = String(req.params.slug ?? "");
          try {
            const detail = solutionsCap.get(userId, slug);
            if (!detail) {
              res.status(404).json({ ok: false, error: "not found" });
              return;
            }
            res.json({ ok: true, solution: detail });
          } catch (err) {
            sendError(ctx, res, err, "getSolution", userId);
          }
        },
        // POST /solutions/extract { slug, name?, description? }
        extractSolution: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          const body = (req.body ?? {}) as {
            slug?: string;
            name?: string;
            description?: string;
          };
          if (!body.slug) {
            res.status(400).json({ ok: false, error: "slug required" });
            return;
          }
          try {
            const detail = solutionsCap.extract(userId, {
              slug: body.slug,
              name: body.name,
              description: body.description,
            });
            res.json({ ok: true, solution: detail });
          } catch (err) {
            sendError(ctx, res, err, "extractSolution", userId);
          }
        },
        // POST /solutions/save  { ...SolutionSpecInput }
        saveSolution: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          const input = req.body as SolutionSpecInput;
          if (!input || !input.slug) {
            res.status(400).json({ ok: false, error: "slug required" });
            return;
          }
          try {
            const detail = solutionsCap.save(userId, input);
            res.json({ ok: true, solution: detail });
          } catch (err) {
            sendError(ctx, res, err, "saveSolution", userId);
          }
        },
        // DELETE /solutions/:slug → { ok }
        deleteSolution: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          const slug = String(req.params.slug ?? "");
          try {
            solutionsCap.remove(userId, slug);
            res.json({ ok: true });
          } catch (err) {
            sendError(ctx, res, err, "deleteSolution", userId);
          }
        },
        // GET /solutions/:slug/diff?against=reality|<slug>
        diffSolution: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          const slug = String(req.params.slug ?? "");
          const against = String(req.query.against ?? "reality");
          try {
            const diff = solutionsCap.diff(userId, { slug, against });
            res.json({ ok: true, diff });
          } catch (err) {
            sendError(ctx, res, err, "diffSolution", userId);
          }
        },
        // POST /solutions/:slug/apply → { ok, appliedWorkers }
        applySolution: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          const slug = String(req.params.slug ?? "");
          try {
            const result = await solutionsCap.apply(userId, slug);
            res.json(result);
          } catch (err) {
            sendError(ctx, res, err, "applySolution", userId);
          }
        },
        // POST /solutions/:slug/activate → apply + mark active
        activateSolution: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          const slug = String(req.params.slug ?? "");
          try {
            const result = await solutionsCap.activate(userId, slug);
            res.json(result);
          } catch (err) {
            sendError(ctx, res, err, "activateSolution", userId);
          }
        },
        // GET /solutions-active → { ok, activeSlug }
        getActive: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) {
            res.status(401).json({ ok: false, error: "no user context" });
            return;
          }
          try {
            res.json({ ok: true, activeSlug: solutionsCap.getActive(userId) });
          } catch (err) {
            sendError(ctx, res, err, "getActive", userId);
          }
        },
        exportSolution: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          const slug = String(req.params.slug);
          if (!slug) { res.status(400).json({ ok: false, error: "slug required" }); return; }
          try {
            const envelope = solutionsCap.export(userId, slug);
            res.setHeader("Content-Disposition", `attachment; filename="${slug}.solution.json"`);
            res.setHeader("Content-Type", "application/json");
            res.send(JSON.stringify(envelope, null, 2));
          } catch (err) {
            sendError(ctx, res, err, "exportSolution", userId);
          }
        },
        importSolution: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          const envelope = req.body as Record<string, unknown>;
          if (!envelope || !envelope.spec) { res.status(400).json({ ok: false, error: "invalid import body" }); return; }
          try {
            const detail = solutionsCap.import(userId, envelope);
            res.json({ ok: true, solution: detail });
          } catch (err) {
            sendError(ctx, res, err, "importSolution", userId);
          }
        },

        // ── Harness² routes ───────────────────────────────────────

        harnessStatus: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          try {
            const status = harvesterCap.getStatus(userId);
            res.json({ ok: true, ...status });
          } catch (err) { sendError(ctx, res, err, "harnessStatus", userId); }
        },

        harnessOrganise: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          const { fresh = false } = (req.body ?? {}) as { fresh?: boolean };
          try {
            const result = await harvesterCap.organise(userId, { fresh });
            res.json(result);
          } catch (err) { sendError(ctx, res, err, "harnessOrganise", userId); }
        },

        harnessAnalyse: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          // Analyse is heavy — delegates to the host's runPrompt.
          // For now, proxy to the legacy /api/experience/analyse route.
          // Full migration of the analyse prompt into the plugin is Phase 2.
          try {
            const proxyRes = await fetch(`http://localhost:${(req as any).socket?.localPort || 12008}/api/experience/analyse`, {
              method: "POST",
              headers: { "Content-Type": "application/json", cookie: req.headers.cookie || "" },
              body: JSON.stringify(req.body),
            });
            const body = await proxyRes.json();
            res.json(body);
          } catch (err) { sendError(ctx, res, err, "harnessAnalyse", userId); }
        },

        harnessListEvents: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          try {
            res.json({ ok: true, events: harvesterCap.listEvents(userId) });
          } catch (err) { sendError(ctx, res, err, "harnessListEvents", userId); }
        },

        harnessReadEvent: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          const file = req.params.file as string;
          try {
            const content = harvesterCap.readFile(userId, "events", file);
            if (content === null) { res.status(404).json({ ok: false, error: "not found" }); return; }
            res.json({ ok: true, content });
          } catch (err) { sendError(ctx, res, err, "harnessReadEvent", userId); }
        },

        harnessListInsights: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          try {
            res.json({ ok: true, insights: harvesterCap.listInsights(userId) });
          } catch (err) { sendError(ctx, res, err, "harnessListInsights", userId); }
        },

        harnessReadInsight: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          const file = req.params.file as string;
          try {
            const content = harvesterCap.readFile(userId, "insights", file);
            if (content === null) { res.status(404).json({ ok: false, error: "not found" }); return; }
            res.json({ ok: true, content });
          } catch (err) { sendError(ctx, res, err, "harnessReadInsight", userId); }
        },

        harnessHistory: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          try {
            const history = await harvesterCap.getHistory(userId);
            res.json({ ok: true, history });
          } catch (err) { sendError(ctx, res, err, "harnessHistory", userId); }
        },

        harnessRollback: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          const { oid } = (req.body ?? {}) as { oid?: string };
          if (!oid) { res.status(400).json({ ok: false, error: "oid required" }); return; }
          try {
            const result = await harvesterCap.rollback(userId, oid);
            res.json(result);
          } catch (err) { sendError(ctx, res, err, "harnessRollback", userId); }
        },

        harnessComponents: async (req: Request, res: Response) => {
          const userId = userIdFromReq(req);
          if (!userId) { res.status(401).json({ ok: false, error: "no user context" }); return; }
          try {
            const snapshot = snapshotCap.build(userId);
            // Components are derived client-side from snapshot;
            // return the snapshot and let the client extract.
            res.json({ ok: true, snapshot });
          } catch (err) { sendError(ctx, res, err, "harnessComponents", userId); }
        },
      },
    };
  },
};

function sendError(
  ctx: PluginContext,
  res: Response,
  err: unknown,
  op: string,
  userId: string,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  ctx.log.warn(`[workforce-studio] ${op} failed for ${userId}: ${msg}`);
  res.status(500).json({ ok: false, error: msg });
}

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
