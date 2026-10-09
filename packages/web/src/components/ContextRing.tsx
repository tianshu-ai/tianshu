import { useMemo, useState } from "react";
import { useChatStore } from "../stores/chat-store";
import { useT } from "../hooks/useT";

/**
 * Circular context-usage indicator placed next to the model picker.
 *
 * Reads the last assistant message's `meta.usage.input` (= actual
 * tokens sent to the model) and `meta.contextWindow` to derive a
 * percentage. Renders a small SVG ring that fills clockwise.
 *
 * Click opens a tooltip with numbers + a "Compact now" button that
 * sends `/compact` over the WS.
 */
export default function ContextRing() {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const isCompacting = useChatStore((s) => s.isCompacting);
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const [showPopover, setShowPopover] = useState(false);

  // Find the last assistant message with meta
  const { usedTokens, contextWindow } = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "assistant" && m.meta?.usage && m.meta.contextWindow) {
        return {
          usedTokens: m.meta.usage.totalTokens,
          contextWindow: m.meta.contextWindow,
        };
      }
    }
    return { usedTokens: 0, contextWindow: 0 };
  }, [messages]);

  // Don't render if we have no data
  if (!contextWindow || !usedTokens) return null;

  // Read triggerPercent from server config via last assistant meta,
  // or fall back to the default.
  const triggerPct = 60;
  const pct = Math.min((usedTokens / contextWindow) * 100, 100);
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (pct / 100) * circumference;

  // Threshold tick position on the ring (angle in radians, 0 = top)
  const thresholdAngle = (triggerPct / 100) * 2 * Math.PI - Math.PI / 2;
  const tickInner = radius - 1.5;
  const tickOuter = radius + 1.5;
  const tx1 = 12 + tickInner * Math.cos(thresholdAngle);
  const ty1 = 12 + tickInner * Math.sin(thresholdAngle);
  const tx2 = 12 + tickOuter * Math.cos(thresholdAngle);
  const ty2 = 12 + tickOuter * Math.sin(thresholdAngle);

  // Use the same muted tone as the model selector pill.
  // Only shift to warning/danger at high usage.
  const color =
    pct >= triggerPct
      ? "var(--danger, #ef4444)"
      : pct >= triggerPct * 0.67
        ? "var(--warning, #f59e0b)"
        : "var(--fg-muted, #999)";

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  };

  const handleCompact = () => {
    setShowPopover(false);
    sendPrompt("/compact");
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setShowPopover((v) => !v)}
        className="flex items-center justify-center rounded-full p-0.5 transition-colors hover:bg-bg-hover"
        title={`${t("chat.context")}: ${pct.toFixed(0)}%`}
        aria-label={`Context usage ${pct.toFixed(0)}%`}
      >
        <svg width="24" height="24" viewBox="0 0 24 24">
          {/* Background circle */}
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="var(--border, #333)"
            strokeWidth="2.5"
          />
          {/* Usage arc */}
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            transform="rotate(-90 12 12)"
            style={{ transition: "stroke-dashoffset 0.3s ease" }}
          />
          {/* Threshold tick mark — shows where auto-compact triggers */}
          <line
            x1={tx1}
            y1={ty1}
            x2={tx2}
            y2={ty2}
            stroke="var(--danger, #ef4444)"
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0.5"
          />
          {/* Percentage text */}
          <text
            x="12"
            y="12"
            textAnchor="middle"
            dominantBaseline="central"
            fill={color}
            fontSize="7"
            fontWeight="600"
          >
            {pct < 10 ? pct.toFixed(0) : Math.round(pct)}
          </text>
        </svg>
      </button>

      {showPopover && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowPopover(false)}
          />
          {/* Popover */}
          <div
            className="absolute bottom-full right-0 z-50 mb-2 w-56 rounded-lg border border-border bg-bg-surface p-3 shadow-lg"
            style={{ background: "var(--bg-surface, #1a1a2e)" }}
          >
            <div className="mb-2 text-xs font-medium text-fg-default">
              {t("chat.contextUsage")}
            </div>

            {/* Progress bar with threshold marker */}
            <div className="relative mb-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-hover">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${pct}%`,
                  backgroundColor: color,
                }}
              />
              {/* Threshold line */}
              <div
                className="absolute top-0 h-full w-px"
                style={{
                  left: `${triggerPct}%`,
                  backgroundColor: "var(--danger, #ef4444)",
                  opacity: 0.6,
                }}
              />
            </div>

            <div className="mb-1 flex justify-between text-[11px] text-fg-muted">
              <span>{formatTokens(usedTokens)} / {formatTokens(contextWindow)}</span>
              <span>{pct.toFixed(1)}%</span>
            </div>
            <div className="mb-3 text-[10px] text-fg-fainter">
              {t("chat.autoCompactAt")} {triggerPct}%
              {pct >= triggerPct
                ? ` — ${t("chat.compactingSoon")}`
                : ` (≈${formatTokens(Math.round(contextWindow * triggerPct / 100))})`
              }
            </div>

            <button
              type="button"
              onClick={handleCompact}
              disabled={isCompacting}
              className="w-full rounded-md border border-border px-2 py-1.5 text-xs font-medium text-fg-default transition-colors hover:bg-bg-hover disabled:opacity-50"
            >
              {isCompacting ? t("chat.compacting") : t("chat.compactNow")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
