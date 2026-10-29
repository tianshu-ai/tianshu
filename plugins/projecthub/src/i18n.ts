// ProjectHub panel i18n — same pattern as doctor plugin.

import { useEffect, useState } from "react";

type Locale = "en" | "zh" | "de";

function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem("tianshu.locale");
    if (stored === "en" || stored === "zh" || stored === "de") return stored;
  } catch { /* */ }
  if (typeof navigator !== "undefined") {
    const lang = (navigator.language || "").toLowerCase();
    if (lang.startsWith("zh")) return "zh";
    if (lang.startsWith("de")) return "de";
  }
  return "en";
}

function getLocale(): Locale { return detectLocale(); }

export function useLocaleRefresh(): Locale {
  const [locale, setLocale] = useState(getLocale);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "tianshu.locale") setLocale(getLocale());
    };
    window.addEventListener("storage", onStorage);
    const timer = setInterval(() => {
      const current = getLocale();
      setLocale((prev) => (prev !== current ? current : prev));
    }, 500);
    return () => { window.removeEventListener("storage", onStorage); clearInterval(timer); };
  }, []);
  return locale;
}

const UI: Record<string, Record<Locale, string>> = {
  // Panel header
  "projects":              { en: "Projects",                    zh: "项目",              de: "Projekte" },
  // Empty / not configured
  "notConfigured.title":   { en: "Connect a project tracker",   zh: "连接项目管理工具",     de: "Projekttracker verbinden" },
  "notConfigured.body":    { en: "Open Settings → ProjectHub to configure your Redmine, Jira, or other project management tool.", zh: "前往 设置 → ProjectHub 配置你的 Redmine、Jira 或其他项目管理工具。", de: "Öffne Einstellungen → ProjectHub, um Redmine, Jira oder ein anderes Tool zu konfigurieren." },
  "noProjects":            { en: "No projects found. Check plugin configuration.", zh: "未找到项目，请检查插件配置。", de: "Keine Projekte gefunden. Bitte Konfiguration prüfen." },
  // Issue list
  "noIssues":              { en: "No issues match the current filter.", zh: "当前筛选条件下没有问题。", de: "Keine Einträge für den aktuellen Filter." },
  // Filter
  "filter.open":           { en: "Open",    zh: "打开",   de: "Offen" },
  "filter.closed":         { en: "Closed",  zh: "已关闭", de: "Geschlossen" },
  "filter.all":            { en: "All",     zh: "全部",   de: "Alle" },
};

export function t(key: string): string {
  const loc = getLocale();
  return UI[key]?.[loc] ?? UI[key]?.en ?? key;
}
