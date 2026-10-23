/**
 * ChatTranscript — renders a session's message history using the same
 * MessageBubble as the main chat UI. Exposed to plugins via
 * UiPrimitives so they don't need to duplicate rendering logic.
 *
 * Props:
 *   sessionId — the session to render
 *   tailing   — when true, polls for new messages (live view)
 *   className — optional CSS class for the scroll container
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WireMessage } from "../types/chat";
import { mergeToolTurns } from "../lib/merge-tool-turns";
import MessageBubble from "./MessageBubble";

interface Props {
  sessionId: string;
  tailing?: boolean;
  className?: string;
}

export default function ChatTranscript({ sessionId, tailing, className }: Props) {
  const [messages, setMessages] = useState<WireMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        credentials: "include",
      });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { messages: WireMessage[] };
      setMessages(data.messages ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  // Initial fetch
  useEffect(() => {
    void fetchMessages();
  }, [fetchMessages]);

  // Tail while tailing
  useEffect(() => {
    if (!tailing) return;
    const iv = setInterval(() => void fetchMessages(), 3000);
    return () => clearInterval(iv);
  }, [tailing, fetchMessages]);

  // Auto-scroll
  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const merged = useMemo(
    () => (messages ? mergeToolTurns(messages) : []),
    [messages],
  );

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={className ?? "flex-1 overflow-y-auto"}
    >
      {error && (
        <div className="rounded border border-rose-700/40 bg-rose-950/30 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      {messages === null && (
        <div className="text-xs italic text-fg-faint p-4">Loading…</div>
      )}
      {messages !== null && merged.length === 0 && (
        <div className="text-xs italic text-fg-faint p-4">No messages yet.</div>
      )}
      <div className="mx-auto max-w-3xl space-y-1 p-4">
        {merged.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
      </div>
    </div>
  );
}
