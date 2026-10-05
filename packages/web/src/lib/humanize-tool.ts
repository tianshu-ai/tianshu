/**
 * Translate raw tool call (name + args) into a short human-readable
 * sentence that non-technical users can understand.
 *
 * Returns undefined when no good mapping exists — caller falls back
 * to the raw tool name.
 */

type Args = Record<string, unknown>;

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

/** Extract a meaningful fragment from a shell command string. */
function commandHint(cmd: string): string {
  const c = cmd.trim();
  // pip / npm / yarn install
  if (/\b(pip3?|npm|yarn|pnpm)\s+install\b/i.test(c)) return "安装依赖";
  // git operations
  if (/\bgit\s+clone\b/i.test(c)) return "克隆仓库";
  if (/\bgit\s+pull\b/i.test(c)) return "拉取更新";
  if (/\bgit\s+push\b/i.test(c)) return "推送代码";
  if (/\bgit\s+commit\b/i.test(c)) return "提交变更";
  if (/\bgit\s+checkout\b/i.test(c)) return "切换分支";
  // python / node script
  if (/\b(python3?|node)\s+/i.test(c)) return "运行脚本";
  // curl / wget
  if (/\b(curl|wget)\s+/i.test(c)) return "请求网络资源";
  // cat / echo to file
  if (/\bcat\s+>/.test(c)) return "写入文件";
  // mkdir
  if (/\bmkdir\b/.test(c)) return "创建目录";
  // rm
  if (/\brm\b/.test(c)) return "删除文件";
  // ls / dir
  if (/\b(ls|dir)\b/.test(c)) return "列出文件";
  // cd
  if (/\bcd\b/.test(c)) return "切换目录";
  // docker
  if (/\bdocker\b/i.test(c)) return "执行 Docker 操作";
  // generic — first word
  const first = c.split(/\s+/)[0];
  return `运行 ${shorten(first, 20)}`;
}

// ── Main mapping table ────────────────────────────────────
type Humanizer = (args: Args) => string;

const TOOL_MAP: Record<string, Humanizer> = {
  // File operations
  write_file: (a) => {
    const p = str(a.path);
    return p ? `写入 ${shorten(basename(p))}` : "写入文件";
  },
  read_file: (a) => {
    const p = str(a.path);
    return p ? `读取 ${shorten(basename(p))}` : "读取文件";
  },
  edit_file: (a) => {
    const p = str(a.path);
    return p ? `编辑 ${shorten(basename(p))}` : "编辑文件";
  },
  delete_file: (a) => {
    const p = str(a.path);
    return p ? `删除 ${shorten(basename(p))}` : "删除文件";
  },
  list_files: () => "浏览文件列表",
  create_directory: (a) => {
    const p = str(a.path);
    return p ? `创建目录 ${shorten(basename(p))}` : "创建目录";
  },

  // Sync / bridge
  sync_up: (a) => {
    const p = str(a.path || a.localPath);
    return p ? `上传 ${shorten(basename(p))}` : "上传文件到服务器";
  },
  sync_down: (a) => {
    const p = str(a.path || a.remotePath);
    return p ? `下载 ${shorten(basename(p))}` : "从服务器下载文件";
  },

  // Shell exec
  exec: (a) => {
    const cmd = str(a.command);
    return cmd ? commandHint(cmd) : "执行命令";
  },
  shell_exec: (a) => {
    const cmd = str(a.command);
    return cmd ? commandHint(cmd) : "执行命令";
  },

  // Search & web
  web_search: (a) => {
    const q = str(a.query);
    return q ? `搜索「${shorten(q, 20)}」` : "搜索网页";
  },
  web_fetch: (a) => {
    const u = str(a.url);
    try {
      const host = new URL(u).hostname;
      return `获取 ${host} 内容`;
    } catch { /* */ }
    return "获取网页内容";
  },

  // Code interpreter / analysis
  code_interpreter: () => "运行代码分析",
  python: () => "运行 Python 代码",

  // Database
  ds_query: (a) => {
    const src = str(a.source || a.connection);
    return src ? `查询数据库 ${shorten(src, 16)}` : "查询数据库";
  },
  ds_execute: (a) => {
    const src = str(a.source || a.connection);
    return src ? `执行数据库操作 ${shorten(src, 16)}` : "执行数据库操作";
  },
  ds_schema: () => "查看数据库结构",
  ds_list: () => "列出数据源",
  ds_panel: () => "推送到数据面板",

  // Knowledge / memory
  wiki_search: (a) => {
    const q = str(a.query);
    return q ? `搜索知识库「${shorten(q, 16)}」` : "搜索知识库";
  },
  wiki_read: () => "读取知识库",
  memory_search: () => "搜索记忆",
  memory_read: () => "读取记忆",

  // Image generation
  generate_image: (a) => {
    const p = str(a.prompt);
    return p ? `生成图片：${shorten(p, 24)}` : "生成图片";
  },

  // Configuration
  tenant_config_read: () => "读取配置",
  tenant_config_write: () => "更新配置",
  tenant_config_list: () => "列出配置项",
  model_list: () => "查看可用模型",
  task_list_workers: () => "查看工作者状态",

  // Cron / scheduling
  cron_list: () => "查看定时任务",
  cron_create: () => "创建定时任务",
  cron_delete: () => "删除定时任务",

  // Board / workboard
  board_create: () => "创建看板",
  board_update: () => "更新看板",
  board_render: () => "渲染看板",
};

// ── Bridge tool name normalizer ───────────────────────────
// Bridge tools arrive as `bridge_<host>_local_<actual>`, e.g.
// `bridge_yuyudemac_studio_local_exec`.
function normalizeBridgeName(name: string): string {
  const m = name.match(/^bridge_.*?_local_(.+)$/);
  return m ? m[1] : name;
}

// ── Public API ────────────────────────────────────────────

export function humanizeToolCall(
  name: string,
  args: Args,
): string {
  const normalized = normalizeBridgeName(name);
  const fn = TOOL_MAP[normalized];
  if (fn) return fn(args);
  // Fallback: return undefined-ish — caller shows raw name
  return "";
}

/**
 * Summarize a group of tool calls into one sentence.
 * e.g. "安装依赖 → 运行脚本 → 上传文件"
 */
export function humanizeToolGroup(
  calls: { name: string; arguments: Args; result?: { ok?: boolean } }[],
): string {
  // Deduplicate consecutive identical summaries
  const summaries: string[] = [];
  for (const c of calls) {
    const h = humanizeToolCall(c.name, c.arguments);
    const label = h || normalizeBridgeName(c.name);
    if (summaries.length === 0 || summaries[summaries.length - 1] !== label) {
      summaries.push(label);
    }
  }
  // Cap at 4 steps to avoid overflow
  if (summaries.length > 4) {
    return summaries.slice(0, 3).join(" → ") + ` → …共 ${calls.length} 步`;
  }
  return summaries.join(" → ");
}
