// Outbound media (image / video / file) for the iLink bot API.
//
// Wire shape mirrors `@tencent-weixin/openclaw-weixin` (MIT) verbatim
// — that's the reference implementation Tencent ships, and we want to
// stay protocol-compatible so a future Tencent-side change doesn't
// force us to diverge.
//
// Flow per file:
//   1. Read + hash plaintext, generate fresh AES-128 key + filekey.
//   2. POST /ilink/bot/getuploadurl → CDN upload URL (or upload_param
//      to compose one).
//   3. AES-128-ECB encrypt the buffer (PKCS7), POST to the CDN; CDN
//      replies with `x-encrypted-param` = the download-side opaque
//      param we'll need to embed in the eventual message item.
//   4. POST /ilink/bot/sendmessage with a single item_list entry of
//      the appropriate type (IMAGE / VIDEO / FILE), carrying the
//      AES key + CDN ref.
//
// The CDN URL itself is `https://novac2c.cdn.weixin.qq.com/c2c`
// (platform constant, matches what Tencent's plugin hard-codes).
// All ciphertext is AES-128-ECB with PKCS7 padding. We currently
// only support outbound (sending to a user); inbound media reading
// is a separate concern handled in channel.ts.

import { createCipheriv } from "node:crypto";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { apiPost, buildBaseInfo } from "./ilink-api.js";

/** Platform constant for the c2c CDN endpoint. */
export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** UploadMediaType — matches the iLink proto enum. */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

/** MessageItem types observed on inbound + needed for outbound. */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** AES-128-ECB ciphertext size with PKCS7 padding (matches the
 *  reference implementation's `aesEcbPaddedSize`). */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** Encrypt with AES-128-ECB + PKCS7. Node's `aes-128-ecb` defaults
 *  to PKCS7 padding when no IV is provided. */
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Result of a successful CDN upload — handed to the matching
 *  sendXyzMessage() so it can build the message item. */
export interface UploadedMedia {
  filekey: string;
  downloadEncryptedQueryParam: string;
  /** AES key as hex (32 chars). Convert to base64 when stuffing
   *  into the message item's `aes_key`. */
  aesKeyHex: string;
  /** Plaintext bytes — surfaced in FileItem.len. */
  fileSize: number;
  /** Ciphertext bytes — surfaced in ImageItem.mid_size / VideoItem.video_size. */
  fileSizeCiphertext: number;
}

interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  upload_full_url?: string;
}

/** POST /ilink/bot/getuploadurl. */
async function getUploadUrl(opts: {
  baseUrl: string;
  token: string;
  filekey: string;
  mediaType: number;
  toUserId: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  aeskeyHex: string;
  botAgent: string;
  channelVersion: string;
  timeoutMs?: number;
}): Promise<GetUploadUrlResp> {
  const body = JSON.stringify({
    filekey: opts.filekey,
    media_type: opts.mediaType,
    to_user_id: opts.toUserId,
    rawsize: opts.rawsize,
    rawfilemd5: opts.rawfilemd5,
    filesize: opts.filesize,
    no_need_thumb: true,
    aeskey: opts.aeskeyHex,
    base_info: buildBaseInfo(opts),
  });
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
  });
  const resp = JSON.parse(raw) as GetUploadUrlResp;
  if (resp.ret && resp.ret !== 0) {
    throw new Error(
      `getUploadUrl ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`,
    );
  }
  return resp;
}

/** POST ciphertext to the CDN; the response header
 *  `x-encrypted-param` carries the download-side opaque param. */
async function uploadCiphertextToCdn(opts: {
  cdnUrl: string;
  ciphertext: Buffer;
  maxRetries?: number;
}): Promise<{ downloadEncryptedQueryParam: string }> {
  const maxRetries = opts.maxRetries ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(opts.cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(opts.ciphertext),
      });
      // 4xx is a client error; don't retry — fail fast so the
      // caller surfaces the real diagnosis (bad token, expired
      // upload URL, etc.) rather than spinning the same broken
      // request.
      if (res.status >= 400 && res.status < 500) {
        const errMsg =
          res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(
          `CDN upload client error ${res.status}: ${errMsg}`,
        );
      }
      if (res.status !== 200) {
        const errMsg =
          res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN upload server error: ${errMsg}`);
      }
      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) {
        throw new Error(
          "CDN upload response missing x-encrypted-param header",
        );
      }
      return { downloadEncryptedQueryParam: downloadParam };
    } catch (err) {
      lastErr = err;
      // Client errors propagate immediately — see fail-fast note above.
      if (err instanceof Error && err.message.includes("client error")) {
        throw err;
      }
      if (attempt >= maxRetries) break;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("CDN upload failed");
}

/** End-to-end upload: read → encrypt → register with iLink → POST
 *  ciphertext to CDN. Returns the bag of refs sendXyzMessage()
 *  needs to compose the message item. */
async function uploadMedia(params: {
  filePath: string;
  toUserId: string;
  mediaType: number;
  baseUrl: string;
  token: string;
  cdnBaseUrl: string;
  botAgent: string;
  channelVersion: string;
}): Promise<UploadedMedia> {
  const plaintext = await fs.readFile(params.filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");

  const reg = await getUploadUrl({
    baseUrl: params.baseUrl,
    token: params.token,
    filekey,
    mediaType: params.mediaType,
    toUserId: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskeyHex: aesKeyHex,
    botAgent: params.botAgent,
    channelVersion: params.channelVersion,
  });

  const uploadFullUrl = reg.upload_full_url?.trim();
  const uploadParam = reg.upload_param?.trim();
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(
      "getUploadUrl returned no upload URL (need upload_full_url or upload_param)",
    );
  }
  const cdnUrl = uploadFullUrl
    ? uploadFullUrl
    : `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(
        uploadParam!,
      )}&filekey=${encodeURIComponent(filekey)}`;

  const ciphertext = encryptAesEcb(plaintext, aesKey);
  const { downloadEncryptedQueryParam } = await uploadCiphertextToCdn({
    cdnUrl,
    ciphertext,
  });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aesKeyHex,
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

// ─── send helpers (one per message-item type) ────────────────────

interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** Common envelope for all media send variants. The `item` is the
 *  pre-built MessageItem (image_item / video_item / file_item).
 *  Tencent's reference splits text caption + media into two
 *  separate sendmessage calls because each `item_list` request
 *  contains exactly one item — we mirror that behaviour. */
async function postSingleItem(opts: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  contextToken: string;
  item: Record<string, unknown>;
  botAgent: string;
  channelVersion: string;
  timeoutMs?: number;
}): Promise<SendMessageResp> {
  const clientId = `tianshu-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: opts.ilinkUserId,
      client_id: clientId,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      context_token: opts.contextToken,
      item_list: [opts.item],
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
  const resp = JSON.parse(raw) as SendMessageResp;
  if (resp.ret && resp.ret !== 0) {
    throw new Error(
      `sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`,
    );
  }
  return resp;
}

