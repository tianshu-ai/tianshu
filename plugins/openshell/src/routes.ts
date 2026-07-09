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
      const { policy, raw } = await runner.getPolicy();
      res.json({ policy, raw });
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  // POST /policy/allow — manually allow a denied endpoint. Body:
  //   { host: string, port: number, protocol?: "http"|"https"|"tcp",
  //     binary?: string }
  // Reuses the runner's allowEgress via allowDenial (fills default
  // opencode binaries). Returns { ok: true } on success.
  const allowDenied: PluginRouteHandler = async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        host?: unknown;
        port?: unknown;
        protocol?: unknown;
        binary?: unknown;
      };
      const host = typeof body.host === "string" ? body.host.trim() : "";
      const port =
        typeof body.port === "number"
          ? body.port
          : typeof body.port === "string"
            ? Number.parseInt(body.port, 10)
            : NaN;
      if (!host || Number.isNaN(port) || port < 1 || port > 65535) {
        res.status(400).json({ error: "host and a valid port are required" });
        return;
      }
      const protocol =
        body.protocol === "http" ||
        body.protocol === "https" ||
        body.protocol === "tcp"
          ? body.protocol
          : undefined;
      const binary = typeof body.binary === "string" ? body.binary : undefined;
      await runner.allowDenial({ host, port, protocol, binary });
      res.json({ ok: true, host, port });
    } catch (err) {
      res
        .status(502)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    listDenials,
    listAllowed,
    allowDenied,
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
