// WeChat plugin — client side.
//
// Single surface: a `WeChatAdminPage` rendered in the chat shell's
// /admin area. It lists existing wechat bindings + lets the user
// add a new one through a QR-scan modal:
//
//   1. Click "+ Add account" → POST /api/p/wechat/login/start
//   2. Page shows the returned QR (image URL from iLink)
//   3. Page polls /api/p/wechat/login/poll until scanned=true
//   4. On confirm, the server creates a channel_bindings row
//      AND starts the WeChatChannel adapter — the new account
//      appears in the list ready to receive messages.
//
// Tencent-side: the user scans + confirms in their own WeChat app.
// Until they confirm, /login/poll returns `scanned: false` and we
// keep polling. After confirm, the binding's adapter takes over.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import QRCode from "qrcode";
import {
  CheckCircle2,
  Loader2,
  MessageSquare,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type {
  PanelProps,
  PluginClientExports,
  SidebarSectionProps,
} from "@tianshu-ai/plugin-sdk/client";
import {
  subscribeToWsEvent,
  useChatNav,
  useUiPrimitives,
  usePluginT,
} from "@tianshu-ai/plugin-sdk/client";

// ─── wire shapes ────────────────────────────────────────────────

interface BindingView {
  id: string;
  channelId: string;
  displayName: string | null;
  enabled: boolean;
  status: "idle" | "starting" | "running" | "error" | "stopped";
  statusDetail: string | null;
  config: { token?: string; ilinkUserId?: string; username?: string } & Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface LoginStartResponse {
  ok: boolean;
  qrcode: string;
  qrCodeImageUrl: string;
  error?: string;
}

interface LoginPollResponse {
  ok: boolean;
  scanned: boolean;
  binding?: BindingView;
  error?: string;
}

const ROUTE_BASE = "/api/p/wechat";

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ROUTE_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}

// ─── status pill ────────────────────────────────────────────────

function StatusPill({ status, detail }: { status: BindingView["status"]; detail: string | null }) {
  const t = usePluginT("wechat");
  const config: Record<BindingView["status"], { label: string; tone: string }> = {
    running: { label: t("status.running"), tone: "bg-success/10 text-success border-success/30" },
    starting: { label: t("status.starting"), tone: "bg-warning/10 text-warning border-warning/30" },
    idle: { label: t("status.idle"), tone: "bg-bg-hover text-fg-muted border-border-default" },
    stopped: { label: t("status.stopped"), tone: "bg-bg-hover text-fg-muted border-border-default" },
    error: { label: t("status.error"), tone: "bg-danger/10 text-danger border-danger/30" },
  };
  const cfg = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${cfg.tone}`}
      title={detail ?? undefined}
    >
      {status === "starting" && <Loader2 className="h-3 w-3 animate-spin" />}
      {cfg.label}
    </span>
  );
}

// ─── add-account modal ──────────────────────────────────────────

interface AddModalProps {
  onClose: () => void;
  onBound: () => void;
}

function AddAccountFlow({ onClose, onBound }: AddModalProps) {
  const { Modal } = useUiPrimitives();
  const t = usePluginT("wechat");
  const [phase, setPhase] = useState<
    "model" | "loading" | "qr" | "scanned" | "error"
  >("model");
  const [qr, setQr] = useState<LoginStartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState<BindingView | null>(null);
  const [models, setModels] = useState<
    { id: string; displayName: string }[]
  >([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const pollRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Step 0: load model catalog so the user can pick which LLM this
  // wechat binding routes inbound DMs to. Default = tenant default.
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/models", { credentials: "include" });
        const body = (await r.json()) as {
          models?: { id: string; displayName?: string; label?: string }[];
          defaultModel?: string | null;
        };
        const list = (body.models ?? []).map((m) => ({
          id: m.id,
          displayName: m.displayName ?? m.label ?? m.id,
        }));
        setModels(list);
        setDefaultModel(body.defaultModel ?? null);
        // Pre-select the default; user can override before scanning.
        setSelectedModel(body.defaultModel ?? list[0]?.id ?? "");
      } catch {
        // best-effort; admin can still scan, the binding will fall
        // back to the tenant default when no modelId is stored.
      }
    })();
    return () => {
      pollRef.current.cancelled = true;
    };
  }, []);

  // Step 1: fetch QR (triggered only after the user clicks Continue
  // on the model picker).
  const startQr = useCallback(async () => {
    setPhase("loading");
    try {
      const r = await api("/login/start", { method: "POST", body: "{}" });
      const body = (await r.json()) as LoginStartResponse;
      if (!r.ok || !body.ok) {
        setError(body.error ?? `HTTP ${r.status}`);
        setPhase("error");
        return;
      }
      setQr(body);
      setPhase("qr");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, []);

  // Step 2: poll for scan completion
  useEffect(() => {
    if (phase !== "qr" || !qr) return;
    pollRef.current = { cancelled: false };
    const ref = pollRef.current;
    void (async () => {
      while (!ref.cancelled) {
        try {
          const r = await api("/login/poll", {
            method: "POST",
            body: JSON.stringify({
              qrcode: qr.qrcode,
              modelId: selectedModel || undefined,
            }),
          });
          const body = (await r.json()) as LoginPollResponse;
          if (ref.cancelled) return;
          if (!r.ok || !body.ok) {
            setError(body.error ?? `HTTP ${r.status}`);
            setPhase("error");
            return;
          }
          if (body.scanned && body.binding) {
            setBound(body.binding);
            setPhase("scanned");
            return;
          }
          // Still pending; small backoff between polls so we don't
          // hammer Tencent if their long-poll endpoint returns
          // early. The server's own long-poll timeout is ~35s.
          await sleep(1000);
        } catch (err) {
          if (ref.cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setPhase("error");
          return;
        }
      }
    })();
    return () => {
      ref.cancelled = true;
    };
  }, [phase, qr]);

  // Step 3: once bound, give the parent a chance to refresh + close.
  useEffect(() => {
    if (phase !== "scanned") return;
    onBound();
    const timer = setTimeout(onClose, 1500);
    return () => clearTimeout(timer);
  }, [phase, onBound, onClose]);

  return (
    <Modal isOpen onClose={onClose} title={t("add.title")} size="sm">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
        {phase === "model" && (
          <>
            <div className="text-sm text-fg-muted">
              {t("add.chooseModel")}
            </div>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full max-w-sm rounded-md border border-border-default bg-bg-elevated px-3 py-2 text-sm text-fg-default"
            >
              {models.length === 0 && (
                <option value="">{t("add.noModels")}</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                  {defaultModel === m.id ? t("add.default") : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void startQr()}
              disabled={models.length === 0 || !selectedModel}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-fg-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              {t("add.continue")}
            </button>
            <div className="text-[11px] text-fg-fainter">
              {t("add.changeLater")}
            </div>
          </>
        )}
        {phase === "loading" && (
          <>
            <Loader2 className="h-6 w-6 animate-spin text-fg-faint" />
            <div className="text-sm text-fg-muted">{t("add.requestingQr")}</div>
          </>
        )}
        {phase === "qr" && qr && (
          <>
            <div className="text-sm text-fg-muted">{t("add.scanToAuthorise")}</div>
            <QrCanvas value={qr.qrCodeImageUrl} />
            <div className="text-[11px] text-fg-faint">{t("add.scanSteps")}</div>
            <div className="flex items-center gap-2 text-[11px] text-fg-fainter">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("add.waitingForScan")}
            </div>
          </>
        )}
        {phase === "scanned" && bound && (
          <>
            <CheckCircle2 className="h-10 w-10 text-success" />
            <div className="text-sm font-medium text-fg-default">{t("add.connected")}</div>
            <div className="text-xs text-fg-muted">
              {bound.displayName ?? bound.config.username ?? t("add.defaultAccountName")}
            </div>
          </>
        )}
        {phase === "error" && (
          <>
            <X className="h-10 w-10 text-danger" />
            <div className="text-sm text-fg-default">{t("add.loginFailed")}</div>
            <div className="max-w-xs break-words text-xs text-fg-muted">{error}</div>
          </>
        )}
      </div>
    </Modal>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Tencent's iLink `qrcode_img_content` is the URL the WeChat app
// should fetch (e.g. `https://liteapp.weixin.qq.com/q/<id>?qrcode=...`).
// It's NOT a pre-rendered image — dropping it into `<img src=>`
// shows a broken-image icon. We render the URL ourselves through
// the `qrcode` lib so the user gets an actual scannable QR.
function QrCanvas({ value }: { value: string }) {
  const t = usePluginT("wechat");
  const id = useId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setErr(null);
    QRCode.toCanvas(canvas, value, {
      width: 224,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).catch((e: unknown) => {
      if (cancelled) return;
      setErr(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [value]);
  if (err) {
    return (
      <div className="flex h-56 w-56 items-center justify-center rounded-md border border-danger/30 bg-danger/10 p-3 text-center text-xs text-danger">
        {t("qr.renderFailed", { error: err })}
      </div>
    );
  }
  return (
    <canvas
      ref={canvasRef}
      aria-label={t("qr.ariaLabel")}
      id={`wechat-qr-${id}`}
      className="h-56 w-56 rounded-md border border-border-default bg-white p-2"
    />
  );
}

// ─── admin page ─────────────────────────────────────────────────

function WeChatPanel(_props: PanelProps) {
  const t = usePluginT("wechat");
  const [bindings, setBindings] = useState<BindingView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Used after a delete to pop the chat area back to webchat in case
  // the user was viewing one of this binding's sessions.
  const { setViewingSession } = useChatNav();

  const refresh = useCallback(async () => {
    try {
      const r = await api("/bindings");
      const body = (await r.json()) as { ok: boolean; bindings?: BindingView[]; error?: string };
      if (!r.ok || !body.ok) {
        setError(body.error ?? `HTTP ${r.status}`);
        return;
      }
      setError(null);
      setBindings(body.bindings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm(t("page.deleteConfirm"))) return;
      try {
        const r = await api(`/bindings/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `HTTP ${r.status}`);
          return;
        }
        // If the user was looking at a session belonging to this
        // binding, the cascade just yanked it out from under
        // them. Pop them back to the webchat thread so they
        // don't end up staring at an empty pane.
        setViewingSession(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh, setViewingSession],
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-6 text-fg-default">
      <header className="mb-6 flex items-center justify-between border-b border-border-subtle pb-4">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-6 w-6 text-success" />
          <div>
            <h1 className="text-lg font-semibold">{t("page.title")}</h1>
            <p className="text-sm text-fg-muted">
              {t("page.subtitle")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg-default"
          title={t("page.refresh")}
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {bindings === null ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("page.loading")}
        </div>
      ) : bindings.length === 0 ? (
        // Not yet connected. Single CTA — a wechat user can only
        // bind one account (host enforces unique (tenant, user,
        // channel)) so there's no plural "Add" affordance.
        <div className="rounded-md border border-dashed border-border-default px-6 py-10 text-center">
          <MessageSquare className="mx-auto mb-3 h-8 w-8 text-fg-fainter" />
          <div className="text-sm font-medium text-fg-default">{t("page.empty.title")}</div>
          <div className="mt-1 text-xs text-fg-muted">
            {t("page.empty.desc")}
          </div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-fg-on-accent hover:bg-accent-hover"
          >
            {t("page.empty.connect")}
          </button>
        </div>
      ) : (
        // Already bound. Show the one account + an inline "replace"
        // affordance — re-scanning supersedes the binding via the
        // host's cascade-replace policy.
        <>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] text-fg-faint">
            {t("page.bound.hint")}
          </span>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-default px-2.5 py-1 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg-default"
          >
            <RefreshCw className="h-3 w-3" />
            {t("page.bound.rescan")}
          </button>
        </div>
        <ul className="space-y-2">
          {bindings.map((b) => (
            <li
              key={b.id}
              className="rounded-md border border-border-subtle bg-bg-elevated px-3 py-2.5"
            >
              {/* Header: account name + delete, aligned. */}
              <div className="flex items-start justify-between gap-2">
                <div
                  className="min-w-0 flex-1 truncate text-sm font-medium text-fg-default"
                  title={b.displayName ?? b.config.username ?? undefined}
                >
                  {b.displayName ?? b.config.username ?? t("page.bound.defaultAccountName")}
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(b.id)}
                  className="-mr-1 -mt-0.5 shrink-0 rounded p-1.5 text-fg-muted hover:bg-danger/10 hover:text-danger"
                  title={t("page.bound.disconnect")}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {/* Binding id on its own line (it's long + monospace). */}
              <div className="mt-0.5 truncate font-mono text-[10px] text-fg-faint" title={b.id}>
                {b.id}
              </div>
              {/* Meta chips: status / model / date, wrapping cleanly. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-faint">
                <StatusPill status={b.status} detail={b.statusDetail} />
                {typeof b.config.modelId === "string" && b.config.modelId && (
                  <span
                    className="rounded bg-bg-hover px-1.5 py-px font-mono text-[10px] text-fg-muted"
                    title={t("page.bound.modelTitle")}
                  >
                    {String(b.config.modelId)}
                  </span>
                )}
                <span className="text-fg-fainter">
                  {t("page.bound.boundOn", { date: new Date(b.createdAt).toLocaleDateString() })}
                </span>
              </div>
            </li>
          ))}
        </ul>
        </>
      )}

      {adding && (
        <AddAccountFlow
          onClose={() => setAdding(false)}
          onBound={() => void refresh()}
        />
      )}
    </div>
  );
}

// ─── Sidebar section ──────────────────────────────────────
//
// Lists active wechat chat sessions under the Channels section of
// the host sidebar. The plugin pulls its own session list from
// `/api/p/wechat/sessions` (server-side endpoint added alongside
// this component) so the host doesn't have to know what "a wechat
// session" looks like beyond the generic channel_id row in the
// sessions table.
//
// Clicking a row hands the chat area off to that session through
// the plugin-sdk's chat-nav hook; the agent's per-session history
// drives the main pane and the composer drops to read-only.

interface WeChatSession {
  id: string;
  channelChatId: string;
  title: string | null;
  bindingId: string | null;
  createdAt: number;
}

function WeChatSidebarSection(_props: SidebarSectionProps) {
  const t = usePluginT("wechat");
  const [sessions, setSessions] = useState<WeChatSession[] | null>(null);
  const { viewingSessionId, setViewingSession } = useChatNav();

  const refresh = useCallback(async () => {
    try {
      const r = await api("/sessions");
      const body = (await r.json()) as { ok: boolean; sessions?: WeChatSession[] };
      if (body.ok) setSessions(body.sessions ?? []);
    } catch {
      // best-effort; keep showing whatever we had
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Live push for new sessions / messages — the router broadcasts
    // `channel_session_changed` on every inbound + cascade delete
    // so the sidebar stays in sync without a polling delay.
    const offWs = subscribeToWsEvent<{
      type: "channel_session_changed";
      channelId: string;
    }>("channel_session_changed", (ev) => {
      if (ev.channelId === "wechat") void refresh();
    });
    // Polling fallback as a backup in case a socket hiccup
    // dropped a push.
    const t = setInterval(() => void refresh(), 30_000);
    return () => {
      offWs();
      clearInterval(t);
    };
  }, [refresh]);

  if (sessions === null) {
    // Quiet during first load; the section appears once data lands.
    return null;
  }
  if (sessions.length === 0) {
    // No bound accounts yet — hint where to start. We deliberately
    // skip the heading here to keep the sidebar quiet for users
    // who haven't enabled wechat.
    return null;
  }

  // Decode `<channel>:dm|group:<peer>` into something nicer; same
  // format the server stamps via ensureChannelSession.
  function formatLabel(title: string | null): string {
    if (!title) return t("sidebar.untitled");
    const m = title.match(/^([^:]+):(dm|group):(.+)$/);
    if (!m) return title;
    const peer = m[3].length > 18 ? `${m[3].slice(0, 16)}…` : m[3];
    return `${m[2] === "dm" ? t("sidebar.dm") : t("sidebar.group")} · ${peer}`;
  }

  return (
    <>
      {sessions.map((s) => {
        const active = s.id === viewingSessionId;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => setViewingSession(s.id)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors ${
              active
                ? "bg-bg-hover text-fg-default border border-border-default"
                : "text-fg-muted hover:bg-bg-hover hover:text-fg-default border border-transparent"
            }`}
            title={s.title ?? s.channelChatId}
          >
            <span className="flex-shrink-0 rounded bg-success/15 px-1 py-px text-[9px] uppercase tracking-wider text-success">
              {t("sidebar.wechat")}
            </span>
            <span className="flex-1 truncate text-xs">{formatLabel(s.title)}</span>
            {active && (
              <span className="text-[9px] uppercase tracking-wider text-fg-faint">
                {t("sidebar.active")}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

const clientExports: PluginClientExports = {
  components: {
    WeChatPanel: WeChatPanel as PluginClientExports["components"][string],
    WeChatSidebarSection:
      WeChatSidebarSection as PluginClientExports["components"][string],
  },
};

export const components = clientExports.components;
export default clientExports;
