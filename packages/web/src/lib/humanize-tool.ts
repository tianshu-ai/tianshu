/**
 * Translate raw tool call (name + args) into a short human-readable
 * label. Clean and concise — no raw shell commands in the summary.
 *
 * Meaningful parameters (filenames, search queries, hostnames) are
 * included via i18n interpolation. Shell commands are classified
 * by category only (Install / Run script / etc.) — the raw command
 * stays in the expand-to-see-details view.
 */

import { translate, type TranslationKey } from "./i18n";

type Args = Record<string, unknown>;
type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function basename(path: string): string {
  const s = path.replace(/\\/g, "/");
  return s.split("/").pop() ?? s;
}

function shorten(s: string, max = 30): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Classify a shell command into a category key. */
function classifyCommand(cmd: string): TranslationKey {
  const c = cmd.trim();
  if (/\b(pip3?|npm|yarn|pnpm)\s+install\b/i.test(c)) return "tool.cmd.install";
  if (/\bgit\s+clone\b/i.test(c)) return "tool.cmd.gitClone";
  if (/\bgit\s+pull\b/i.test(c)) return "tool.cmd.gitPull";
  if (/\bgit\s+push\b/i.test(c)) return "tool.cmd.gitPush";
  if (/\bgit\s+commit\b/i.test(c)) return "tool.cmd.gitCommit";
  if (/\bgit\s+checkout\b/i.test(c)) return "tool.cmd.gitCheckout";
  if (/\b(python3?|node)\s+/i.test(c)) return "tool.cmd.runScript";
  if (/\b(curl|wget)\s+/i.test(c)) return "tool.cmd.httpRequest";
  if (/\bcat\s+>/.test(c)) return "tool.cmd.writeFile";
  if (/\bmkdir\b/.test(c)) return "tool.cmd.mkdir";
  if (/\brm\b/.test(c)) return "tool.cmd.rm";
  if (/\b(ls|dir)\b/.test(c)) return "tool.cmd.ls";
  if (/\bdocker\b/i.test(c)) return "tool.cmd.docker";
  return "tool.cmd.run";
}

// ── Bridge tool name normalizer ───────────────────────────
export function normalizeBridgeName(name: string): string {
  const m = name.match(/^bridge_.*?_local_(.+)$/);
  return m ? m[1] : name;
}

/** Short display name (no i18n, just strip bridge prefix). */
export function shortToolName(name: string): string {
  return normalizeBridgeName(name);
}

// ── Mapping table ─────────────────────────────────────────
type Humanizer = (t: T, args: Args) => string;

