// Boot-time tool-delta detector.
//
// Problem: a user opens a chat, the conversation grows for a few
// days, then the server is upgraded. The new release ships extra
// tools (e.g. `worker_analytics`). The system prompt rebuilt each
// turn does include the fresh tool catalogue — but the model has
// hundreds of turns of history where the tool was absent. In
// practice the model often "stays in its lane" and never tries
// the new tool, even though the user could have benefitted.
//
// Fix: every builtin tool carries a `since` semver in its plugin
// manifest. Every session carries the host's `package.json/version`
// at creation time (`created_under_app_version`). On server boot
// we compute the per-session diff: tools whose `since` is newer
// than the session's stamped version. If the diff is non-empty
// we drop a synthetic `role: "user"` system note into the
// session inbox so the *next* turn's history contains an explicit
// "btw, X is new since you last opened this conversation" hint.
//
// After the note is sent we bump the session's stamp to the
// current host version so successive restarts on the same release
// don't fire the same note again.
//
// Design notes:
//
//   - Pure helpers here; the boot wiring sits in `index.ts` and
//     calls `computeSessionToolDeltas()` followed by
//     `appendMessage(role:"user", renderToolDeltaNote(...))` for
//     each session that has a non-empty delta.
//
//   - We don't notify NULL-version sessions (migration 009 leaves
//     pre-009 rows NULL). Replaying every tool ever added would
//     flood users on a single restart with no upside.
//
//   - Comparison is "X.Y.Z[-prerelease] semver-ish":
//     0.3.20 > 0.3.19 > 0.3.10 > 0.3.2  (numeric compare, not
//     lexicographic). Prerelease tags are sorted lower than the
//     base version so "0.4.0-rc1" sits before "0.4.0".
//
//   - Bad/missing `since` on a tool is silently skipped — third
//     party plugins might not have updated yet; we'd rather miss
//     a notification than crash boot.

export interface ToolCatalogEntry {
  /** Tool name as advertised to the model (matches the pi-ai
   *  schema name, what the agent actually calls). */
  toolName: string;
  /** `manifest.contributes.tools[].since`. Optional: a tool
   *  without `since` is treated as "existed forever". */
  since?: string | null;
  /** Plugin that contributes this tool. Surfaced in the
   *  notification so the user sees "from plugin X". */
  pluginId: string;
  /** One-line tool description for the notification body. Comes
   *  from the tool's pi-ai schema. */
  description?: string;
}

export interface SessionStamp {
  sessionId: string;
  /** NULL for pre-009 sessions. */
  createdUnderAppVersion: string | null;
}

export interface SessionDelta {
  sessionId: string;
  /** Subset of the catalog whose `since` post-dates this session's
   *  stamp. Empty when nothing's new (caller skips the notification). */
  newTools: ToolCatalogEntry[];
}

/** Parse a `X.Y.Z[-prerelease]` string into a comparable tuple.
 *  Returns null on malformed input so the caller can skip. */
export function parseVersion(
  v: string | null | undefined,
): { numeric: [number, number, number]; pre: string } | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/.exec(v);
  if (!m) return null;
  return {
    numeric: [Number(m[1]), Number(m[2]), Number(m[3])],
    // "" sorts highest in our compare (no-prerelease > prerelease)
    pre: m[4] ?? "",
  };
}

/** Returns +1 if a > b, -1 if a < b, 0 if equal. Treats null as
 *  -Infinity so unparseable values never look newer than real ones. */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa.numeric[i] !== pb.numeric[i]) {
      return pa.numeric[i] > pb.numeric[i] ? 1 : -1;
    }
  }
  // numeric tie — prerelease tags sort lower than no-prerelease
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1; // a is stable, b is pre
  if (pb.pre === "") return -1; // b is stable, a is pre
  return pa.pre > pb.pre ? 1 : -1; // both have prereleases, lex compare
}

/** Compute new tools per session. The session's stamp is the
 *  *floor*: a tool with `since == stamp` is **not** new (the user
 *  was already on that version when they opened the chat). A tool
 *  with `since > stamp && since <= currentVersion` is new. Tools
 *  with `since > currentVersion` are filtered out — they shouldn't
 *  be in the catalog at all on this server, but if they are it's
 *  a manifest error we don't want to mislead the user about. */
export function computeSessionToolDeltas(opts: {
  currentVersion: string;
  catalog: ToolCatalogEntry[];
  sessions: SessionStamp[];
}): SessionDelta[] {
  const { currentVersion, catalog, sessions } = opts;
  // Pre-filter catalog to tools that have a parseable since at all.
  // No-since tools are treated as ancient and never trigger a
  // delta. Future-since tools (since > current) are dropped as
  // manifest errors.
  const candidates: ToolCatalogEntry[] = catalog.filter((t) => {
    if (!t.since) return false;
    if (parseVersion(t.since) == null) return false;
    return compareVersions(t.since, currentVersion) <= 0;
  });
  return sessions
    .map((s) => {
      if (!s.createdUnderAppVersion) {
        // Pre-009 / unstamped session: skip outright. Caller is
        // expected to bump the column to currentVersion separately
        // so future restarts don't keep retrying.
        return { sessionId: s.sessionId, newTools: [] };
      }
      if (compareVersions(s.createdUnderAppVersion, currentVersion) >= 0) {
        // Session is up-to-date (or somehow newer; treat as
        // up-to-date to avoid spurious notifications during
        // downgrades).
        return { sessionId: s.sessionId, newTools: [] };
      }
      const newTools = candidates.filter(
        (t) => compareVersions(t.since, s.createdUnderAppVersion) > 0,
      );
      return { sessionId: s.sessionId, newTools };
    })
    .filter((d) => d.newTools.length > 0);
}

/** Render a human-readable, model-friendly system note for a
 *  single session's delta. Caller appends this verbatim as a
 *  `role: "user"` message — same convention plugin enable/disable
 *  uses (see `renderPluginsChangedNote`). */
export function renderToolDeltaNote(opts: {
  fromVersion: string;
  toVersion: string;
  newTools: ToolCatalogEntry[];
}): string {
  const { fromVersion, toVersion, newTools } = opts;
  const lines: string[] = [];
  lines.push(
    `[system note] tianshu upgraded from ${fromVersion} to ${toVersion} ` +
      `while this conversation was open. ` +
      `New tool${newTools.length === 1 ? "" : "s"} available:`,
  );
  for (const t of newTools) {
    const desc = t.description
      ? ` — ${t.description.length > 100 ? t.description.slice(0, 97) + "..." : t.description}`
      : "";
    lines.push(`  - \`${t.toolName}\` (from ${t.pluginId}, since ${t.since ?? "?"})${desc}`);
  }
  lines.push(
    `The full updated tool catalog is in the system prompt; ` +
      `this note exists so you don't have to spot the addition by inspection.`,
  );
  return lines.join("\n");
}