/** Helper: build the CDN-media sub-object every media item carries. */
function buildCdnMedia(uploaded: UploadedMedia): Record<string, unknown> {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    // aes_key on the message item is base64-encoded bytes (the
    // raw 16-byte key, not its hex string). Same convention the
    // reference impl uses; verified against the inbound side.
    aes_key: Buffer.from(uploaded.aesKeyHex, "hex").toString("base64"),
    encrypt_type: 1,
  };
}

export async function sendImageMessage(opts: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  contextToken: string;
  uploaded: UploadedMedia;
  botAgent: string;
  channelVersion: string;
  timeoutMs?: number;
}): Promise<SendMessageResp> {
  const item = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: buildCdnMedia(opts.uploaded),
      mid_size: opts.uploaded.fileSizeCiphertext,
    },
  };
  return postSingleItem({ ...opts, item });
}

export async function sendVideoMessage(opts: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  contextToken: string;
  uploaded: UploadedMedia;
  botAgent: string;
  channelVersion: string;
  timeoutMs?: number;
}): Promise<SendMessageResp> {
  const item = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: buildCdnMedia(opts.uploaded),
      video_size: opts.uploaded.fileSizeCiphertext,
    },
  };
  return postSingleItem({ ...opts, item });
}

export async function sendFileMessage(opts: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  contextToken: string;
  uploaded: UploadedMedia;
  fileName: string;
  botAgent: string;
  channelVersion: string;
  timeoutMs?: number;
}): Promise<SendMessageResp> {
  const item = {
    type: MessageItemType.FILE,
    file_item: {
      media: buildCdnMedia(opts.uploaded),
      file_name: opts.fileName,
      // FileItem.len in the proto is a string (int64) — plaintext bytes.
      len: String(opts.uploaded.fileSize),
    },
  };
  return postSingleItem({ ...opts, item });
}

// ─── Public: pick the right path by MIME, upload + send ───────────

/** Coarse MIME sniffing by extension. Channels don't have a file
 *  picker upstream — the caller supplies a path on disk and we
 *  pick image / video / file from the extension. Unknown types
 *  fall through to FILE (generic attachment). */
function classifyByExtension(
  filePath: string,
): "image" | "video" | "file" {
  const ext = path.extname(filePath).toLowerCase();
  if (
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".png" ||
    ext === ".gif" ||
    ext === ".webp" ||
    ext === ".bmp"
  ) {
    return "image";
  }
  if (
    ext === ".mp4" ||
    ext === ".mov" ||
    ext === ".m4v" ||
    ext === ".avi" ||
    ext === ".webm"
  ) {
    return "video";
  }
  return "file";
}

/** End-to-end: read a local file, upload to CDN, send it as the
 *  appropriate message type (image / video / generic file). The
 *  caller is responsible for an optional text caption sent
 *  before this (Tencent's API doesn't let one sendmessage carry
 *  both — see postSingleItem). */
export async function uploadAndSendFile(opts: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  contextToken: string;
  filePath: string;
  /** Override the basename used for the FILE message type. */
  fileName?: string;
  cdnBaseUrl?: string;
  botAgent: string;
  channelVersion: string;
  timeoutMs?: number;
}): Promise<{ kind: "image" | "video" | "file"; uploaded: UploadedMedia }> {
  const cdnBaseUrl = opts.cdnBaseUrl ?? ILINK_CDN_BASE_URL;
  const kind = classifyByExtension(opts.filePath);
  const mediaType =
    kind === "image"
      ? UploadMediaType.IMAGE
      : kind === "video"
        ? UploadMediaType.VIDEO
        : UploadMediaType.FILE;

  const uploaded = await uploadMedia({
    filePath: opts.filePath,
    toUserId: opts.ilinkUserId,
    mediaType,
    baseUrl: opts.baseUrl,
    token: opts.token,
    cdnBaseUrl,
    botAgent: opts.botAgent,
    channelVersion: opts.channelVersion,
  });

  if (kind === "image") {
    await sendImageMessage({ ...opts, uploaded });
  } else if (kind === "video") {
    await sendVideoMessage({ ...opts, uploaded });
  } else {
    await sendFileMessage({
      ...opts,
      uploaded,
      fileName: opts.fileName ?? path.basename(opts.filePath),
    });
  }
  return { kind, uploaded };
}
