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
  // db
  "no tenants yet (will be created on first start)": "尚无租户（首次启动时自动创建）",
  "no active tenants":                          "无活跃租户",
  // network
  "Development checkout — service checks skipped": "开发模式 — 跳过服务检查",
  // providers
  "no providers configured":                    "未配置任何提供方",
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
  "ProgramArguments binary matches current CLI": "ProgramArguments 可执行文件与当前 CLI 匹配",
  "ProgramArguments binary mismatch":           "ProgramArguments 可执行文件不匹配",
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
  // compaction
  "auto-compaction disabled (models.compaction.enabled=false)": "自动压缩已禁用 (models.compaction.enabled=false)",
  "compaction configured (defaults: reserveTokens=16384, keepRecentTokens=20000)": "压缩已配置（默认：reserveTokens=16384, keepRecentTokens=20000）",
};

// Dynamic line text patterns: [startsWith, replacement prefix]
const LINE_PREFIXES: Array<[string, string]> = [
  ["Server up on :",                   "服务运行中，端口 :"],
  ["Server port ",                     "服务端口 "],
  ["Port ",                            "端口 "],
  ["Web port ",                        "Web 端口 "],
  ["config.json loaded",               "config.json 已加载"],
  ["Node ",                            "Node "],
  ["v",                                "v"], // version lines pass through
];

// Suffix patterns for dynamic texts
const LINE_SUFFIXES: Array<[string, string]> = [
  [" free",                            " 空闲"],
  [" in use, no HTTP response",        " 已占用，无 HTTP 响应"],
  [" owned by another process",        " 被其他进程占用"],
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

  // Prefix match (group titles)
  // already handled by tTitle

  // Dynamic texts — try prefix + suffix patterns
  for (const [prefix, zhPrefix] of LINE_PREFIXES) {
    if (text.startsWith(prefix)) {
      const rest = text.slice(prefix.length);
      // Check if suffix also matches
      for (const [suffix, zhSuffix] of LINE_SUFFIXES) {
        if (rest.endsWith(suffix)) {
          const mid = rest.slice(0, rest.length - suffix.length);
          return zhPrefix + mid + zhSuffix;
        }
      }
      return zhPrefix + rest;
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
