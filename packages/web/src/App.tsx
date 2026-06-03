import { useEffect, useRef, useState } from "react";

// PR #21 minimal chat UI:
// - one column, scrolling messages, input at the bottom
// - WebSocket with the protocol from packages/server/src/chat/ws-protocol.ts
// - history fetched on connect; streaming deltas appended live

type WireMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: number;
};

type Me = {
  tenantId: string;
  userId: string;
  config: { branding: { name?: string; emoji?: string } | null };
  defaultModel: { id: string; name: string; provider: string } | null;
};

const STREAMING_ID = "__streaming__";

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [messages, setMessages] = useState<WireMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // ─── /api/me on first paint
  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json() as Promise<Me>)
      .then(setMe)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // ─── WebSocket
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "history" }));
    });
    ws.addEventListener("message", (ev) => {
      let parsed: { type: string; [k: string]: unknown };
      try {
        parsed = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (parsed.type) {
        case "history":
          setMessages((parsed.messages as WireMessage[]) ?? []);
          return;
        case "message_added":
          setMessages((prev) => [...prev, parsed.message as WireMessage]);
          return;
        case "stream_start":
          setStreaming(true);
          setMessages((prev) => [
            ...prev,
            {
              id: STREAMING_ID,
              sessionId: "",
              role: "assistant",
              content: "",
              createdAt: Date.now(),
            },
          ]);
          return;
        case "stream_delta":
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === STREAMING_ID);
            if (idx < 0) return prev;
            const next = prev.slice();
            next[idx] = { ...next[idx]!, content: next[idx]!.content + (parsed.delta as string) };
            return next;
          });
          return;
        case "stream_end":
          setStreaming(false);
          setMessages((prev) => {
            const final = parsed.message as WireMessage;
            const idx = prev.findIndex((m) => m.id === STREAMING_ID);
            if (idx < 0) return [...prev, final];
            const next = prev.slice();
            next[idx] = final;
            return next;
          });
          return;
        case "stream_error":
          setStreaming(false);
          setError((parsed.reason as string) ?? "stream error");
          setMessages((prev) => prev.filter((m) => m.id !== STREAMING_ID));
          return;
      }
    });
    ws.addEventListener("close", () => {
      wsRef.current = null;
    });
    return () => {
      ws.close();
    };
  }, []);

  // ─── auto-scroll on new content
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text || !wsRef.current || streaming) return;
    setError(null);
    wsRef.current.send(JSON.stringify({ type: "prompt", content: text }));
    setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const brand = me?.config.branding ?? { name: "Tianshu", emoji: "⭐" };
  const model = me?.defaultModel?.name ?? "—";

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-lg font-semibold tracking-tight">
            <span className="mr-2">{brand.emoji ?? "⭐"}</span>
            天枢 · {brand.name ?? "Tianshu"}
            <span className="ml-3 text-xs font-normal text-slate-500">
              tenant <span className="text-slate-300">{me?.tenantId ?? "…"}</span> ·
              user <span className="text-slate-300">{me?.userId ?? "…"}</span>
            </span>
          </h1>
          <div className="text-xs text-slate-500">model: <span className="text-slate-300">{model}</span></div>
        </div>
      </header>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.length === 0 && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400">
              Day 0 chat. Conversation history is per-user, persisted in
              <code className="mx-1 rounded bg-slate-800 px-1 py-0.5 text-xs">~/.tianshu/tenants/{me?.tenantId ?? "default"}/db.sqlite</code>.
              Type below.
            </div>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}
          {streaming && (
            <div className="text-xs text-slate-500">streaming…</div>
          )}
          {error && (
            <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
              {error}
            </div>
          )}
        </div>
      </div>

      <footer className="border-t border-slate-800 px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Message Tianshu… (Enter to send, Shift+Enter newline)"
            className="flex-1 resize-none rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm placeholder:text-slate-500 focus:border-slate-600 focus:outline-none"
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim() || streaming}
            className="rounded-md bg-amber-300 px-4 py-2 text-sm font-medium text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
          >
            Send
          </button>
        </div>
      </footer>
    </div>
  );
}

function Bubble({ m }: { m: WireMessage }) {
  const isUser = m.role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          "max-w-[85%] whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm leading-relaxed " +
          (isUser
            ? "border-amber-300/30 bg-amber-300/10 text-amber-100"
            : "border-slate-800 bg-slate-900/60 text-slate-100")
        }
      >
        {m.content || (m.role === "assistant" ? "…" : "")}
      </div>
    </div>
  );
}
