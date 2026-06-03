import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { useChatStore } from "../stores/chat-store";

/**
 * Bottom composer. Mirrors the closed-source repo's ChatInput minus the
 * file-attachment / model-picker rails — those land later. Enter sends,
 * Shift+Enter inserts a newline.
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
      <div className="mx-auto flex max-w-4xl items-end gap-2">
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
          className="input-base flex-1 resize-none"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!isStreaming && !draft.trim()}
          className={
            "flex h-10 w-10 items-center justify-center rounded-lg transition-colors " +
            (isStreaming
              ? "bg-rose-600 text-white hover:bg-rose-700"
              : "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-gray-800 disabled:text-gray-500")
          }
          title={isStreaming ? "Stop" : "Send"}
        >
          {isStreaming ? <Square size={16} /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
}
