// Theme store: drives the `data-theme` attribute on <html> and
// surfaces the active theme to plugins via the plugin-sdk
// useTheme() hook.
//
// Three modes:
//   - "light": force light tokens
//   - "dark":  force dark tokens
//   - "system": follow `prefers-color-scheme` (live; flips when
//               OS preference changes mid-session)
//
// Persistence: localStorage under TIANSHU_THEME_KEY. Default on
// first run is "system" — most users have an OS preference set
// and will get the matching look automatically.
//
// The store also writes the resolved theme into a getter so
// non-React code (plugins loaded as separate bundles, CodeBlock
// reading shiki's theme name) can read the current value
// synchronously without subscribing.

import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "tianshu.theme";

function loadPreferredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* SSR or storage-disabled environment */
  }
  return "system";
}

function storePreferredMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* swallow */
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const initialMode = loadPreferredMode();
  return {
    mode: initialMode,
    resolved: resolveTheme(initialMode),
    setMode: (mode) => {
      storePreferredMode(mode);
      set({ mode, resolved: resolveTheme(mode) });
      applyThemeAttribute(get().resolved);
    },
  };
});

/** Mirror the resolved theme onto <html data-theme="..."> so the
 *  CSS rules in index.css take effect. Idempotent; safe to call
 *  on every change. */
function applyThemeAttribute(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

/** Initial paint: read the persisted preference and write the
 *  attribute before React mounts. Must be called once at boot
 *  from main.tsx so the first frame already shows the right
 *  theme (no flash-of-wrong-theme). */
export function bootstrapTheme(): void {
  const store = useThemeStore.getState();
  applyThemeAttribute(store.resolved);

  // Live-react to OS preference changes when mode is "system".
  if (typeof window === "undefined" || !window.matchMedia) return;
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const { mode } = useThemeStore.getState();
    if (mode !== "system") return;
    const resolved: ResolvedTheme = mql.matches ? "dark" : "light";
    useThemeStore.setState({ resolved });
    applyThemeAttribute(resolved);
  };
  // Both APIs exist depending on browser version.
  if (mql.addEventListener) mql.addEventListener("change", onChange);
  else mql.addListener(onChange);
}

/** Synchronous accessor for non-React consumers. Plugins read
 *  this through the plugin-sdk useTheme() hook, but a few
 *  components (CodeBlock, anything pre-mount) need a sync getter. */
export function getResolvedTheme(): ResolvedTheme {
  return useThemeStore.getState().resolved;
}
