// Doctor panel i18n — lightweight translation layer.
//
// Reads locale from the same localStorage key as the main app
// (tianshu.locale). Falls back to browser language detection.
//
// Two layers:
//   1. UI strings — hard-coded labels in the panel chrome
//   2. Server text — group titles and common check-line texts
//      returned by the /api/p/doctor/check endpoint.
//
// Dynamic texts containing ports, model IDs, paths etc. pass
// through untranslated — the diagnostic detail is still useful
// in English and the setup agent understands both languages.

type Locale = "en" | "zh";

function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem("tianshu.locale");
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    // localStorage unavailable
  }
  if (typeof navigator !== "undefined") {
    const lang = (navigator.language || "").toLowerCase();
    if (lang.startsWith("zh")) return "zh";
  }
  return "en";
}

let locale: Locale | null = null;
function getLocale(): Locale {
  if (!locale) locale = detectLocale();
  return locale;
}

// ── UI strings (panel chrome) ──────────────────────────────────

const UI: Record<string, Record<Locale, string>> = {
  "panel.title":          { en: "System Doctor",        zh: "系统诊断" },
  "panel.recheck":        { en: "Re-check",             zh: "重新检查" },
  "panel.checking":       { en: "Checking…",            zh: "检查中…" },
  "panel.running":        { en: "Running diagnostics…", zh: "正在诊断…" },
  "panel.healthy":        { en: "Healthy ✓",            zh: "一切正常 ✓" },
  "panel.usable":         { en: "Usable, with caveats", zh: "可用，但有注意事项" },
  "panel.incomplete":     { en: "Setup incomplete",     zh: "配置未完成" },
  "panel.fix":            { en: "fix",                  zh: "修复" },
  "pin.header":           { en: "Doctor found an issue in", zh: "Doctor 在以下模块发现问题：" },
  "pin.footer":           { en: "Please diagnose and fix this.", zh: "请诊断并修复。" },
};

export function t(key: string): string {
  const entry = UI[key];
  if (!entry) return key;
  return entry[getLocale()] ?? entry.en ?? key;
}

// ── Server text translation ────────────────────────────────────

// Group titles (exact match)
const GROUP_TITLES: Record<string, string> = {
  "Authentication":       "身份认证",
  "Config files":         "配置文件",
  "Tenant DBs":           "租户数据库",
  "Network & service":    "网络与服务",
  "LLM providers":        "LLM 提供方",
  "Runtime":              "运行环境",
  "Sandbox":              "沙箱",
  "Service":              "服务管理",
  "Tenants & plugins":    "租户与插件",
  "Tianshu version":      "天枢版本",
};

// Dynamic group title prefixes
const GROUP_PREFIXES: Array<[string, string]> = [
  ["Tenant: ",  "租户："],
  ["Plugin: ",  "插件："],
];

// Common check-line texts (exact match)
const LINE_TEXTS: Record<string, string> = {
  // auth
  "disabled (open dev mode — no login wall)":   "已关闭（开放开发模式，无登录门槛）",
  "enabled (sign-in required)":                 "已开启（需要登录）",
  "sessionSecret resolves":                     "会话密钥已配置",
  "auth.sessionSecret is empty / unresolved":   "auth.sessionSecret 为空或未解析",
  "no super-admin configured":                  "未配置超级管理员",
  "no way to log in":                           "无可用登录方式",
  "a superAdmins entry has an empty username":  "超级管理员条目中有空用户名",
  "auth.db present":                            "auth.db 已存在",
  "auth.db not created yet (created on first start)": "auth.db 尚未创建（首次启动时自动创建）",
  "failed to read auth config":                 "读取认证配置失败",
  // config
  "HOME environment variable not set":          "HOME 环境变量未设置",
  "config.json failed to load":                 "config.json 加载失败",
  "config.json exists & parses":                "config.json 存在且解析正常",
  "config.json present but invalid JSON":       "config.json 存在但 JSON 格式无效",
  "config.json missing":                        "config.json 缺失",
  "TIANSHU_HOME does not exist yet":            "TIANSHU_HOME 目录尚不存在",
  // db
  "no tenants yet (will be created on first start)": "尚无租户（首次启动时自动创建）",
  "no active tenants":                          "无活跃租户",
  // network
  "Development checkout — service checks skipped": "开发模式 — 跳过服务检查",
  // providers
  "no providers configured":                    "未配置任何提供方",
  "defaultModelId resolves":                    "defaultModelId 已配置",
  "defaultModelId references unknown provider": "defaultModelId 引用了未知提供方",
  "no explicit defaultModelId — auto-pick from catalog": "未设置 defaultModelId — 从模型目录自动选择",
  "auto-compaction disabled (models.compaction.enabled=false)": "自动压缩已禁用 (models.compaction.enabled=false)",
  "compaction configured (defaults: reserveTokens=16384, keepRecentTokens=20000)": "压缩已配置（默认值：reserveTokens=16384, keepRecentTokens=20000）",
  // runtime
  "GlobalOps failed to initialise":             "GlobalOps 初始化失败",
  // sandbox
  "microsandbox SDK loaded":                    "microsandbox SDK 已加载",
  "microsandbox SDK not available":             "microsandbox SDK 不可用",
  "microsandbox SDK loaded but Sandbox class missing": "microsandbox SDK 已加载但 Sandbox 类缺失",
  "alpine quick-boot succeeded":                "Alpine 快速启动成功",
  "alpine quick-boot failed":                   "Alpine 快速启动失败",
  // service
  "Could not determine install path":           "无法确定安装路径",
  "Cannot read plist file":                     "无法读取 plist 文件",
  "Cannot read systemd unit file":              "无法读取 systemd unit 文件",
  "Cannot parse ProgramArguments from plist":   "无法解析 plist 中的 ProgramArguments",
  "Plist missing WorkingDirectory":             "plist 缺少 WorkingDirectory",
  "ProgramArguments binary matches current CLI": "ProgramArguments 与当前 CLI 匹配",
  "ProgramArguments binary mismatch":           "ProgramArguments 不匹配",
  "ExecStart binary matches":                   "ExecStart 可执行文件匹配",
  "ExecStart binary mismatch":                  "ExecStart 可执行文件不匹配",
  "WorkingDirectory matches":                   "WorkingDirectory 匹配",
  "WorkingDirectory matches current install":   "WorkingDirectory 与当前安装匹配",
  "WorkingDirectory mismatch":                  "WorkingDirectory 不匹配",
  "Service loaded but not running":             "服务已加载但未运行",
  "Service not loaded":                         "服务未加载",
  // tenants
  "couldn't enumerate plugins":                 "无法枚举插件",
  "no tenants on disk":                         "磁盘上无租户",
  // version
  "Couldn't reach npm registry to check for updates": "无法连接 npm 仓库检查更新",
};

