// Agent tool: find and repair tool results that stalled a user's turn.
//
// Deliberately a two-step, human-in-the-loop tool:
//
//   audit_tool_results { action: "scan" }
//       → read-only list. Nothing is modified. Findings are grouped
//         by whether they actually stalled a conversation.
//
//   audit_tool_results { action: "detail", messageId }
//       → show the full picture for ONE row (current text, proposed
//         replacement, where the backup will go) so the operator can
//         decide. Optionally writes a copy to the workspace for
//         inspection.
//
//   audit_tool_results { action: "fix", messageId }
//       → repair exactly ONE row. Rejects arrays.
//
//   audit_tool_results { action: "restore", messageId, backupPath }
//       → undo a previous fix from its backup file.
//
// Scope: only `messages` rows holding a tool result. Session state,
// chat context and the files themselves are never touched — the
// point is to stop a bad stored result from poisoning future turns,
// not to rewrite history.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type {
  AgentTool,
  AgentToolContext,
  ToolResult,
} from "@tianshu-ai/plugin-sdk";
import {
  buildStub,
  fixToolResult,
  restoreToolResult,
  scanToolResults,
  type Finding,
} from "./tool-result-audit.js";

const ACTION = Type.Union([
  Type.Literal("scan"),
  Type.Literal("detail"),
  Type.Literal("fix"),
  Type.Literal("restore"),
]);

export function auditToolResultsSchema(): Tool {
  return {
    name: "audit_tool_results",
    description: `Find and repair stored tool results that stalled a conversation.

Start with action:"scan" — it is read-only and lists candidate rows together
with an "impact" verdict:
  - stalled   : no successful retry and no normal reply followed; the user was
                left with a dead turn. These are the ones worth repairing.
  - recovered : a later call to the same tool succeeded, so the user was not
                blocked. Usually nothing to do.
  - continued : the conversation carried on normally afterwards. Nothing to do.

Then, for ONE row at a time:
  - action:"detail", messageId → shows what the row holds now and what would
    replace it. Optionally drops a copy into your workspace for inspection.
  - action:"fix", messageId → replaces that row's text with a short stub that
    tells the model to re-read the file. The original is backed up first.
  - action:"restore", messageId, backupPath → undoes a previous fix.

\`fix\` takes exactly one messageId. It refuses lists on purpose: whether a
corrupted row actually hurt the user varies per row, and that is the
operator's call, not something to batch. Always show the scan results and let
the user choose which rows to repair.

Only the \`messages\` table is touched. Chat context, session state and the
underlying files are left alone.`,
    parameters: Type.Object({
      action: ACTION,
      /** Tenant whose database to inspect. Defaults to the one this
       *  agent runs in. */
      targetTenant: Type.Optional(
        Type.String({
          description:
            'Tenant id to inspect, e.g. "local" or "dn". Defaults to the current tenant.',
        }),
      ),
      messageId: Type.Optional(
        Type.String({ description: "Single message id (detail / fix / restore)." }),
      ),
      backupPath: Type.Optional(
        Type.String({ description: "Backup file returned by a previous fix." }),
      ),
      since: Type.Optional(
        Type.String({
          description: "Only rows created on/after this date, YYYY-MM-DD.",
        }),
      ),
      until: Type.Optional(
        Type.String({
          description: "Only rows created on/before this date, YYYY-MM-DD.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 1000, description: "Max findings (default 200)." }),
      ),
      includeRecovered: Type.Optional(
        Type.Boolean({
          description:
            "Also report rows that did not stall the user (default false).",
        }),
      ),
    }),
  };
}

// ── Path resolution ─────────────────────────────────────────────

/** Root that holds every tenant directory. Mirrors the host layout:
 *  `~/.tianshu/tenants/<id>/db.sqlite`. Honours TIANSHU_HOME . */
function tenantsRoot(): string {
  const base =
    process.env.TIANSHU_HOME?.trim() ||
    path.join(os.homedir(), ".tianshu");
  return path.join(base, "tenants");
}

function resolveTenantDb(tenantId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(tenantId)) {
    throw new Error(`invalid tenant id: ${tenantId}`);
  }
  const p = path.join(tenantsRoot(), tenantId, "db.sqlite");
  if (!fs.existsSync(p)) {
    const known = fs.existsSync(tenantsRoot())
      ? fs
          .readdirSync(tenantsRoot(), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];
    throw new Error(
      `no database for tenant "${tenantId}" at ${p}` +
        (known.length ? `. Known tenants: ${known.join(", ")}` : ""),
    );
  }
  return p;
}

function backupDirFor(dbPath: string): string {
  return path.join(path.dirname(dbPath), ".tool-result-backups");
}

function parseDay(raw: string | undefined, endOfDay: boolean): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`expected YYYY-MM-DD, got "${raw}"`);
  const [, y, mo, d] = m;
  // Local midnight; for `until` include the whole day.
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  if (endOfDay) dt.setHours(23, 59, 59, 999);
  return dt.getTime();
}

