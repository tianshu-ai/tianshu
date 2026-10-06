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
export type T = (key: TranslationKey, params?: Record<string, string | number>) => string;

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

  // Host tools — system
  compact_context: (t) => t("tool.compactContext"),
  tool_catalog_refresh: (t) => t("tool.catalogRefresh"),
  recall_range: (t) => t("tool.recallRange"),
  recall_tool_call: (t) => t("tool.recallToolCall"),
  inspect_session: (t) => t("tool.inspectSession"),
  read_session_log: (t) => t("tool.readSessionLog"),

  // Host tools — interactive
  switch_panel: (t, a) => {
    const p = str(a.panel);
    if (!p || p === "list") return t("tool.listPanels");
    return t("tool.switchPanel");
  },
  solution: (t, a) => {
    const action = str(a.action);
    if (action === "list") return t("tool.solutionList");
    if (action === "active" || action === "get") return t("tool.solutionGet");
    if (action === "save") return t("tool.solutionSave");
    return t("tool.solution");
  },
  ask_user: (t, a) => {
    const q = str(a.question);
    return q ? t("tool.askUserNamed", { question: shorten(q, 30) }) : t("tool.askUser");
  },
  channel_send_file: (t, a) => {
    const p = str(a.path);
    return p ? t("tool.sendFileNamed", { name: basename(p) }) : t("tool.sendFile");
  },
  nudge_session: (t) => t("tool.nudgeSession"),

  // Tasks
  task_create: (t, a) => {
    const title = str(a.title);
    return title ? t("tool.taskCreateNamed", { title: shorten(title, 20) }) : t("tool.taskCreate");
  },
  task_list: (t) => t("tool.taskList"),
  task_update: (t) => t("tool.taskUpdate"),

  // Directory
  list_dir: (t) => t("tool.listFiles"),
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
    // First step … last two steps
    return summaries[0] + " → […] → " + summaries.slice(-2).join(" → ") + "  (" + calls.length + " steps)";
  }
  return summaries.join(" → ");
}

// ── Humanized args for expanded detail view ─────────────────

type ArgsFormatter = (t: T, args: Args) => string;

