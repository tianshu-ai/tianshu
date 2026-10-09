import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Send, Square, Upload } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { tianshuWs } from "../lib/ws";
import { useComposerStore } from "../stores/composer-store";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { useVoiceMode } from "../hooks/useVoiceMode";
import ModelSelector from "./ModelSelector";
import ContextRing from "./ContextRing";
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
  const activeInteraction = useChatStore((s) => s.activeInteraction);
  // When an ask_user interaction is pending, the agent loop is
  // suspended (isStreaming=true) but the user should still be able
  // to type a free-form answer. Treat it as "not streaming" for
  // the composer's disabled/send logic.
  const effectiveStreaming = isStreaming && !activeInteraction;
  const isCompacting = useChatStore((s) => s.isCompacting);
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const abort = useChatStore((s) => s.abort);

  // Yu, 2026-09-19: voice mode piggy-backs on each prompt so the
  // server can inject a system-prompt fragment asking tianshu to
  // append a <voice_summary>...</voice_summary> block. Sent per-
  // turn so a user can toggle mid-conversation and see the effect
  // on the very next reply without re-negotiating anything.
  const voiceEnabled = useVoiceMode().enabled;

  const attachmentCount = useComposerStore((s) => s.attachments.length);
  const hasPending = useComposerStore((s) => s.hasPending());
  const applyTransforms = useComposerStore((s) => s.applyTransforms);
  const clearAll = useComposerStore((s) => s.clearAll);

  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const addAtt = useComposerStore((s) => s.addAttachment);
  const updateAtt = useComposerStore((s) => s.updateAttachment);

  // ── Drag & drop onto composer ────────────────────────────
  useEffect(() => {
    const zone = dropZoneRef.current;
    if (!zone) return;
    let counter = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      counter++;
      if (counter === 1) setDragActive(true);
    };
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      counter--;
      if (counter <= 0) { counter = 0; setDragActive(false); }
    };
    const drop = (e: DragEvent) => {
      counter = 0;
      setDragActive(false);
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      for (const file of Array.from(e.dataTransfer.files)) {
        const MAX = 50 * 1024 * 1024;
        if (file.size > MAX) {
          addAtt({ name: file.name, size: file.size, status: "error", error: `Exceeds ${MAX / 1024 / 1024} MB`, mimeType: file.type || "application/octet-stream" });
          continue;
        }
        const id = addAtt({ name: file.name, size: file.size, status: "uploading", mimeType: file.type || "application/octet-stream" });
        void (async () => {
          try {
            const resp = await fetch("/api/p/files/upload", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
              body: file,
            });
            if (!resp.ok) {
              updateAtt(id, { status: "error", error: `${resp.status}: ${(await resp.text()).slice(0, 200)}` });
              return;
            }
            const json = (await resp.json()) as { path: string; size: number };
            updateAtt(id, { status: "ready", path: json.path, size: json.size });
          } catch (err) {
            updateAtt(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
          }
        })();
      }
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
    };
  }, [addAtt, updateAtt]);
  const pendingDraft = useChatStore((s) => s.pendingDraft);

  // Consume pendingDraft from InteractionButtons
  useEffect(() => {
    if (pendingDraft !== null) {
      setDraft(pendingDraft);
      useChatStore.setState({ pendingDraft: null });
      // Focus the textarea so the user can edit and hit Enter
      ref.current?.focus();
    }
  }, [pendingDraft]);
  const pttRef = useRef(false); // push-to-talk active

  // ── Voice input (server-side ASR) ────────────────────────
  const onVoiceResult = useCallback((text: string) => {
    setDraft((prev) => (prev ? prev + " " + text : text));
  }, []);
  const { recording, toggle: toggleVoice, voiceLoading, available: asrAvailable, shortcut } = useVoiceInput(onVoiceResult);

  // ── Push-to-talk: Alt+V ──────────────────────────────────
  useEffect(() => {
    // Parse shortcut like "ctrl+shift+m" into modifier checks
    const parts = shortcut.toLowerCase().split("+").map((s) => s.trim());
    const needCtrl = parts.includes("ctrl");
    const needShift = parts.includes("shift");
    const needAlt = parts.includes("alt");
    const needMeta = parts.includes("meta") || parts.includes("cmd");
    const mainKey = parts.find((p) => !["ctrl", "shift", "alt", "meta", "cmd"].includes(p)) || "m";

    const matchesShortcut = (e: KeyboardEvent) =>
      e.key.toLowerCase() === mainKey &&
      e.ctrlKey === needCtrl &&
      e.shiftKey === needShift &&
      e.altKey === needAlt &&
      e.metaKey === needMeta;

    const onKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e) && asrAvailable && !pttRef.current && !recording && !voiceLoading) {
        e.preventDefault();
        pttRef.current = true;
        void toggleVoice();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (pttRef.current && recording &&
        (e.key.toLowerCase() === mainKey || e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta")
      ) {
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
  }, [recording, voiceLoading, toggleVoice, shortcut, asrAvailable]);

  // auto-resize textarea
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  // Whether the user has typed text that can be sent as a follow-up
  // during an active agent turn.
  const canFollowUp = effectiveStreaming && draft.trim().length > 0;

  const sendAllowed = (() => {
    if (canFollowUp) return true;
    if (effectiveStreaming) return false; // stop button handles abort
    if (isCompacting) return false;
    if (submitting) return false;
    if (hasPending) return false;
    return draft.trim().length > 0 || attachmentCount > 0;
  })();

  const submit = async () => {
    // Follow-up: send message to agent mid-turn without aborting
    if (canFollowUp) {
      const trimmed = draft.trimEnd();
      if (!trimmed) return;
      tianshuWs.send({ type: "follow_up", content: trimmed });
      setDraft("");
      return;
    }
    if (effectiveStreaming) return; // shouldn't reach here
    if (submitting || hasPending) return;
    const trimmed = draft.trimEnd();
    if (!trimmed && attachmentCount === 0) return;

    // If there's a pending ask_user interaction, resolve it with
    // the user's free-form text instead of sending a normal prompt.
    if (activeInteraction) {
      tianshuWs.send({
        type: "interaction_response",
        id: activeInteraction.id,
        value: trimmed,
      });
      useChatStore.setState({ activeInteraction: null });
      setDraft("");
      return;
    }

    setSubmitting(true);
    try {
      const finalText = await applyTransforms(trimmed);
      const ready = useComposerStore.getState().attachments.filter((a) => a.status === "ready" && !!a.path);
      const wire: WireAttachment[] = ready.map((a) => ({
        path: a.path!, mimeType: a.mimeType ?? "application/octet-stream", name: a.name, size: a.size,
      }));
      if (finalText.trim().length > 0 || wire.length > 0) {
        sendPrompt(
          finalText,
          wire.length > 0 ? wire : undefined,
          voiceEnabled ? { voiceMode: true } : undefined,
        );
      }
      setDraft("");
      clearAll();
    } finally {
      setSubmitting(false);
    }
  };

  // Voice button title with shortcut hint
  const isMac = navigator.platform?.startsWith("Mac") || navigator.userAgent?.includes("Mac");
  const displayShortcut = shortcut
    .replace(/ctrl/i, isMac ? "⌃" : "Ctrl")
    .replace(/shift/i, isMac ? "⇧" : "Shift")
    .replace(/alt/i, isMac ? "⌥" : "Alt")
    .replace(/meta|cmd/i, isMac ? "⌘" : "Win")
    .replace(/\+/g, isMac ? "" : "+")
    .toUpperCase();
  const voiceTitle = recording
    ? t("chat.stopListening")
    : voiceLoading
      ? t("chat.transcribing")
      : `${t("chat.voiceInput")} (${displayShortcut})`;

  return (
    <div
      className={
        voiceEnabled
          ? "border-t border-border-subtle bg-bg-base px-6 py-5"
          : "border-t border-border-subtle bg-bg-base px-4 py-3"
      }
    >
      <div
        ref={dropZoneRef}
        className={
          voiceEnabled
            ? `relative mx-auto flex max-w-5xl flex-col gap-3 rounded-3xl border bg-bg-elevated p-5 focus-within:border-accent transition-colors duration-150 ${
                dragActive ? "border-brand-400 bg-brand-500/5" : "border-border-subtle"
              }`
            : `relative mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border bg-bg-elevated p-3 focus-within:border-accent transition-colors duration-150 ${
                dragActive ? "border-brand-400 bg-brand-500/5" : "border-border-subtle"
              }`
        }
      >
        {/* Drop overlay inside composer */}
        <div
          className={`absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl transition-all duration-200 pointer-events-none ${
            dragActive ? "opacity-100 scale-100" : "opacity-0 scale-95"
          }`}
          style={{ transitionProperty: "opacity, transform" }}
        >
          <div className="absolute inset-0 rounded-2xl bg-bg-elevated/90 backdrop-blur-sm" />
          <div className="absolute inset-1 rounded-xl border-2 border-dashed border-brand-400/60 animate-pulse" />
          <div className="relative flex flex-col items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500/15 animate-bounce" style={{ animationDuration: "1.5s" }}>
              <Upload size={20} className="text-brand-400" />
            </div>
            <div className="text-center">
              <div className="text-sm font-semibold text-fg-default">{t("chat.dropFiles")}</div>
              <div className="mt-0.5 text-xs text-fg-faint">{t("chat.dropFilesHint")}</div>
            </div>
          </div>
        </div>
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
          className={
            voiceEnabled
              ? "resize-none bg-transparent text-xl leading-relaxed text-fg-default placeholder:text-fg-faint focus:outline-none sm:text-2xl"
              : "min-h-[28px] resize-none bg-transparent text-[14px] leading-relaxed text-fg-default placeholder:text-fg-faint focus:outline-none"
          }
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <PluginComposerActions />
          </div>
          <div className="flex items-center gap-2">
            <ContextRing />
            <ModelSelector />
            {!effectiveStreaming && asrAvailable && (
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
            {effectiveStreaming && (
              <button
                type="button"
                onClick={abort}
                className="rounded-lg p-1.5 text-danger transition-colors hover:bg-bg-hover hover:text-danger"
                title={t("chat.stop")}
              >
                <Square size={18} />
              </button>
            )}
            {(!effectiveStreaming || canFollowUp) && (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!sendAllowed}
                className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-default disabled:cursor-not-allowed disabled:opacity-30"
                title={canFollowUp ? t("chat.followUp") : hasPending ? t("chat.waitingUploads") : t("chat.send")}
                aria-label={canFollowUp ? t("chat.followUp") : t("chat.send")}
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
