# Reverse-MCP wire protocol

Authoritative contract between the tianshu server (`reverse-mcp` plugin,
this repo) and a local bridge client (e.g.
[`tianshu-ai/local-bridge`](https://github.com/tianshu-ai/local-bridge)).
The client implements this; it does **not** import any tianshu package.

## Transport

The bridge client opens a **WebSocket to the server's chat endpoint**:

```
wss://<host>/ws
```

Authentication reuses the server's normal identity resolver chain:

- **Auth enabled** — send `Authorization: Bearer <token>`, where `<token>`
  is the connection token shown in the Local Bridge panel (minted via
  `host.bridgeToken`). The resolver verifies it and establishes
  `(tenantId, userId)`; the server stamps `userId` on the socket.
- **Auth disabled (dev)** — no token needed; the dev resolver assigns a
  default identity.

The bridge is thus scoped to exactly one `(tenant, user)`. Its tools are
visible only in that user's own sessions (main + worker), never shared
across users.

## Framing

All frames are JSON text messages on the shared `/ws` socket. Each frame
has a `type`. Direction is **inverted MCP**: the server is the JSON-RPC
client (sends `tools/call`), the bridge is the JSON-RPC server.

### client → server

**Register (or re-register) this device and its tools.** Send once right
after the socket opens (and again if the tool set changes).

```json
{
  "type": "reverse_mcp_register",
  "deviceId": "mac-mini",
  "label": "Work Mac",
  "tools": [
    {
      "name": "browser_navigate",
      "description": "Open a URL in the local browser",
      "inputSchema": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] }
    }
  ]
}
```

- `deviceId` — stable id for this machine/instance. A reconnect with the
  same `(user, deviceId)` replaces the previous connection.
- `tools[]` — MCP `Tool`-shaped descriptors. `inputSchema` is a JSON
  Schema object; omit for a no-arg tool.

**Reply to a server request** (see `reverse_mcp_request`):

```json
{ "type": "reverse_mcp_response", "id": "<request id>", "result": { "content": [ { "type": "text", "text": "…" } ] } }
```

or on failure:

```json
{ "type": "reverse_mcp_response", "id": "<request id>", "error": { "code": -32000, "message": "…" } }
```

**Graceful unregister** (optional; a dropped socket is cleaned up
automatically):

```json
{ "type": "reverse_mcp_unregister" }
```

### server → client

**Acknowledge a register:**

```json
{ "type": "reverse_mcp_registered", "ok": true, "deviceId": "mac-mini" }
```

**A JSON-RPC request to execute locally.** Today the only method is
`tools/call` (standard MCP shape):

```json
{
  "type": "reverse_mcp_request",
  "id": "1721394000000-1",
  "method": "tools/call",
  "params": { "name": "browser_navigate", "arguments": { "url": "https://example.com" } }
}
```

The client executes the named tool locally and replies with a
`reverse_mcp_response` carrying the same `id`. The `result` should be a
standard MCP `tools/call` result:

```json
{ "content": [ { "type": "text", "text": "navigated to https://example.com" } ], "isError": false }
```

The server flattens `content[].text` blocks into the agent-visible tool
result; `isError: true` marks the tool call failed.

## Tool naming

On the server each bridge tool becomes an agent tool named
`bridge_<deviceId>_<toolName>` (non-alphanumerics collapsed to `_`). The
agent sees these only for the owning user.

## Timeouts

The server times out a `tools/call` after 60s and reports a failure to
the agent. Keep local operations bounded or stream progress by returning
promptly.

## Versioning

This is a thin envelope around standard MCP JSON-RPC. A future revision
may move the same JSON-RPC payloads onto a dedicated endpoint with a
handshake `initialize`; the `params`/`result` shapes are intended to stay
stable across that move.
