// OpenShell admin API routes (mounted at /api/p/openshell/*).
//
// Two read-only endpoints backing the Policy admin page:
//   GET /api/p/openshell/policy/denials?minutes=N&last=M
//       → recent network denials from the sandbox policy log,
//         parsed + filtered to the last N minutes.
//   GET /api/p/openshell/policy/allowed
//       → the current effective policy (allow-list) for the sandbox.
//
// Both bridge into the per-tenant sandbox via the runner (the policy
// API + `policy get` are gateway/sandbox-scoped, not reachable from
// the host directly). Handlers are intentionally thin: parse query,
// call the runner, shape JSON, map errors to a 502 with the message
// so the UI can show what went wrong instead of a blank panel.

import type { PluginRouteHandler } from "@tianshu-ai/plugin-sdk";
import type { OpenShellRunner } from "./runner/openshell-runner.js";

export function buildPolicyRoutes(
  runner: OpenShellRunner,
): Record<string, PluginRouteHandler> {
  const listDenials: PluginRouteHandler = async (req, res) => {
    try {
      const minutes = clampInt(req.query.minutes, 60, 1, 10_080);
      const last = clampInt(req.query.last, 200, 1, 1000);
      const result = await runner.listDenials({ minutes, last });
      res.json({
        minutes,
        denials: result.denials,
        logAvailable: result.logAvailable,
      });
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  const listAllowed: PluginRouteHandler = async (_req, res) => {
    try {
      const { raw } = await runner.getPolicy();
      // Try to parse as JSON; if the CLI printed text, hand back the
      // raw string so the UI can render it verbatim.
      let policy: unknown = null;
      try {
        policy = JSON.parse(raw);
      } catch {
        policy = null;
      }
      res.json({ policy, raw });
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    listDenials,
    listAllowed,
  };
}

function clampInt(
  v: unknown,
  dflt: number,
  min: number,
  max: number,
): number {
  const n =
    typeof v === "string"
      ? Number.parseInt(v, 10)
      : typeof v === "number"
        ? v
        : NaN;
  if (Number.isNaN(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}
