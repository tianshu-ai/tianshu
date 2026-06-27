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

/** Errcode values iLink uses for "token went stale, stop polling".
 *  Includes the documented "stale token" code AND -14 "session
 *  timeout" which fires when a previously-valid token is
 *  invalidated server-side (e.g. user revoked the bot, account
 *  rotation, parallel login from another instance). Both end in
 *  the same admin remediation: re-run QR login. */
export const STALE_TOKEN_ERRCODES = new Set<number>([50000201, -14]);
/** Legacy single-code export. Prefer the set above; this stays
 *  to avoid breaking any caller already importing it. */
export const STALE_TOKEN_ERRCODE = 50000201;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

/** Production iLink API host. Hard-coded because it's a platform
 *  constant of the integration, not a tunable. If Tencent ever
 *  moves the host, that's a plugin update, not a user config
 *  change. */
export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";

/** Tag we send in `base_info.bot_agent` so Tencent's analytics
 *  knows our traffic came from tianshu. Equivalent to an HTTP
 *  User-Agent. */
export const TIANSHU_BOT_AGENT = "tianshu";

/**
 * `iLink-App-Id` header. Tencent's published wechat plugin pulls
 * this from its own package.json ("ilink_appid": "bot"), so we
 * pin the same string verbatim. Tencent's gateway uses it as a
 * routing tag.
 */
const ILINK_APP_ID = "bot";

/**
 * `iLink-App-ClientVersion` header. Tencent's plugin encodes its
 * package version as 0x00MMmmpp (major/minor/patch packed). We
 * publish 0.3.x = 0x000300xx; pin a stable value matching the
 * tianshu app version at first ship so Tencent doesn't see a
 * bare zero. The exact integer doesn't gate auth; Tencent reads
 * this for analytics + soft-version routing only.
 */
const ILINK_APP_CLIENT_VERSION = packVersion("0.3.36");

