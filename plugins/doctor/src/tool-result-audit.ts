// Audit and repair corrupted tool results stored in the `messages`
// table.
//
// Scope is deliberately narrow: this reads and writes **only** the
// `messages` rows that hold a tool result. It does not touch session
// state, does not re-run the tool, and does not reload any chat
// context. The single goal is to unstick a user whose turn died
// because a tool returned unusable content.
//
// Why it exists: a `read_file` result can be stored as megabytes of
// decoding garbage (a binary file mis-detected as text). That blob
// then dominates the context on every subsequent turn of that
// session, and the user has to abandon the conversation. Marking the
// offending row as unusable lets the model re-read the file — with
// code that now detects binary content properly.
//
// Two-step workflow, by design:
//
//   1. `scan`  — read-only. Lists offenders with an `impact` verdict
//                so a human can decide which ones actually hurt.
//   2. `fix`   — ONE message id at a time. Never batch. Backs the
//                original row up first so it can be restored.
//
// The `fix` action refuses a list. Stalling is not uniform: a
// corrupted row that the user worked around is noise, while one that
// killed the turn is worth repairing. That judgement belongs to the
// operator, not to a bulk UPDATE.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** Tool results this audit understands. Both read raw file content
 *  and so can decode a binary file into replacement characters. */
const AUDITED_TOOLS = new Set(["read_file", "tenant_config_read"]);

/** Replacement characters as a share of total text, above which a
 *  row is certainly decoding garbage rather than a stray artefact. */
const BAD_CHAR_RATIO_THRESHOLD = 0.2;

/** Character count above which the result was written before the
 *  return-size cap existed. */
const OVERSIZED_CHARS = 30_000;

/** Decoded characters as a share of the file's byte size, below
 *  which the decode clearly failed (UTF-8 never shrinks a file to a
 *  fraction of its byte count). */
const CATASTROPHIC_RATIO = 0.05;

/** How far to look ahead in a session when judging impact. */
const FOLLOWUP_WINDOW = 12;

export type Impact = "stalled" | "recovered" | "continued";

export interface Finding {
  messageId: string;
  sessionId: string;
  toolName: string;
  createdAt: number;
  /** Problem signals, in descending severity. */
  problems: string[];
  /** Byte size recorded in the tool result, when present. */
  size?: number;
  /** Character count of the stored text. */
  chars: number;
  /** Share of U+FFFD in the text. */
  badRatio: number;
  /** Filesystem path parsed out of the `// workspace:///...` header. */
  filePath?: string;
  /** Did this row actually stall the user? */
  impact: Impact;
  /** One-line evidence for the impact verdict. */
  impactReason: string;
}

export interface ScanOptions {
  /** Absolute path to the tenant's db.sqlite. */
  dbPath: string;
  /** Only rows newer than this (epoch ms). */
  since?: number;
  /** Only rows older than this (epoch ms). */
  until?: number;
  /** Cap on returned findings (default 200). */
  limit?: number;
  /** Include non-stalled findings too (default: stalled only). */
  includeRecovered?: boolean;
}

type MessageRow = {
  rid: number;
  id: string;
  session_id: string;
  role: string;
  entry_type: string;
  content: string;
  created_at: number;
};

interface ParsedToolResult {
  toolName: string;
  text: string;
  /** Full file size recorded by the tool. */
  size?: number;
  /** How many bytes THIS call actually read. A paged read returns
   *  far fewer characters than `size` — that is normal, not a
   *  decode failure, so the ratio check must use this field. */
  bytesReturned?: number;
  ok?: boolean;
}

/** Decode a stored row into the fields this audit needs. Returns
 *  null for rows that are not a tool result of an audited tool. */
