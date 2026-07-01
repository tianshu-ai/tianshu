// ThemeToggle — three-way segmented toggle for light / dark /
// system. Renders inline in headers and admin pages.
//
// Why three modes instead of a single light/dark switch: power
// users on macOS often have OS-level automatic dark mode; forcing
// them to choose one or the other means the app stops tracking
// the OS. "system" is the right default.

import { Monitor, Moon, Sun } from "lucide-react";
import { useThemeStore, type ThemeMode } from "../../stores/theme-store";

const OPTIONS: Array<{ value: ThemeMode; label: string; Icon: typeof Sun }> = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

export interface ThemeToggleProps {
  /** Compact mode: just icons, no labels. Useful in tight headers. */
  compact?: boolean;
  /** Optional className. */
  className?: string;
}

export function ThemeToggle({ compact = false, className = "" }: ThemeToggleProps) {
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
      aria-label="Theme"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
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
                    // The active mode needs an unmistakable highlight in
                    // both themes. Earlier attempts used bg-raised (white
                    // in light theme, invisible) and accent-faint (only
                    // 8% alpha in light theme, barely visible on white).
                    // Use the SOLID accent colour as the pill background
                    // with on-accent (white) text, like a normal
                    // segmented control. Unambiguous on any surface.
                    background: "var(--color-accent)",
                    color: "var(--color-fg-on-accent)",
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