// Regex-based pattern translations: [pattern, replacer]
// Order matters — first match wins.
const LINE_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  // runtime
  [/^Node (.+) is too old$/, (m) => `Node ${m[1]} 版本过低`],
  [/^Node (.+)$/, (m) => `Node ${m[1]}`],
  [/^HOME=(.+)$/, (m) => `HOME=${m[1]}`],
  [/^(.+) (\S+) \((.+)\)$/, (m) => {
    // "darwin 27.0.0 (arm64)" — platform line, pass through
    if (["darwin", "linux", "win32"].includes(m[1])) return `${m[1]} ${m[2]} (${m[3]})`;
    return "";
  }],
  // version
  [/^Tianshu (.+) \(git checkout\)$/, (m) => `天枢 ${m[1]}（Git 源码）`],
  [/^Tianshu (.+)$/, (m) => `天枢 ${m[1]}`],
  [/^Up to date with npm `latest` \((.+)\)$/, (m) => `已是最新版（npm latest: ${m[1]}）`],
  [/^Update available: (.+) → (.+)$/, (m) => `可更新：${m[1]} → ${m[2]}`],
  // config
  [/^TIANSHU_HOME$/, () => "TIANSHU_HOME"],
  // network
  [/^Server up on :(.+)$/, (m) => `服务运行中，端口 :${m[1]}`],
  [/^Server port (\d+) free$/, (m) => `服务端口 ${m[1]} 空闲`],
  [/^Port (\d+) owned by another process$/, (m) => `端口 ${m[1]} 被其他进程占用`],
  [/^Port (\d+) in use, no HTTP response$/, (m) => `端口 ${m[1]} 已占用，无 HTTP 响应`],
  [/^Web port (\d+) free$/, (m) => `Web 端口 ${m[1]} 空闲`],
  [/^Web port (\d+) in use$/, (m) => `Web 端口 ${m[1]} 已占用`],
  [/^Web UI on (.+)$/, (m) => `Web UI 地址：${m[1]}`],
  // providers — dynamic provider names
  [/^(.+) reachable$/, (m) => `${m[1]} 可达`],
  [/^(.+) configured \(probe skipped — local\/custom endpoint\)$/, (m) => `${m[1]} 已配置（跳过探测 — 本地/自定义端点）`],
  [/^(.+) configured$/, (m) => `${m[1]} 已配置`],
  [/^(.+): API key not set$/, (m) => `${m[1]}：API 密钥未设置`],
  [/^(.+): `api` field missing$/, (m) => `${m[1]}：缺少 \`api\` 字段`],
  [/^(.+): unknown `api` value "(.+)"$/, (m) => `${m[1]}：未知 \`api\` 值 "${m[2]}"`],
  [/^provider "(.+)" configured$/, (m) => `提供方 "${m[1]}" 已配置`],
  [/^provider "(.+)": (.+)$/, (m) => `提供方 "${m[1]}"：${m[2]}`],
  [/^(\d+) model\(s\) missing contextWindow$/, (m) => `${m[1]} 个模型缺少 contextWindow`],
  [/^compaction: reserveTokens=(\d+), keepRecentTokens=(\d+)$/, (m) => `上下文压缩：reserveTokens=${m[1]}, keepRecentTokens=${m[2]}`],
  [/^compaction\.reserveTokens=(\d+) is very low$/, (m) => `compaction.reserveTokens=${m[1]} 过低`],
  [/^compaction\.keepRecentTokens=(\d+) is very low$/, (m) => `compaction.keepRecentTokens=${m[1]} 过低`],
  // service
  [/^(.+) service installed: (.+)$/, (m) => `${m[1]} 服务已安装：${m[2]}`],
  [/^No (.+) service installed \((.+)\)$/, (m) => `未安装 ${m[1]} 服务（${m[2]}）`],
  [/^Service running \(PID (\d+)\)$/, (m) => `服务运行中（PID ${m[1]}）`],
  [/^Could not load (.+) backend$/, (m) => `无法加载 ${m[1]} 后端`],
  [/^Platform (.+) — no service backend$/, (m) => `平台 ${m[1]} — 无服务后端`],
  // db
  [/^(.+): db\.sqlite missing$/, (m) => `${m[1]}：db.sqlite 缺失`],
  [/^(.+): failed to open$/, (m) => `${m[1]}：打开失败`],
  // auth
  [/^OAuth super-admin: (.+)$/, (m) => `OAuth 超级管理员：${m[1]}`],
  [/^super-admin "(.+)" ready$/, (m) => `超级管理员 "${m[1]}" 就绪`],
  [/^super-admin "(.+)": password empty \/ unresolved$/, (m) => `超级管理员 "${m[1]}"：密码为空或未解析`],
  // tenants
  [/^defaultModel override: (.+)$/, (m) => `默认模型覆盖：${m[1]}`],
  [/^  users \((\d+)\): (.*)$/, (m) => `  用户 (${m[1]})：${m[2] || "（无）"}`],
  [/^  enabled plugins \((\d+)\): (.*)$/, (m) => `  已启用插件 (${m[1]})：${m[2] || "（无）"}`],
  [/^  disabled plugins \((\d+)\): (.+)$/, (m) => `  已禁用插件 (${m[1]})：${m[2]}`],
  [/^  unknown plugins in config \((\d+)\): (.+)$/, (m) => `  配置中的未知插件 (${m[1]})：${m[2]}`],
  [/^  workboard: no defaultModel resolvable for this tenant$/, () => "  工作板：该租户无法解析 defaultModel"],
  [/^  worker '(.+)': pinned model (.+)$/, (m) => `  工作线程 '${m[1]}'：固定模型 ${m[2]}`],
  [/^  worker '(.+)': pinned model not in catalog$/, (m) => `  工作线程 '${m[1]}'：固定模型不在目录中`],
  [/^  worker '(.+)': inherits (.+)$/, (m) => `  工作线程 '${m[1]}'：继承 ${m[2]}`],
  [/^  worker '(.+)': no model resolvable$/, (m) => `  工作线程 '${m[1]}'：无法解析模型`],
  [/^  deprecated 'worker' field set \(keys: (.+)\)$/, (m) => `  已弃用的 'worker' 字段仍存在（keys: ${m[1]}）`],
  [/^  (.+): contextWindow not set$/, (m) => `  ${m[1]}：未设置 contextWindow`],
  [/^  (.+): contextWindow=(\d+) below known ceiling$/, (m) => `  ${m[1]}：contextWindow=${m[2]} 低于已知上限`],
  [/^  (.+): maxTokens \((\d+)\) > contextWindow \((\d+)\)$/, (m) => `  ${m[1]}：maxTokens (${m[2]}) 超过 contextWindow (${m[3]})`],
  [/^  (.+): maxTokens not set$/, (m) => `  ${m[1]}：未设置 maxTokens`],
  [/^  (.+): maxTokens=(\d+) looks low$/, (m) => `  ${m[1]}：maxTokens=${m[2]} 偏低`],
  [/^  (.+): maxTokens=(\d+) below known ceiling$/, (m) => `  ${m[1]}：maxTokens=${m[2]} 低于已知上限`],
  [/^  (.+): missing compat\.supportsDeveloperRole: false$/, (m) => `  ${m[1]}：缺少 compat.supportsDeveloperRole: false`],
];

/**
 * Translate a server-returned text string. Returns the original
 * if no translation is found (dynamic texts with variables pass
 * through gracefully).
 */
export function tText(text: string): string {
  if (getLocale() === "en") return text;

  // Exact match
  const exact = LINE_TEXTS[text];
  if (exact) return exact;

  // Regex pattern match
  for (const [re, fn] of LINE_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const result = fn(m);
      // Empty string means "pass through" (platform line fallback)
      return result || text;
    }
  }

  return text;
}

/**
 * Translate a group title.
 */
export function tTitle(title: string): string {
  if (getLocale() === "en") return title;

  const exact = GROUP_TITLES[title];
  if (exact) return exact;

  for (const [prefix, zhPrefix] of GROUP_PREFIXES) {
    if (title.startsWith(prefix)) {
      return zhPrefix + title.slice(prefix.length);
    }
  }

  return title;
}
