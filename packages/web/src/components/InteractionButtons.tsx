// InteractionButtons — renders ask_user tool option buttons.
//
// Clicking an option adds it as a tag chip in the composer.
// The user can select multiple options regardless of multiSelect flag,
// optionally type additional text, then hit Send.

import { useEffect, useRef } from "react";
import { useChatStore } from "../stores/chat-store";

export function InteractionButtons() {
  const interaction = useChatStore((s) => s.activeInteraction);
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (interaction && interaction.id !== lastIdRef.current) {
      lastIdRef.current = interaction.id;
    }
  }, [interaction]);

  if (!interaction) return null;

  const { question, options } = interaction;

  const handleClick = (value: string, label: string) => {
    useChatStore.setState({
      pendingDraft: { display: label, send: value },
    });
  };

  return (
    <div className="mt-2 mb-1 px-3 flex flex-col items-center">
      {question && (
        <div className="text-xs text-fg-muted mb-2">{question}</div>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => handleClick(opt.value, opt.label)}
            className={[
              "inline-flex flex-col items-start rounded-lg border px-3 py-2",
              "text-left text-xs transition-all duration-150",
              "hover:border-accent hover:bg-accent/10",
              "border-border-subtle bg-bg-elevated/60 text-fg-default",
            ].join(" ")}
          >
            <span className="font-medium">{opt.label}</span>
            {opt.description && (
              <span className="text-xs text-fg-faint mt-0.5">
                {opt.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
