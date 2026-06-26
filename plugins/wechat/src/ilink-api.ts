// Tencent iLink bot API client.
//
// Endpoints we hit (all POST, all under <baseUrl>/ilink/bot/...):
//   - get_bot_qrcode    : start a QR-login session
//   - get_qrcode_status : long-poll for scan completion + token
//   - getupdates        : long-poll for inbound messages (sync_buf cursor)
//   - sendmessage       : send a single message item to a user
//
// Tencent's reference implementation lives in
// `@tencent-weixin/openclaw-weixin` (MIT). The shapes below mirror
// the wire formats we observed there + verified directly against
// `https://ilinkai.weixin.qq.com`. The plugin uses a tiny subset
// of the surface (no media upload, no typing, no read-receipts);
// those can be added as the feature matures.
//
// Auth model:
//   - QR endpoints take no auth (anyone can request a fresh QR).
//   - After the user scans + confirms, get_qrcode_status returns
//     a Bearer token specific to the bot+account pair. Every
//     other API call carries `Authorization: Bearer <token>`.
//   - Tokens occasionally go stale (errcode `STALE_TOKEN_ERRCODE`);
//     the caller (monitor) should pause + back off when that
//     happens.
//   - getupdates is long-polled with a server-issued `sync_buf`
//     cursor. We pass back whatever the server returned last so
//     it can resume from the right offset, including across
//     process restarts (the monitor persists `sync_buf` to disk).

// HTTP request error classification — useful for the monitor's
// backoff strategy (retry on transient network blips, surface
// hard errors immediately).
export type ApiError =
  | { type: "timeout" }
  | { type: "network"; description: string }
  | { type: "non200"; status: number; body: string }
  | { type: "abort" };

export const STALE_TOKEN_ERRCODE = 50000201;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

/** Build the `base_info` block every authenticated request carries.
 *  Identifies the calling bot to Tencent's analytics. */
function buildBaseInfo(opts: { botAgent: string; channelVersion: string }) {
  return {
    bot_agent: opts.botAgent,
    // Pack semver as 0x00MMNNPP — matches Tencent's reference impl.
    bot_agent_version: packVersion(opts.channelVersion),
  };
}

function packVersion(semver: string): number {
  const parts = semver.split(".").map((p) => parseInt(p, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

interface RawPostOpts {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

/** POST a JSON body to an iLink endpoint. Throws a typed ApiError
 *  on transport-level failures; the caller checks `resp.ret` /
 *  `resp.errcode` for API-level failures from the response body. */
async function apiPost(opts: RawPostOpts): Promise<string> {
  const url = `${trimTrailingSlash(opts.baseUrl)}/${opts.endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }

  // Compose the request abort signal: caller-provided + per-call
  // timeout. The timeout always wins eventually; the caller signal
  // wins immediately on shutdown.
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) controller.abort();
    else opts.abortSignal.addEventListener("abort", onCallerAbort);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: opts.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw classifyAndThrow({ type: "non200", status: res.status, body });
    }
    return await res.text();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      if (opts.abortSignal?.aborted) {
        throw classifyAndThrow({ type: "abort" });
      }
      throw classifyAndThrow({ type: "timeout" });
    }
    if (isClassifiedApiError(err)) throw err;
    throw classifyAndThrow({
      type: "network",
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timeoutHandle);
    if (opts.abortSignal) opts.abortSignal.removeEventListener("abort", onCallerAbort);
  }
}

function classifyAndThrow(err: ApiError): never {
  const e = new Error(`iLink ${err.type}`) as Error & { kind: ApiError };
  e.kind = err;
  throw e;
}

function isClassifiedApiError(e: unknown): boolean {
  return typeof e === "object" && e != null && "kind" in (e as Record<string, unknown>);
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// ─── QR login ──────────────────────────────────────────────────

export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** Step 1 of QR login. Returns a unique qr id (`qrcode`) and an
 *  image URL the user displays + scans. */
export async function getBotQrCode(opts: {
  baseUrl: string;
  botType?: string;
  localTokenList?: string[];
}): Promise<QrCodeResponse> {
  const botType = opts.botType ?? "3";
  const body = JSON.stringify({ local_token_list: opts.localTokenList ?? [] });
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body,
  });
  return JSON.parse(raw) as QrCodeResponse;
}

export interface QrCodeStatusResponse {
  /** 0 = pending, 1 = scanned, 2 = confirmed (token issued),
   *  -1 = expired. Subject to Tencent's API evolution. */
  status?: number;
  token?: string;
  username?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** Step 2 of QR login: long-poll the scan status. Resolves once
 *  the user confirms (status=2 with token) or the QR expires. */
export async function getQrCodeStatus(opts: {
  baseUrl: string;
  qrcode: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<QrCodeStatusResponse> {
  const body = JSON.stringify({ qrcode: opts.qrcode });
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/get_qrcode_status",
    body,
    timeoutMs: opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
    abortSignal: opts.abortSignal,
  });
  return JSON.parse(raw) as QrCodeStatusResponse;
}

// ─── Long-poll inbound ─────────────────────────────────────────

export interface IncomingMessage {
  /** Per-message context token: must be echoed in every outbound
   *  reply targeting the same user. */
  context_token?: string;
  /** Sender's iLink user id (opaque). */
  ilink_user_id?: string;
  /** Username (display name) if Tencent surfaces one. */
  username?: string;
  /** Message content payload. Tencent's `MsgItem` shape: text /
   *  image / video / file etc. We extract `.text` opportunistically;
   *  unsupported types route through with empty body and the agent
   *  decides. */
  msg_items?: Array<{
    msg_item_type?: number;
    text?: string;
    image_url?: string;
    image_md5?: string;
  }>;
  /** Native message id, used for replies + dedup. */
  msg_id?: string;
  /** Timestamp from the server (seconds since epoch in Tencent's API). */
  msg_create_time?: number;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IncomingMessage[];
  /** Opaque cursor for the next long-poll request. */
  get_updates_buf?: string;
  /** Optional dynamic poll timeout the server wants us to use. */
  longpolling_timeout_ms?: number;
}

export async function getUpdates(opts: {
  baseUrl: string;
  token: string;
  get_updates_buf: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  botAgent: string;
  channelVersion: string;
}): Promise<GetUpdatesResponse> {
  const body = JSON.stringify({
    get_updates_buf: opts.get_updates_buf,
    base_info: buildBaseInfo(opts),
  });
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/getupdates",
    body,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
    abortSignal: opts.abortSignal,
  });
  return JSON.parse(raw) as GetUpdatesResponse;
}

// ─── Outbound send ─────────────────────────────────────────────

export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** Send a plain-text message to a previously-seen user. Requires
 *  the `context_token` from a recent inbound message; we look up
 *  the most recent token per `ilink_user_id` in the channel
 *  adapter. */
export async function sendTextMessage(opts: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  contextToken: string;
  text: string;
  botAgent: string;
  channelVersion: string;
  timeoutMs?: number;
}): Promise<SendMessageResponse> {
  const body = JSON.stringify({
    ilink_user_id: opts.ilinkUserId,
    context_token: opts.contextToken,
    msg_items: [
      {
        msg_item_type: 1, // text
        text: opts.text,
      },
    ],
    base_info: buildBaseInfo(opts),
  });
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
  });
  const resp = JSON.parse(raw) as SendMessageResponse;
  if (resp.ret && resp.ret !== 0) {
    throw new Error(
      `sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`,
    );
  }
  return resp;
}