/** Per-tool formatters that turn raw args into readable text. */
const ARGS_MAP: Record<string, ArgsFormatter> = {
  // Host tools
  compact_context: (t) => t("toolDetail.compactContext"),
  tool_catalog_refresh: (t, a) => {
    const mode = str(a.mode);
    return mode ? t("toolDetail.catalogRefreshMode", { mode }) : t("toolDetail.catalogRefresh");
  },
  switch_panel: (t, a) => {
    const p = str(a.panel);
    if (!p) return t("toolDetail.switchPanel");
    if (p === "list") return t("toolDetail.switchPanelList");
    if (p === "close" || p === "none") return t("toolDetail.switchPanelClose");
    const PANEL_KEY: Record<string, TranslationKey> = {
      "board.main": "toolDetail.panel.board",
      "cron.main": "toolDetail.panel.cron",
      "datasource.main": "toolDetail.panel.datasource",
      "files.main": "toolDetail.panel.files",
      "reverse-mcp.main": "toolDetail.panel.reverseMcp",
      "wiki.main": "toolDetail.panel.wiki",
      "workboard.main": "toolDetail.panel.workboard",
      "workforce-studio.main": "toolDetail.panel.workforce",
    };
    const panelName = PANEL_KEY[p] ? t(PANEL_KEY[p]) : p;
    return t("toolDetail.switchPanelTo", { panel: panelName });
  },
  solution: (t, a) => {
    const action = str(a.action);
    const slug = str(a.slug);
    if (action === "active") return t("toolDetail.solutionActive");
    if (action === "get" && slug) return t("toolDetail.solutionGet", { slug });
    if (action === "save") return t("toolDetail.solutionSave", { slug: slug || t("toolDetail.newSolution") });
    if (action === "list") return t("toolDetail.solutionList");
    if (action === "activate" && slug) return t("toolDetail.solutionActivate", { slug });
    if (action === "delete" && slug) return t("toolDetail.solutionDelete", { slug });
    return t("toolDetail.solutionAction", { action: action || t("toolDetail.unknown") });
  },
  generate_image: (t, a) => {
    const p = str(a.prompt);
    const parts = [t("toolDetail.genImage")];
    if (p) parts.push(t("toolDetail.genImagePrompt", { prompt: shorten(p, 60) }));
    if (str(a.style)) parts.push(t("toolDetail.genImageStyle", { style: String(a.style) }));
    if (str(a.size)) parts.push(t("toolDetail.genImageSize", { size: String(a.size) }));
    return parts.join(" \xb7 ");
  },
  ask_user: (t, a) => t("toolDetail.askUser", { question: str(a.question) || str(a.message) || "…" }),
  channel_send_file: (t, a) => t("toolDetail.sendFile", { name: str(a.path) ? basename(str(a.path)) : t("toolDetail.unknown") }),
  recall_tool_call: (t, a) => t("toolDetail.recallToolCall", { id: str(a.callId) || "…" }),
  recall_range: (t) => t("toolDetail.recallRange"),
  inspect_session: (t, a) => t("toolDetail.inspectSession", { id: str(a.sessionId) || t("toolDetail.current") }),
  read_session_log: (t) => t("toolDetail.readSessionLog"),
  nudge_session: (t, a) => t("toolDetail.nudgeSession", { message: shorten(str(a.message) || "", 40) }),

  // File operations
  write_file: (t, a) => t("toolDetail.writeFile", { name: str(a.path) ? basename(str(a.path)) : t("toolDetail.unknown") }),
  read_file: (t, a) => t("toolDetail.readFile", { name: str(a.path) ? basename(str(a.path)) : t("toolDetail.unknown") }),
  edit_file: (t, a) => t("toolDetail.editFile", { name: str(a.path) ? basename(str(a.path)) : t("toolDetail.unknown") }),
  delete_file: (t, a) => t("toolDetail.deleteFile", { name: str(a.path) ? basename(str(a.path)) : t("toolDetail.unknown") }),
  list_files: (t, a) => t("toolDetail.listDir", { path: str(a.path) || "." }),
  create_directory: (t, a) => t("toolDetail.createDir", { path: str(a.path) || t("toolDetail.unknown") }),
  list_dir: (t, a) => t("toolDetail.listDir", { path: str(a.path) || "." }),

  // Sync
  sync_up: (t, a) => t("toolDetail.uploadFile", { name: str(a.path || a.localPath) ? basename(str(a.path || a.localPath)) : t("toolDetail.unknown") }),
  sync_down: (t, a) => t("toolDetail.downloadFile", { name: str(a.path || a.remotePath) ? basename(str(a.path || a.remotePath)) : t("toolDetail.unknown") }),

  // Exec
  exec: (t, a) => {
    const cmd = str(a.command);
    return cmd ? t("toolDetail.execCmdDetail", { cmd: shorten(cmd, 80) }) : t("toolDetail.execCmd");
  },
  shell_exec: (t, a) => {
    const cmd = str(a.command);
    return cmd ? t("toolDetail.execCmdDetail", { cmd: shorten(cmd, 80) }) : t("toolDetail.execCmd");
  },

  // Web
  web_search: (t, a) => t("toolDetail.webSearch", { query: str(a.query) || "…" }),
  web_fetch: (t, a) => {
    const u = str(a.url);
    try {
      const host = new URL(u).hostname;
      return t("toolDetail.webFetchHost", { host });
    } catch { /* */ }
    return t("toolDetail.webFetchUrl", { url: shorten(u, 40) });
  },

  // Database
  ds_query: (t, a) => {
    const src = str(a.source || a.connection);
    const q = shorten(str(a.query || a.sql) || "", 60);
    return src
      ? t("toolDetail.dbQuery", { source: src, query: q })
      : t("toolDetail.dbQueryPlain", { query: q });
  },
  ds_execute: (t, a) => {
    const src = str(a.source || a.connection);
    const q = shorten(str(a.query || a.sql) || "", 60);
    return src
      ? t("toolDetail.dbExec", { source: src, query: q })
      : t("toolDetail.dbExecPlain", { query: q });
  },
  ds_schema: (t, a) => t("toolDetail.dbSchema", { source: str(a.source || a.name) || t("toolDetail.all") }),
  ds_list: (t) => t("toolDetail.dbList"),
  ds_panel: (t, a) => t("toolDetail.dbPanel", { query: shorten(str(a.query || a.sql) || "", 40) }),

  // Knowledge
  wiki_search: (t, a) => t("toolDetail.wikiSearch", { query: str(a.query) || "…" }),
  wiki_read: (t, a) => t("toolDetail.wikiRead", { page: str(a.page || a.path) || "…" }),
  memory_search: (t, a) => t("toolDetail.memorySearch", { query: str(a.query) || "…" }),
  memory_read: (t, a) => t("toolDetail.memoryRead", { key: str(a.key || a.path) || "…" }),

  // Config
  tenant_config_read: (t, a) => t("toolDetail.configRead", { path: str(a.path) || "…" }),
  tenant_config_write: (t, a) => t("toolDetail.configWrite", { path: str(a.path) || "…" }),
  tenant_config_list: (t) => t("toolDetail.configList"),
  model_list: (t) => t("toolDetail.modelList"),
  task_list_workers: (t) => t("toolDetail.workerList"),

  // Tasks
  task_create: (t, a) => t("toolDetail.taskCreate", { title: str(a.title) || "…" }),
  task_list: (t, a) => {
    const status = str(a.status);
    return status ? t("toolDetail.taskListStatus", { status }) : t("toolDetail.taskList");
  },
  task_update: (t, a) => t("toolDetail.taskUpdate", { title: str(a.title) || str(a.taskId) || "…" }),

  // Cron
  cron_list: (t) => t("toolDetail.cronList"),
  cron_create: (t, a) => t("toolDetail.cronCreate", { name: str(a.name) || "…" }),
  cron_delete: (t, a) => t("toolDetail.cronDelete", { name: str(a.name || a.id) || "…" }),

  // Board
  board_create: (t) => t("toolDetail.boardCreate"),
  board_update: (t) => t("toolDetail.boardUpdate"),
  board_render: (t) => t("toolDetail.boardRender"),

  // Code
  code_interpreter: (t) => t("toolDetail.codeInterpreter"),
  python: (t) => t("toolDetail.python"),
};

