// Messenger plugin — client side.
//
// Panel for managing contacts.
// - WeChat: name → QR scan → iLink binding (send-only, no channel)
// - WS: manual endpoint URL + token

import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  RefreshCw,
} from "lucide-react";
import QRCode from "qrcode";
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
  ready?: boolean;
}

function typeIcon(type: string) {
  if (type === "wechat") return <MessageCircle size={14} className="text-success" />;
  return <Globe size={14} className="text-accent" />;
}

function typeLabel(type: string) {
  if (type === "wechat") return "WeChat";
  return "WebSocket";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── QR canvas ───────────────────────────────────────────────────

function QrCanvas({ value }: { value: string }) {
  const id = useId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setErr(null);
    QRCode.toCanvas(canvas, value, {
      width: 224, margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).catch((e: unknown) => {
      if (cancelled) return;
      setErr(e instanceof Error ? e.message : String(e));
    });
    return () => { cancelled = true; };
  }, [value]);
  if (err) {
    return (
      <div className="flex h-56 w-56 items-center justify-center rounded-md border border-danger/30 bg-danger/10 p-3 text-center text-xs text-danger">
        QR render failed: {err}
      </div>
    );
  }
  return (
    <canvas
      ref={canvasRef}
      aria-label="WeChat QR code"
      id={`messenger-qr-${id}`}
      className="h-56 w-56 rounded-md border border-border-default bg-white p-2"
    />
  );
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
    } catch { /* */ }
  };

  const doToggle = async (c: Contact) => {
    try {
      await fetch(`${API}/contacts/${c.id}`, {
        method: "PUT", credentials: "include",
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
      const r = await fetch(`${API}/contacts/${id}/test`, { method: "POST", credentials: "include" });
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
                className={`flex items-center gap-3 px-4 py-2.5 group hover:bg-bg-hover ${!c.enabled ? "opacity-50" : ""}`}
              >
                {typeIcon(c.type)}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-fg-default truncate flex items-center gap-1.5">
                    {c.name}
                    {c.type === "wechat" && c.ready === false && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-warning/15 text-warning" title="Send a message to the bot from WeChat to activate">needs activation</span>
                    )}
                  </div>
                  <div className="text-xs text-fg-faint">{typeLabel(c.type)}</div>
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

      {/* Add WeChat (QR flow) */}
      <Modal isOpen={addType === "wechat"} onClose={() => setAddType(null)} title="Add WeChat Contact" size="sm" allowMaximize={false}>
        <AddWeChatFlow onCreated={() => { setAddType(null); void refresh(); }} onCancel={() => setAddType(null)} />
      </Modal>

      {/* Add WS */}
      <Modal isOpen={addType === "ws"} onClose={() => setAddType(null)} title="Add WebSocket Contact" size="sm" allowMaximize={false}>
        <AddWsForm onCreated={() => { setAddType(null); void refresh(); }} onCancel={() => setAddType(null)} />
      </Modal>

      {/* Delete confirm */}
      <Modal isOpen={confirmDelete !== null} onClose={() => setConfirmDelete(null)} title="Delete Contact" size="sm" allowMaximize={false}>
        <div className="flex flex-col gap-4 p-1">
          <p className="text-sm text-fg-muted">Remove <span className="font-medium text-fg-default">"{confirmDelete?.name}"</span>?</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmDelete(null)} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">Cancel</button>
            <button onClick={() => { const id = confirmDelete?.id; setConfirmDelete(null); if (id) void doDelete(id); }} className="text-xs px-3 py-1.5 rounded-md bg-danger text-fg-on-accent font-medium hover:opacity-90">Delete</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Add WeChat: name → QR → auto-create (messenger's own binding) ──

function AddWeChatFlow({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [phase, setPhase] = useState<"name" | "loading" | "qr" | "done" | "error">("name");
  const [name, setName] = useState("");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pollRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  const startQr = useCallback(async () => {
    if (!name.trim()) return;
    setPhase("loading");
    setError("");
    try {
      const r = await fetch(`${API}/wechat/qr/start`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        setError(body.error ?? `HTTP ${r.status}`);
        setPhase("error");
        return;
      }
      setQrUrl(body.qrCodeImageUrl);
      setQrCode(body.qrcode);
      setPhase("qr");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [name]);

  // Poll for scan → auto-create contact
  useEffect(() => {
    if (phase !== "qr" || !qrCode) return;
    pollRef.current = { cancelled: false };
    const ref = pollRef.current;
    void (async () => {
      while (!ref.cancelled) {
        try {
          const r = await fetch(`${API}/wechat/qr/poll`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ qrcode: qrCode, name: name.trim() }),
          });
          const body = await r.json();
          if (ref.cancelled) return;
          if (!r.ok || !body.ok) {
            setError(body.error ?? `HTTP ${r.status}`);
            setPhase("error");
            return;
          }
          if (body.scanned && body.contact) {
            setPhase("done");
            return;
          }
          await sleep(1000);
        } catch (err) {
          if (ref.cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setPhase("error");
          return;
        }
      }
    })();
    return () => { ref.cancelled = true; };
  }, [phase, qrCode, name]);

  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(onCreated, 1200);
    return () => clearTimeout(t);
  }, [phase, onCreated]);

  return (
    <div className="flex flex-col items-center gap-4 p-2">
      {phase === "name" && (
        <>
          <div className="w-full">
            <label className="text-xs text-fg-muted mb-1 block">Contact Name</label>
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void startQr(); }}
              placeholder="老王" autoFocus
              className="w-full text-sm px-3 py-2 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-success"
            />
          </div>
          <div className="flex justify-end gap-2 w-full">
            <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">Cancel</button>
            <button onClick={startQr} disabled={!name.trim()} className="text-xs px-3 py-1.5 rounded-md bg-success text-white font-medium hover:opacity-90 disabled:opacity-50">
              Next — Show QR
            </button>
          </div>
        </>
      )}

      {phase === "loading" && (
        <div className="flex flex-col items-center gap-2 py-8">
          <Loader2 size={24} className="animate-spin text-success" />
          <span className="text-xs text-fg-muted">Fetching QR code…</span>
        </div>
      )}

      {phase === "qr" && qrUrl && (
        <>
          <div className="text-xs text-fg-muted text-center">
            Ask <span className="font-medium text-fg-default">{name}</span> to scan with WeChat
          </div>
          <QrCanvas value={qrUrl} />
          <div className="flex items-center gap-1.5 text-xs text-fg-fainter">
            <Loader2 size={12} className="animate-spin" />
            Waiting for scan…
          </div>
          <button onClick={onCancel} className="text-xs text-fg-faint hover:text-fg-muted">Cancel</button>
        </>
      )}

      {phase === "done" && (
        <div className="flex flex-col items-center gap-2 py-8">
          <CheckCircle2 size={28} className="text-success" />
          <span className="text-sm font-medium text-fg-default">{name}</span>
          <span className="text-xs text-fg-muted">Added successfully</span>
          <span className="text-xs text-warning mt-1">⚠ Send any message to the bot from WeChat to activate</span>
        </div>
      )}

      {phase === "error" && (
        <div className="flex flex-col items-center gap-3 py-6">
          <XCircle size={24} className="text-danger" />
          <span className="text-xs text-danger text-center">{error}</span>
          <div className="flex gap-2">
            <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">Cancel</button>
            <button onClick={() => { setPhase("name"); setError(""); }} className="text-xs px-3 py-1.5 rounded-md bg-accent text-fg-on-accent hover:opacity-90 flex items-center gap-1">
              <RefreshCw size={10} /> Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Add WS contact ──────────────────────────────────────────────

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
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), type: "ws", config, waitReply }),
      });
      const body = await r.json();
      if (body.ok) onCreated();
      else setError(body.error ?? "Failed");
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col gap-3 p-1">
      <div>
        <label className="text-xs text-fg-muted mb-1 block">Display Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-server" autoFocus
          className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent" />
      </div>
      <div>
        <label className="text-xs text-fg-muted mb-1 block">A2A Endpoint URL</label>
        <input value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} placeholder="https://other-agent.example.com/.well-known/agent.json"
          className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent font-mono" />
      </div>
      <div>
        <label className="text-xs text-fg-muted mb-1 block">Auth Token (optional)</label>
        <input value={wsToken} onChange={(e) => setWsToken(e.target.value)} type="password" placeholder="Bearer ..."
          className="w-full text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent font-mono" />
      </div>
      <label className="flex items-center gap-2 text-xs text-fg-muted cursor-pointer">
        <input type="checkbox" checked={waitReply} onChange={(e) => setWaitReply(e.target.checked)} className="rounded border-border-default" />
        Wait for reply (sync mode)
      </label>
      {error && <div className="text-xs text-danger">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">Cancel</button>
        <button onClick={doSave} disabled={saving} className="text-xs px-3 py-1.5 rounded-md bg-accent text-fg-on-accent font-medium hover:opacity-90 disabled:opacity-50">
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
