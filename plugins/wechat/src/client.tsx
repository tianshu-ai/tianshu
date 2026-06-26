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
  useRef,
  useState,
} from "react";
import {
  CheckCircle2,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type {
  AdminPageProps,
  PluginClientExports,
} from "@tianshu-ai/plugin-sdk/client";
import { useUiPrimitives } from "@tianshu-ai/plugin-sdk/client";

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
  const config: Record<BindingView["status"], { label: string; tone: string }> = {
    running: { label: "Connected", tone: "bg-success/10 text-success border-success/30" },
    starting: { label: "Starting", tone: "bg-warning/10 text-warning border-warning/30" },
    idle: { label: "Idle", tone: "bg-bg-hover text-fg-muted border-border-default" },
    stopped: { label: "Stopped", tone: "bg-bg-hover text-fg-muted border-border-default" },
    error: { label: "Error", tone: "bg-danger/10 text-danger border-danger/30" },
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
  const [phase, setPhase] = useState<"loading" | "qr" | "scanned" | "error">("loading");
  const [qr, setQr] = useState<LoginStartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState<BindingView | null>(null);
  const pollRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Step 1: fetch QR
  useEffect(() => {
    setPhase("loading");
    void (async () => {
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
    })();
    return () => {
      pollRef.current.cancelled = true;
    };
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
            body: JSON.stringify({ qrcode: qr.qrcode }),
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
    const t = setTimeout(onClose, 1500);
    return () => clearTimeout(t);
  }, [phase, onBound, onClose]);

  return (
    <Modal isOpen onClose={onClose} title="Add WeChat account" size="sm">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
        {phase === "loading" && (
          <>
            <Loader2 className="h-6 w-6 animate-spin text-fg-faint" />
            <div className="text-sm text-fg-muted">Requesting QR code…</div>
          </>
        )}
        {phase === "qr" && qr && (
          <>
            <div className="text-sm text-fg-muted">Scan with WeChat to authorise</div>
            <img
              src={qr.qrCodeImageUrl}
              alt="WeChat login QR"
              className="h-56 w-56 rounded-md border border-border-default bg-white p-2"
            />
            <div className="text-[11px] text-fg-faint">Open WeChat → Scan → Confirm</div>
            <div className="flex items-center gap-2 text-[11px] text-fg-fainter">
              <Loader2 className="h-3 w-3 animate-spin" />
              waiting for scan…
            </div>
          </>
        )}
        {phase === "scanned" && bound && (
          <>
            <CheckCircle2 className="h-10 w-10 text-success" />
            <div className="text-sm font-medium text-fg-default">Connected</div>
            <div className="text-xs text-fg-muted">
              {bound.displayName ?? bound.config.username ?? "WeChat account"}
            </div>
          </>
        )}
        {phase === "error" && (
          <>
            <X className="h-10 w-10 text-danger" />
            <div className="text-sm text-fg-default">Login failed</div>
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

// ─── admin page ─────────────────────────────────────────────────

function WeChatAdminPage(_props: AdminPageProps) {
  const [bindings, setBindings] = useState<BindingView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
      if (!confirm("Disconnect this WeChat account from tianshu?")) return;
      try {
        const r = await api(`/bindings/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `HTTP ${r.status}`);
          return;
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-6 text-fg-default">
      <header className="mb-6 flex items-center justify-between border-b border-border-subtle pb-4">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-6 w-6 text-success" />
          <div>
            <h1 className="text-lg font-semibold">WeChat</h1>
            <p className="text-sm text-fg-muted">
              Connect WeChat accounts so direct messages route to your agent.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg-default"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-fg-on-accent hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" />
            Add account
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {bindings === null ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : bindings.length === 0 ? (
        <div className="rounded-md border border-dashed border-border-default px-6 py-10 text-center">
          <MessageSquare className="mx-auto mb-3 h-8 w-8 text-fg-fainter" />
          <div className="text-sm font-medium text-fg-default">No accounts connected</div>
          <div className="mt-1 text-xs text-fg-muted">
            Click <span className="font-medium">Add account</span> to scan a QR code and start
            routing WeChat messages here.
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {bindings.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between rounded-md border border-border-subtle bg-bg-elevated px-4 py-3"
            >
              <div>
                <div className="text-sm font-medium text-fg-default">
                  {b.displayName ?? b.config.username ?? "WeChat account"}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-faint">
                  <span className="font-mono">{b.id}</span>
                  <StatusPill status={b.status} detail={b.statusDetail} />
                  <span>· bound {new Date(b.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(b.id)}
                className="rounded p-1.5 text-fg-muted hover:bg-danger/10 hover:text-danger"
                title="Disconnect"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
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

const clientExports: PluginClientExports = {
  components: {
    WeChatAdminPage: WeChatAdminPage as PluginClientExports["components"][string],
  },
};

export const components = clientExports.components;
export default clientExports;