// ── Formatting ──────────────────────────────────────────────────

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

const IMPACT_MARK: Record<Finding["impact"], string> = {
  stalled: "🔴 stalled",
  recovered: "🟡 recovered",
  continued: "⚪ continued",
};

function formatScan(findings: Finding[], opts: { includeRecovered: boolean; total?: number }): string {
  if (findings.length === 0) {
    return (
      "No problematic tool results found.\n\n" +
      "Every stored read_file / tenant_config_read result either decodes " +
      "cleanly or was followed by a successful retry."
    );
  }

  const stalled = findings.filter((f) => f.impact === "stalled");
  const rest = findings.filter((f) => f.impact !== "stalled");

  const lines: string[] = [];
  lines.push(
    `Found ${findings.length} problematic tool result(s): ` +
      `${stalled.length} stalled a turn, ${rest.length} did not.`,
  );

  const render = (list: Finding[]) => {
    const rows = list.map((f, i) => {
      const size = f.size !== undefined ? `${f.size} B` : "?";
      const bad = (f.badRatio * 100).toFixed(0);
      const file = f.filePath ?? "(path unknown)";
      return (
        `| ${i + 1} | ${f.messageId} | ${f.sessionId} | ${file} | ` +
        `${size} → ${f.chars} chars (${bad}% bad) | ${f.problems.join(", ")} | ` +
        `${IMPACT_MARK[f.impact]} · ${f.impactReason} | ${fmtTime(f.createdAt)} |`
      );
    });
    return [
      "| # | messageId | session | file | size → chars | problems | impact | time |",
      "|---|---|---|---|---|---|---|---|",
      ...rows,
    ].join("\n");
  };

  if (stalled.length > 0) {
    lines.push("\n### Stalled turns — worth repairing\n");
    lines.push(render(stalled));
    lines.push(
      "\nPick the rows to repair, then run `detail` on one to preview the " +
        "change, and `fix` to apply it. One row per call.",
    );
  }

  if (rest.length > 0 && opts.includeRecovered) {
    lines.push("\n### Did not stall the user — usually leave these alone\n");
    lines.push(render(rest));
  } else if (rest.length > 0) {
    lines.push(
      `\n(${rest.length} more row(s) did not stall the user and are hidden. ` +
        `Pass includeRecovered:true to list them.)`,
    );
  }

  return lines.join("\n");
}

// ── Tool ────────────────────────────────────────────────────────

