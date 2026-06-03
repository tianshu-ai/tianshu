import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import ModelSelector from "./ModelSelector";

/**
 * Bottom composer.
 *
 * Visual layout mirrors the closed-source predecessor's ChatInput:
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │                                                        │
 *   │  [ textarea ………………………………………………… ]                      │
 *   │                                                        │
 *   │  [        ]                          [ ModelSelector ] │
 *   │  (left toolbar — file attach, etc.   [ Send / Stop  ]  │
 *   │   ships in a later PR)                                 │
 *   │                                                        │
 *   └────────────────────────────────────────────────────────┘
 *
 * Enter sends, Shift+Enter inserts a newline.
 */
export default function ChatInput() {
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const abort = useChatStore((s) => s.abort);

  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // auto-resize textarea up to ~10 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  const submit = () => {
    if (isStreaming) {
      abort();
      return;
    }
    const v = draft.trim();
    if (!v) return;
    sendPrompt(v);
    setDraft("");
  };

  return (
    <div className="border-t border-gray-800 bg-gray-950 px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border border-gray-800 bg-gray-900 p-3 focus-within:border-gray-700">
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Message Tianshu — Enter to send, Shift+Enter for newline"
          className="resize-none bg-transparent text-[14px] leading-relaxed text-gray-100 placeholder:text-gray-500 focus:outline-none"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Left toolbar — file attach / compact / etc. ship later. */}
          </div>
          <div className="flex items-center gap-2">
            <ModelSelector />
            {isStreaming ? (
              <button
                type="button"
                onClick={abort}
                className="rounded-lg p-1.5 text-rose-400 transition-colors hover:bg-gray-700 hover:text-rose-300"
                title="Stop"
              >
                <Square size={18} />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!draft.trim()}
                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                title="Send"
              >
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
