// Messenger plugin — client side.
//
// A panel listing configured contacts with add/edit/delete. The
// agent uses `send_message` tool; this panel is for configuration.

import { useCallback, useEffect, useState } from "react";
import {
  Globe,
  MessageCircle,
  Plus,
  Trash2,
  Send,
  Loader2,
  CheckCircle2,
  XCircle,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent, useUiPrimitives } from "@tianshu-ai/plugin-sdk/client";

const API = "/api/p/messenger";

interface Contact {
  id: string;
  name: string;
  type: "wechat" | "ws";
  config: Record<string, unknown>;
  waitReply: boolean;
  enabled: boolean;
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
  const [adding, setAdding] = useState(false);
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
          <Send size={16} className="text-accent" />
          <span className="text-sm font-medium">Messenger</span>
          <span className="text-xs text-fg-faint">({contacts.length})</span>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-accent text-fg-on-accent hover:opacity-90 transition-opacity"
        >
          <Plus size={12} />
          Add
        </button>
      </div>

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto">
        {contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-fg-fainter">
            <Send size={28} className="mb-2 opacity-30" />
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
                {/* Test result indicator */}
                {testResult?.id === c.id && (
                  testResult.ok
                    ? <CheckCircle2 size={14} className="text-success flex-shrink-0" />
                    : <span title={testResult.error}><XCircle size={14} className="text-danger flex-shrink-0" /></span>
                )}
                {/* Test button */}
                <button
                  onClick={() => doTest(c.id)}
                  disabled={testing === c.id || !c.enabled}
                  className="opacity-0 group-hover:opacity-100 text-xs text-fg-faint hover:text-accent px-1.5 py-0.5 rounded transition-colors flex-shrink-0"
                >
                  {testing === c.id ? <Loader2 size={12} className="animate-spin" /> : "Test"}
                </button>
                {/* Toggle */}
                <button
                  onClick={() => doToggle(c)}
                  className="opacity-0 group-hover:opacity-100 text-fg-faint hover:text-fg-default p-0.5 rounded flex-shrink-0"
                  title={c.enabled ? "Disable" : "Enable"}
                >
                  {c.enabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                </button>
                {/* Delete */}
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

      {/* Add contact modal */}
      <Modal
        isOpen={adding}
        onClose={() => setAdding(false)}
        title="Add Contact"
        size="sm"
        allowMaximize={false}
      >
        <AddContactForm
          onCreated={() => { setAdding(false); void refresh(); }}
          onCancel={() => setAdding(false)}
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
            The agent will no longer be able to send messages to this contact.
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

// ── Add contact form ────────────────────────────────────────────

function AddContactForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"wechat" | "ws">("wechat");
  const [bindingId, setBindingId] = useState("");
  const [wxId, setWxId] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [wsToken, setWsToken] = useState("");
  const [waitReply, setWaitReply] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const doSave = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    const config: Record<string, unknown> = {};
    if (type === "wechat") {
      if (!bindingId.trim() || !wxId.trim()) { setError("Binding ID and WeChat ID are required"); return; }
      config.bindingId = bindingId.trim();
      config.wxId = wxId.trim();
    } else {
      if (!wsUrl.trim()) { setError("Endpoint URL is required"); return; }
      config.url = wsUrl.trim();
      if (wsToken.trim()) config.token = wsToken.trim();
    }
    setSaving(true);
    setError("");
    try {
      const r = await fetch(`${API}/contacts`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), type, config, waitReply }),
      });
      const body = await r.json();
      if (body.ok) {
        onCreated();
      } else {
        setError(body.error ?? "Failed to create");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-1">
      {/* Type selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setType("wechat")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-medium transition-colors ${
            type === "wechat"
              ? "bg-success/15 text-success ring-1 ring-success/30"
              : "text-fg-muted hover:bg-bg-hover ring-1 ring-border-default"
          }`}
        >
          <MessageCircle size={14} /> WeChat
        </button>
        <button
          onClick={() => setType("ws")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-medium transition-colors ${
            type === "ws"
              ? "bg-accent/15 text-accent ring-1 ring-accent/30"
              : "text-fg-muted hover:bg-bg-hover ring-1 ring-border-default"
          }`}
        >
          <Globe size={14} /> WebSocket
        </button>
      </div>

      {/* Name */}
      <div>
        <label className="text-xs text-fg-muted mb-1 block">Display Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={type === "wechat" ? "老王" : "prod-server"}
          className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Type-specific fields */}
      {type === "wechat" ? (
        <>
          <div>
            <label className="text-xs text-fg-muted mb-1 block">Binding ID</label>
            <input
              value={bindingId}
              onChange={(e) => setBindingId(e.target.value)}
              placeholder="cb_..."
              className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent font-mono"
            />
            <span className="text-xs text-fg-fainter mt-0.5 block">From WeChat plugin settings</span>
          </div>
          <div>
            <label className="text-xs text-fg-muted mb-1 block">WeChat ID (wxId)</label>
            <input
              value={wxId}
              onChange={(e) => setWxId(e.target.value)}
              placeholder="o9cq80..."
              className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent font-mono"
            />
          </div>
        </>
      ) : (
        <>
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
        </>
      )}

      {/* Wait reply toggle */}
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

      {/* Actions */}
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
