// Node.js-backed fetch shim so MCP transports can pin the upstream
// Host header.
//
// Why we need this: Playwright MCP (and most MCP servers) bind to
// `localhost:<port>` and validate the inbound `Host` header against
// that bound address. From the host process we connect through a
// per-tenant microsandbox port forward, so the upstream IP/host is
// e.g. `127.0.0.1:58474` — never `localhost:3200`. The fix is to
// override the Host header — but Node's built-in fetch (undici)
// silently overrides any caller-supplied Host header with the URL's
// host (see undici Request validation), so the override gets
// discarded.
//
// The MCP SDK's StreamableHTTPClientTransport accepts a
// `fetch?: FetchLike` opt that fully replaces fetch. We feed it a
// shim built on `node:http` (where the Host header is honoured),
// preserving the SDK's native call shape so reconnect logic, SSE
// streaming, auth, and retries continue to work.
//
// Streams: the SDK reads `response.body` as a ReadableStream for
// SSE responses. We bridge node:http's IncomingMessage into a Web
// ReadableStream. JSON responses are read via `await resp.text()`
// or `.json()` so a buffered fallback works just as well.

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/**
 * Build a fetch-shaped function that routes requests through
 * `node:http` so that a caller-supplied `Host` header is preserved.
 *
 * @param hostHeader Value to set on every outbound request's Host
 *                   header. Most callers want their upstream MCP
 *                   server's bound address (e.g. `localhost:3200`).
 */
export function makeNodeHttpFetch(hostHeader: string) {
  return async function fetchViaNodeHttp(
    input: string | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const url =
      typeof input === "string" || input instanceof URL ? new URL(input) : input;
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    // Normalise `init.headers` → plain dict.
    const headerDict: Record<string, string> = {};
    if (init.headers) {
      // Headers can be Headers/array/object — coerce via Headers.
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headerDict[k] = v;
      });
    }
    // Force our Host header. node:http actually honours this
    // (unlike undici's fetch).
    headerDict["host"] = hostHeader;
    delete headerDict["Host"]; // case-insensitive — only keep one

    // Body coercion. The SDK only sends string / undefined bodies
    // for JSON-RPC, but support common shapes defensively.
    let body: Buffer | undefined;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body === "string") body = Buffer.from(init.body);
      else if (init.body instanceof Uint8Array) body = Buffer.from(init.body);
      else if (init.body instanceof ArrayBuffer) body = Buffer.from(new Uint8Array(init.body));
      else body = Buffer.from(String(init.body));
    }
    if (body) headerDict["content-length"] = String(body.length);

    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;

    return new Promise<Response>((resolve, reject) => {
      const req = transport(
        {
          host: url.hostname,
          port,
          path: `${url.pathname}${url.search}`,
          method: (init.method ?? "GET").toUpperCase(),
          headers: headerDict,
        },
        (res) => {
          resolve(buildWebResponse(res));
        },
      );
      req.on("error", reject);
      // Honour AbortSignal so the SDK's timeout / disconnect path
      // works.
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          req.destroy(abortError(signal));
        } else {
          const onAbort = () => req.destroy(abortError(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          req.on("close", () => signal.removeEventListener("abort", onAbort));
        }
      }
      if (body) req.write(body);
      req.end();
    });
  };
}

function abortError(signal: AbortSignal): Error {
  // Surface signal.reason when available (most modern callers set
  // a DOMException). Fall back to a plain AbortError for older
  // runtimes.
  const reason = (signal as unknown as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function buildWebResponse(res: IncomingMessage): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else if (typeof v === "string") headers.set(k, v);
  }
  // Convert IncomingMessage → ReadableStream so the SDK can pipe
  // the SSE body through eventsource-parser.
  const stream = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: res.statusCode ?? 0,
    statusText: res.statusMessage ?? "",
    headers,
  });
}
