// Per-tenant tool-result audit, surfaced in the System Doctor panel.
//
// Unlike the agent tool (`audit_tool_results`), which inspects ONE
// tenant on request, this route summarises every tenant on disk so
// the panel can show a one-line health figure per tenant and the
// operator can drill into the one that looks wrong.
//
// Counts only. The full finding list stays behind the agent tool —
// the panel does not need to serialise hundreds of rows, and the
// repair path must stay a deliberate, one-row-at-a-time action.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Request, Response } from "express";
import type { PluginContext } from "@tianshu-ai/plugin-sdk";
import { scanToolResults } from "./tool-result-audit.js";
import { sweepOversizedReads, type OversizedResult } from "./recent-sweep.js";

export interface TenantAuditSummary {
  tenantId: string;
  /** Rows that stalled a turn — the ones worth repairing. */
  stalled: number;
  /** Rows that were corrupt but recovered (shown on request only). */
  recovered: number;
  /** Rows that were corrupt but the conversation carried on. */
  continued: number;
  /** Suspicious tool results sitting in RECENT turns of live
   *  sessions. This is the proactive signal: such a row is about to
   *  be replayed into the next turn's context, whether or not the
   *  previous turn happened to survive it. */
  recentSuspicious: number;
  /** How many sessions / tool results the recent sweep covered. */
  recentScanned?: { sessions: number; results: number; turns: number };
  /** Up to a handful of the most recent offenders, so the panel can
   *  show what was found without a second request. */
  recent?: OversizedResult[];
  /** Results that are merely long, with no decoding fault. Not
   *  suspicious — shown so the panel can distinguish "a lot of long
   *  log reads" from "corrupted output". */
  oversizedAdvisory?: number;
  /** Present when the tenant could not be scanned. */
  error?: string;
}

function tenantsRoot(): string {
  const base =
    process.env.TIANSHU_HOME?.trim() || path.join(os.homedir(), ".tianshu");
  return path.join(base, "tenants");
}

/** Tenant directories that actually have a database. */
function listTenants(): string[] {
  const root = tenantsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => fs.existsSync(path.join(root, id, "db.sqlite")))
    .sort();
}

/**
 * Summarise one tenant. `deep` includes recovered/continued counts;
 * the cheap path stops once stalled is known.
 */
export function summariseTenant(
  tenantId: string,
  opts: { deep?: boolean; recentTurns?: number } = {},
): TenantAuditSummary {
  const dbPath = path.join(tenantsRoot(), tenantId, "db.sqlite");
  try {
    const findings = scanToolResults({
      dbPath,
      includeRecovered: true,
      limit: 5000,
    });
    let stalled = 0;
    let recovered = 0;
    let continued = 0;
    for (const f of findings) {
      if (f.impact === "stalled") stalled++;
      else if (f.impact === "recovered") recovered++;
      else continued++;
    }

    // Proactive sweep over the most recent turns of every session.
    // One rule only: read_file results that exceed the character cap.
    let recentSuspicious = 0;
    let recentScanned:
      | { sessions: number; results: number; turns: number }
      | undefined;
    let recent: OversizedResult[] | undefined;
    let oversizedAdvisory: number | undefined;
    try {
      const sweep = sweepOversizedReads({
        dbPath,
        recentTurns: opts.recentTurns ?? 10,
        limit: 200,
      });
      recentSuspicious = sweep.findings.length;
      recentScanned = sweep.scanned;
      recent = sweep.findings.slice(0, 5);
      oversizedAdvisory = sweep.findings.length;
    } catch {
      // A sweep failure must not hide the historical counts.
    }

    return {
      tenantId,
      stalled,
      recovered,
      continued,
      recentSuspicious,
      recentScanned,
      recent,
      oversizedAdvisory,
    };
  } catch (err) {
    return {
      tenantId,
      stalled: 0,
      recovered: 0,
      continued: 0,
      recentSuspicious: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build the Express handlers this plugin exposes. */
export function auditRoutes(_ctx: PluginContext) {
  const listTenantsHandler = (_req: Request, res: Response) => {
    try {
      res.json({ tenants: listTenants() });
    } catch (err) {
      res.status(500).json({
        error: "list_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** GET /audit?tenant=<id>|all&deep=1 */
  const auditHandler = (req: Request, res: Response) => {
    try {
      const requested =
        typeof req.query.tenant === "string" ? req.query.tenant.trim() : "all";
      const deep = req.query.deep === "1" || req.query.deep === "true";

      const ids =
        requested === "all" || requested === ""
          ? listTenants()
          : [requested];

      if (requested !== "all" && requested !== "" && ids.length === 1) {
        const p = path.join(tenantsRoot(), requested, "db.sqlite");
        if (!fs.existsSync(p)) {
          res.status(404).json({
            error: "tenant_not_found",
            message: `no database for tenant "${requested}"`,
            known: listTenants(),
          });
          return;
        }
      }

      const summaries = ids.map((id) => summariseTenant(id, { deep }));
      res.json({
        tenants: summaries,
        totalStalled: summaries.reduce((n, s) => n + s.stalled, 0),
      });
    } catch (err) {
      res.status(500).json({
        error: "audit_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { listTenantsHandler, auditHandler };
}