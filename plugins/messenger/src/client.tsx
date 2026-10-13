// Messenger plugin — client side.
//
// Panel for managing contacts. WeChat contacts are picked from
// existing wechat bindings (requires wechat plugin active). WS
// contacts are added manually with endpoint URL.

import { useCallback, useEffect, useState } from "react";
import {
  Globe,
  MessageCircle,
  MessageSquareShare,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent, useUiPrimitives } from "@tianshu-ai/plugin-sdk/client";

const API = "/api/p/messenger";
const WECHAT_API = "/api/p/wechat";

interface Contact {
  id: string;
  name: string;
  type: "wechat" | "ws";
  config: Record<string, unknown>;
  waitReply: boolean;
  enabled: boolean;
  createdAt: number;
}

interface WeChatBinding {
  id: string;
  displayName: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

interface WeChatSession {
  id: string;
  channelChatId: string;
  bindingId: string | null;
  title: string | null;
  createdAt: number;
}

function typeIcon(type: string) {
  if (type === "wechat") return <MessageCircle size={14} className="text-success" />;
  return <Globe size={14} className="text-accent" />;
}

function typeLabel(type: string) {
  if (type === "wechat") return "WeChat";
  return "WebSocket";
}

// ── Main panel ──────────────────────────────────────────────────

function MessengerPanel(_props: PanelProps) {
  const { Modal } = useUiPrimitives();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [addType, setAddType] = useState<"wechat" | "ws" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; error?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Contact | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/contacts`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) setContacts(body.contacts ?? []);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeToWsEvent<{ type: string; event?: string }>(
      "plugin_event",
      (ev) => { if (ev.event === "messenger:messenger_changed") void refresh(); },
    );
  }, [refresh]);

  const doDelete = async (id: string) => {
    try {
      await fetch(`${API}/contacts/${id}`, { method: "DELETE", credentials: "include" });
      setContacts((prev) => prev.filter((c) => c.id !== id));
    } catch { /* ws refresh reconciles */ }
  };

  const doToggle = async (c: Contact) => {
    try {
      await fetch(`${API}/contacts/${c.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !c.enabled }),
      });
      void refresh();
    } catch { /* */ }
  };

  const doTest = async (id: string) => {
    setTesting(id);
    setTestResult(null);
    try {
      const r = await fetch(`${API}/contacts/${id}/test`, {
        method: "POST",
        credentials: "include",
      });
      const body = await r.json();
      setTestResult({ id, ok: body.ok, error: body.error });
    } catch (err) {
      setTestResult({ id, ok: false, error: String(err) });
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden text-fg-default">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <MessageSquareShare size={16} className="text-accent" />
          <span className="text-sm font-medium">Messenger</span>
          <span className="text-xs text-fg-faint">({contacts.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setAddType("wechat")}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-success/15 text-success hover:bg-success/25 transition-colors"
            title="Add WeChat contact"
          >
            <MessageCircle size={12} />
            <Plus size={10} />
          </button>
          <button
            onClick={() => setAddType("ws")}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
            title="Add WebSocket contact"
          >
            <Globe size={12} />
            <Plus size={10} />
          </button>
        </div>
      </div>

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto">
        {contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-fg-fainter">
            <MessageSquareShare size={28} className="mb-2 opacity-30" />
            <span className="text-xs">No contacts configured</span>
            <span className="text-xs mt-1">Add a contact to let the agent send messages</span>
          </div>
        ) : (
          <div className="py-1">
            {contacts.map((c) => (
              <div
                key={c.id}
                className={`flex items-center gap-3 px-4 py-2.5 group hover:bg-bg-hover ${
                  !c.enabled ? "opacity-50" : ""
                }`}
              >
                {typeIcon(c.type)}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-fg-default truncate">{c.name}</div>
                  <div className="text-xs text-fg-faint flex items-center gap-1">
                    <span>{typeLabel(c.type)}</span>
                    {c.waitReply && (
                      <>
                        <span className="text-fg-fainter">·</span>
                        <span>wait reply</span>
                      </>
                    )}
                  </div>
                </div>
                {testResult?.id === c.id && (
                  testResult.ok
                    ? <CheckCircle2 size={14} className="text-success flex-shrink-0" />
                    : <span title={testResult.error}><XCircle size={14} className="text-danger flex-shrink-0" /></span>
                )}
                <button
                  onClick={() => doTest(c.id)}
                  disabled={testing === c.id || !c.enabled}
                  className="opacity-0 group-hover:opacity-100 text-xs text-fg-faint hover:text-accent px-1.5 py-0.5 rounded transition-colors flex-shrink-0"
                >
                  {testing === c.id ? <Loader2 size={12} className="animate-spin" /> : "Test"}
                </button>
                <button
                  onClick={() => doToggle(c)}
                  className="opacity-0 group-hover:opacity-100 text-fg-faint hover:text-fg-default p-0.5 rounded flex-shrink-0"
                  title={c.enabled ? "Disable" : "Enable"}
                >
                  {c.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                </button>
                <button
                  onClick={() => setConfirmDelete(c)}
                  className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-danger p-0.5 rounded flex-shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add WeChat contact — pick from existing binding contacts */}
      <Modal
        isOpen={addType === "wechat"}
        onClose={() => setAddType(null)}
        title="Add WeChat Contact"
        size="sm"
        allowMaximize={false}
      >
        <AddWeChatFlow
          onCreated={() => { setAddType(null); void refresh(); }}
          onCancel={() => setAddType(null)}
        />
      </Modal>

      {/* Add WS contact */}
      <Modal
        isOpen={addType === "ws"}
        onClose={() => setAddType(null)}
        title="Add WebSocket Contact"
        size="sm"
        allowMaximize={false}
      >
        <AddWsForm
          onCreated={() => { setAddType(null); void refresh(); }}
          onCancel={() => setAddType(null)}
        />
      </Modal>

      {/* Delete confirmation */}
      <Modal
        isOpen={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete Contact"
        size="sm"
        allowMaximize={false}
      >
        <div className="flex flex-col gap-4 p-1">
          <p className="text-sm text-fg-muted">
            Remove <span className="font-medium text-fg-default">"{confirmDelete?.name}"</span>?
          </p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirmDelete(null)}
              className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                const id = confirmDelete?.id;
                setConfirmDelete(null);
                if (id) void doDelete(id);
              }}
              className="text-xs px-3 py-1.5 rounded-md bg-danger text-fg-on-accent font-medium hover:opacity-90"
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Add WeChat contact: pick from existing bindings + sessions ──

function AddWeChatFlow({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [loading, setLoading] = useState(true);
  const [bindings, setBindings] = useState<WeChatBinding[]>([]);
  const [sessions, setSessions] = useState<WeChatSession[]>([]);
  const [selectedBinding, setSelectedBinding] = useState("");
  const [selectedChat, setSelectedChat] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Fetch existing wechat bindings + sessions
  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [bRes, sRes] = await Promise.all([
          fetch(`${WECHAT_API}/bindings`, { credentials: "include" }),
          fetch(`${WECHAT_API}/sessions`, { credentials: "include" }),
        ]);
        const bBody = await bRes.json();
        const sBody = await sRes.json();
        const bs: WeChatBinding[] = bBody.ok ? bBody.bindings ?? [] : [];
        const ss: WeChatSession[] = sBody.ok ? sBody.sessions ?? [] : [];
        setBindings(bs);
        setSessions(ss);
        // Auto-select first binding
        if (bs.length === 1) setSelectedBinding(bs[0].id);
      } catch { /* */ }
      setLoading(false);
    })();
  }, []);

  // Filter sessions by selected binding
  const filteredSessions = selectedBinding
    ? sessions.filter((s) => s.bindingId === selectedBinding)
    : sessions;

  // Deduplicate by channelChatId (same person may have multiple sessions)
  const uniqueChats = new Map<string, WeChatSession>();
  for (const s of filteredSessions) {
    if (!uniqueChats.has(s.channelChatId)) uniqueChats.set(s.channelChatId, s);
  }
  const chatList = [...uniqueChats.values()];

  // When user picks a chat, auto-fill name from session title
  const handlePickChat = (chatId: string) => {
    setSelectedChat(chatId);
    const session = uniqueChats.get(chatId);
    if (session?.title && !name.trim()) {
      setName(session.title);
    }
  };

  const doSave = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!selectedChat) { setError("Pick a contact"); return; }
    const bindingId = selectedBinding || sessions.find((s) => s.channelChatId === selectedChat)?.bindingId;
    setSaving(true);
    setError("");
    try {
      const r = await fetch(`${API}/contacts`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          type: "wechat",
          config: { bindingId, wxId: selectedChat },
          waitReply: false,
        }),
      });
      const body = await r.json();
      if (body.ok) onCreated();
      else setError(body.error ?? "Failed");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-2 py-8">
        <Loader2 size={20} className="animate-spin text-success" />
        <span className="text-xs text-fg-muted">Loading WeChat bindings…</span>
      </div>
    );
  }

  if (bindings.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 px-4">
        <MessageCircle size={24} className="text-fg-fainter" />
        <span className="text-xs text-fg-muted text-center">
          No active WeChat bindings found.<br />
          Set up WeChat plugin first.
        </span>
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-2">
      {/* Binding selector (only if multiple) */}
      {bindings.length > 1 && (
        <div>
          <label className="text-xs text-fg-muted mb-1 block">WeChat Account</label>
          <select
            value={selectedBinding}
            onChange={(e) => { setSelectedBinding(e.target.value); setSelectedChat(""); }}
            className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default"
          >
            <option value="">All accounts</option>
            {bindings.map((b) => (
              <option key={b.id} value={b.id}>{b.displayName}</option>
            ))}
          </select>
        </div>
      )}

      {/* Pick from known contacts (people who've messaged the bot) */}
      {chatList.length > 0 && (
        <div>
          <label className="text-xs text-fg-muted mb-1 block">Pick Contact</label>
          <div className="max-h-40 overflow-y-auto rounded-md border border-border-default">
            {chatList.map((s) => (
              <button
                key={s.channelChatId}
                onClick={() => handlePickChat(s.channelChatId)}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-bg-hover flex items-center gap-2 transition-colors ${
                  selectedChat === s.channelChatId ? "bg-success/10 text-success" : "text-fg-default"
                }`}
              >
                <MessageCircle size={12} className={selectedChat === s.channelChatId ? "text-success" : "text-fg-faint"} />
                <span className="truncate">{s.title || s.channelChatId}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {chatList.length === 0 && (
        <div className="text-xs text-fg-fainter text-center py-3">
          No WeChat conversations yet. Have the contact message your bot first.
        </div>
      )}

      {/* Name */}
      <div>
        <label className="text-xs text-fg-muted mb-1 block">Display Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="老王"
          className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-success"
        />
      </div>

      {error && <div className="text-xs text-danger">{error}</div>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          onClick={doSave}
          disabled={saving || !selectedChat || !name.trim()}
          className="text-xs px-3 py-1.5 rounded-md bg-success text-white font-medium hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Add"}
        </button>
      </div>
    </div>
  );
}

// ── Add WS contact (manual form) ───────────────────────────────

function AddWsForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [wsToken, setWsToken] = useState("");
  const [waitReply, setWaitReply] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const doSave = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!wsUrl.trim()) { setError("Endpoint URL is required"); return; }
    const config: Record<string, unknown> = { url: wsUrl.trim() };
    if (wsToken.trim()) config.token = wsToken.trim();
    setSaving(true);
    setError("");
    try {
      const r = await fetch(`${API}/contacts`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), type: "ws", config, waitReply }),
      });
      const body = await r.json();
      if (body.ok) onCreated();
      else setError(body.error ?? "Failed");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-1">
      <div>
        <label className="text-xs text-fg-muted mb-1 block">Display Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="prod-server"
          autoFocus
          className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div>
        <label className="text-xs text-fg-muted mb-1 block">A2A Endpoint URL</label>
        <input
          value={wsUrl}
          onChange={(e) => setWsUrl(e.target.value)}
          placeholder="https://other-agent.example.com/.well-known/agent.json"
          className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent font-mono"
        />
      </div>
      <div>
        <label className="text-xs text-fg-muted mb-1 block">Auth Token (optional)</label>
        <input
          value={wsToken}
          onChange={(e) => setWsToken(e.target.value)}
          type="password"
          placeholder="Bearer ..."
          className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent font-mono"
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-fg-muted cursor-pointer">
        <input
          type="checkbox"
          checked={waitReply}
          onChange={(e) => setWaitReply(e.target.checked)}
          className="rounded border-border-default"
        />
        Wait for reply (sync mode)
      </label>
      {error && <div className="text-xs text-danger">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          onClick={doSave}
          disabled={saving}
          className="text-xs px-3 py-1.5 rounded-md bg-accent text-fg-on-accent font-medium hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Add Contact"}
        </button>
      </div>
    </div>
  );
}

// ── exports ─────────────────────────────────────────────────────

const exports: PluginClientExports = {
  components: { MessengerPanel },
};

export default exports;
