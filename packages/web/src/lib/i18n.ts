// Lightweight i18n for the chat shell.
//
// Why a custom layer instead of react-i18next: the surface is
// tiny (UI affordances only — model output streams through
// untouched), the bundle savings matter for the chat shell, and
// the closed-source predecessor used the same pattern. When we
// outgrow it we'll swap in a richer library; until then keep it
// simple.
//
// Locales:
//   - en  English
//   - zh  Simplified Chinese
//
// Persistence: window.localStorage["tianshu.locale"]. We don't
// negotiate from navigator.language to avoid surprising users who
// already chose; first-run defaults from the browser preference.
//
// Reactivity: components subscribe through useT() (see hooks/useT).
// Every setLocale() call bumps a version counter that the hook
// listens to so language changes re-render in place without a
// page reload.

export type Locale = "en" | "zh";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "zh"] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  zh: "中文",
};

const STORAGE_KEY = "tianshu.locale";

const STRINGS: Record<Locale, Record<string, string>> = {
  en: {
    // chat composer
    "chat.placeholder": "Message Tianshu — Enter to send, Shift+Enter for newline",
    "chat.stop": "Stop",
    "chat.send": "Send",
    "chat.waitingUploads": "Waiting for uploads to finish…",
    "chat.hideSidebar": "Hide sidebar",
    "chat.showSidebar": "Show sidebar",
    "chat.pluginManager": "Plugin Manager",
    "chat.openPluginManager": "Open Plugin Manager",
    "chat.loading": "Loading…",
    "chat.loadEarlier": "Load earlier messages",
    "chat.rateLimited": "Rate limited",
    "chat.authExpired": "Auth expired",
    "chat.connectionIssue": "Connection issue",
    "chat.retryIn": " — retrying in {s}s (attempt {a}/{max})",
    "chat.dismiss": "dismiss",
    "chat.compacted": "📌 Conversation history compacted ({mode}): {summarised} earlier messages summarised, {kept} kept verbatim.",
    "chat.compactAuto": "auto",
    "chat.compactManual": "manual",
    "chat.model": "Model:",
    "chat.readOnlyChannel": "Read-only · messages flow in from the channel",
    "chat.welcome": "Welcome to {name}",
    "chat.welcomeBody": "An open AI agent platform with a sidecar browser. Messages persist per-tenant.",
    "chat.connectionInterrupted": "Connection interrupted",
    "chat.retryInShort": " — retrying in {remaining} (attempt {a})",
    "chat.stopLower": "stop",
    // common
    "common.close": "Close",
    "common.save": "Save",
    "common.saving": "Saving…",
    "common.saved": "Saved",
    "common.reset": "Reset",
    "common.reload": "Reload",
    "common.refresh": "Refresh",
    "common.cancel": "Cancel",
    "common.create": "Create",
    "common.creating": "Creating…",
    "common.add": "Add",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.remove": "Remove",
    "common.enable": "Enable",
    "common.disable": "Disable",
    "common.clear": "Clear",
    "common.loading": "Loading…",
    "common.logOut": "Log out",
    // plugin manager
    "plugin.manager.title": "Plugin Manager",
    "plugin.tab.installed": "Installed",
    "plugin.tab.catalog": "Catalog",
    "plugin.refresh.installedTooltip": "Re-discover plugins on disk (after a manual install or git pull)",
    "plugin.refresh.catalogTooltip": "Re-fetch the catalog from the registry",
    "plugin.loading": "Loading…",
    "plugin.empty.title": "No plugins discovered for this tenant.",
    "plugin.catalog.fetching": "Fetching catalog…",
    "plugin.catalog.empty": "Catalog is empty.",
    "plugin.catalog.verified": "verified",
    "plugin.catalog.installTooltip": "Install lands in P2",
    "plugin.catalog.installed": "Installed",
    "plugin.catalog.install": "Install",
    "plugin.state.active": "active",
    "plugin.state.disabled": "disabled",
    "plugin.state.failed": "failed",
    "plugin.state.noClientBundle": "no client bundle",
    "plugin.toggle.disabledTooltip": "Plugin cannot be enabled in its current state",
    "plugin.toggle.disableTooltip": "Click to disable",
    "plugin.toggle.enableTooltip": "Click to enable",
    "plugin.config.empty": "This plugin has no user-editable configuration.",
    "plugin.config.secret.setBadge": "set",
    "plugin.config.secret.placeholderSet": "••• stored — type a new value to replace, or click Clear",
    // panels
    "panel.right.resizeAriaLabel": "Resize right panel",
    "panel.right.resizeTooltip": "Drag to resize (double-click to reset)",
    "panel.tab.close": "Close panel",
    // modal
    "modal.restore": "Restore",
    "modal.maximize": "Maximize",
    // file dialog
    "file.download": "Download",
    "file.error.notFound": "File not found.",
    // previews
    "preview.mode.render": "Render",
    "preview.mode.source": "Source",
    "preview.tooltip.viewSource": "View source",
    "preview.tooltip.livePreview": "Live preview",
    "preview.image.altFallback": "image",
    "preview.html.iframeTitle": "HTML preview",
    "preview.pdf.iframeTitle": "PDF preview",
    "viewer.binary": "Binary file. No preview available.",
    "viewer.noContent": "No content.",
    // login
    "login.title": "Sign in to Tianshu",
    "login.subtitle": "Choose a provider to continue.",
    "login.loading": "Loading…",
    "login.authDisabled": "Authentication is disabled.",
    "login.openApp": "Open the app",
    "login.username": "Username",
    "login.password": "Password",
    "login.signIn": "Sign in",
    "auth.signOut": "Sign out",
    "admin.title": "Settings",
    "lang.label": "Language",
    "user.role.member": "member",
    "user.role.admin": "admin",
    "user.role.dev": "dev",
    "user.theme": "Theme",
    "user.signOut": "Sign out",
    "user.switchTenant": "Switch tenant",
  },
  zh: {
    "chat.placeholder": "发消息给天枢 — Enter 发送，Shift+Enter 换行",
    "chat.stop": "停止",
    "chat.send": "发送",
    "chat.waitingUploads": "等待上传完成…",
    "chat.hideSidebar": "隐藏侧边栏",
    "chat.showSidebar": "显示侧边栏",
    "chat.pluginManager": "插件管理",
    "chat.openPluginManager": "打开插件管理",
    "chat.loading": "加载中…",
    "chat.loadEarlier": "加载更早的消息",
    "chat.rateLimited": "限流中",
    "chat.authExpired": "授权已过期",
    "chat.connectionIssue": "连接异常",
    "chat.retryIn": " — {s} 秒后重试（第 {a}/{max} 次）",
    "chat.dismiss": "关闭",
    "chat.compacted": "📌 对话历史已压缩（{mode}）：{summarised} 条早期消息已摘要，{kept} 条原样保留。",
    "chat.compactAuto": "自动",
    "chat.compactManual": "手动",
    "chat.model": "模型：",
    "chat.readOnlyChannel": "只读 · 消息从渠道流入",
    "chat.welcome": "欢迎使用 {name}",
    "chat.welcomeBody": "一个带 sidecar 浏览器的开放 AI agent 平台。消息按租户持久化保存。",
    "chat.connectionInterrupted": "连接中断",
    "chat.retryInShort": " — {remaining} 后重试（第 {a} 次）",
    "chat.stopLower": "停止",
    "common.close": "关闭",
    "common.save": "保存",
    "common.saving": "保存中…",
    "common.saved": "已保存",
    "common.reset": "重置",
    "common.reload": "重新加载",
    "common.refresh": "刷新",
    "common.cancel": "取消",
    "common.create": "创建",
    "common.creating": "创建中…",
    "common.add": "添加",
    "common.delete": "删除",
    "common.edit": "编辑",
    "common.remove": "移除",
    "common.enable": "启用",
    "common.disable": "停用",
    "common.clear": "清除",
    "common.loading": "加载中…",
    "common.logOut": "退出登录",
    "plugin.manager.title": "插件管理器",
    "plugin.tab.installed": "已安装",
    "plugin.tab.catalog": "插件市场",
    "plugin.refresh.installedTooltip": "重新扫描本地插件（手动安装或 git pull 后使用）",
    "plugin.refresh.catalogTooltip": "从注册中心重新获取插件市场列表",
    "plugin.loading": "加载中…",
    "plugin.empty.title": "当前租户下未发现任何插件。",
    "plugin.catalog.fetching": "正在获取插件市场…",
    "plugin.catalog.empty": "插件市场为空。",
    "plugin.catalog.verified": "已认证",
    "plugin.catalog.installTooltip": "安装功能将在 P2 阶段上线",
    "plugin.catalog.installed": "已安装",
    "plugin.catalog.install": "安装",
    "plugin.state.active": "已启用",
    "plugin.state.disabled": "已禁用",
    "plugin.state.failed": "已失败",
    "plugin.state.noClientBundle": "缺少客户端包",
    "plugin.toggle.disabledTooltip": "当前状态下无法启用该插件",
    "plugin.toggle.disableTooltip": "点击禁用",
    "plugin.toggle.enableTooltip": "点击启用",
    "plugin.config.empty": "该插件没有可由用户编辑的配置项。",
    "plugin.config.secret.setBadge": "已设置",
    "plugin.config.secret.placeholderSet": "••• 已存储 — 输入新值可替换，或点击“清除”",
    "panel.right.resizeAriaLabel": "调整右侧面板宽度",
    "panel.right.resizeTooltip": "拖动调整宽度（双击重置）",
    "panel.tab.close": "关闭面板",
    "modal.restore": "还原",
    "modal.maximize": "最大化",
    "file.download": "下载",
    "file.error.notFound": "文件未找到。",
    "preview.mode.render": "渲染",
    "preview.mode.source": "源码",
    "preview.tooltip.viewSource": "查看源码",
    "preview.tooltip.livePreview": "实时预览",
    "preview.image.altFallback": "图片",
    "preview.html.iframeTitle": "HTML 预览",
    "preview.pdf.iframeTitle": "PDF 预览",
    "viewer.binary": "二进制文件，无法预览。",
    "viewer.noContent": "无内容。",
    "login.title": "登录天枢",
    "login.subtitle": "请选择登录方式继续。",
    "login.loading": "加载中…",
    "login.authDisabled": "身份验证已关闭。",
    "login.openApp": "打开应用",
    "login.username": "用户名",
    "login.password": "密码",
    "login.signIn": "登录",
    "auth.signOut": "退出登录",
    "admin.title": "设置",
    "lang.label": "语言",
    "user.role.member": "成员",
    "user.role.admin": "管理员",
    "user.role.dev": "开发者",
    "user.theme": "主题",
    "user.signOut": "退出登录",
    "user.switchTenant": "切换租户",
  },
};

export type TranslationKey = keyof (typeof STRINGS)["en"];

let current: Locale = detectInitial();
const listeners = new Set<() => void>();

function detectInitial(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    // localStorage may be unavailable (private mode, SSR build);
    // fall through to browser-language detection.
  }
  if (typeof navigator !== "undefined") {
    const lang = (navigator.language || "").toLowerCase();
    if (lang.startsWith("zh")) return "zh";
  }
  return "en";
}

export function getLocale(): Locale {
  return current;
}

export function getSupportedLocales(): readonly Locale[] {
  return SUPPORTED_LOCALES;
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // best-effort; persistence is nice-to-have.
  }
  for (const fn of listeners) fn();
}

/** Subscribe to locale changes. Returns an unsubscribe fn. */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Translate a key using the current locale. Falls back to the
 * English string, then the key itself, so a missing translation
 * never renders an empty span.
 *
 * Optional `params` interpolate `{name}` placeholders in the string,
 * e.g. translate("chat.retryIn", { s: 3, a: 1, max: 4 }).
 */
export function translate(
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const raw = STRINGS[current][key] ?? STRINGS.en[key] ?? (key as string);
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_m, name) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}