export const AuditToolResultsTool: AgentTool = {
  schema: auditToolResultsSchema(),
  execute: (args, ctx: AgentToolContext): ToolResult => {
    const action = String(args.action ?? "");
    const tenantId =
      typeof args.targetTenant === "string" && args.targetTenant.trim()
        ? args.targetTenant.trim()
        : ctx.tenantId;

    let dbPath: string;
    try {
      dbPath = resolveTenantDb(tenantId);
    } catch (err) {
      return {
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      };
    }

    if (action === "scan") {
      try {
        const findings = scanToolResults({
          dbPath,
          since: parseDay(
            typeof args.since === "string" ? args.since : undefined,
            false,
          ),
          until: parseDay(
            typeof args.until === "string" ? args.until : undefined,
            true,
          ),
          limit:
            typeof args.limit === "number" ? args.limit : undefined,
          includeRecovered: args.includeRecovered === true,
        });
        const text = formatScan(findings, {
          includeRecovered: args.includeRecovered === true,
        });
        ctx.log.info(
          `audit_tool_results scan tenant=${tenantId} found=${findings.length}`,
        );
        return {
          ok: true,
          text: `Tenant: ${tenantId}\n\n${text}`,
          data: { tenantId, findings },
        };
      } catch (err) {
        return {
          ok: false,
          text: `scan failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const messageId =
      typeof args.messageId === "string" ? args.messageId.trim() : "";
    if (!messageId) {
      return {
        ok: false,
        text: `action "${action}" requires messageId. Run action:"scan" first and pass one id from the table.`,
      };
    }

    if (action === "detail") {
      try {
        // A fresh scan restricted to one row would apply the impact
        // filter; instead read the row directly through scan with a
        // large window and pick it out. Simpler: re-scan including
        // recovered rows and filter in memory.
        const all = scanToolResults({
          dbPath,
          includeRecovered: true,
          limit: 5000,
        });
        const hit = all.find((f) => f.messageId === messageId);
        if (!hit) {
          return {
            ok: false,
            text:
              `No problematic tool result with id ${messageId}.\n` +
              `Either the id is wrong, or that row is fine. Run action:"scan" to list candidates.`,
          };
        }

        const stub = buildStub({
          toolName: hit.toolName,
          filePath: hit.filePath,
          size: hit.size,
        });
        // Drop the current text next to the agent's other scratch
        // files so it can be inspected without blowing the context.
        const previewDir = path.join(ctx.userHomeDir, "tmp");
        fs.mkdirSync(previewDir, { recursive: true });
        const previewPath = path.join(
          previewDir,
          `audit-${messageId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`,
        );
        const rows = new Database(dbPath, {
          readonly: true,
          fileMustExist: true,
        });
        let current = "";
        try {
          const raw = rows
            .prepare(
              `SELECT content FROM messages WHERE id = ?`,
            )
            .get(messageId) as { content?: string } | undefined;
          const parsed = raw?.content ? JSON.parse(raw.content) : null;
          const blocks = Array.isArray(parsed?.content) ? parsed.content : [];
          current = blocks
            .map((b: { text?: string }) => (typeof b.text === "string" ? b.text : ""))
            .join("");
        } finally {
          rows.close();
        }
        fs.writeFileSync(previewPath, current, "utf8");

        const backupDir = backupDirFor(dbPath);
        return {
          ok: true,
          text: [
            `Message: ${hit.messageId}`,
            `Tenant:  ${tenantId}`,
            `Session: ${hit.sessionId}`,
            `Tool:    ${hit.toolName}`,
            `File:    ${hit.filePath ?? "(path unknown)"}`,
            `Stored:  ${hit.chars} chars` +
              (hit.size !== undefined ? ` from ${hit.size} bytes` : "") +
              ` · ${(hit.badRatio * 100).toFixed(1)}% replacement chars`,
            `Problems: ${hit.problems.join(", ")}`,
            `Impact:  ${IMPACT_MARK[hit.impact]} — ${hit.impactReason}`,
            "",
            `Current text written to: ${previewPath}`,
            "",
            "Proposed replacement (what the model will see instead):",
            "---",
            stub,
            "---",
            "",
            `Backup will be written to: ${backupDir}/`,
            "",
            `To apply: action:"fix", messageId:"${hit.messageId}"`,
            "To leave it alone: do nothing.",
          ].join("\n"),
          data: { finding: hit, stub, previewPath, backupDir },
        };
      } catch (err) {
        return {
          ok: false,
          text: `detail failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (action === "fix") {
      try {
        const result = fixToolResult({
          dbPath,
          messageId,
          backupDir: backupDirFor(dbPath),
        });
        ctx.log.info(
          `audit_tool_results fix tenant=${tenantId} id=${messageId} ` +
            `${result.beforeChars} → ${result.afterChars} chars`,
        );
        return {
          ok: true,
          text: [
            `Repaired ${result.messageId} in tenant ${tenantId}.`,
            `Session: ${result.sessionId} · tool: ${result.toolName}`,
            `Text: ${result.beforeChars} chars → ${result.afterChars} chars`,
            `Backup: ${result.backupPath}`,
            "",
            "Only this messages row changed. Chat context, session state and",
            "the file on disk are untouched. To undo:",
            `  action:"restore", messageId:"${result.messageId}", backupPath:"${result.backupPath}"`,
          ].join("\n"),
          data: result,
        };
      } catch (err) {
        return {
          ok: false,
          text: `fix failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (action === "restore") {
      const backupPath =
        typeof args.backupPath === "string" ? args.backupPath.trim() : "";
      if (!backupPath) {
        return {
          ok: false,
          text: `action "restore" requires backupPath (returned by the original fix).`,
        };
      }
      try {
        const out = restoreToolResult({ dbPath, messageId, backupPath });
        return {
          ok: true,
          text: `Restored ${out.messageId} from ${backupPath} (${out.restoredChars} chars).`,
          data: out,
        };
      } catch (err) {
        return {
          ok: false,
          text: `restore failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return {
      ok: false,
      text: `unknown action "${action}". Use scan | detail | fix | restore.`,
    };
  },
};