// A2A Peer plugin — client panel.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Link2,
  Copy,
  Check,
  Plus,
  Trash2,
  Loader2,
  ToggleLeft,
  ToggleRight,
  Send,
  MessageCircle,
  XCircle,
} from "lucide-react";
import type { PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent, useUiPrimitives, usePluginT } from "@tianshu-ai/plugin-sdk/client";

const API = "/api/p/a2a-peer";

interface Peer {
  id: string;
  name: string;
  endpointUrl: string;
  agentCard: Record<string, unknown>;
  status: "active" | "disabled";
  createdAt: number;
}

interface PeerMessage {
  id: string;
  peerId: string;
  direction: "inbound" | "outbound";
  sender: string;
  text: string;
  createdAt: number;
}

// ── Main panel ──────────────────────────────────────────────────

export function A2APeerPanel() {
  const t = usePluginT("a2a-peer");
  const { Modal } = useUiPrimitives();
  const [peers, setPeers] = useState<Peer[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [chatPeer, setChatPeer] = useState<Peer | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Peer | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/peers`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) setPeers(body.peers);
    } catch { /* */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => subscribeToWsEvent("a2a_peer_changed", () => void refresh()), [refresh]);

  const doToggle = useCallback(async (p: Peer) => {
    await fetch(`${API}/peers/${p.id}`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: p.status === "active" ? "disabled" : "active" }),
    });
    void refresh();
  }, [refresh]);

  const doDelete = useCallback(async (id: string) => {
    await fetch(`${API}/peers/${id}`, { method: "DELETE", credentials: "include" });
    void refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col h-full text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <Link2 size={16} className="text-fg-muted" />
          <span className="text-xs font-semibold text-fg-default">{t("panel.title")}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowInvite(true)}
            className="text-xs px-2 py-1 rounded bg-accent/15 text-accent hover:bg-accent/25"
          >
            {t("panel.invite")}
          </button>
          <button
            onClick={() => setShowConnect(true)}
            className="text-xs px-2 py-1 rounded bg-success/15 text-success hover:bg-success/25"
          >
            <Plus size={12} className="inline -mt-px mr-0.5" />
            {t("panel.connect")}
          </button>
        </div>
      </div>

      {/* Peer list */}
      {peers.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-fg-faint gap-2 px-4">
          <Link2 size={28} className="opacity-30" />
          <p className="text-xs">{t("panel.empty")}</p>
          <p className="text-xs opacity-60">{t("panel.emptyHint")}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {peers.map((p) => (
            <div
              key={p.id}
              className={`flex items-center gap-3 px-4 py-2.5 group hover:bg-bg-hover ${p.status !== "active" ? "opacity-50" : ""}`}
            >
              <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-xs">
                {String(p.agentCard?.emoji || "🔗")}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-fg-default truncate flex items-center gap-1.5">
                  {p.name}
                  <span className={`text-[10px] px-1 py-0.5 rounded ${
                    p.status === "active" ? "bg-success/15 text-success" : "bg-fg-faint/15 text-fg-faint"
                  }`}>
                    {t(p.status === "active" ? "peer.active" : "peer.disabled")}
                  </span>
                </div>
                <div className="text-xs text-fg-faint truncate">{p.endpointUrl}</div>
              </div>
              <button
                onClick={() => setChatPeer(p)}
                className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-accent p-1 rounded flex-shrink-0"
                title="Chat"
              >
                <MessageCircle size={12} />
              </button>
              <button
                onClick={() => void doToggle(p)}
                className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-fg-muted p-1 rounded flex-shrink-0"
                title={t(p.status === "active" ? "peer.disable" : "peer.enable")}
              >
                {p.status === "active" ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
              </button>
              <button
                onClick={() => setConfirmDelete(p)}
                className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-danger p-1 rounded flex-shrink-0"
                title={t("peer.delete")}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Invite modal */}
      <Modal isOpen={showInvite} onClose={() => setShowInvite(false)} title={t("invite.title")} size="sm" allowMaximize={false}>
        <InviteFlow onClose={() => setShowInvite(false)} />
      </Modal>

      {/* Connect modal */}
      <Modal isOpen={showConnect} onClose={() => setShowConnect(false)} title={t("connect.title")} size="sm" allowMaximize={false}>
        <ConnectFlow onDone={() => { setShowConnect(false); void refresh(); }} onCancel={() => setShowConnect(false)} />
      </Modal>

      {/* Chat modal */}
      <Modal isOpen={chatPeer !== null} onClose={() => setChatPeer(null)} title={chatPeer?.name ?? ""} size="md" allowMaximize={false}>
        {chatPeer && <PeerChat peer={chatPeer} />}
      </Modal>

      {/* Delete confirm */}
      <Modal isOpen={confirmDelete !== null} onClose={() => setConfirmDelete(null)} title={t("delete.title")} size="sm" allowMaximize={false}>
        <div className="flex flex-col gap-4 p-1">
          <p className="text-sm text-fg-muted">{t("delete.confirm", { name: confirmDelete?.name ?? "" })}</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDelete(null)} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">{t("delete.cancel")}</button>
            <button onClick={() => { const id = confirmDelete?.id; setConfirmDelete(null); if (id) void doDelete(id); }} className="text-xs px-3 py-1.5 rounded-md bg-danger text-fg-on-accent font-medium hover:opacity-90">{t("delete.delete")}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Invite flow ─────────────────────────────────────────────────

function InviteFlow({ onClose }: { onClose: () => void }) {
  const t = usePluginT("a2a-peer");
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/invite`, { method: "POST", credentials: "include" });
      const body = await r.json();
      if (body.ok) setCode(body.code);
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { void generate(); }, [generate]);

  const doCopy = useCallback(() => {
    if (!code) return;
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  if (loading) return <div className="flex justify-center p-6"><Loader2 className="w-6 h-6 animate-spin text-fg-muted" /></div>;

  return (
    <div className="flex flex-col items-center gap-4 p-4">
      <div className="text-3xl font-mono font-bold tracking-[0.3em] text-accent select-all">{code}</div>
      <p className="text-xs text-fg-muted text-center">{t("invite.hint")}</p>
      <button onClick={doCopy} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-accent/15 text-accent hover:bg-accent/25">
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? t("invite.copied") : "Copy"}
      </button>
    </div>
  );
}