function parseToolResult(row: MessageRow): ParsedToolResult | null {
  if (row.role !== "tool") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as {
    toolName?: unknown;
    content?: unknown;
    details?: unknown;
  };
  const toolName = typeof p.toolName === "string" ? p.toolName : "";
  if (!AUDITED_TOOLS.has(toolName)) return null;

  let text = "";
  if (Array.isArray(p.content)) {
    for (const block of p.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: string }).text === "string"
      ) {
        text += (block as { text: string }).text;
      }
    }
  }

  const details = (p.details ?? {}) as {
    size?: unknown;
    bytesReturned?: unknown;
    ok?: unknown;
  };
  const size =
    typeof details.size === "number" ? details.size : undefined;
  const bytesReturned =
    typeof details.bytesReturned === "number" ? details.bytesReturned : undefined;
  const ok = typeof details.ok === "boolean" ? details.ok : undefined;

  return { toolName, text, size, bytesReturned, ok };
}

/** Count U+FFFD in a string without allocating an array. */
function countReplacement(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) n++;
  }
  return n;
}

/** Pull `workspace:///a/b.html` out of the `// ...` header line that
 *  both read tools prepend. Returns a workspace-relative path. */
function parseHeaderPath(text: string): string | undefined {
  const m = /^\/\/\s*(?:workspace:\/\/\/)?(\S+)/.exec(text);
  if (!m) return undefined;
  const raw = m[1]!;
  // Headers look like "a/b/c.html" or "workspace:///a/b/c.html";
  // reject anything that does not look like a file, e.g. the
  // "(12345 bytes)" tail when a path contains spaces.
  if (!raw || raw.startsWith("(")) return undefined;
  return raw.replace(/^\/+/, "");
}

/** Classify the problem signals present in one row. */
function classify(
  row: MessageRow,
  parsed: ParsedToolResult,
  badRatio: number,
): string[] {
  const problems: string[] = [];
  const chars = parsed.text.length;
  const size = parsed.size;
  // The decode-ratio check MUST use the bytes this call actually
  // read, not the file size. A paged read (`offset` + `limit`)
  // legitimately returns a small slice of a large file — judging
  // that against `size` flags every paged read as a failure. Fall
  // back to `size` only when the tool did not record
  // `bytesReturned` (older rows).
  const consumed = parsed.bytesReturned ?? size;

  if (badRatio > BAD_CHAR_RATIO_THRESHOLD) {
    problems.push("replacement-chars");
  }
  if (chars > OVERSIZED_CHARS) {
    problems.push("oversized");
  }
  if (
    consumed !== undefined &&
    consumed > 4096 &&
    chars < consumed * CATASTROPHIC_RATIO
  ) {
    problems.push("catastrophic-decode");
  }
  if (chars === 0 && parsed.ok === true && size !== undefined && size > 0) {
    problems.push("empty-but-ok");
  }
  return problems;
}

/**
 * Judge whether this row stalled the user.
 *
 * Walk the rows that follow it in the same session (by rowid, which
 * is insertion order — `seq` is null on fork_tail rows):
 *
 *   - a later successful result from the same tool on the same path
 *     means the agent recovered → `recovered`
 *   - a later assistant row with real text and a non-error stop
 *     reason means the conversation moved on → `continued`
 *   - neither, within the window → `stalled`
 */
function judgeImpact(
  db: Database.Database,
  row: MessageRow,
  filePath: string | undefined,
  toolName: string,
): { impact: Impact; reason: string } {
  const followUps = db
    .prepare<
      [string, number, number],
      MessageRow
    >(
      `SELECT rowid AS rid, id, session_id, role, entry_type, content, created_at
         FROM messages
        WHERE session_id = ? AND rowid > ?
        ORDER BY rowid
        LIMIT ?`,
    )
    .all(row.session_id, row.rid, FOLLOWUP_WINDOW);

  for (const next of followUps) {
    if (next.role === "tool") {
      const p = parseToolResult(next);
      if (!p) continue;
      if (p.toolName !== toolName) continue;
      if (p.ok === false) continue;
      const nextPath = parseHeaderPath(p.text);
      if (filePath && nextPath === filePath) {
        return {
          impact: "recovered",
          reason: `re-read succeeded at row ${next.id}`,
        };
      }
      if (!filePath && p.text.length > 0) {
        return {
          impact: "recovered",
          reason: `later ${toolName} succeeded at row ${next.id}`,
        };
      }
    }
    if (next.role === "assistant") {
      if (isUsableAssistant(next)) {
        return {
          impact: "continued",
          reason: `conversation continued at row ${next.id}`,
        };
      }
    }
  }

  return {
    impact: "stalled",
    reason: `no successful follow-up within ${FOLLOWUP_WINDOW} rows`,
  };
}

