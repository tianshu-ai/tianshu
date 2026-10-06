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
    // First step … last two steps
    return summaries[0] + " → […] → " + summaries.slice(-2).join(" → ") + "  (" + calls.length + " steps)";
  }
  return summaries.join(" → ");
}

// ── Humanized args for expanded detail view ─────────────────

type ArgsFormatter = (args: Args) => string;

/** Per-tool formatters that turn raw args into readable text. */
const ARGS_MAP: Record<string, ArgsFormatter> = {
  // Host tools
  compact_context: () => "压缩对话上下文",
  tool_catalog_refresh: (a) => `刷新工具目录` + (str(a.mode) ? ` (模式: ${a.mode})` : ""),
  switch_panel: (a) => `切换面板: ${str(a.panel) || "未知"}`,
  solution: (a) => {
    const action = str(a.action);
    const slug = str(a.slug);
    if (action === "active") return "查看当前激活方案";
    if (action === "get" && slug) return `获取方案: ${slug}`;
    if (action === "save") return `保存方案: ${slug || "新方案"}`;
    if (action === "list") return "列出所有方案";
    if (action === "activate" && slug) return `激活方案: ${slug}`;
    if (action === "delete" && slug) return `删除方案: ${slug}`;
    return `方案操作: ${action || "未知"}`;
  },
  generate_image: (a) => {
    const p = str(a.prompt);
    const parts = ["生成图片"];
    if (p) parts.push(`描述: ${shorten(p, 60)}`);
    if (str(a.style)) parts.push(`风格: ${a.style}`);
    if (str(a.size)) parts.push(`尺寸: ${a.size}`);
    return parts.join(" \xb7 ");
  },
  ask_user: (a) => `询问用户: ${str(a.question) || str(a.message) || "…"}`,
  channel_send_file: (a) => `发送文件: ${str(a.path) ? basename(str(a.path)!) : "未知"}`,
  recall_tool_call: (a) => `回顾工具调用: ${str(a.callId) || "…"}`,
  recall_range: () => "回顾历史消息",
  inspect_session: (a) => `检查会话: ${str(a.sessionId) || "当前"}`,
  read_session_log: () => "读取会话日志",
  nudge_session: (a) => `唤醒会话: ${shorten(str(a.message) || "", 40)}`,

  // File operations
  write_file: (a) => `写入文件: ${str(a.path) ? basename(str(a.path)!) : "未知"}`,
  read_file: (a) => `读取文件: ${str(a.path) ? basename(str(a.path)!) : "未知"}`,
  edit_file: (a) => `编辑文件: ${str(a.path) ? basename(str(a.path)!) : "未知"}`,
  delete_file: (a) => `删除文件: ${str(a.path) ? basename(str(a.path)!) : "未知"}`,
  list_files: (a) => `列出目录: ${str(a.path) || "."}`,
  create_directory: (a) => `创建目录: ${str(a.path) || "未知"}`,
  list_dir: (a) => `列出目录: ${str(a.path) || "."}`,

  // Sync
  sync_up: (a) => `上传文件: ${str(a.path || a.localPath) ? basename(str(a.path || a.localPath)!) : "未知"}`,
  sync_down: (a) => `下载文件: ${str(a.path || a.remotePath) ? basename(str(a.path || a.remotePath)!) : "未知"}`,

  // Exec
  exec: (a) => {
    const cmd = str(a.command);
    return cmd ? `执行命令: ${shorten(cmd, 80)}` : "执行命令";
  },
  shell_exec: (a) => {
    const cmd = str(a.command);
    return cmd ? `执行命令: ${shorten(cmd, 80)}` : "执行命令";
  },

  // Web
  web_search: (a) => `搜索: ${str(a.query) || "…"}`,
  web_fetch: (a) => {
    const u = str(a.url);
    try { return `获取网页: ${new URL(u).hostname}`; } catch { /* */ }
    return `获取网页: ${shorten(u, 40)}`;
  },

  // Database
  ds_query: (a) => {
    const src = str(a.source || a.connection);
    const q = str(a.query || a.sql);
    return `查询数据库${src ? " " + src : ""}: ${shorten(q || "", 60)}`;
  },
  ds_execute: (a) => {
    const src = str(a.source || a.connection);
    return `执行 SQL${src ? " " + src : ""}: ${shorten(str(a.query || a.sql) || "", 60)}`;
  },
  ds_schema: (a) => `查看数据库 Schema: ${str(a.source || a.name) || "全部"}`,
  ds_list: () => "列出数据源",
  ds_panel: (a) => `推送到数据面板: ${shorten(str(a.query || a.sql) || "", 40)}`,

  // Knowledge
  wiki_search: (a) => `搜索知识库: ${str(a.query) || "…"}`,
  wiki_read: (a) => `读取知识页: ${str(a.page || a.path) || "…"}`,
  memory_search: (a) => `搜索记忆: ${str(a.query) || "…"}`,
  memory_read: (a) => `读取记忆: ${str(a.key || a.path) || "…"}`,

  // Config
  tenant_config_read: (a) => `读取配置: ${str(a.path) || "…"}`,
  tenant_config_write: (a) => `写入配置: ${str(a.path) || "…"}`,
  tenant_config_list: () => "列出配置",
  model_list: () => "列出可用模型",
  task_list_workers: () => "列出工作者",

  // Tasks
  task_create: (a) => `创建任务: ${str(a.title) || "…"}`,
  task_list: (a) => `列出任务${str(a.status) ? " (状态: " + a.status + ")" : ""}`,
  task_update: (a) => `更新任务: ${str(a.title) || str(a.taskId) || "…"}`,

  // Cron
  cron_list: () => "列出定时任务",
  cron_create: (a) => `创建定时任务: ${str(a.name) || "…"}`,
  cron_delete: (a) => `删除定时任务: ${str(a.name || a.id) || "…"}`,

  // Board
  board_create: () => "创建看板",
  board_update: () => "更新看板",
  board_render: () => "渲染看板",

  // Code
  code_interpreter: () => "运行代码分析",
  python: () => "运行 Python",
};

/**
 * Human-readable description of a tool call's arguments.
 * Used in the expanded detail view instead of raw key-value dump.
 * Returns undefined when no formatter is registered — caller
 * falls back to formatArgsText().
 */
export function humanizeArgs(name: string, args: Args): string | undefined {
  const normalized = normalizeBridgeName(name);
  // Bridge exec uses the exec formatter
  if (/exec$/i.test(normalized) && ARGS_MAP.exec) {
    return ARGS_MAP.exec(args);
  }
  const fn = ARGS_MAP[normalized];
  return fn ? fn(args) : undefined;
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
export type ToolRenderType = "terminal" | "markdown" | "json" | "image" | "plain";

/**
 * Infer how a tool call's detail view should render based on the
 * tool name. Later this can read a server-supplied hint; for now
 * it pattern-matches against known tool-name conventions.
 */
export function inferRender(name: string): ToolRenderType {
  // exec-style tools → terminal
  if (/exec$/i.test(name) || name === "shell_exec") return "terminal";
  // web search / fetch → markdown (results are readable text)
  if (/^web_search$|^web_fetch$/i.test(name)) return "markdown";
  // file read/write → plain
  if (/^(read_file|write_file|list_dir|create_dir)$/i.test(name)) return "plain";
  // generate_image / screenshot → image (handled separately)
  if (/generate_image|screenshot/i.test(name)) return "image";
  // default
  return "plain";
}
