// Fire browser desktop notifications + tab title flash when the
// assistant finishes a reply while the tab is hidden.
//
// Sits at the ChatArea level alongside useAutoSpeakReplies.
// Subscribes to the chat store's messages array and detects new
// assistant messages via an id-tracking set (same pattern as
// useAutoSpeakReplies).

import { useEffect, useRef } from "react";
import { useChatStore } from "../stores/chat-store";
import { useNotificationStore } from "../stores/notification-store";
import { useT } from "./useT";

export function useNotifications(): void {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const notify = useNotificationStore((s) => s.notify);
  const enabled = useNotificationStore((s) => s.enabled);

  // Track which assistant message ids we've already handled so we
  // only fire once per new completion, not on every re-render.
  const seenRef = useRef<Set<string>>(new Set<string>());
  // Seed with current messages on first mount so history doesn't
  // trigger notifications.
  const seededRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    // Seed pass: record all current assistant ids without notifying.
    if (!seededRef.current) {
      for (const m of messages) {
        if (m.role === "assistant" && m.id) seenRef.current.add(m.id);
      }
      seededRef.current = true;
      return;
    }

    // While still streaming, don't notify — wait for the final message.
    if (isStreaming) return;

    // Walk messages and find any new assistant message we haven't seen.
    for (const m of messages) {
      if (m.role !== "assistant" || !m.id) continue;
      if (seenRef.current.has(m.id)) continue;

      seenRef.current.add(m.id);

      // Only notify when the tab is hidden.
      if (!document.hidden) continue;

      // Skip empty / synthetic messages.
      const text = (m.text ?? "").trim();
      if (!text && !(m.toolCalls?.length)) continue;

      // Build a short preview for the notification body.
      const preview = text.length > 80 ? text.slice(0, 77) + "…" : text;

      notify(
        t("notify.title"),
        preview || t("notify.body"),
        t("notify.flashTitle"),
      );
      // One notification per batch is enough — don't spam.
      break;
    }
  }, [messages, isStreaming, enabled, notify, t]);
}
