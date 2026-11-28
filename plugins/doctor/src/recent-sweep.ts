// Proactive sweep: find `read_file` results that are too large to be
// healthy, in the recent turns of each session.
//
// Scope is deliberately narrow. Earlier revisions of this file tried
// to judge corruption too — replacement characters, decode collapse,
// empty-but-ok. In practice those produced almost no real findings
// while generating a lot of argument about thresholds, and the one
// thing that actually hurts is simple: a single tool result carrying
// tens or hundreds of thousands of characters, which then dominates
// the context on every later turn.
//
// So the rule is one line: read_file, recent turns, characters over
// the cap. Anything else is noise.
//
// "Recent" is measured in turn_number, not rows: one turn can hold
// dozens of tool calls, so a row-count window would cover only part
// of a single turn.

import Database from "better-sqlite3";

/** Only this tool. It is the one that returns raw file content and
 *  the only one that has produced oversized results in practice. */
const TOOL = "read_file";

/** Results at or above this should never reach the model. Matches
 *  the reader's own MAX_RETURN_CHARS: anything above it predates the
 *  cap or bypassed it. */
const OVERSIZED_CHARS = 30_000;

export interface OversizedResult {
  messageId: string;
  sessionId: string;
  sessionTitle?: string;
  sessionStatus?: string;
  turnNumber: number;
  createdAt: number;
  /** How many turns back from the session's latest turn. */
  turnsBack: number;
  chars: number;
  bytesReturned?: number;
  fileSize?: number;
  filePath?: string;
}

export interface SweepOptions {
  dbPath: string;
  /** How many recent turns per session to inspect (default 10). */
  recentTurns?: number;
  /** Skip sessions whose latest message is older than this. */
  activeSince?: number;
  /** Hard cap on returned rows (default 100). */
  limit?: number;
  /** Per-session row cap, so a huge branch cannot stall the sweep. */
  maxRowsPerSession?: number;
}

interface Row {
  rid: number;
  id: string;
  session_id: string;
  content: string;
  created_at: number;
  turn_number: number | null;
}

interface SessionRow {
  id: string;
  title: string | null;
  status: string;
  leaf_id: string | null;
}

function parseHeaderPath(text: string): string | undefined {
  const m = /^\/\/\s*(?:workspace:\/\/\/)?(\S+)/.exec(text);
  if (!m) return undefined;
  const raw = m[1]!;
  if (!raw || raw.startsWith("(")) return undefined;
  return raw.replace(/^\/+/, "");
}

interface Decoded {
  text: string;
  size?: number;
  bytesReturned?: number;
}

function decode(content: string): Decoded | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as {
    content?: unknown;
    details?: { size?: unknown; bytesReturned?: unknown };
  };
  const blocks = Array.isArray(p.content) ? p.content : [];
  let text = "";
  for (const b of blocks) {
    if (
      b &&
      typeof b === "object" &&
      (b as { type?: string }).type === "text" &&
      typeof (b as { text: string }).text === "string"
    ) {
      text += (b as { text: string }).text;
    }
  }
  const d = p.details ?? {};
  return {
    text,
    size: typeof d.size === "number" ? d.size : undefined,
    bytesReturned:
      typeof d.bytesReturned === "number" ? d.bytesReturned : undefined,
  };
}

/**
 * Sweep the recent turns of every ACTIVE session in a tenant, newest
 * first, and return the `read_file` results that exceed the character
 * cap.
 *
 * Archived / ended sessions are skipped on purpose. They will never
 * receive another turn, so an oversized result there cannot be
 * replayed into a context — and the chat UI already truncates what it
 * renders, so it is not a rendering hazard either. Only live sessions
 * describe a problem that still exists.
 */
export function sweepOversizedReads(opts: SweepOptions): {
  scanned: { sessions: number; results: number; turns: number };
  findings: OversizedResult[];
} {
  const recentTurns = opts.recentTurns ?? 10;
  const limit = opts.limit ?? 100;
  const maxRows = opts.maxRowsPerSession ?? 800;

  const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });
  try {
    // Session → latest turn, so we can window per session and order
    // the scan by recency without depending on a missing `updated_at`.
    const sessions = db
      .prepare<
        [number],
        SessionRow & { latest: number | null; maxturn: number | null }
      >(
        `SELECT s.id      AS id,
                s.title   AS title,
                s.status  AS status,
                s.leaf_id AS leaf_id,
                m.latest  AS latest,
                m.maxturn AS maxturn
           FROM sessions s
           LEFT JOIN (
                SELECT session_id,
                       MAX(created_at)  AS latest,
                       MAX(turn_number) AS maxturn
                  FROM messages
                 GROUP BY session_id
           ) m ON m.session_id = s.id
          WHERE m.latest IS NOT NULL
          ORDER BY m.latest DESC
          LIMIT ?`,
      )
      .all(2000);

    const findings: OversizedResult[] = [];
    let scannedResults = 0;
    let scannedSessions = 0;
    let scannedTurns = 0;

    // Parameters are positional: (session_id, minTurn, limit).
    const perSession = db.prepare<[string, number, number], Row>(
      // `turn_number` is NULL on fork_tail rows; those are read-only
      // history snapshots, not live turns, so they are excluded.
      `SELECT rowid AS rid, id, session_id, content, created_at, turn_number
         FROM messages
        WHERE role = 'tool'
          AND turn_number IS NOT NULL
          AND session_id = ?
          AND turn_number >= ?
          AND instr(content, '"toolName":"${TOOL}"') > 0
        ORDER BY rowid DESC
        LIMIT ?`,
    );

    for (const s of sessions) {
      // Archived and ended sessions are out of scope: nobody will send
      // them another turn, so an oversized result there cannot flood a
      // context. Only `active` sessions are inspected.
      if (s.status !== "active") continue;
      if (opts.activeSince !== undefined) {
        if ((s.latest ?? 0) < opts.activeSince) continue;
      }
      const minTurn = Math.max(0, (s.maxturn ?? 0) - (recentTurns - 1));
      const rows = perSession.all(s.id, minTurn, maxRows);
      if (rows.length === 0) continue;
      scannedSessions++;
      const maxturn = s.maxturn ?? 0;
      const seenTurns = new Set<number>();

      for (const r of rows) {
        scannedResults++;
        if (r.turn_number !== null) seenTurns.add(r.turn_number);

        const d = decode(r.content);
        if (!d) continue;
        const chars = d.text.length;
        if (chars <= OVERSIZED_CHARS) continue;

        findings.push({
          messageId: r.id,
          sessionId: r.session_id,
          sessionTitle: s.title ?? undefined,
          sessionStatus: s.status,
          turnNumber: r.turn_number ?? 0,
          createdAt: r.created_at,
          turnsBack: maxturn - (r.turn_number ?? 0),
          chars,
          bytesReturned: d.bytesReturned,
          fileSize: d.size,
          filePath: parseHeaderPath(d.text),
        });
      }
      scannedTurns += seenTurns.size;
    }

    // Most recent turn first, then the biggest offender.
    findings.sort((a, b) => {
      if (a.turnsBack !== b.turnsBack) return a.turnsBack - b.turnsBack;
      return b.chars - a.chars;
    });

    return {
      scanned: {
        sessions: scannedSessions,
        results: scannedResults,
        turns: scannedTurns,
      },
      findings: findings.slice(0, limit),
    };
  } finally {
    db.close();
  }
}