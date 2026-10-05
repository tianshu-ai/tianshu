/**
 * Translate raw tool call (name + args) into a short human-readable
 * label with concrete details (not just "Run command" but what command).
 *
 * Format: "Action · detail"  e.g. "安装依赖 · npm install react"
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

function shorten(s: string, max = 40): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Extract a compact representation of a shell command. */
function compactCmd(cmd: string): string {
  // Strip common prefixes: cd ... && <rest> → <rest>
  let c = cmd.trim();
  // Unwrap: cd /path && <rest> → <rest>
  c = c.replace(/^cd\s+\S+\s*&&\s*/i, "");
  // Unwrap: bash -c '...' or sh -c '...' → inner
  const shM = c.match(/^(?:bash|sh|zsh)\s+-c\s+['"](.+)['"]$/s);
  if (shM) c = shM[1].trim();
  // Collapse whitespace
  c = c.replace(/\s+/g, " ");
  return shorten(c, 48);
}

/** Classify a shell command and return [action_key, detail]. */
function classifyCommand(cmd: string): { key: TranslationKey; detail: string } {
  const c = cmd.trim();
  const compact = compactCmd(cmd);

  if (/\b(pip3?|npm|yarn|pnpm)\s+install\b/i.test(c))
    return { key: "tool.cmd.install", detail: compact };
  if (/\bgit\s+clone\b/i.test(c))
    return { key: "tool.cmd.gitClone", detail: compact };
  if (/\bgit\s+pull\b/i.test(c))
    return { key: "tool.cmd.gitPull", detail: compact };
  if (/\bgit\s+push\b/i.test(c))
    return { key: "tool.cmd.gitPush", detail: compact };
  if (/\bgit\s+commit\b/i.test(c))
    return { key: "tool.cmd.gitCommit", detail: compact };
  if (/\bgit\s+checkout\b/i.test(c))
    return { key: "tool.cmd.gitCheckout", detail: compact };
  if (/\b(python3?|node)\s+/i.test(c))
    return { key: "tool.cmd.runScript", detail: compact };
  if (/\b(curl|wget)\s+/i.test(c))
    return { key: "tool.cmd.httpRequest", detail: compact };
  if (/\bcat\s+>/.test(c))
    return { key: "tool.cmd.writeFile", detail: compact };
  if (/\bmkdir\b/.test(c))
    return { key: "tool.cmd.mkdir", detail: compact };
  if (/\brm\b/.test(c))
    return { key: "tool.cmd.rm", detail: compact };
  if (/\b(ls|dir)\b/.test(c))
    return { key: "tool.cmd.ls", detail: compact };
  if (/\bdocker\b/i.test(c))
    return { key: "tool.cmd.docker", detail: compact };
  return { key: "tool.cmd.run", detail: compact };
}

// ── Bridge tool name normalizer ───────────────────────────
function normalizeBridgeName(name: string): string {
  const m = name.match(/^bridge_.*?_local_(.+)$/);
  return m ? m[1] : name;
}

/** Short display name (no i18n, just strip bridge prefix). */
export function shortToolName(name: string): string {
  return normalizeBridgeName(name);
}

// ── Helper: "Action · detail" ─────────────────────────────
function withDetail(action: string, detail: string): string {
  if (!detail) return action;
  return `${action} · ${detail}`;
}

// ── Mapping table: tool name → (t, args) → translated string ──
type Humanizer = (t: T, args: Args) => string;

const TOOL_MAP: Record<string, Humanizer> = {
  // File operations
  write_file: (t, a) => {
    const p = str(a.path);
    return p ? withDetail(t("tool.writeFile"), basename(p)) : t("tool.writeFile");
  },
  read_file: (t, a) => {
    const p = str(a.path);
    return p ? withDetail(t("tool.readFile"), basename(p)) : t("tool.readFile");
  },
  edit_file: (t, a) => {
    const p = str(a.path);
    return p ? withDetail(t("tool.editFile"), basename(p)) : t("tool.editFile");
  },
  delete_file: (t, a) => {
    const p = str(a.path);
    return p ? withDetail(t("tool.deleteFile"), basename(p)) : t("tool.deleteFile");
  },
  list_files: (t) => t("tool.listFiles"),
  create_directory: (t, a) => {
    const p = str(a.path);
    return p ? withDetail(t("tool.mkdir"), basename(p)) : t("tool.mkdir");
  },

  // Sync / bridge
  sync_up: (t, a) => {
    const p = str(a.path || a.localPath);
    return p ? withDetail(t("tool.upload"), basename(p)) : t("tool.upload");
  },
  sync_down: (t, a) => {
    const p = str(a.path || a.remotePath);
    return p ? withDetail(t("tool.download"), basename(p)) : t("tool.download");
  },

  // Shell exec — always show the actual command
  exec: (t, a) => {
    const cmd = str(a.command);
    if (!cmd) return t("tool.exec");
    const { key, detail } = classifyCommand(cmd);
    return withDetail(t(key), detail);
  },
  shell_exec: (t, a) => {
    const cmd = str(a.command);
    if (!cmd) return t("tool.exec");
    const { key, detail } = classifyCommand(cmd);
    return withDetail(t(key), detail);
  },

  // Search & web
  web_search: (t, a) => {
    const q = str(a.query);
    return q ? withDetail(t("tool.search"), shorten(q, 32)) : t("tool.search");
  },
  web_fetch: (t, a) => {
    const u = str(a.url);
    try {
      const host = new URL(u).hostname;
      return withDetail(t("tool.fetch"), host);
    } catch { /* */ }
    return t("tool.fetch");
  },

  // Code
  code_interpreter: (t) => t("tool.codeAnalysis"),
  python: (t) => t("tool.runPython"),

  // Database
  ds_query: (t, a) => {
    const src = str(a.source || a.connection);
    const q = str(a.query || a.sql);
    const detail = [src, q ? shorten(q, 30) : ""].filter(Boolean).join(" · ");
    return withDetail(t("tool.dbQuery"), detail);
  },
  ds_execute: (t, a) => {
    const src = str(a.source || a.connection);
    return src ? withDetail(t("tool.dbExec"), src) : t("tool.dbExec");
  },
  ds_schema: (t, a) => {
    const src = str(a.source || a.name);
    return src ? withDetail(t("tool.dbSchema"), src) : t("tool.dbSchema");
  },
  ds_list: (t) => t("tool.dbList"),
  ds_panel: (t) => t("tool.dbPanel"),

  // Knowledge
  wiki_search: (t, a) => {
    const q = str(a.query);
    return q ? withDetail(t("tool.wikiSearch"), shorten(q, 24)) : t("tool.wikiSearch");
  },
  wiki_read: (t, a) => {
    const p = str(a.page || a.path);
    return p ? withDetail(t("tool.wikiRead"), shorten(p, 24)) : t("tool.wikiRead");
  },
  memory_search: (t, a) => {
    const q = str(a.query);
    return q ? withDetail(t("tool.memorySearch"), shorten(q, 24)) : t("tool.memorySearch");
  },
  memory_read: (t) => t("tool.memoryRead"),

  // Image
  generate_image: (t, a) => {
    const p = str(a.prompt);
    return p ? withDetail(t("tool.genImage"), shorten(p, 30)) : t("tool.genImage");
  },

  // Config
  tenant_config_read: (t, a) => {
    const k = str(a.key || a.path);
    return k ? withDetail(t("tool.configRead"), k) : t("tool.configRead");
  },
  tenant_config_write: (t, a) => {
    const k = str(a.key || a.path);
    return k ? withDetail(t("tool.configWrite"), k) : t("tool.configWrite");
  },
  tenant_config_list: (t) => t("tool.configList"),
  model_list: (t) => t("tool.modelList"),
  task_list_workers: (t) => t("tool.workerList"),

  // Cron
  cron_list: (t) => t("tool.cronList"),
  cron_create: (t, a) => {
    const n = str(a.name || a.title);
    return n ? withDetail(t("tool.cronCreate"), shorten(n, 24)) : t("tool.cronCreate");
  },
  cron_delete: (t, a) => {
    const n = str(a.name || a.id);
    return n ? withDetail(t("tool.cronDelete"), shorten(n, 24)) : t("tool.cronDelete");
  },

  // Board
  board_create: (t, a) => {
    const n = str(a.name || a.title);
    return n ? withDetail(t("tool.boardCreate"), shorten(n, 24)) : t("tool.boardCreate");
  },
  board_update: (t) => t("tool.boardUpdate"),
  board_render: (t) => t("tool.boardRender"),
};

// ── Public API ────────────────────────────────────────────

export function humanizeToolCall(
  name: string,
  args: Args,
  t: T = translate,
): string {
  const normalized = normalizeBridgeName(name);
  const fn = TOOL_MAP[normalized];
  if (fn) return fn(t, args);
  return "";
}

/**
 * Summarize a group of tool calls into one line.
 * Each step includes its detail, deduplicating identical labels.
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
