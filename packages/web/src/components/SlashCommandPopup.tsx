import { useEffect, useRef, useState } from "react";
import { Archive, RefreshCw, Zap } from "lucide-react";
import { useT } from "../hooks/useT";

export interface SlashCommand {
  command: string;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const COMMANDS: SlashCommand[] = [
  {
    command: "/compact",
    label: "/compact",
    description: "Compress conversation history into a summary",
    icon: <Archive size={14} />,
  },
  {
    command: "/recompact",
    label: "/recompact",
    description: "Re-generate the previous session's summary",
    icon: <RefreshCw size={14} />,
  },
];

interface Props {
  active: boolean;
  filter: string;
  onSelect: (command: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export default function SlashCommandPopup({ active, filter, onSelect, onClose, anchorRef }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = COMMANDS.filter((c) =>
    c.command.startsWith("/" + filter.toLowerCase()),
  );

  useEffect(() => {
    setSelectedIdx(0);
  }, [filter]);

  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filtered[selectedIdx]) {
          onSelect(filtered[selectedIdx].command);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, selectedIdx, filtered, onSelect, onClose]);

  if (!active || filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 mb-1 w-72 overflow-hidden rounded-lg border border-border-default bg-bg-surface shadow-lg z-50"
    >
      <div className="px-2 py-1.5 text-[11px] font-medium text-fg-faint uppercase tracking-wide border-b border-border-subtle">
        Commands
      </div>
      {filtered.map((cmd, i) => (
        <button
          key={cmd.command}
          type="button"
          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
            i === selectedIdx
              ? "bg-bg-hover text-fg-default"
              : "text-fg-muted hover:bg-bg-hover/50"
          }`}
          onMouseEnter={() => setSelectedIdx(i)}
          onClick={() => onSelect(cmd.command)}
        >
          <span className="flex-shrink-0 text-fg-faint">{cmd.icon}</span>
          <div className="min-w-0">
            <div className="font-mono text-xs font-medium">{cmd.label}</div>
            <div className="text-[11px] text-fg-faint truncate">{cmd.description}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
