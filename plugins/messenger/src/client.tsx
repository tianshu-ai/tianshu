// Messenger plugin — client side.
//
// Panel for managing contacts.
// - WeChat: name → QR scan → iLink binding (send-only, no channel)
// - WS: manual endpoint URL + token

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
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
  History,
  Zap,
  Copy,
  IdCard,
  Save,
} from "lucide-react";
import QRCode from "qrcode";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { subscribeToWsEvent, sendWsMessage, useUiPrimitives, usePluginT } from "@tianshu-ai/plugin-sdk/client";

const API = "/api/p/messenger";

interface Contact {
  id: string;
  name: string;
  type: "wechat" | "ws" | "a2a";
  config: Record<string, unknown>;
  waitReply: boolean;
  enabled: boolean;
  createdAt: number;
  ready?: boolean;
}

function typeIcon(type: string) {
  if (type === "wechat") return <MessageCircle size={14} className="text-success" />;
  return <MessageSquareShare size={14} className="text-accent" />;
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
  const { Modal, MarkdownBlock } = useUiPrimitives();
  const t = usePluginT("messenger");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [addType, setAddType] = useState<"wechat" | "ws" | "a2a" | null>(null);
  const [showA2aToken, setShowA2aToken] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; error?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Contact | null>(null);
  const [historyContact, setHistoryContact] = useState<Contact | null>(null);
  const [rebindContact, setRebindContact] = useState<Contact | null>(null);
  const [agentCard, setAgentCard] = useState<{ name: string; description: string } | null>(null);
  const [peerCardContact, setPeerCardContact] = useState<Contact | null>(null);
  const [cardExpanded, setCardExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/contacts`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) setContacts(body.contacts ?? []);
    } catch { /* best-effort */ }
    try {
      const r = await fetch(`${API}/agent-card`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) setAgentCard(body.card);
    } catch { /* */ }
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
      // Auto-clear after 3s
      setTimeout(() => setTestResult((prev) => prev?.id === id ? null : prev), 3000);
    } catch (err) {
      setTestResult({ id, ok: false, error: String(err) });
      setTimeout(() => setTestResult((prev) => prev?.id === id ? null : prev), 5000);
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
          <span className="text-sm font-medium">{t("panel.title")}</span>
          <span className="text-xs text-fg-faint">({contacts.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setAddType("wechat")}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-success/15 text-success hover:bg-success/25 transition-colors"
            title={t("panel.addWechat")}
          >
            <MessageCircle size={12} />
            <Plus size={10} />
          </button>
          <button
            onClick={() => setShowA2aToken(true)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
            title={t("panel.a2aToken")}
          >
            {t("panel.a2aToken")}
          </button>
          <button
            onClick={() => setAddType("a2a")}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 transition-colors"
            title={t("panel.addA2a")}
          >
            <Plus size={10} />
            A2A
          </button>
        </div>
      </div>

      {/* Agent Card — inline */}
      {agentCard && (
        <div className="mx-3 mt-2 mb-1 rounded-lg border border-amber-500/20 bg-amber-950/15 overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5">
            <IdCard size={12} className="text-amber-400 shrink-0" />
            <span className="text-[12px] font-medium text-amber-300 truncate flex-1">
              {agentCard.name || "Unnamed Agent"}
            </span>
            <button
              onClick={() => {
                sendWsMessage({ type: "prompt", content: "请用 update_agent_card 工具更新你的 Agent Card（name 和 description 都要更新）。先回顾我们的对话历史，总结出你主要帮我解决什么类型的问题、我的业务场景是什么。name 要根据历史起一个能体现你角色的名字（比如「Alex 的技术参谋」「小王的运营助手」），不要用默认名。description 写一段面向其他 agent 的自我介绍，重点：你的用户是谁、你帮他解决什么业务问题、你擅长什么领域。不要罗列工具名，要从业务角度描述。" });
              }}
              className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors flex items-center gap-0.5 shrink-0"
              title="让 AI 更新 Agent Card"
            >
              ✨ AI
            </button>
          </div>
          {agentCard.description ? (
            <div className="px-3 pb-2">
              <div className={`text-[11px] text-fg-faint leading-relaxed prose prose-xs prose-invert max-w-none ${cardExpanded ? "" : "line-clamp-2"}`}>
                <MarkdownBlock noProse>{agentCard.description}</MarkdownBlock>
              </div>
              {agentCard.description.length > 80 && (
                <button onClick={() => setCardExpanded((v) => !v)} className="text-[10px] text-amber-400/70 hover:text-amber-300 mt-0.5">
                  {cardExpanded ? "收起" : "...more"}
                </button>
              )}
            </div>
          ) : (
            <div className="px-3 pb-2">
              <p className="text-[11px] text-fg-fainter italic">还没有描述，点 ✨ AI 让 agent 自己写</p>
            </div>
          )}
        </div>
      )}

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto">
        {contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-fg-fainter">
            <MessageSquareShare size={28} className="mb-2 opacity-30" />
            <span className="text-xs">{t("panel.empty")}</span>
            <span className="text-xs mt-1">{t("panel.emptyHint")}</span>
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
                    {c.type === "wechat" && c.ready === false && !c.config?.disabledReason && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-warning/15 text-warning">{t("panel.needsActivation")}</span>
                    )}
                    {!c.enabled && c.config?.disabledReason === "token_expired" && (
                      <>
                        <span className="text-[10px] px-1 py-0.5 rounded bg-danger/15 text-danger">{t("panel.tokenExpired")}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); setRebindContact(c); }}
                          className="text-[10px] px-1 py-0.5 rounded bg-accent/15 text-accent hover:bg-accent/25"
                        >{t("panel.rebind")}</button>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-fg-faint">{c.type === "wechat" ? t("contact.wechat") : c.type}</div>

                </div>
                {testResult?.id === c.id && (
                  testResult.ok
                    ? <CheckCircle2 size={14} className="text-success flex-shrink-0" />
                    : <span title={testResult.error}><XCircle size={14} className="text-danger flex-shrink-0" /></span>
                )}
                {c.type === "a2a" && (c.config as any)?.peerCard && (
                  <button
                    onClick={() => setPeerCardContact(c)}
                    className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-teal-400 p-1 rounded flex-shrink-0"
                    title="Agent Card"
                  >
                    <IdCard size={12} />
                  </button>
                )}
                <button
                  onClick={() => setHistoryContact(c)}
                  className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-fg-muted p-1 rounded flex-shrink-0"
                  title={t("contact.history")}
                >
                  <History size={12} />
                </button>
                <button
                  onClick={() => doTest(c.id)}
                  disabled={testing === c.id || !c.enabled}
                  className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-accent p-1 rounded flex-shrink-0 disabled:opacity-30"
                  title={t("contact.test")}
                >
                  {testing === c.id ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                </button>
                <button
                  onClick={() => doToggle(c)}
                  className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-fg-muted p-1 rounded flex-shrink-0"
                  title={c.enabled ? t("contact.disable") : t("contact.enable")}
                >
                  {c.enabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                </button>
                <button
                  onClick={() => setConfirmDelete(c)}
                  className="opacity-0 group-hover:opacity-100 text-fg-fainter hover:text-danger p-1 rounded flex-shrink-0"
                  title={t("contact.delete")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add WeChat (QR flow) */}
      <Modal isOpen={addType === "wechat"} onClose={() => setAddType(null)} title={t("add.title")} size="sm" allowMaximize={false}>
        <AddWeChatFlow onCreated={() => { setAddType(null); void refresh(); }} onCancel={() => setAddType(null)} />
      </Modal>

      {/* A2A token */}
      <Modal isOpen={showA2aToken} onClose={() => setShowA2aToken(false)} title={t("a2a.tokenTitle")} size="sm" allowMaximize={false}>
        <A2aTokenFlow onClose={() => setShowA2aToken(false)} />
      </Modal>

      {/* Add A2A contact */}
      <Modal isOpen={addType === "a2a"} onClose={() => setAddType(null)} title={t("a2a.addTitle")} size="sm" allowMaximize={false}>
        <AddA2aFlow onDone={() => { setAddType(null); void refresh(); }} onCancel={() => setAddType(null)} />
      </Modal>



      {/* Message history */}
      <Modal isOpen={historyContact !== null} onClose={() => setHistoryContact(null)} title={t("history.title", { name: historyContact?.name ?? "" })} size="md" allowMaximize={false}>
        {historyContact && <MessageHistory contactId={historyContact.id} contactName={historyContact.name} />}
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
      {/* Peer Agent Card modal */}
      {peerCardContact && (
        <Modal isOpen={!!peerCardContact} onClose={() => setPeerCardContact(null)} title={(peerCardContact.config as any)?.peerCard?.name || peerCardContact.name} size="sm" allowMaximize={false}>
          <div className="p-3">
            <div className="text-xs text-fg-faint leading-relaxed whitespace-pre-wrap">
              <MarkdownBlock noProse>{(peerCardContact.config as any)?.peerCard?.description || "暂无描述"}</MarkdownBlock>
            </div>
          </div>
        </Modal>
      )}

      {/* Rebind WeChat (QR flow for existing contact) */}
      <Modal isOpen={rebindContact !== null} onClose={() => setRebindContact(null)} title={t("rebind.title", { name: rebindContact?.name ?? "" })} size="sm" allowMaximize={false}>
        {rebindContact && <RebindWeChatFlow contactId={rebindContact.id} onDone={() => { setRebindContact(null); void refresh(); }} onCancel={() => setRebindContact(null)} />}
      </Modal>
    </div>
  );
}

// ── Rebind WeChat: QR scan to update existing contact token ──

function RebindWeChatFlow({ contactId, onDone, onCancel }: { contactId: string; onDone: () => void; onCancel: () => void }) {
  const t = usePluginT("messenger");
  const [phase, setPhase] = useState<"loading" | "qr" | "activating" | "done" | "error">("loading");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pollRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  const startQr = useCallback(async () => {
    setPhase("loading");
    setError("");
    try {
      const r = await fetch(`${API}/wechat/qr/start`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await r.json();
      if (!r.ok || !body.ok) { setError(body.error ?? `HTTP ${r.status}`); setPhase("error"); return; }
      setQrUrl(body.qrCodeImageUrl);
      setQrCode(body.qrcode);
      setPhase("qr");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, []);

  useEffect(() => { void startQr(); }, [startQr]);

  // Poll for QR scan
  useEffect(() => {
    if (phase !== "qr" || !qrCode) return;
    pollRef.current = { cancelled: false };
    const ref = pollRef.current;
    void (async () => {
      while (!ref.cancelled) {
        try {
          const r = await fetch(`${API}/wechat/rebind/poll`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ qrcode: qrCode, contactId }),
          });
          const body = await r.json();
          if (ref.cancelled) return;
          if (body.scanned) { setPhase("activating"); return; }
          if (!r.ok) { setError(body.error ?? "failed"); setPhase("error"); return; }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => { ref.cancelled = true; };
  }, [phase, qrCode, contactId]);

  // Poll for activation (context_token from first inbound message)
  useEffect(() => {
    if (phase !== "activating") return;
    pollRef.current = { cancelled: false };
    const ref = pollRef.current;
    void (async () => {
      while (!ref.cancelled) {
        try {
          const r = await fetch(`${API}/contacts`, { credentials: "include" });
          const body = await r.json();
          if (ref.cancelled) return;
          const contact = (body.contacts ?? []).find((c: Contact) => c.id === contactId);
          if (contact?.ready) { setPhase("done"); return; }
          await sleep(2000);
        } catch {
          if (ref.cancelled) return;
          await sleep(3000);
        }
      }
    })();
    return () => { ref.cancelled = true; };
  }, [phase, contactId]);

  // Auto-close on done
  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(onDone, 1200);
    return () => clearTimeout(t);
  }, [phase, onDone]);

  if (phase === "loading") return <div className="flex justify-center p-6"><Loader2 className="w-6 h-6 animate-spin text-fg-muted" /></div>;
  if (phase === "activating") return (
    <div className="flex flex-col items-center gap-4 p-4">
      <CheckCircle2 className="w-8 h-8 text-success" />
      <p className="text-sm text-fg-muted">{t("rebind.success")}</p>
      <p className="text-xs text-warning">{t("rebind.needsActivation")}</p>
      <div className="flex items-center gap-1.5 text-xs text-fg-fainter">
        <Loader2 size={12} className="animate-spin" />
        {t("add.waitingScan")}
      </div>
    </div>
  );
  if (phase === "done") return (
    <div className="flex flex-col items-center gap-3 p-4">
      <CheckCircle2 className="w-8 h-8 text-success" />
      <p className="text-sm text-fg-muted">{t("rebind.activated")}</p>
    </div>
  );
  if (phase === "error") return (
    <div className="flex flex-col items-center gap-3 p-4">
      <XCircle className="w-6 h-6 text-danger" />
      <p className="text-sm text-danger">{error}</p>
      <div className="flex gap-2">
        <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">{t("rebind.cancel")}</button>
        <button onClick={() => void startQr()} className="text-xs px-3 py-1.5 rounded-md bg-accent text-fg-on-accent font-medium">{t("rebind.retry")}</button>
      </div>
    </div>
  );
  // QR phase
  return (
    <div className="flex flex-col items-center gap-4 p-4">
      <p className="text-xs text-fg-muted">{t("rebind.scanPrompt")}</p>
      {qrUrl && <QrCanvas value={qrUrl} />}
      <div className="flex items-center gap-1.5 text-xs text-fg-fainter">
        <Loader2 size={12} className="animate-spin" />
        {t("add.waitingScan")}
      </div>
      <button onClick={onCancel} className="text-xs text-fg-faint hover:text-fg-muted">{t("rebind.cancel")}</button>
    </div>
  );
}

// ── Add WeChat: name → QR → auto-create (messenger's own binding) ──

function AddWeChatFlow({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const t = usePluginT("messenger");
  const [phase, setPhase] = useState<"name" | "loading" | "qr" | "activating" | "done" | "error">("name");
  const [name, setName] = useState("");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
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
            setContactId(body.contact.id);
            setPhase("activating");
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

  // Phase: activating — poll until contact is ready (has context_token)
  useEffect(() => {
    if (phase !== "activating" || !contactId) return;
    pollRef.current = { cancelled: false };
    const ref = pollRef.current;
    void (async () => {
      while (!ref.cancelled) {
        try {
          const r = await fetch(`${API}/contacts`, { credentials: "include" });
          const body = await r.json();
          if (ref.cancelled) return;
          const contact = (body.contacts ?? []).find((c: Contact) => c.id === contactId);
          if (contact?.ready) {
            setPhase("done");
            return;
          }
          await sleep(2000);
        } catch {
          if (ref.cancelled) return;
          await sleep(3000);
        }
      }
    })();
    return () => { ref.cancelled = true; };
  }, [phase, contactId]);

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
            <label className="text-xs text-fg-muted mb-1 block">{t("add.nameLabel")}</label>
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void startQr(); }}
              placeholder={t("add.namePlaceholder")} autoFocus
              className="w-full text-sm px-3 py-2 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-success"
            />
          </div>
          <div className="flex justify-end gap-2 w-full">
            <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">{t("add.cancel")}</button>
            <button onClick={startQr} disabled={!name.trim()} className="text-xs px-3 py-1.5 rounded-md bg-success text-white font-medium hover:opacity-90 disabled:opacity-50">
              {t("add.next")}
            </button>
          </div>
        </>
      )}

      {phase === "loading" && (
        <div className="flex flex-col items-center gap-2 py-8">
          <Loader2 size={24} className="animate-spin text-success" />
          <span className="text-xs text-fg-muted">{t("add.fetchingQr")}</span>
        </div>
      )}

      {phase === "qr" && qrUrl && (
        <>
          <div className="text-xs text-fg-muted text-center">
            {t("add.askScan", { name })}
          </div>
          <QrCanvas value={qrUrl} />
          <div className="flex items-center gap-1.5 text-xs text-fg-fainter">
            <Loader2 size={12} className="animate-spin" />
            {t("add.waitingScan")}
          </div>
          <button onClick={onCancel} className="text-xs text-fg-faint hover:text-fg-muted">{t("add.cancel")}</button>
        </>
      )}

      {phase === "activating" && (
        <div className="flex flex-col items-center gap-3 py-6">
          <MessageCircle size={28} className="text-success" />
          <span className="text-sm font-medium text-fg-default">{name}</span>
          <span className="text-xs text-fg-muted text-center">
            {t("add.scanOk", { name })}
          </span>
          <div className="flex items-center gap-1.5 text-xs text-fg-fainter mt-1">
            <Loader2 size={12} className="animate-spin" />
            {t("add.waitingMsg")}
          </div>
          <button onClick={onCancel} className="text-xs text-fg-faint hover:text-fg-muted mt-2">{t("add.skip")}</button>
        </div>
      )}

      {phase === "done" && (
        <div className="flex flex-col items-center gap-2 py-8">
          <CheckCircle2 size={28} className="text-success" />
          <span className="text-sm font-medium text-fg-default">{name}</span>
          <span className="text-xs text-fg-muted">{t("add.done")}</span>
        </div>
      )}

      {phase === "error" && (
        <div className="flex flex-col items-center gap-3 py-6">
          <XCircle size={24} className="text-danger" />
          <span className="text-xs text-danger text-center">{error}</span>
          <div className="flex gap-2">
            <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">Cancel</button>
            <button onClick={() => { setPhase("name"); setError(""); }} className="text-xs px-3 py-1.5 rounded-md bg-accent text-fg-on-accent hover:opacity-90 flex items-center gap-1">
              <RefreshCw size={10} /> {t("add.retry")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Message history (WeChat style) ──────────────────────────────

interface MessageRecord {
  id: string;
  contactId: string;
  direction: "outbound" | "inbound";
  text: string;
  status: "sent" | "failed" | "received";
  error?: string;
  createdAt: number;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDateLabel(ts: number, t: (k: string) => string): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t("history.today");
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t("history.yesterday");
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function showDateSep(prev: MessageRecord | null, curr: MessageRecord): boolean {
  if (!prev) return true;
  return new Date(prev.createdAt).toDateString() !== new Date(curr.createdAt).toDateString();
}

function showTimeSep(prev: MessageRecord | null, curr: MessageRecord): boolean {
  if (!prev) return true;
  return curr.createdAt - prev.createdAt > 5 * 60 * 1000;
}

function MessageHistory({ contactId, contactName }: { contactId: string; contactName: string }) {
  const t = usePluginT("messenger");
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const r = await fetch(`${API}/contacts/${contactId}/messages`, { credentials: "include" });
        const body = await r.json();
        // API returns newest-first; reverse to chronological
        if (body.ok) setMessages((body.messages ?? []).reverse());
      } catch { /* */ }
      setLoading(false);
    })();
  }, [contactId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={18} className="animate-spin text-fg-faint" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-fg-fainter">
        <MessageSquareShare size={28} className="mb-2 opacity-20" />
        <span className="text-xs">{t("panel.noMessages")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-96 overflow-y-auto rounded-md" style={{ background: "var(--bg-chat, #ededed)" }}>
      <div className="flex-1 px-3 py-2">
        {messages.map((m, i) => {
          const prev = i > 0 ? messages[i - 1] : null;
          const dateSep = showDateSep(prev, m);
          const timeSep = dateSep || showTimeSep(prev, m);
          return (
            <div key={m.id}>
              {/* Date label */}
              {dateSep && (
                <div className="flex justify-center py-2">
                  <span className="text-[10px] px-2.5 py-0.5 rounded-sm bg-black/[.06] dark:bg-white/[.08] text-fg-fainter">
                    {fmtDateLabel(m.createdAt, t)}
                  </span>
                </div>
              )}
              {/* Time label */}
              {timeSep && !dateSep && (
                <div className="flex justify-center py-1.5">
                  <span className="text-[10px] text-fg-fainter">{fmtTime(m.createdAt)}</span>
                </div>
              )}
              {/* Bubble row */}
              {m.direction === "inbound" ? (
                /* ── Inbound: left-aligned ── */
                <div className="flex justify-start items-start gap-1.5 mb-1">
                  {/* Avatar placeholder */}
                  <div className="w-8 h-8 rounded flex-shrink-0 bg-[#3d3d3d] flex items-center justify-center">
                    <span className="text-[11px] font-bold text-[#e8e8e8]">{contactName.charAt(0).toUpperCase()}</span>
                  </div>
                  <div className="flex flex-col max-w-[75%]">
                    <span className="text-[10px] text-fg-faint mb-0.5 ml-1">{contactName}</span>
                    <div className="relative px-2.5 py-[7px] rounded-[4px] text-[13px] leading-[1.45] whitespace-pre-wrap break-words bg-white dark:bg-[#3d3d3d] text-[#1f1f1f] dark:text-[#e8e8e8]">
                      {/* Tail triangle — left */}
                      <div className="absolute top-[10px] -left-[5px] w-0 h-0 border-t-[5px] border-t-transparent border-b-[5px] border-b-transparent border-r-[6px] border-r-white dark:border-r-[#3d3d3d]" />
                      {m.text}
                    </div>
                  </div>
                </div>
              ) : (
                /* ── Outbound: right-aligned ── */
                <div className="flex justify-end items-start gap-1.5 mb-1">
                  {/* Failure icon */}
                  {m.status === "failed" && (
                    <span title={m.error ?? "Send failed"} className="mt-1 flex-shrink-0">
                      <XCircle size={15} className="text-danger" />
                    </span>
                  )}
                  <div className="flex flex-col items-end max-w-[75%]">
                    <span className="text-[10px] text-fg-faint mb-0.5 mr-1">{t("history.me")}</span>
                    <div
                      className={`relative px-2.5 py-[7px] rounded-[4px] text-[13px] leading-[1.45] whitespace-pre-wrap break-words ${
                        m.status === "sent" || m.status === "received"
                          ? "bg-[#95ec69] dark:bg-[#3eb575] text-[#1f1f1f] dark:text-[#111]"
                          : "bg-red-200 dark:bg-red-900/50 text-danger"
                      }`}
                    >
                      {/* Tail triangle — right */}
                      <div
                        className={`absolute top-[10px] -right-[5px] w-0 h-0 border-t-[5px] border-t-transparent border-b-[5px] border-b-transparent ${
                          m.status === "sent" || m.status === "received"
                            ? "border-l-[6px] border-l-[#95ec69] dark:border-l-[#3eb575]"
                            : "border-l-[6px] border-l-red-200 dark:border-l-red-900/50"
                        }`}
                      />
                      {m.text}
                    </div>
                  </div>
                  {/* Avatar placeholder */}
                  <div className="w-8 h-8 rounded flex-shrink-0 bg-[#95ec69] dark:bg-[#3eb575] flex items-center justify-center">
                    <span className="text-[11px] font-bold text-[#1f1f1f] dark:text-[#111]">Me</span>
                  </div>
                </div>
              )}
              {/* Error detail below bubble */}
              {m.status === "failed" && m.error && (
                <div className="flex justify-end pr-1 mb-1">
                  <span className="text-[10px] text-danger/60 max-w-[75%] text-right">{m.error}</span>
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Agent Card editor ───────────────────────────────────────────

interface AgentCardData {
  name: string;
  description: string;
}

function AgentCardEditor({ onClose }: { onClose: () => void }) {
  const [card, setCard] = useState<AgentCardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`${API}/agent-card`, { credentials: "include" });
        const body = await r.json();
        if (body.ok) setCard(body.card);
      } catch { /* */ }
      setLoading(false);
    })();
  }, []);

  const doSave = useCallback(async () => {
    if (!card) return;
    setSaving(true);
    setSaved(false);
    try {
      const r = await fetch(`${API}/agent-card`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(card),
      });
      const body = await r.json();
      if (body.ok) {
        setCard(body.card);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { /* */ }
    setSaving(false);
  }, [card]);

  if (loading) return <div className="flex justify-center p-6"><Loader2 className="w-6 h-6 animate-spin text-fg-muted" /></div>;
  if (!card) return <div className="p-4 text-sm text-danger">Failed to load agent card</div>;

  const inputCls = "w-full text-sm px-3 py-2 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-amber-500/50";

  return (
    <div className="flex flex-col gap-3 p-2">
      <p className="text-xs text-fg-faint">
        Agent Card 是其他 agent 通过 A2A 看到的你的名片。你也可以让 agent 自己用 update_agent_card 工具更新。
      </p>
      {/* Name */}
      <div>
        <label className="text-xs text-fg-muted mb-1 block">Name</label>
        <input value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} placeholder="e.g. Tianshu" className={inputCls} />
      </div>

      {/* Description */}
      <div>
        <label className="text-xs text-fg-muted mb-1 block">Description</label>
        <textarea value={card.description} onChange={(e) => setCard({ ...card, description: e.target.value })}
          placeholder="描述这个 agent 能做什么… 你也可以让 agent 自己填写" rows={6}
          className={`${inputCls} resize-none`} />
      </div>

      {/* Save */}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">Cancel</button>
        <button onClick={doSave} disabled={saving}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-amber-500 text-black font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
          {saving ? <Loader2 size={12} className="animate-spin" /> : saved ? <CheckCircle2 size={12} /> : <Save size={12} />}
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── A2A token flow ──────────────────────────────────────────────

function A2aTokenFlow({ onClose }: { onClose: () => void }) {
  const t = usePluginT("messenger");
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`${API}/a2a/token`, { method: "POST", credentials: "include" });
        const body = await r.json();
        if (body.ok) setPairUrl(body.pairUrl || body.token);
      } catch { /* */ }
      setLoading(false);
    })();
  }, []);

  const doCopy = useCallback(() => {
    if (!pairUrl) return;
    void navigator.clipboard.writeText(pairUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [pairUrl]);

  if (loading) return <div className="flex justify-center p-6"><Loader2 className="w-6 h-6 animate-spin text-fg-muted" /></div>;

  return (
    <div className="flex flex-col items-center gap-4 p-4">
      {pairUrl && (
        <div className="w-full px-3 py-2 rounded-md bg-bg-elevated border border-border-default text-xs font-mono text-fg-muted break-all text-center select-all">
          {pairUrl}
        </div>
      )}
      <p className="text-xs text-fg-muted text-center">{t("a2a.tokenHint")}</p>
      <button onClick={doCopy} disabled={!pairUrl} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50">
        {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
        {copied ? t("a2a.copied") : t("a2a.copyUrl")}
      </button>
    </div>
  );
}

// ── Add A2A contact flow ────────────────────────────────────────

function AddA2aFlow({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const t = usePluginT("messenger");
  const [name, setName] = useState("");
  const [pasteValue, setPasteValue] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [parsed, setParsed] = useState(false);
  const [phase, setPhase] = useState<"paste" | "confirm" | "saving" | "done" | "error">("paste");
  const [error, setError] = useState("");

  /** Parse a URL like https://host/api/p/messenger/a2a/receive?key=xxx */
  const parseInput = useCallback((raw: string) => {
    setPasteValue(raw);
    try {
      const u = new URL(raw.trim());
      const key = u.searchParams.get("token");
      if (key) {
        u.searchParams.delete("token");
        const ep = u.toString().replace(/\?$/, "");
        setEndpoint(ep);
        setApiKey(key);
        // Derive name from hostname
        setName(u.hostname);
        setParsed(true);
        return;
      }
    } catch { /* not a URL */ }
    setParsed(false);
  }, []);

  const doPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) parseInput(text);
    } catch { /* clipboard denied */ }
  }, [parseInput]);

  const doSave = useCallback(async () => {
    if (!endpoint.trim() || !apiKey.trim()) return;
    setPhase("saving");
    setError("");
    try {
      const r = await fetch(`${API}/contacts`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "A2A Agent", type: "a2a", config: { endpoint: endpoint.trim(), apiKey: apiKey.trim() } }),
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
  }, [name, endpoint, apiKey, onDone]);

  if (phase === "saving") return <div className="flex justify-center p-6"><Loader2 className="w-6 h-6 animate-spin text-fg-muted" /></div>;
  if (phase === "done") return (
    <div className="flex flex-col items-center gap-3 p-4">
      <CheckCircle2 className="w-8 h-8 text-success" />
      <p className="text-sm text-fg-muted">{t("a2a.addSuccess")}</p>
    </div>
  );
  if (phase === "error") return (
    <div className="flex flex-col items-center gap-3 p-4">
      <XCircle className="w-6 h-6 text-danger" />
      <p className="text-sm text-danger">{error}</p>
      <div className="flex gap-2">
        <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">{t("a2a.cancel")}</button>
        <button onClick={() => setPhase("paste")} className="text-xs px-3 py-1.5 rounded-md bg-accent text-fg-on-accent font-medium">{t("a2a.retry")}</button>
      </div>
    </div>
  );

  if (phase === "confirm" || parsed) return (
    <div className="flex flex-col gap-3 p-2">
      <div>
        <label className="text-xs text-fg-muted mb-1 block">{t("a2a.nameLabel")}</label>
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder={t("a2a.namePlaceholder")} autoFocus
          className="w-full text-sm px-3 py-2 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
      <div className="text-xs text-fg-faint font-mono break-all px-1">{endpoint}</div>
      <div className="flex justify-end gap-2">
        <button onClick={() => { setParsed(false); setPhase("paste"); }} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">{t("a2a.cancel")}</button>
        <button onClick={doSave} className="text-xs px-3 py-1.5 rounded-md bg-success text-white font-medium hover:opacity-90">{t("a2a.save")}</button>
      </div>
    </div>
  );

  // paste phase
  return (
    <div className="flex flex-col items-center gap-4 p-4">
      <p className="text-xs text-fg-muted text-center">{t("a2a.pasteHint")}</p>
      <button onClick={doPaste} className="flex items-center gap-2 text-sm px-4 py-2.5 rounded-md bg-accent/15 text-accent hover:bg-accent/25 font-medium transition-colors">
        <Copy size={14} />
        {t("a2a.pasteButton")}
      </button>
      <div className="w-full">
        <input
          value={pasteValue} onChange={(e) => parseInput(e.target.value)}
          placeholder={t("a2a.pasteInputPlaceholder")}
          className="w-full text-xs px-3 py-2 rounded-md bg-bg-elevated border border-border-default text-fg-default placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-accent font-mono"
        />
      </div>
      <div className="flex justify-end w-full">
        <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">{t("a2a.cancel")}</button>
      </div>
    </div>
  );
}

// ── exports ─────────────────────────────────────────────────────

const exports: PluginClientExports = {
  components: { MessengerPanel },
};

export default exports;
