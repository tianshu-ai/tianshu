// Session health check.
//
// Detects active sessions with excessive message counts that will
// blow past any model's context window. Reports them as warnings
// with enough detail for the setup agent to offer a fix (fork +
// LLM-summarise).

import type { CheckGroup, CheckLine } from "../render.js";
import { GlobalOps } from "../../core/global-ops.js";
import { getTenantsRoot, getTianshuHome } from "../../core/paths.js";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** Sessions with more messages than this trigger a warning. */
const OVERSIZED_THRESHOLD = 2000;

export interface SessionCheckOpts {
  home?: string;
  /** Override the message-count threshold (for tests). */
  threshold?: number;
}

interface OversizedSession {
  tenantId: string;
  sessionId: string;
  userId: string;
  messageCount: number;
  oldestMessage: number; // epoch ms
  newestMessage: number; // epoch ms
}

export function checkSessions(opts: SessionCheckOpts = {}): CheckGroup {
  const home = opts.home ?? getTianshuHome();
  const threshold = opts.threshold ?? OVERSIZED_THRESHOLD;
  const lines: CheckLine[] = [];
  const oversized: OversizedSession[] = [];

  const tenantsRoot = getTenantsRoot(home);
  if (!fs.existsSync(tenantsRoot)) {
    lines.push({ severity: "ok", text: "no tenants yet" });
    return { title: "Session Health", lines, oversized } as any;
  }

  let ops: GlobalOps;
  try {
    ops = new GlobalOps({ home });
  } catch {
    lines.push({ severity: "warning", text: "could not open GlobalOps" });
    return { title: "Session Health", lines, oversized } as any;
  }

  const ids = ops.list();
  for (const tenantId of ids) {
    const dbPath = path.join(tenantsRoot, tenantId, "db.sqlite");
    if (!fs.existsSync(dbPath)) continue;

    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      continue;
    }

    try {
      const rows = db
        .prepare<
          [number],
          {
            id: string;
            user_id: string;
            cnt: number;
            oldest: number;
            newest: number;
          }
        >(
          `SELECT s.id, s.user_id,
                  COUNT(m.id) AS cnt,
                  MIN(m.created_at) AS oldest,
                  MAX(m.created_at) AS newest
           FROM sessions s
           JOIN messages m ON m.session_id = s.id
           WHERE s.status = 'active' AND s.kind = 'user'
           GROUP BY s.id
           HAVING cnt > ?
           ORDER BY cnt DESC`,
        )
        .all(threshold);

      for (const r of rows) {
        oversized.push({
          tenantId,
          sessionId: r.id,
          userId: r.user_id,
          messageCount: r.cnt,
          oldestMessage: r.oldest,
          newestMessage: r.newest,
        });
        lines.push({
          severity: "warning",
          text: `tenant ${tenantId}: session ${r.id.slice(0, 20)}… has ${r.cnt} messages (threshold: ${threshold})`,
          detail: `user=${r.user_id} — may cause context-window overflows. Use /compact or the session-compact tool to fork and summarise.`,
        });
      }
    } finally {
      db.close();
    }
  }

  if (lines.length === 0) {
    lines.push({
      severity: "ok",
      text: "all active sessions are within healthy message counts",
    });
  }

  // Attach oversized list for programmatic consumers (setup agent tool).
  const group: CheckGroup & { oversized?: OversizedSession[] } = {
    title: "Session Health",
    lines,
  };
  if (oversized.length > 0) group.oversized = oversized;
  return group;
}