const TOOL_MAP: Record<string, Humanizer> = {
  // File operations — filename is meaningful
  write_file: (t, a) => {
    const p = str(a.path);
    return p ? t("tool.writeFileNamed", { name: shorten(basename(p)) }) : t("tool.writeFile");
  },
  read_file: (t, a) => {
    const p = str(a.path);
    return p ? t("tool.readFileNamed", { name: shorten(basename(p)) }) : t("tool.readFile");
  },
  edit_file: (t, a) => {
    const p = str(a.path);
    return p ? t("tool.editFileNamed", { name: shorten(basename(p)) }) : t("tool.editFile");
  },
  delete_file: (t, a) => {
    const p = str(a.path);
    return p ? t("tool.deleteFileNamed", { name: shorten(basename(p)) }) : t("tool.deleteFile");
  },
  list_files: (t) => t("tool.listFiles"),
  create_directory: (t, a) => {
    const p = str(a.path);
    return p ? t("tool.mkdirNamed", { name: shorten(basename(p)) }) : t("tool.mkdir");
  },

  // Sync / bridge — filename is meaningful
  sync_up: (t, a) => {
    const p = str(a.path || a.localPath);
    return p ? t("tool.uploadNamed", { name: shorten(basename(p)) }) : t("tool.upload");
  },
  sync_down: (t, a) => {
    const p = str(a.path || a.remotePath);
    return p ? t("tool.downloadNamed", { name: shorten(basename(p)) }) : t("tool.download");
  },

  // Shell exec — category only, no raw command
  exec: (t, a) => {
    const cmd = str(a.command);
    return cmd ? t(classifyCommand(cmd)) : t("tool.exec");
  },
  shell_exec: (t, a) => {
    const cmd = str(a.command);
    return cmd ? t(classifyCommand(cmd)) : t("tool.exec");
  },

  // Search & web — query/host is meaningful
  web_search: (t, a) => {
    const q = str(a.query);
    return q ? t("tool.searchNamed", { query: shorten(q, 24) }) : t("tool.search");
  },
  web_fetch: (t, a) => {
    const u = str(a.url);
    try {
      const host = new URL(u).hostname;
      return t("tool.fetchNamed", { host });
    } catch { /* */ }
    return t("tool.fetch");
  },

  // Code
  code_interpreter: (t) => t("tool.codeAnalysis"),
  python: (t) => t("tool.runPython"),

  // Database — source name is meaningful
  ds_query: (t, a) => {
    const src = str(a.source || a.connection);
    return src ? t("tool.dbQueryNamed", { name: src }) : t("tool.dbQuery");
  },
  ds_execute: (t, a) => {
    const src = str(a.source || a.connection);
    return src ? t("tool.dbExecNamed", { name: src }) : t("tool.dbExec");
  },
  ds_schema: (t) => t("tool.dbSchema"),
  ds_list: (t) => t("tool.dbList"),
  ds_panel: (t) => t("tool.dbPanel"),

  // Knowledge — query is meaningful
  wiki_search: (t, a) => {
    const q = str(a.query);
    return q ? t("tool.wikiSearchNamed", { query: shorten(q, 20) }) : t("tool.wikiSearch");
  },
  wiki_read: (t) => t("tool.wikiRead"),
  memory_search: (t) => t("tool.memorySearch"),
  memory_read: (t) => t("tool.memoryRead"),

  // Image — prompt is meaningful
  generate_image: (t, a) => {
    const p = str(a.prompt);
    return p ? t("tool.genImageNamed", { prompt: shorten(p, 24) }) : t("tool.genImage");
  },

  // Config
  tenant_config_read: (t) => t("tool.configRead"),
  tenant_config_write: (t) => t("tool.configWrite"),
  tenant_config_list: (t) => t("tool.configList"),
  model_list: (t) => t("tool.modelList"),
  task_list_workers: (t) => t("tool.workerList"),

  // Cron
  cron_list: (t) => t("tool.cronList"),
  cron_create: (t) => t("tool.cronCreate"),
  cron_delete: (t) => t("tool.cronDelete"),

  // Board
  board_create: (t) => t("tool.boardCreate"),
  board_update: (t) => t("tool.boardUpdate"),
  board_render: (t) => t("tool.boardRender"),
};

// ── Public API ────────────────────────────────────────────

export function humanizeToolCall(
  name: string,
  args: Args,
  t: T = translate,
): string {
  // Agent-supplied title takes priority
  const title = typeof args._title === "string" ? args._title.trim() : "";
  if (title) return title;
  // Fallback to regex classification
  const normalized = normalizeBridgeName(name);
  const fn = TOOL_MAP[normalized];
  if (fn) return fn(t, args);
  return "";
}

/**
 * Summarize a group of tool calls into one clean line.
 * Deduplicates consecutive identical labels.
 */
export function humanizeToolGroup(
  calls: { name: string; arguments: Args; result?: { ok?: boolean } }[],
  t: T = translate,
): string {
  const summaries: string[] = [];
  for (const c of calls) {
    const h = humanizeToolCall(c.name, c.arguments, t);
    const label = h || normalizeBridgeName(c.name);
    if (summaries.length === 0 || summaries[summaries.length - 1] !== label) {
      summaries.push(label);
    }
  }
  if (summaries.length > 4) {
    return summaries.slice(0, 3).join(" → ") + t("tool.groupOverflow", { total: calls.length });
  }
  return summaries.join(" → ");
}
