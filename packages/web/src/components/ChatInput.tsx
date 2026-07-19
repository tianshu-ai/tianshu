import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { useComposerStore } from "../stores/composer-store";
import ModelSelector from "./ModelSelector";
import PluginComposerActions from "./PluginComposerActions";
import ComposerAttachments from "./ComposerAttachments";
import type { WireAttachment } from "../types/chat";
import { useT } from "../hooks/useT";

/**
 * Bottom composer.
 *
 * Visual layout mirrors the closed-source predecessor's ChatInput:
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │  [ chip chip chip … ]   (optional attachments row)     │
 *   │                                                        │
 *   │  [ textarea ………………………………………………… ]                      │
 *   │                                                        │
 *   │  [📎 ⋯ ]                              [ ModelSelector ] │
 *   │  (plugin composer actions)            [ Send / Stop  ] │
 *   │                                                        │
 *   └────────────────────────────────────────────────────────┘
 *
 * Plugin contributions decide what shows up on the left ("file attach"
 * is shipped by the `uploads` plugin; future plugins can drop in
 * voice-record, paste-image, etc. via `composerActions`).
 *
 * Send is disabled while any attachment is still uploading; transforms
 * registered by plugins (`registerDraftTransform`) run in registration
 * order on the draft just before it's sent.
 *
 * Enter sends, Shift+Enter inserts a newline.
 */
export default function ChatInput() {
  const t = useT();
  const isStreaming = useChatStore((s) => s.isStreaming);
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const abort = useChatStore((s) => s.abort);

  const attachmentCount = useComposerStore((s) => s.attachments.length);
  const hasPending = useComposerStore((s) => s.hasPending());
  const applyTransforms = useComposerStore((s) => s.applyTransforms);
  const clearAll = useComposerStore((s) => s.clearAll);

  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // auto-resize textarea up to ~10 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  const sendAllowed = (() => {
    if (isStreaming) return true; // shows Stop, always clickable
    if (submitting) return false;
    if (hasPending) return false;
    // Allow sending with attachments + empty text (the "I just dropped
    // these in, look at them" gesture).
    return draft.trim().length > 0 || attachmentCount > 0;
  })();

  const submit = async () => {
    if (isStreaming) {
      abort();
      return;
    }
    if (submitting || hasPending) return;
    const trimmed = draft.trimEnd();
    if (!trimmed && attachmentCount === 0) return;

    setSubmitting(true);
    try {
      const finalText = await applyTransforms(trimmed);
      // Collect ready attachments at the moment of send and forward
      // them as a first-class field on the prompt. The server
      // builds a multimodal UserMessage from this list (images go
      // into ImageContent parts; non-images stay as references).
      const ready = useComposerStore
        .getState()
        .attachments.filter((a) => a.status === "ready" && !!a.path);
      const wire: WireAttachment[] = ready.map((a) => ({
        path: a.path!,
        mimeType: a.mimeType ?? "application/octet-stream",
        name: a.name,
        size: a.size,
      }));
      // We tolerate transforms returning empty strings — there's
      // probably no model that benefits from "" + we already gated
      // on (text || attachments). If transforms drop everything
      // that's their bug, not ours.
      if (finalText.trim().length > 0 || wire.length > 0) {
        sendPrompt(finalText, wire.length > 0 ? wire : undefined);
      }
      setDraft("");
      clearAll();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t border-border-subtle bg-bg-base px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border border-border-subtle bg-bg-elevated p-3 focus-within:border-border-default">
        <ComposerAttachments />
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Don't send while an IME (Chinese/Japanese/Korean, etc.)
            // is composing — Enter there confirms the candidate, not
            // "send". e.nativeEvent.isComposing covers modern
            // browsers; keyCode === 229 is the legacy still-composing
            // signal some IMEs emit.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          placeholder={t("chat.placeholder")}
          className="resize-none bg-transparent text-[14px] leading-relaxed text-fg-default placeholder:text-fg-faint focus:outline-none"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <PluginComposerActions />
          </div>
          <div className="flex items-center gap-2">
            <ModelSelector />
            {isStreaming ? (
              <button
                type="button"
                onClick={abort}
                className="rounded-lg p-1.5 text-danger transition-colors hover:bg-bg-hover hover:text-danger"
                title={t("chat.stop")}
              >
                <Square size={18} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!sendAllowed}
                className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-default disabled:cursor-not-allowed disabled:opacity-30"
                title={hasPending ? t("chat.waitingUploads") : t("chat.send")}
                aria-label={t("chat.send")}
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
