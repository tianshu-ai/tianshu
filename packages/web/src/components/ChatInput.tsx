import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Send, Square } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { useComposerStore } from "../stores/composer-store";
import { useVoiceInput } from "../hooks/useVoiceInput";
import ModelSelector from "./ModelSelector";
import PluginComposerActions from "./PluginComposerActions";
import ComposerAttachments from "./ComposerAttachments";
import type { WireAttachment } from "../types/chat";
import { useT } from "../hooks/useT";

/**
 * Bottom composer.
 *
 * Voice input: click mic or hold Alt+V (push-to-talk).
 * - Click: toggle record on/off
 * - Hold Alt+V: record while held, release → transcribe
 */
export default function ChatInput() {
  const t = useT();
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isCompacting = useChatStore((s) => s.isCompacting);
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const abort = useChatStore((s) => s.abort);

  const attachmentCount = useComposerStore((s) => s.attachments.length);
  const hasPending = useComposerStore((s) => s.hasPending());
  const applyTransforms = useComposerStore((s) => s.applyTransforms);
  const clearAll = useComposerStore((s) => s.clearAll);

  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pttRef = useRef(false); // push-to-talk active

  // ── Voice input (server-side ASR) ────────────────────────
  const onVoiceResult = useCallback((text: string) => {
    setDraft((prev) => (prev ? prev + " " + text : text));
  }, []);
  const { recording, toggle: toggleVoice, voiceLoading } = useVoiceInput(onVoiceResult);

  // ── Push-to-talk: Alt+V ──────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+M: push-to-talk (hold to record)
      if (e.ctrlKey && e.shiftKey && e.key === "M" && !pttRef.current && !recording && !voiceLoading) {
        e.preventDefault();
        pttRef.current = true;
        void toggleVoice();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if ((e.key === "M" || e.key === "Control" || e.key === "Shift") && pttRef.current && recording) {
        e.preventDefault();
        pttRef.current = false;
        void toggleVoice();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [recording, voiceLoading, toggleVoice]);

  // auto-resize textarea
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  const sendAllowed = (() => {
    if (isStreaming) return true;
    if (isCompacting) return false;
    if (submitting) return false;
    if (hasPending) return false;
    return draft.trim().length > 0 || attachmentCount > 0;
  })();

  const submit = async () => {
    if (isStreaming) { abort(); return; }
    if (submitting || hasPending) return;
    const trimmed = draft.trimEnd();
    if (!trimmed && attachmentCount === 0) return;

    setSubmitting(true);
    try {
      const finalText = await applyTransforms(trimmed);
      const ready = useComposerStore.getState().attachments.filter((a) => a.status === "ready" && !!a.path);
      const wire: WireAttachment[] = ready.map((a) => ({
        path: a.path!, mimeType: a.mimeType ?? "application/octet-stream", name: a.name, size: a.size,
      }));
      if (finalText.trim().length > 0 || wire.length > 0) {
        sendPrompt(finalText, wire.length > 0 ? wire : undefined);
      }
      setDraft("");
      clearAll();
    } finally {
      setSubmitting(false);
    }
  };

  // Voice button title with platform-aware shortcut hint
  const isMac = navigator.platform?.startsWith("Mac") || navigator.userAgent?.includes("Mac");
  const shortcut = isMac ? "⌃⇧M" : "Ctrl+Shift+M";
  const voiceTitle = recording
    ? t("chat.stopListening")
    : voiceLoading
      ? t("chat.transcribing")
      : `${t("chat.voiceInput")} (${shortcut})`;

  return (
    <div className="border-t border-border-subtle bg-bg-base px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border border-border-subtle bg-bg-elevated p-3 focus-within:border-border-default">
        <ComposerAttachments />
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          placeholder={
            recording
              ? t("chat.recording")
              : isCompacting
                ? t("chat.compacting")
                : t("chat.placeholder")
          }
          className="resize-none bg-transparent text-[14px] leading-relaxed text-fg-default placeholder:text-fg-faint focus:outline-none"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <PluginComposerActions />
          </div>
          <div className="flex items-center gap-2">
            <ModelSelector />
            {!isStreaming && (
              <button
                type="button"
                onClick={() => void toggleVoice()}
                disabled={voiceLoading}
                className={`relative rounded-lg p-1.5 transition-colors ${
                  recording
                    ? "text-danger bg-danger/10"
                    : voiceLoading
                      ? "text-fg-faint opacity-50 cursor-wait"
                      : "text-fg-muted hover:bg-bg-hover hover:text-fg-default"
                }`}
                title={voiceTitle}
                aria-label={t("chat.voiceInput")}
              >
                {voiceLoading ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <>
                    <Mic size={18} />
                    {recording && (
                      <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-danger animate-pulse" />
                    )}
                  </>
                )}
              </button>
            )}
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