/**
 * Human-readable description of a tool call's arguments.
 * Used in the expanded detail view instead of raw key-value dump.
 * Returns undefined when no formatter is registered — caller
 * falls back to formatArgsText().
 */
export function humanizeArgs(name: string, args: Args, t: T = translate): string | undefined {
  const normalized = normalizeBridgeName(name);
  // Bridge exec uses the exec formatter
  if (/exec$/i.test(normalized) && ARGS_MAP.exec) {
    return ARGS_MAP.exec(t, args);
  }
  const fn = ARGS_MAP[normalized];
  return fn ? fn(t, args) : undefined;
}

// ── Render-type inference ───────────────────────────────────────

/**
 * UI render hint for a tool call's expanded detail view.
 *
 * - `"terminal"` — faux-terminal: `$ command` + stdout/stderr.
 * - `"markdown"` — render result text as Markdown.
 * - `"json"`     — syntax-highlighted JSON viewer.
 * - `"image"`    — inline image(s) from result.
 * - `"plain"`    — monospace pre block (default).
 */
export type ToolRenderType = "terminal" | "markdown" | "json" | "image" | "file" | "plain";

/**
 * Infer how a tool call's detail view should render based on the
 * tool name. Later this can read a server-supplied hint; for now
 * it pattern-matches against known tool-name conventions.
 */
export function inferRender(name: string): ToolRenderType {
  const n = normalizeBridgeName(name);
  // exec-style tools → terminal
  if (/exec$/i.test(n) || n === "shell_exec") return "terminal";
  // web search / fetch → markdown (results are readable text)
  if (/^web_search$|^web_fetch$/i.test(n)) return "markdown";
  // file read/write/edit → file viewer
  if (/^(read_file|write_file|edit_file|delete_file)$/i.test(n)) return "file";
  // directory listing → plain
  if (/^(list_dir|list_files|create_dir|create_directory)$/i.test(n)) return "plain";
  // generate_image / screenshot → image (handled separately)
  if (/generate_image|screenshot/i.test(name)) return "image";
  // default
  return "plain";
}

// ── File content helpers (used by ToolCallDetail renderer) ──────

/** Try to decode base64 to UTF-8 text. Returns undefined for binary / invalid. */
export function decodeBase64Text(b64: string, maxBytes = 50000): string | undefined {
  if (!b64 || b64.length > maxBytes * 1.4) return undefined; // rough size guard
  try {
    const raw = atob(b64);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    // Reject binary: control chars other than \t \n \r
    if (bytes.some((b) => b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b))) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Map file extension to syntax-highlight language hint. */
export function extToLang(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
    html: "html", css: "css", scss: "scss", less: "less",
    md: "markdown", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
    swift: "swift", kt: "kotlin", lua: "lua", php: "php", r: "r",
    dockerfile: "dockerfile", makefile: "makefile",
    txt: "text", log: "text", csv: "text", tsv: "text", env: "text",
  };
  return map[ext] || "text";
}

/** Extract file content from tool call args (bridge or direct). */
export function extractFileContent(args: Args): string | undefined {
  // Bridge write_file: base64 param
  const b64 = str(args.base64);
  if (b64) return decodeBase64Text(b64);
  // Direct write: content param
  const content = str(args.content);
  if (content) return content;
  return undefined;
}

/** Extract file content from tool result (read_file response). */
export function extractFileResultContent(resultText: string): { filename: string; bytes: number; content?: string } | undefined {
  try {
    const parsed = JSON.parse(resultText.trim());
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (!("path" in parsed && "bytes" in parsed)) return undefined;
    const p = typeof parsed.path === "string" ? parsed.path : "";
    const b = typeof parsed.bytes === "number" ? parsed.bytes : 0;
    const fname = p.split("/").pop() || p;
    // Try decoding base64 content
    if (typeof parsed.base64 === "string" && parsed.base64.length > 0) {
      const decoded = decodeBase64Text(parsed.base64);
      if (decoded) return { filename: fname, bytes: b, content: decoded };
    }
    return { filename: fname, bytes: b };
  } catch {
    return undefined;
  }
}
