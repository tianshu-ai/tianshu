// Tenant DB readiness check.
//
// We open each tenant's sqlite file briefly. If the file doesn't
// exist yet (fresh setup), that's fine — it'll be created on
// first server boot. If it exists but won't open, that's a
// blocker.

import fs from "node:fs";
import path from "node:path";
import { CheckGroup } from "../render.js";
import { GlobalOps } from "../../core/global-ops.js";
import { getTenantsRoot, getTianshuHome } from "../../core/paths.js";

export interface DbCheckOpts {
  home?: string;
}

export function checkDb(opts: DbCheckOpts = {}): CheckGroup {
  const home = opts.home ?? getTianshuHome();
  const lines: CheckGroup["lines"] = [];

  const tenantsRoot = getTenantsRoot(home);
  if (!fs.existsSync(tenantsRoot)) {
    lines.push({
      severity: "ok",
      text: "no tenants yet (will be created on first start)",
      detail: tenantsRoot,
    });
    return { title: "Tenant DBs", lines };
  }

  let ops: GlobalOps;
  try {
    ops = new GlobalOps({ home });
  } catch (err) {
    lines.push({
      severity: "blocker",
      text: "GlobalOps failed to initialise",
      detail: err instanceof Error ? err.message : String(err),
    });
    return { title: "Tenant DBs", lines };
  }

  try {
    const ids = ops.list();
    if (ids.length === 0) {
      lines.push({
        severity: "ok",
        text: "no active tenants",
        detail: "default will be auto-created on first server start.",
      });
    }
    for (const id of ids) {
      const dbPath = path.join(tenantsRoot, id, "db.sqlite");
      if (!fs.existsSync(dbPath)) {
        lines.push({
          severity: "warning",
          text: `${id}: db.sqlite missing`,
          detail: dbPath,
        });
        continue;
      }
      // Touch the DB by opening + listing tables. GlobalOps already
      // validates the schema migrations on open via .open(); we
      // surface a single ok / blocker line per tenant.
      try {
        ops.open(id);
        lines.push({
          severity: "ok",
          text: `${id}`,
          detail: dbPath,
        });
      } catch (err) {
        lines.push({
          severity: "blocker",
          text: `${id}: failed to open`,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    ops.closePool();
  }

  return { title: "Tenant DBs", lines };
}