/** Assistant row that represents a real reply (text, not an error). */
function isUsableAssistant(row: MessageRow): boolean {
  let p: unknown;
  try {
    p = JSON.parse(row.content);
  } catch {
    return false;
  }
  const o = p as {
    stopReason?: unknown;
    errorMessage?: unknown;
    content?: unknown;
  };
  const stop = typeof o.stopReason === "string" ? o.stopReason : "";
  if (stop === "error" || stop === "aborted") return false;
  if (typeof o.errorMessage === "string" && o.errorMessage.length > 0) {
    return false;
  }
  if (!Array.isArray(o.content)) return false;
  for (const block of o.content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: string }).text === "string" &&
      (block as { text: string }).text.trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

/** Read-only scan. Opens the database read-only — this function
 *  physically cannot modify anything. */
export function scanToolResults(opts: ScanOptions): Finding[] {
  const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });
  try {
    const conditions = [`role = 'tool'`];
    const params: (string | number)[] = [];
    if (opts.since !== undefined) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      conditions.push("created_at <= ?");
      params.push(opts.until);
    }

    const rows = db
      .prepare<unknown[], MessageRow>(
        `SELECT rowid AS rid, id, session_id, role, entry_type, content, created_at
           FROM messages
          WHERE ${conditions.join(" AND ")}
          ORDER BY rowid`,
      )
      .all(...params);

    const findings: Finding[] = [];
    for (const row of rows) {
      const parsed = parseToolResult(row);
      if (!parsed) continue;

      const bad = countReplacement(parsed.text);
      const badRatio = parsed.text.length > 0 ? bad / parsed.text.length : 0;
      const problems = classify(row, parsed, badRatio);
      if (problems.length === 0) continue;

      const filePath = parseHeaderPath(parsed.text);
      const { impact, reason } = judgeImpact(
        db,
        row,
        filePath,
        parsed.toolName,
      );
      if (impact !== "stalled" && !opts.includeRecovered) continue;

      findings.push({
        messageId: row.id,
        sessionId: row.session_id,
        toolName: parsed.toolName,
        createdAt: row.created_at,
        problems,
        size: parsed.size,
        chars: parsed.text.length,
        badRatio,
        filePath,
        impact,
        impactReason: reason,
      });
    }

    findings.sort((a, b) => {
      // Stalled first, then by recency.
      if (a.impact !== b.impact) {
        return a.impact === "stalled" ? -1 : 1;
      }
      return b.createdAt - a.createdAt;
    });

    return findings.slice(0, opts.limit ?? 200);
  } finally {
    db.close();
  }
}

// ── Repair ───────────────────────────────────────────────────────

export interface FixOptions {
  dbPath: string;
  /** Exactly one message id. A list is rejected on purpose. */
  messageId: string;
  /** Directory to write the original row's content into before the
   *  UPDATE. Created if missing. */
  backupDir: string;
}

export interface FixResult {
  messageId: string;
  sessionId: string;
  toolName: string;
  beforeChars: number;
  afterChars: number;
  backupPath: string;
  /** Text now stored in the row. */
  replacement: string;
}

/** Build the stub that replaces an unusable result. It must be
 *  honest about what happened and tell the model what to do next,
 *  without pretending the file was empty. */
export function buildStub(original: {
  toolName: string;
  filePath?: string;
  size?: number;
}): string {
  const where = original.filePath ? ` (${original.filePath})` : "";
  const bytes =
    original.size !== undefined ? ` ${original.size} bytes` : "";
  return (
    `[Tool result removed by maintenance]\n` +
    `The stored ${original.toolName} output${where} could not be used: it ` +
    `contained${bytes} of content that did not decode as text, and reading it ` +
    `stalled the conversation. The original output has been backed up.\n` +
    `If you still need this file, read it again — the current reader detects ` +
    `binary content and will return an extraction hint instead of raw bytes.`
  );
}