function packVersion(semver: string): number {
  const parts = semver.split(".").map((p) => parseInt(p, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/**
 * Build the common headers Tencent's gateway expects on every
 * iLink call. This is the auth shape that OpenClaw's reference
 * plugin uses; the API silently drops requests that use the
 * wrong scheme (e.g. plain `Authorization: Bearer <token>`),
 * which is why my initial implementation never got any inbound
 * messages even with a valid token.
 */
function buildIlinkHeaders(opts: { token?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (opts.token) {
    // Authorization MUST carry the Bearer prefix. iLink also
    // requires AuthorizationType=ilink_bot_token to disambiguate
    // the credential kind.
    headers.Authorization = `Bearer ${opts.token}`;
    headers.AuthorizationType = "ilink_bot_token";
  }
  return headers;
}

/** X-WECHAT-UIN: random 32-bit unsigned int decimal string,
 *  base64-encoded. Tencent's gateway uses it as a per-request
 *  nonce; the value itself isn't validated. */
function randomWechatUin(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const u32 =
    (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  const decimal = (u32 >>> 0).toString();
  return btoa(decimal);
}

/** Build the `base_info` block every authenticated request carries.
 *  Identifies the calling bot to Tencent's analytics. */
export function buildBaseInfo(opts: { botAgent: string; channelVersion: string }) {
  return {
    // channel_version is a string (e.g. "0.3.36"). OpenClaw's
    // reference packed it into a uint32 in the iLink-App-ClientVersion
    // header but kept the body field as the raw semver string. I
    // misread the JS earlier; the int variant gives -14.
    channel_version: opts.channelVersion,
    bot_agent: opts.botAgent,
  };
}

interface RawPostOpts {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

/** GET an iLink endpoint. QR-status polling uses GET (not POST)
 *  with the qr id as a query-string param; mirror Tencent's own
 *  client. Returns raw response body. */
async function apiGet(opts: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const url = `${trimTrailingSlash(opts.baseUrl)}/${opts.endpoint}`;
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
      method: "GET",
      headers: buildIlinkHeaders({}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw classifyAndThrow({ type: "non200", status: res.status, body });
    }
    return await res.text();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      if (opts.abortSignal?.aborted) throw classifyAndThrow({ type: "abort" });
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

/** POST a JSON body to an iLink endpoint. Throws a typed ApiError
 *  on transport-level failures; the caller checks `resp.ret` /
 *  `resp.errcode` for API-level failures from the response body. */
export async function apiPost(opts: RawPostOpts): Promise<string> {
  const url = `${trimTrailingSlash(opts.baseUrl)}/${opts.endpoint}`;
  const headers = buildIlinkHeaders({ token: opts.token });

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
  baseUrl?: string;
  botType?: string;
  localTokenList?: string[];
}): Promise<QrCodeResponse> {
  const botType = opts.botType ?? "3";
  const body = JSON.stringify({ local_token_list: opts.localTokenList ?? [] });
  const raw = await apiPost({
    baseUrl: opts.baseUrl ?? ILINK_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body,
  });
  return JSON.parse(raw) as QrCodeResponse;
}

/**
 * Status response from `/ilink/bot/get_qrcode_status`. The wire
 * shape is verbose; we surface the fields the plugin actually
 * needs and leave the rest under `raw` for debugging.
 *
 * `status` is a string enum:
 *   - "wait"            : not scanned yet, keep polling
 *   - "scaned"          : user opened the QR but hasn't tapped
 *                         Confirm. Keep polling. (Tencent typo.)
 *   - "need_verifycode" : new bot account; user must enter a
 *                         numeric pairing code. We don't support
 *                         this path yet — the admin UI surfaces
 *                         it as an error.
 *   - "scaned_but_redirect" : Tencent wants us to retry against
 *                         a different api host. Tracks redirect
 *                         from `redirect_host`. Not supported v0.
 *   - "confirmed"       : terminal success; token in bot_token,
 *                         user id in ilink_user_id.
 *   - "expired"         : QR died; restart the login flow.
 *   - "verify_code_blocked" : too many bad pairing attempts.
 */
export interface QrCodeStatusResponse {
  status?: string;
  bot_token?: string;
  ilink_user_id?: string;
  ilink_bot_id?: string;
  username?: string;
  /**
   * Per-binding API host Tencent assigns at confirm time. Often
   * differs from the QR-login host (e.g. ilinkai.weixin.qq.com
   * for login, sometimes-shard for actual messaging). MUST be
   * used by every subsequent call (getupdates, sendmessage),
   * else iLink answers -14 "session timeout" because the token
   * is registered on a different shard.
   */
  baseurl?: string;
  redirect_host?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** Step 2 of QR login: long-poll the scan status via **GET** (not
 *  POST). Mirrors Tencent's own client: qrcode in the query
 *  string, no body. Resolves once the user confirms (status =
 *  "confirmed" + bot_token) or the QR expires. */
export async function getQrCodeStatus(opts: {
  baseUrl?: string;
  qrcode: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<QrCodeStatusResponse> {
  const raw = await apiGet({
    baseUrl: opts.baseUrl ?? ILINK_BASE_URL,
    endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(opts.qrcode)}`,
    timeoutMs: opts.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
    abortSignal: opts.abortSignal,
  });
  return JSON.parse(raw) as QrCodeStatusResponse;
}

// ─── Long-poll inbound ─────────────────────────────────────────

/**
 * Inbound message as iLink actually delivers it. The wire shape
 * doesn't match Tencent's published reference docs in a few
 * places — we sniffed it from a live response and tracked here:
 *
 *   from_user_id  : sender's opaque iLink id ("...@im.wechat")
 *   to_user_id    : the bot's own id ("...@im.bot")
 *   message_id    : numeric id used for replies + dedup
 *   create_time_ms / update_time_ms / delete_time_ms : ms
 *   item_list[]   : message body parts. Each item carries a
 *                   `type` field (1 = text, others = image/file
 *                   we don't render yet) and the actual text
 *                   under `text_item.text`.
 *   context_token : per-user opaque cursor for outbound replies
 *   session_id / group_id : empty string for DMs
 */
export interface IncomingMessage {
  context_token?: string;
  from_user_id?: string;
  to_user_id?: string;
  message_id?: number | string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    image_item?: { image_url?: string; image_md5?: string };
  }>;
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
/**
 * Send a plain-text message downstream. Wire shape matches
 * Tencent's `SendMessageReq` proto + the `msg` envelope OpenClaw's
 * reference uses:
 *
 *   {
 *     msg: {
 *       from_user_id: "",            // empty; gateway fills in
 *       to_user_id: <recipient>,
 *       client_id: <random per-send>,
 *       message_type: 2,             // BOT
 *       message_state: 2,            // FINISH
 *       context_token: <opaque>,     // from last inbound msg
 *       item_list: [{ type: 1, text_item: { text } }]
 *     },
 *     base_info: { channel_version, bot_agent }
 *   }
 *
 * My first draft used `ilink_user_id` + `msg_items` (note the
 * underscore variant) which got accepted but the message never
 * arrived on the user side. The right names are `to_user_id` +
 * `item_list` + `text_item` and the whole thing has to live
 * under a `msg` wrapper.
 */
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
  const clientId = `tianshu-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: opts.ilinkUserId,
      client_id: clientId,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      context_token: opts.contextToken,
      item_list: [
        {
          type: 1, // TEXT
          text_item: { text: opts.text },
        },
      ],
    },
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
