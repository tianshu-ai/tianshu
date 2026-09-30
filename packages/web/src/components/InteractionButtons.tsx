// InteractionButtons — renders ask_user tool option buttons.
//
// Clicking an option fills the composer draft with the option's
// value text. The user can edit it, then hit Send — which resolves
// the pending interaction via interaction_response.

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat-store";

export function InteractionButtons() {
  const interaction = useChatStore((s) => s.activeInteraction);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (interaction && interaction.id !== lastIdRef.current) {
      lastIdRef.current = interaction.id;
      setSelected(new Set());
    }
  }, [interaction]);

  if (!interaction) return null;

  const { question, options, multiSelect } = interaction;

  const fillDraft = (text: string) => {
    useChatStore.setState({ pendingDraft: text });
  };

  const handleClick = (value: string) => {
    if (multiSelect) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    } else {
      // Single select — fill the composer with the value
      fillDraft(value);
    }
  };

  const handleConfirm = () => {
    if (selected.size === 0) return;
    // Multi-select — fill comma-separated values
    fillDraft([...selected].join(", "));
  };

  return (
    <div className="mt-2 mb-1 px-3 flex flex-col items-center">
      {question && (
        <div className="text-[12px] text-fg-muted mb-2">{question}</div>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {options.map((opt) => {
          const isSelected = selected.has(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleClick(opt.value)}
              className={[
                "inline-flex flex-col items-start rounded-lg border px-3 py-2",
                "text-left text-[12px] transition-all duration-150",
                "hover:border-accent hover:bg-accent/10",
                isSelected
                  ? "border-accent bg-accent/15 text-fg-default"
                  : "border-border-subtle bg-bg-elevated/60 text-fg-default",
              ].join(" ")}
            >
              <span className="font-medium">{opt.label}</span>
              {opt.description && (
                <span className="text-[10px] text-fg-faint mt-0.5">
                  {opt.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {multiSelect && selected.size > 0 && (
        <button
          type="button"
          onClick={handleConfirm}
          className="mt-2 rounded-md bg-accent px-4 py-1.5 text-[12px] font-medium text-white hover:bg-accent/90 transition-colors"
        >
          确认选择 ({selected.size})
        </button>
      )}
    </div>
  );
}
