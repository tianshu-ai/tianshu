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
    "auth.signOut": "Sign out",
    "admin.title": "Settings",
    "lang.label": "Language",
    "user.role.member": "member",
    "user.role.admin": "admin",
    "user.role.dev": "dev",
    "user.theme": "Theme",
    "user.signOut": "Sign out",
  },
  zh: {
    "auth.signOut": "退出登录",
    "admin.title": "设置",
    "lang.label": "语言",
    "user.role.member": "成员",
    "user.role.admin": "管理员",
    "user.role.dev": "开发者",
    "user.theme": "主题",
    "user.signOut": "退出登录",
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
 */
export function translate(key: TranslationKey): string {
  return (
    STRINGS[current][key] ?? STRINGS.en[key] ?? (key as string)
  );
}