// ── Connect flow ────────────────────────────────────────────────

function ConnectFlow({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const t = usePluginT("a2a-peer");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"form" | "connecting" | "done" | "error">("form");
  const [error, setError] = useState("");

  const doConnect = useCallback(async () => {
    if (!url.trim() || !code.trim()) return;
    setPhase("connecting");
    setError("");
    try {
      const r = await fetch(`${API}/connect`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteUrl: url.trim(), code: code.trim().toUpperCase() }),
      });
      const body = await r.json();
      if (body.ok) {
        setPhase("done");
        setTimeout(onDone, 1200);
      } else {
        setError(body.error || "Unknown error");
        setPhase("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [url, code, onDone]);

  if (phase === "connecting") return <div className="flex justify-center p-6"><Loader2 className="w-6 h-6 animate-spin text-fg-muted" /></div>;
  if (phase === "done") return (
    <div className="flex flex-col items-center gap-3 p-4">
      <Check className="w-8 h-8 text-success" />
      <p className="text-sm text-fg-muted">{t("connect.success")}</p>
    </div>
  );
  if (phase === "error") return (
    <div className="flex flex-col items-center gap-3 p-4">
      <XCircle className="w-6 h-6 text-danger" />
      <p className="text-sm text-danger">{error}</p>
      <div className="flex gap-2">
        <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">{t("connect.cancel")}</button>
        <button onClick={() => setPhase("form")} className="text-xs px-3 py-1.5 rounded-md bg-accent text-fg-on-accent font-medium">Retry</button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3 p-2">
      <div>
        <label className="text-xs text-fg-muted mb-1 block">{t("connect.urlLabel")}</label>
        <input
          value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder={t("connect.urlPlaceholder")} autoFocus
          className="w-full text-sm px-3 py-2 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div>
        <label className="text-xs text-fg-muted mb-1 block">{t("connect.codeLabel")}</label>
        <input
          value={code} onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void doConnect(); }}
          placeholder={t("connect.codePlaceholder")}
          className="w-full text-sm px-3 py-2 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent font-mono tracking-widest uppercase"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">{t("connect.cancel")}</button>
        <button onClick={doConnect} disabled={!url.trim() || !code.trim()} className="text-xs px-3 py-1.5 rounded-md bg-success text-white font-medium hover:opacity-90 disabled:opacity-50">{t("connect.submit")}</button>
      </div>
    </div>
  );
}

// ── Peer chat ───────────────────────────────────────────────────

function PeerChat({ peer }: { peer: Peer }) {
  const t = usePluginT("a2a-peer");
  const [messages, setMessages] = useState<PeerMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadMessages = useCallback(async () => {
    try {
      const r = await fetch(`${API}/messages/${peer.id}`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) setMessages((body.messages as PeerMessage[]).reverse());
    } catch { /* */ }
  }, [peer.id]);

  useEffect(() => { void loadMessages(); }, [loadMessages]);
  useEffect(() => subscribeToWsEvent("a2a_peer_message", (data: Record<string, unknown>) => {
    if (data.peerId === peer.id) void loadMessages();
  }), [peer.id, loadMessages]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const doSend = useCallback(async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await fetch(`${API}/send`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: peer.id, text: text.trim() }),
      });
      setText("");
      void loadMessages();
    } catch { /* */ }
    setSending(false);
  }, [text, sending, peer.id, loadMessages]);

  return (
    <div className="flex flex-col h-80">
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-1.5 text-xs ${
              m.direction === "outbound"
                ? "bg-accent/20 text-fg-default"
                : "bg-bg-elevated text-fg-default"
            }`}>
              {m.direction === "inbound" && (
                <div className="text-[10px] text-fg-faint mb-0.5">{m.sender}</div>
              )}
              <div className="whitespace-pre-wrap break-words">{m.text}</div>
              <div className="text-[10px] text-fg-fainter mt-0.5">
                {new Date(m.createdAt).toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border-subtle">
        <input
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void doSend(); } }}
          placeholder={t("peer.messagePlaceholder")}
          disabled={peer.status !== "active"}
          className="flex-1 text-xs px-3 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
        <button
          onClick={doSend}
          disabled={!text.trim() || sending || peer.status !== "active"}
          className="p-1.5 rounded-md bg-accent text-fg-on-accent disabled:opacity-50"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}

// ── exports ─────────────────────────────────────────────────────

const exports: PluginClientExports = {
  components: { A2APeerPanel },
};

export default exports;
