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
  Bot,
  Send,
  MoreHorizontal,
  Sparkles,
  Share2,
  Bluetooth,
  Users,
  X,
  Search,
  BluetoothOff,
  BluetoothSearching,
  ArrowLeftRight,
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
  lastMessage?: { text: string; direction: string; createdAt: number } | null;
}

function typeIcon(type: string, config?: Record<string, unknown>) {
  if (type === "wechat") return <MessageCircle size={14} className="text-success" />;
  if (type === "a2a" && config?.endpoint && /\/u\/[^/]+\//.test(config.endpoint as string)) return <Bluetooth size={14} className="text-blue-500" />;
  return <MessageSquareShare size={14} className="text-accent" />;
}

function typeLabel(type: string) {
  if (type === "wechat") return "WeChat";
  return "WebSocket";
}

function formatContactTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth()) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function contactAvatar(name: string, type: string, config?: Record<string, unknown>) {
  const initial = name.charAt(0).toUpperCase();
  const isRelay = type === "a2a" && config?.endpoint && /\/u\/[^/]+\//.test(config.endpoint as string);
  const colors: Record<string, string> = {
    a2a: isRelay ? "bg-blue-500/20 text-blue-500" : "bg-accent/20 text-accent",
    wechat: "bg-success/20 text-success",
    ws: "bg-blue-500/20 text-blue-400",
  };
  const badges: Record<string, { icon: typeof Bot; color: string }> = {
    a2a: isRelay ? { icon: Bluetooth, color: "bg-blue-500 text-white" } : { icon: Sparkles, color: "bg-accent/80 text-fg-on-accent" },
    wechat: { icon: MessageCircle, color: "bg-success text-white" },
  };
  const cls = colors[type] || colors.ws;
  const badge = badges[type];
  return (
    <div className="relative flex-shrink-0">
      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${cls}`}>
        <span className="text-sm font-semibold">{initial}</span>
      </div>
      {badge && (
        <div className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center ring-2 ring-bg-base ${badge.color}`}>
          <badge.icon size={9} />
        </div>
      )}
    </div>
  );
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
  const [pairRequests, setPairRequests] = useState<any[]>([]);
  const [addType, setAddType] = useState<"wechat" | "ws" | "a2a" | "discover" | null>(null);
  const [showA2aToken, setShowA2aToken] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [contactMenu, setContactMenu] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; error?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Contact | null>(null);
  const [historyContact, setHistoryContact] = useState<Contact | null>(null);
  const [rebindContact, setRebindContact] = useState<Contact | null>(null);
  const [agentCard, setAgentCard] = useState<AgentCardData | null>(null);
  const [peerCardContact, setPeerCardContact] = useState<Contact | null>(null);
  const [showPairRequests, setShowPairRequests] = useState(false);
  const [cardExpanded, setCardExpanded] = useState(false);
  const [relayStatus, setRelayStatus] = useState<{ enabled: boolean; connected?: boolean; discoverable?: boolean; publicUrl?: string; orgId?: string; agentId?: string; userId?: string } | null>(null);

  const refreshRelay = useCallback(async () => {
    try {
      const r = await fetch(`${API}/relay/status`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) setRelayStatus(body);
    } catch { /* ignore */ }
  }, []);

  const toggleDiscoverable = useCallback(async () => {
    try {
      const next = !relayStatus?.discoverable;
      await fetch(`${API}/relay/discoverable`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discoverable: next }),
      });
      refreshRelay();
    } catch { /* ignore */ }
  }, [relayStatus, refreshRelay]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/contacts`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) setContacts(body.contacts ?? []);
    } catch { /* best-effort */ }
    try {
      const r = await fetch(`${API}/relay/pair-requests`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) setPairRequests(body.requests ?? []);
    } catch { /* */ }
    try {
      const r = await fetch(`${API}/agent-card`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) setAgentCard(body.card);
    } catch { /* */ }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshRelay();
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

  const doBidirectionalToggle = async (c: Contact) => {
    try {
      const current = !!(c.config as any)?.bidirectional;
      await fetch(`${API}/contacts/${c.id}`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { ...c.config, bidirectional: !current } }),
      });
      void refresh();
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
          <span className="text-[15px] font-semibold tracking-tight">{t("panel.title")}</span>
          {relayStatus && (
            <button
              onClick={toggleDiscoverable}
              disabled={!relayStatus.connected}
              title={
                !relayStatus.connected ? "Relay disconnected"
                : relayStatus.discoverable ? "Discoverable — click to hide"
                : "Hidden — click to be discoverable"
              }
              className={`p-1 rounded transition-colors ${
                !relayStatus.connected ? "text-red-400 opacity-50 cursor-not-allowed"
                : relayStatus.discoverable ? "text-blue-500 hover:text-blue-400"
                : "text-fg-muted hover:text-fg-default"
              }`}
            >
              {!relayStatus.connected ? <BluetoothOff size={16} />
              : relayStatus.discoverable ? <BluetoothSearching size={16} />
              : <Bluetooth size={16} />}
            </button>
          )}
          {relayStatus?.discoverable && (
            <span className="text-[11px] text-fg-muted whitespace-nowrap">{t("pair.discoverableHint")}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(() => {
            const cnt = pairRequests.filter(r => r.direction === 'inbound' && r.status === 'pending').length;
            return (
              <button onClick={() => setShowPairRequests(v => !v)} className={`relative w-7 h-7 flex items-center justify-center rounded-full hover:bg-bg-hover transition-colors ${showPairRequests ? 'text-blue-500' : 'text-fg-muted hover:text-fg-default'}`}>
                <Users size={16} />
                {cnt > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-medium px-1">{cnt}</span>}
              </button>
            );
          })()}
          <div className="relative">
          <button
            onClick={() => setShowAddMenu((v) => !v)}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-bg-hover text-fg-muted hover:text-fg-default transition-colors"
          >
            <Plus size={18} strokeWidth={2} />
          </button>
          {showAddMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowAddMenu(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 w-auto min-w-[10rem] rounded-xl border border-border-subtle bg-bg-surface shadow-lg overflow-hidden whitespace-nowrap">
                <button
                  onClick={() => { setShowAddMenu(false); setAddType("wechat"); }}
                  className="flex items-center gap-3 w-full px-3.5 py-2.5 text-sm text-fg-default hover:bg-bg-hover transition-colors"
                >
                  <MessageCircle size={16} className="text-success" />
                  {t("panel.addWechat")}
                </button>
                <button
                  onClick={() => { setShowAddMenu(false); setAddType("a2a"); }}
                  className="flex items-center gap-3 w-full px-3.5 py-2.5 text-sm text-fg-default hover:bg-bg-hover transition-colors"
                >
                  <Sparkles size={16} className="text-accent" />
                  {t("panel.addAgent")}
                </button>
                {relayStatus?.connected && (
                  <button
                    onClick={() => { setShowAddMenu(false); setAddType("discover"); }}
                    className="flex items-center gap-3 w-full px-3.5 py-2.5 text-sm text-fg-default hover:bg-bg-hover transition-colors"
                  >
                    <Bluetooth size={16} className="text-blue-500" />
                    {t("pair.title")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        </div>
      </div>

      {/* Agent Card — inline */}
      {agentCard && (
        <div className="mx-3 mt-3 mb-1 rounded-xl border border-border-subtle/60 bg-bg-surface/80 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2">
            <IdCard size={12} className="text-accent shrink-0" />
            <span className="text-sm font-medium text-fg-default truncate flex-1">
              {agentCard.name || t("card.unnamed")}
            </span>
            <button
              onClick={() => {
                sendWsMessage({ type: "prompt", content: "请用 update_agent_card 工具更新你的 Agent Card（标准 A2A 格式）。先回顾我们的对话历史，总结出你主要帮我解决什么类型的问题、我的业务场景是什么。\n\n需要更新的字段：\n- name: 根据历史起一个能体现你角色的名字（比如「Alex 的技术参谋」「小王的运营助手」），不要用默认名\n- description: 面向其他 agent 的自我介绍，重点：你的用户是谁、你帮他解决什么业务问题、你擅长什么领域\n- provider: 提供者组织名（比如用户的公司名或个人名）\n- version: 版本号如 1.0.0\n- skills: 技能列表，每个 skill 有 id、name、description，从业务角度描述你能做什么（不要罗列工具名）\n\n示例 skills: [{id: 'code-review', name: '代码审查', description: '审查 PR、发现 bug、建议改进'}]" });
              }}
              className="w-6 h-6 flex items-center justify-center rounded-full text-fg-muted hover:text-accent hover:bg-accent/10 transition-colors shrink-0"
              title={t("card.refreshTitle")}
            >
              <RefreshCw size={13} />
            </button>
            <button
              onClick={() => setShowA2aToken(true)}
              className="w-6 h-6 flex items-center justify-center rounded-full text-fg-muted hover:text-accent hover:bg-accent/10 transition-colors shrink-0"
              title={t("card.shareTitle")}
            >
              <Share2 size={13} />
            </button>
          </div>
          {agentCard.description ? (
            <div className="px-3 pb-2">
              <div className={`text-xs text-fg-faint leading-relaxed max-w-none [&_p]:my-1 ${cardExpanded ? "" : "line-clamp-2"}`}>
                <MarkdownBlock noProse>{agentCard.description}</MarkdownBlock>
              </div>
              {agentCard.description.length > 80 && (
                <button onClick={() => setCardExpanded((v) => !v)} className="text-xs text-accent/70 hover:text-accent mt-0.5">
                  {cardExpanded ? t("card.collapse") : t("card.expand")}
                </button>
              )}
            </div>
          ) : (
            <div className="px-3 pb-2">
              <p className="text-xs text-fg-fainter italic">{t("card.emptyHint")}</p>
            </div>
          )}
          {/* Provider / Version / Skills metadata */}
          {(agentCard.provider || agentCard.version || (agentCard.skills && agentCard.skills.length > 0)) && (
            <div className="px-3 pb-2 space-y-1.5">
              {(agentCard.provider || agentCard.version) && (
                <div className="flex items-center gap-2 text-[11px] text-fg-fainter">
                  {agentCard.provider && <span>{agentCard.provider}</span>}
                  {agentCard.provider && agentCard.version && <span>·</span>}
                  {agentCard.version && <span>v{agentCard.version}</span>}
                </div>
              )}
              {agentCard.skills && agentCard.skills.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {agentCard.skills.map((s: { id: string; name: string; description?: string }) => (
                    <span key={s.id} title={s.description || s.name}
                      className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent/80">
                      <Zap size={9} />{s.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pair requests view */}
      {showPairRequests ? (
        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle">
            <span className="text-sm font-medium">配对请求</span>
            <button onClick={() => setShowPairRequests(false)} className="text-xs text-fg-muted hover:text-fg-default">返回</button>
          </div>
          {pairRequests.filter(r => r.direction === 'inbound' && r.status === 'pending').length === 0 ? (
            <div className="text-center text-fg-muted text-sm py-8">
              {t("pair.noRequests")}
              <br />
              <button onClick={() => setShowPairRequests(false)} className="text-blue-500 hover:text-blue-400 text-xs mt-2 inline-block">{t("pair.backToContacts")}</button>
            </div>
          ) : (
            pairRequests.filter(r => r.direction === 'inbound' && r.status === 'pending').map(r => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-blue-500/20 text-blue-500 flex-shrink-0">
                  <span className="text-sm font-semibold">{(r.peer_name || '?').charAt(0).toUpperCase()}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-fg-default truncate">{r.peer_name || r.peer_agent_id || '未知 Agent'}</div>
                  {r.peerCard?.description && <div className="text-xs text-fg-muted truncate">{r.peerCard.description}</div>}
                </div>
                <div className="flex gap-1.5 flex-shrink-0">
                  <button
                    onClick={async () => { await fetch(`${API}/relay/pair-accept`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: r.id }) }); void refresh(); }}
                    className="text-xs px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                  >接受</button>
                  <button
                    onClick={async () => { await fetch(`${API}/relay/pair-reject`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: r.id }) }); void refresh(); }}
                    className="text-xs px-3 py-1 rounded border border-border-subtle text-fg-muted hover:bg-bg-hover transition-colors"
                  >拒绝</button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
      /* Contact list */
      <div className="flex-1 overflow-y-auto">
        {/* Outbound pending pair requests shown as contacts */}
        {pairRequests.filter(r => r.direction === 'outbound' && (r.status === 'pending' || r.status === 'rejected')).map(r => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-3 group hover:bg-bg-hover">
            {contactAvatar(r.peer_name || r.peer_agent_id || '?', 'a2a', { endpoint: `/u/${r.peer_org_id}/${r.peer_agent_id || '-'}` })}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-fg-default truncate">{r.peer_name || r.peer_agent_id || '未知 Agent'}</span>
              </div>
              <div className="flex items-center justify-between gap-2 mt-0.5">
                <span className={`text-xs ${r.status === 'rejected' ? 'text-red-400' : 'text-yellow-500'}`}>
                  {r.status === 'rejected' ? t("pair.rejected") : t("pair.pendingVerify")}
                </span>
              </div>
            </div>
            <div className="relative flex-shrink-0">
              <button
                onClick={(e) => { e.stopPropagation(); setContactMenu(contactMenu === r.id ? null : r.id); }}
                className="opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded-full hover:bg-bg-hover text-fg-fainter hover:text-fg-muted transition-colors"
              >
                <MoreHorizontal size={16} />
              </button>
              {contactMenu === r.id && (
                <>
                  <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setContactMenu(null); }} />
                  <div className="absolute right-0 top-full mt-1 z-20 w-40 rounded-xl border border-border-subtle shadow-lg overflow-hidden" style={{ backgroundColor: 'var(--color-bg-surface, #131a27)' }}>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        setContactMenu(null);
                        await fetch(`${API}/relay/pair-dismiss`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: r.id }) });
                        void refresh();
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-danger hover:bg-bg-hover transition-colors"
                    >
                      <Trash2 size={15} /> 删除
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
        {contacts.length === 0 && pairRequests.filter(r => r.direction === 'outbound' && (r.status === 'pending' || r.status === 'rejected')).length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-fg-fainter">
            <Send size={32} className="mb-3 opacity-20" />
            <span className="text-xs">{t("panel.empty")}</span>
            <span className="text-xs mt-1">{t("panel.emptyHint")}</span>
          </div>
        ) : (
          <div className="py-1">
            {contacts.map((c, idx) => (
              <div key={c.id}>
              <div
                className={`flex items-center gap-3 px-4 py-3 group hover:bg-bg-hover cursor-pointer ${!c.enabled ? "opacity-50" : ""}`}
                onClick={() => setHistoryContact(c)}
              >
                {contactAvatar(c.name, c.type, c.config)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 min-w-0">
                      <span className="text-sm font-medium text-fg-default truncate">{c.name}</span>
                      {c.type === "wechat" && (c.config as any)?.bidirectional && (
                        <ArrowLeftRight size={12} className="text-accent flex-shrink-0" />
                      )}
                    </span>
                    <span className="text-xs text-fg-fainter flex-shrink-0">
                      {c.lastMessage ? formatContactTime(c.lastMessage.createdAt) : ""}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-xs text-fg-faint truncate">
                      {c.lastMessage
                        ? (c.lastMessage.direction === "outbound" ? t("history.me") + ": " : "") + c.lastMessage.text.replace(/\n/g, " ")
                        : (c.config as any)?.peerCard?.description?.slice(0, 60)?.replace(/\n/g, " ") || ""}
                    </span>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      {c.type === "wechat" && c.ready === false && !c.config?.disabledReason && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-warning/15 text-warning">{t("panel.needsActivation")}</span>
                      )}
                      {!c.enabled && c.config?.disabledReason === "token_expired" && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-danger/15 text-danger">{t("panel.tokenExpired")}</span>
                      )}
                      {!c.enabled && (c.config as any)?.disabledReason === "peer_disconnected" && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-fg-faint/15 text-fg-faint">{t("contact.disconnected")}</span>
                      )}
                    </div>
                  </div>
                </div>
                {testResult?.id === c.id && (
                  testResult.ok
                    ? <CheckCircle2 size={14} className="text-success flex-shrink-0" />
                    : <span title={testResult.error}><XCircle size={14} className="text-danger flex-shrink-0" /></span>
                )}
                <div className="relative flex-shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); setContactMenu(contactMenu === c.id ? null : c.id); }}
                    className="opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded-full hover:bg-bg-hover text-fg-fainter hover:text-fg-muted transition-colors"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {contactMenu === c.id && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setContactMenu(null); }} />
                      <div className="absolute right-0 top-full mt-1 z-20 w-40 rounded-xl border border-border-subtle shadow-lg overflow-hidden" style={{ backgroundColor: 'var(--color-bg-surface, #131a27)' }}>
                        {c.type === "a2a" && (c.config as any)?.peerCard && (
                          <button onClick={(e) => { e.stopPropagation(); setContactMenu(null); setPeerCardContact(c); }} className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-fg-default hover:bg-bg-hover transition-colors">
                            <IdCard size={15} className="text-fg-muted" /> {t("menu.card")}
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); setContactMenu(null); doTest(c.id); }} disabled={testing === c.id || !c.enabled} className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-fg-default hover:bg-bg-hover transition-colors disabled:opacity-30">
                          <Zap size={15} className="text-fg-muted" /> {t("menu.ping")}
                        </button>
                        {c.type === "wechat" && (
                          <button onClick={(e) => { e.stopPropagation(); setContactMenu(null); void doBidirectionalToggle(c); }} className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-fg-default hover:bg-bg-hover transition-colors">
                            {(c.config as any)?.bidirectional ? <ToggleRight size={15} className="text-accent" /> : <ToggleLeft size={15} className="text-fg-muted" />}
                            {t("contact.bidirectional")}
                          </button>
                        )}
                        {(c.config as any)?.disabledReason !== "peer_disconnected" && (
                          <button onClick={(e) => { e.stopPropagation(); setContactMenu(null); doToggle(c); }} className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-fg-default hover:bg-bg-hover transition-colors">
                            {c.enabled ? <ToggleRight size={15} className="text-fg-muted" /> : <ToggleLeft size={15} className="text-fg-muted" />}
                            {c.enabled ? t("contact.disable") : t("contact.enable")}
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); setContactMenu(null); setConfirmDelete(c); }} className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-danger hover:bg-danger/10 transition-colors">
                          <Trash2 size={15} /> {t("menu.delete")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              {idx < contacts.length - 1 && <div className="mx-4 border-b border-border-subtle/50" />}
              </div>
            ))}
          </div>
        )}
      </div>
      )}

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

      <Modal isOpen={addType === "discover"} onClose={() => setAddType(null)} title={t("pair.title")} size="sm" allowMaximize={false}>
        <PairAgentFlow myOrgId={relayStatus?.orgId} myAgentId={relayStatus?.agentId} myUserId={relayStatus?.userId} contacts={contacts} pairRequests={pairRequests} onDone={() => { setAddType(null); void refresh(); }} onCancel={() => setAddType(null)} />
      </Modal>



      {/* Message history */}
      <Modal isOpen={historyContact !== null} onClose={() => setHistoryContact(null)} title={t("history.title", { name: historyContact?.name ?? "" })} size="lg" allowMaximize={true}>
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
      {peerCardContact && (() => {
        const pc = (peerCardContact.config as any)?.peerCard || {};
        const cardName = pc.name || peerCardContact.name;
        const initial = (cardName || "?")[0].toUpperCase();
        return (
          <Modal isOpen onClose={() => setPeerCardContact(null)} title={t("menu.card")} size="sm" allowMaximize={false}>
            <div className="flex flex-col items-center py-4 px-4">
              {/* Avatar */}
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-accent/80 to-accent/40 flex items-center justify-center mb-3 shadow-lg">
                <span className="text-2xl font-bold text-white">{initial}</span>
              </div>
              {/* Name */}
              <h3 className="text-base font-semibold text-fg-default mb-0.5">{cardName}</h3>
              {/* Provider · Version */}
              {(pc.provider || pc.version) && (
                <div className="flex items-center gap-1.5 text-[11px] text-fg-fainter mb-2">
                  {pc.provider && <span>{pc.provider}</span>}
                  {pc.provider && pc.version && <span>·</span>}
                  {pc.version && <span>v{pc.version}</span>}
                </div>
              )}
              {/* Type badge */}
              <div className="flex items-center gap-1 text-[10px] text-fg-muted mb-3">
                {peerCardContact.type === "a2a" ? <><Sparkles size={10} className="text-accent" /> A2A Agent</> : <><MessageCircle size={10} /> WeChat</>}
              </div>
            </div>
            {/* Description */}
            {pc.description ? (
              <div className="px-4 pb-3">
                <div className="text-xs text-fg-faint leading-relaxed [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5">
                  <MarkdownBlock noProse>{pc.description}</MarkdownBlock>
                </div>
              </div>
            ) : (
              <div className="px-4 pb-3 text-center">
                <p className="text-xs text-fg-fainter italic">{t("card.peerEmpty")}</p>
              </div>
            )}
            {/* Skills */}
            {pc.skills && pc.skills.length > 0 && (
              <div className="px-4 pb-3">
                <div className="flex flex-wrap gap-1">
                  {pc.skills.map((s: { id: string; name: string; description?: string }) => (
                    <span key={s.id} title={s.description || s.name}
                      className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent/80">
                      <Zap size={9} />{s.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

          </Modal>
        );
      })()}

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
        <Loader2 size={15} className="animate-spin" />
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
        <Loader2 size={15} className="animate-spin" />
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
            <Loader2 size={15} className="animate-spin" />
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
            <Loader2 size={15} className="animate-spin" />
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
  const { MarkdownBlock } = useUiPrimitives();
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialLoad = useRef(true);

  const fetchMessages = useCallback(async (opts: { before?: number; search?: string; append?: boolean } = {}) => {
    const isAppend = opts.append ?? false;
    if (!isAppend) setLoading(true);
    else setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (opts.before) params.set("before", String(opts.before));
      if (opts.search) params.set("search", opts.search);
      const r = await fetch(`${API}/contacts/${contactId}/messages?${params}`, { credentials: "include" });
      const body = await r.json();
      if (body.ok) {
        // API returns newest-first; reverse to chronological
        const newMsgs = (body.messages ?? []).reverse();
        if (isAppend) {
          setMessages((prev) => [...newMsgs, ...prev]);
        } else {
          setMessages(newMsgs);
        }
        setHasMore(body.hasMore ?? false);
        setTotal(body.total ?? 0);
      }
    } catch { /* */ }
    if (!isAppend) setLoading(false);
    else setLoadingMore(false);
  }, [contactId]);

  useEffect(() => {
    initialLoad.current = true;
    void fetchMessages({ search: activeSearch || undefined });
  }, [contactId, activeSearch, fetchMessages]);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!loading && initialLoad.current && messages.length > 0) {
      initialLoad.current = false;
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "instant" });
      });
    }
  }, [loading, messages.length]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    const oldest = messages[0];
    const prevScrollHeight = scrollRef.current?.scrollHeight ?? 0;
    await fetchMessages({ before: oldest.createdAt, search: activeSearch || undefined, append: true });
    // Restore scroll position after prepending
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        const newScrollHeight = scrollRef.current.scrollHeight;
        scrollRef.current.scrollTop += newScrollHeight - prevScrollHeight;
      }
    });
  }, [loadingMore, hasMore, messages, activeSearch, fetchMessages]);

  const doSearch = useCallback(() => {
    setActiveSearch(searchQuery.trim());
  }, [searchQuery]);

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setActiveSearch("");
  }, []);

  // Stats
  const outCount = messages.filter((m) => m.direction === "outbound").length;
  const inCount = messages.filter((m) => m.direction === "inbound").length;
  const failCount = messages.filter((m) => m.status === "failed").length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={18} className="animate-spin text-fg-faint" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Search bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-fainter" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doSearch(); }}
            placeholder={t("history.searchPlaceholder")}
            className="w-full pl-8 pr-8 py-1.5 text-xs rounded-lg border border-border-subtle bg-bg-base text-fg-default placeholder:text-fg-fainter focus:outline-none focus:border-accent"
          />
          {searchQuery && (
            <button onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-fainter hover:text-fg-muted">
              <X size={13} />
            </button>
          )}
        </div>
        {/* Stats */}
        <div className="flex items-center gap-2 text-[10px] text-fg-fainter flex-shrink-0">
          <span>{t("history.totalMessages", { count: String(total) })}</span>
          {failCount > 0 && (
            <span className="text-danger">{t("history.failedCount", { count: String(failCount) })}</span>
          )}
        </div>
      </div>

      {/* Active search tag */}
      {activeSearch && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-accent/5 border-b border-border-subtle">
          <Search size={11} className="text-accent" />
          <span className="text-[11px] text-accent">{t("history.searchingFor", { query: activeSearch })}</span>
          <button onClick={clearSearch} className="text-[10px] text-fg-muted hover:text-fg-default ml-auto">{t("history.clearSearch")}</button>
        </div>
      )}

      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-fg-fainter py-12">
          <MessageSquareShare size={28} className="mb-2 opacity-20" />
          <span className="text-xs">{activeSearch ? t("history.noSearchResults") : t("panel.noMessages")}</span>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto bg-bg-base">
          {/* Load more button */}
          {hasMore && (
            <div ref={topRef} className="flex justify-center py-3">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-full bg-bg-surface border border-border-subtle text-fg-muted hover:text-fg-default hover:bg-bg-hover transition-colors disabled:opacity-50"
              >
                {loadingMore ? <Loader2 size={11} className="animate-spin" /> : <History size={11} />}
                {loadingMore ? t("history.loading") : t("history.loadMore")}
              </button>
            </div>
          )}

          <div className="px-3 py-2">
            {messages.map((m, i) => {
              const prev = i > 0 ? messages[i - 1] : null;
              const dateSep = showDateSep(prev, m);
              const timeSep = dateSep || showTimeSep(prev, m);
              return (
                <div key={m.id}>
                  {/* Date label */}
                  {dateSep && (
                    <div className="flex justify-center py-2">
                      <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-bg-surface border border-border-subtle/50 text-fg-fainter">
                        {fmtDateLabel(m.createdAt, t)}
                      </span>
                    </div>
                  )}
                  {/* Time label */}
                  {timeSep && !dateSep && (
                    <div className="flex justify-center py-1.5">
                      <span className="text-[11px] text-fg-fainter">{fmtTime(m.createdAt)}</span>
                    </div>
                  )}
                  {/* Bubble row */}
                  {m.direction === "inbound" ? (
                    /* ── Inbound: left-aligned ── */
                    <div className="flex justify-start items-start gap-2 mb-2 group">
                      {contactAvatar(contactName, "a2a")}
                      <div className="flex flex-col max-w-[75%]">
                        <div className="relative px-3 py-2 rounded-xl rounded-tl-sm text-sm leading-relaxed whitespace-pre-wrap break-words bg-bg-surface border border-border-subtle/50 text-fg-default">
                          <MarkdownBlock noProse>{m.text}</MarkdownBlock>
                        </div>
                        <span className="text-[10px] text-fg-fainter mt-0.5 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {fmtFullTime(m.createdAt)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    /* ── Outbound: right-aligned ── */
                    <div className="flex justify-end items-start gap-2 mb-2 group">
                      {/* Failure icon */}
                      {m.status === "failed" && (
                        <span title={m.error ?? "Send failed"} className="mt-2 flex-shrink-0">
                          <XCircle size={15} className="text-danger" />
                        </span>
                      )}
                      <div className="flex flex-col items-end max-w-[75%]">
                        <div
                          className={`relative px-3 py-2 rounded-xl rounded-tr-sm text-sm leading-relaxed whitespace-pre-wrap break-words ${
                            m.status === "sent" || m.status === "received"
                              ? "bg-accent/15 border border-accent/20 text-fg-default"
                              : "bg-danger/10 border border-danger/20 text-danger"
                          }`}
                        >
                          {m.text}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5 mr-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {m.status === "failed" && m.error && (
                            <span className="text-[10px] text-danger/60">{m.error}</span>
                          )}
                          <span className="text-[10px] text-fg-fainter">{fmtFullTime(m.createdAt)}</span>
                          {m.status === "sent" && <CheckCircle2 size={10} className="text-success/60" />}
                          {m.status === "failed" && <XCircle size={10} className="text-danger/60" />}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </div>
  );
}

function fmtFullTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Agent Card editor ───────────────────────────────────────────

interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

interface AgentCardData {
  name: string;
  description: string;
  provider?: string;
  providerUrl?: string;
  version?: string;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: AgentCardSkill[];
}

function AgentCardEditor({ onClose }: { onClose: () => void }) {
  const t = usePluginT("messenger");
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
          placeholder={t("card.descPlaceholder")} rows={4}
          className={`${inputCls} resize-none`} />
      </div>

      {/* Provider + Version */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-fg-muted mb-1 block">Provider</label>
          <input value={card.provider || ""} onChange={(e) => setCard({ ...card, provider: e.target.value })} placeholder="e.g. tianshu-ai" className={inputCls} />
        </div>
        <div>
          <label className="text-xs text-fg-muted mb-1 block">Version</label>
          <input value={card.version || ""} onChange={(e) => setCard({ ...card, version: e.target.value })} placeholder="1.0.0" className={inputCls} />
        </div>
      </div>

      {/* Skills */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-fg-muted">Skills</label>
          <button onClick={() => setCard({ ...card, skills: [...(card.skills || []), { id: crypto.randomUUID().slice(0, 8), name: "", description: "" }] })}
            className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent hover:bg-accent/25">+ Add</button>
        </div>
        {(card.skills || []).map((skill, i) => (
          <div key={skill.id} className="flex gap-2 mb-2 items-start">
            <div className="flex-1 space-y-1">
              <input value={skill.name} onChange={(e) => { const s = [...(card.skills || [])]; s[i] = { ...s[i], name: e.target.value }; setCard({ ...card, skills: s }); }}
                placeholder="Skill name" className={`${inputCls} !py-1 !text-xs`} />
              <input value={skill.description} onChange={(e) => { const s = [...(card.skills || [])]; s[i] = { ...s[i], description: e.target.value }; setCard({ ...card, skills: s }); }}
                placeholder="Skill description" className={`${inputCls} !py-1 !text-xs`} />
            </div>
            <button onClick={() => { const s = [...(card.skills || [])]; s.splice(i, 1); setCard({ ...card, skills: s }); }}
              className="mt-1 text-fg-fainter hover:text-danger"><XCircle size={14} /></button>
          </div>
        ))}
      </div>

      {/* Save */}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">Cancel</button>
        <button onClick={doSave} disabled={saving}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-amber-500 text-black font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
          {saving ? <Loader2 size={15} className="animate-spin" /> : saved ? <CheckCircle2 size={12} /> : <Save size={12} />}
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
  const [pasteValue, setPasteValue] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [peerCard, setPeerCard] = useState<{ name?: string; description?: string } | null>(null);
  const [fetchingCard, setFetchingCard] = useState(false);
  const [phase, setPhase] = useState<"paste" | "confirm" | "saving" | "done" | "error">("paste");
  const [error, setError] = useState("");
  const { MarkdownBlock } = useUiPrimitives();

  /** Parse a URL and fetch peer agent card */
  const parseInput = useCallback(async (raw: string) => {
    setPasteValue(raw);
    setPeerCard(null);
    try {
      const u = new URL(raw.trim());
      const key = u.searchParams.get("token");
      u.searchParams.delete("token");
      u.searchParams.delete("uid");
      const ep = u.toString().replace(/\?$/, "");
      setEndpoint(ep);
      setApiKey(key || "");

      // Fetch peer's agent card via server-side proxy (avoids CORS)
      setFetchingCard(true);
      try {
        const r = await fetch(`${API}/agent-card/fetch-peer`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: ep, ...(key ? { token: key } : {}) }),
        });
        if (r.ok) {
          const body = await r.json();
          if (body.ok && body.card?.name) setPeerCard(body.card);
        }
      } catch { /* peer may not have a card */ }
      setFetchingCard(false);
      setPhase("confirm");
    } catch { /* not a URL */ }
  }, []);

  const doPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) void parseInput(text);
    } catch { /* clipboard denied */ }
  }, [parseInput]);

  const doSave = useCallback(async () => {
    if (!endpoint.trim()) return;
    setPhase("saving");
    setError("");
    const contactName = peerCard?.name || new URL(endpoint).hostname || "A2A Agent";
    try {
      const r = await fetch(`${API}/contacts`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: contactName,
          type: "a2a",
          config: { endpoint: endpoint.trim(), apiKey: apiKey.trim(), ...(peerCard ? { peerCard } : {}) },
        }),
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
  }, [endpoint, apiKey, peerCard, onDone]);

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

  if (phase === "confirm") return (
    <div className="flex flex-col gap-3 p-2">
      {/* Peer card info */}
      {fetchingCard ? (
        <div className="flex items-center gap-2 p-3"><Loader2 size={14} className="animate-spin text-fg-muted" /><span className="text-xs text-fg-faint">正在获取对方名片...</span></div>
      ) : peerCard ? (
        <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <IdCard size={14} className="text-accent" />
            <span className="text-sm font-medium text-fg-default">{peerCard.name}</span>
          </div>
          {peerCard.description && (
            <div className="text-xs text-fg-faint leading-relaxed max-h-32 overflow-y-auto [&_p]:my-1">
              <MarkdownBlock noProse>{peerCard.description}</MarkdownBlock>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
          <div className="flex items-center gap-1.5">
            <IdCard size={14} className="text-fg-fainter" />
            <span className="text-sm text-fg-faint">{new URL(endpoint).hostname}</span>
          </div>
          <p className="text-[11px] text-fg-fainter mt-1">{t("card.peerEmpty")}</p>
        </div>
      )}
      <div className="text-[10px] text-fg-fainter font-mono break-all px-1">{endpoint}</div>
      <div className="flex justify-end gap-2">
        <button onClick={() => { setPhase("paste"); setPeerCard(null); }} className="text-xs px-3 py-1.5 rounded-md ring-1 ring-inset ring-border-default text-fg-muted hover:bg-bg-hover">{t("a2a.cancel")}</button>
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
          value={pasteValue} onChange={(e) => void parseInput(e.target.value)}
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

// ── Pair Agent (Bluetooth discovery) ────────────────────────────

interface DiscoveredAgent {
  orgId: string;
  agentId: string;
  userId?: string;
  name: string;
  description?: string;
  url: string;
  online: boolean;
  card?: { name?: string; description?: string; provider?: string; providerId?: string; skills?: { id: string; name: string; description?: string }[] };
}

function PairAgentFlow({ myOrgId, myAgentId, myUserId, contacts, pairRequests, onDone, onCancel }: { myOrgId?: string; myAgentId?: string; myUserId?: string; contacts: Contact[]; pairRequests: any[]; onDone: () => void; onCancel: () => void }) {
  const t = usePluginT("messenger");
  const [agents, setAgents] = useState<DiscoveredAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/relay/discover`, { credentials: "include" });
        const body = await r.json();
        if (body.ok) setAgents(body.agents ?? []);
        else setError("Failed to fetch");
      } catch { setError("Cannot reach relay"); }
      setLoading(false);
    })();
  }, []);

  const doPair = async (agent: DiscoveredAgent) => {
    setPairing(agent.url);
    setError(null);
    try {
      const r = await fetch(`${API}/relay/pair`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId: agent.orgId,
          agentId: agent.agentId,
          userId: agent.userId || "",
          peerName: agent.card?.name || agent.name || agent.agentId,
        }),
      });
      const body = await r.json();
      if (body.ok) {
        onDone();
      } else {
        const errMsg = body.error === "agent_offline" ? "对方 Agent 当前离线，无法配对" : (body.error || "Pairing failed");
        setError(errMsg);
      }
    } catch (err) { setError(String(err)); }
    setPairing(null);
  };

  // Filter out self and already-paired agents
  const pairedEndpoints = new Set(contacts.filter(c => c.type === "a2a").map(c => c.config?.endpoint as string).filter(Boolean));
  const pendingKeys = new Set(pairRequests.filter(r => r.direction === 'outbound' && r.status === 'pending').map(r => `${r.peer_org_id}/${r.peer_agent_id}`));
  const isSelf = (a: DiscoveredAgent) => a.orgId === myOrgId && a.agentId === myAgentId && (a.userId || "") === (myUserId || "");
  const discoverable = agents.filter(a => !isSelf(a) && !pairedEndpoints.has(a.url));
  const q = search.trim().toLowerCase();
  const filtered = q ? discoverable.filter(a => {
    const name = (a.card?.name || a.name || "").toLowerCase();
    const org = (a.card?.provider || a.orgId || "").toLowerCase();
    const desc = (a.card?.description || a.description || "").toLowerCase();
    return name.includes(q) || org.includes(q) || desc.includes(q) || a.agentId.toLowerCase().includes(q);
  }) : discoverable;

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Search */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-fainter" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t("pair.searchPlaceholder")}
          className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-border-subtle bg-bg-base text-fg-default placeholder:text-fg-fainter focus:outline-none focus:border-accent"
          autoFocus
        />
      </div>
      {error && <div className="text-sm text-red-400 px-1">{error}</div>}
      {loading ? (
        <div className="text-center text-fg-muted py-6"><Loader2 size={20} className="animate-spin inline" /> 扫描中...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-6">
          <div className="text-fg-fainter mb-2"><BluetoothSearching size={32} className="inline opacity-30" /></div>
          <div className="text-sm text-fg-muted">{q ? t("pair.noMatch") : t("pair.noAgents")}</div>
          {!q && <div className="text-xs text-fg-fainter mt-1">{t("pair.ensureDiscoverable")}</div>}
        </div>
      ) : (
        <div className="space-y-1 max-h-[320px] overflow-y-auto">
          {filtered.map(a => {
            const displayName = a.card?.name || a.name || a.agentId;
            const org = a.card?.provider || "";
            const orgId = a.card?.providerId || a.orgId.slice(0, 8);
            const orgDisplay = org ? `${org} (${orgId})` : `@${orgId}`;
            const desc = a.card?.description || a.description || "";
            const isPending = pendingKeys.has(`${a.orgId}/${a.agentId}`);
            const initial = displayName.charAt(0).toUpperCase();
            return (
              <div
                key={a.url}
                className={`flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-bg-hover transition-colors ${
                  isPending ? "opacity-50" : "cursor-pointer"
                }`}
                onClick={() => !isPending && pairing === null && doPair(a)}
              >
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-blue-500/15 text-blue-500 flex-shrink-0">
                  <span className="text-sm font-semibold">{initial}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-fg-default truncate">{displayName}</span>
                    <span className="text-[11px] text-fg-fainter truncate flex-shrink-0">@{orgDisplay}</span>
                  </div>
                  {desc && <div className="text-xs text-fg-muted truncate mt-0.5">{desc}</div>}
                </div>
                {pairing === a.url ? <Loader2 size={14} className="animate-spin text-fg-muted" /> : isPending ? <span className="text-xs text-yellow-500 flex-shrink-0">{t("pair.sent")}</span> : null}
              </div>
            );
          })}
        </div>
      )}
      <button onClick={onCancel} className="w-full text-sm text-fg-muted hover:text-fg-default py-1">取消</button>
    </div>
  );
}

const exports: PluginClientExports = {
  components: { MessengerPanel },
};

export default exports;
