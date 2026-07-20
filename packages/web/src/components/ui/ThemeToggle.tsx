// ThemeToggle — three-way segmented toggle for light / dark /
// system. Renders inline in headers and admin pages.
//
// Why three modes instead of a single light/dark switch: power
// users on macOS often have OS-level automatic dark mode; forcing
// them to choose one or the other means the app stops tracking
// the OS. "system" is the right default.

import { Monitor, Moon, Sun } from "lucide-react";
import { useThemeStore, type ThemeMode } from "../../stores/theme-store";
import { useT } from "../../hooks/useT";

const OPTIONS: Array<{ value: ThemeMode; labelKey: "theme.light" | "theme.dark" | "theme.system"; Icon: typeof Sun }> = [
  { value: "light", labelKey: "theme.light", Icon: Sun },
  { value: "dark", labelKey: "theme.dark", Icon: Moon },
  { value: "system", labelKey: "theme.system", Icon: Monitor },
];

export interface ThemeToggleProps {
  /** Compact mode: just icons, no labels. Useful in tight headers. */
  compact?: boolean;
  /** Optional className. */
  className?: string;
}

export function ThemeToggle({ compact = false, className = "" }: ThemeToggleProps) {
  const t = useT();
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  return (
    <div
      className={`inline-flex rounded-md border p-0.5 text-[11px] ${className}`}
      style={{
        background: "var(--color-bg-elevated)",
        borderColor: "var(--color-border-default)",
        color: "var(--color-fg-muted)",
      }}
      role="group"
      aria-label={t("theme.aria")}
    >
      {OPTIONS.map(({ value, labelKey, Icon }) => {
        const label = t(labelKey);
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={`flex items-center gap-1 rounded px-2 py-0.5 transition-colors`}
            style={
              active
                ? {
                    // Match the sidebar channel-list selected row exactly
                    // (webchat / wechat): bg-hover + fg-default + a
                    // border-default outline. --color-bg-hover is a
                    // visible grey in both themes (slate-200 in light,
                    // gray-800 in dark), so the highlight reads clearly
                    // without inventing a new colour.
                    background: "var(--color-bg-hover)",
                    color: "var(--color-fg-default)",
                    boxShadow: "inset 0 0 0 1px var(--color-border-default)",
                  }
                : undefined
            }
            title={label}
            aria-pressed={active}
          >
            <Icon size={12} />
            {!compact && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