/** Repair exactly one row. Returns the before/after sizes so the
 *  caller can show the operator what changed. */
export function fixToolResult(opts: FixOptions): FixResult {
  if (!opts.messageId || typeof opts.messageId !== "string") {
    throw new Error("fix requires exactly one messageId");
  }
  if (Array.isArray(opts.messageId)) {
    throw new Error("fix accepts ONE messageId per call, not a list");
  }

  const db = new Database(opts.dbPath, { fileMustExist: true });
  try {
    const row = db
      .prepare<[string], MessageRow>(
        `SELECT rowid AS rid, id, session_id, role, entry_type, content, created_at
           FROM messages WHERE id = ?`,
      )
      .get(opts.messageId);

    if (!row) throw new Error(`message not found: ${opts.messageId}`);
    const parsed = parseToolResult(row);
    if (!parsed) {
      throw new Error(
        `message ${opts.messageId} is not a tool result from ` +
          `${[...AUDITED_TOOLS].join(" / ")}`,
      );
    }

    // Back up the original content verbatim before touching it.
    fs.mkdirSync(opts.backupDir, { recursive: true });
    const safeId = opts.messageId.replace(/[^A-Za-z0-9_.-]/g, "_");
    const backupPath = path.join(
      opts.backupDir,
      `${safeId}.${row.created_at}.json`,
    );
    fs.writeFileSync(backupPath, row.content, "utf8");

    const replacement = buildStub({
      toolName: parsed.toolName,
      filePath: parseHeaderPath(parsed.text),
      size: parsed.size,
    });

    // Preserve the row's envelope; replace only the text block's
    // content so toolCallId, toolName and details stay intact for
    // the UI and for orphan-detection on replay.
    const envelope = JSON.parse(row.content) as {
      content?: unknown;
      details?: Record<string, unknown>;
    };
    const blocks = Array.isArray(envelope.content) ? envelope.content : [];
    const textIdx = blocks.findIndex(
      (b: unknown) =>
        b &&
        typeof b === "object" &&
        (b as { type?: string }).type === "text",
    );
    if (textIdx >= 0) {
      blocks[textIdx] = { type: "text", text: replacement };
    } else {
      blocks.unshift({ type: "text", text: replacement });
    }
    envelope.content = blocks;
    envelope.details = {
      ...(envelope.details ?? {}),
      repairedByMaintenance: true,
      repairedAt: Date.now(),
      originalChars: parsed.text.length,
      backupPath,
    };

    db.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(
      JSON.stringify(envelope),
      opts.messageId,
    );

    return {
      messageId: opts.messageId,
      sessionId: row.session_id,
      toolName: parsed.toolName,
      beforeChars: parsed.text.length,
      afterChars: replacement.length,
      backupPath,
      replacement,
    };
  } finally {
    db.close();
  }
}

/** Restore one row from a backup file written by `fixToolResult`. */
export function restoreToolResult(opts: {
  dbPath: string;
  messageId: string;
  backupPath: string;
}): { messageId: string; restoredChars: number } {
  const db = new Database(opts.dbPath, { fileMustExist: true });
  try {
    const original = fs.readFileSync(opts.backupPath, "utf8");
    const row = db
      .prepare<[string], { id: string }>(
        `SELECT id FROM messages WHERE id = ?`,
      )
      .get(opts.messageId);
    if (!row) throw new Error(`message not found: ${opts.messageId}`);

    db.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(
      original,
      opts.messageId,
    );
    const parsed = JSON.parse(original) as {
      content?: Array<{ text?: string }>;
    };
    const chars =
      parsed.content?.reduce(
        (n, b) => n + (typeof b.text === "string" ? b.text.length : 0),
        0,
      ) ?? 0;
    return { messageId: opts.messageId, restoredChars: chars };
  } finally {
    db.close();
  }
}