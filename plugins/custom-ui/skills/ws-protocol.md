---
name: ws-protocol
description: Complete WebSocket protocol for real-time chat — message types, streaming events, tool calls, history pagination, and working code example.
---

# Tianshu WebSocket Chat Protocol

Complete reference for the `/ws` WebSocket protocol. Custom shell UIs use this to communicate with the Tianshu agent in real-time.

## Connection

```javascript
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${proto}//${location.host}/ws`);
```

Authentication uses the same session cookie as HTTP — no extra token needed when the shell is served from the same origin.

## Session Model

Each `(tenant, user)` pair has one active **user session** (kind='user'). The server creates it automatically on first WS connection (`ensureActiveSession`). Key points:

- **Default: one active session per user** — `prompt` messages without `sessionId` go to the user's default session.
- **Dedicated shell session** — call `POST /api/p/custom-ui/session` to create a shell-specific session. Pass the returned `sessionId` in `prompt` and `history` messages to keep shell conversations separate from the default chat.
- **Session persists across reconnects** — closing and reopening the WS doesn't create a new session. Messages are persisted in the DB.
- **History is session-scoped** — `history` and `history_more` default to the active session. Pass `sessionId` to read a specific session (e.g. channel sessions from the sidebar).
- **Channel sessions** — messages from WeChat/Telegram/etc. create separate sessions with `kind='channel'`. List them via `GET /api/channel-sessions`.
- **Worker sessions** — workboard tasks run in ephemeral `kind='worker'` sessions. These are not directly accessible from the shell UI.
- **Compaction** — when the conversation gets too long, the server automatically summarizes older messages (`history_compacted` event). The session id may change after compaction.

## Client → Server Messages

### `hello` — Request identity confirmation
```json
{ "type": "hello" }
```
Server responds with `connected` event containing `tenantId` and `userId`. Send this right after the socket opens.

### `prompt` — Send user message (triggers agent run)
```json
{
  "type": "prompt",
  "content": "Help me analyze this data",
  "modelId": "anthropic/claude-sonnet-4-6",
  "sessionId": "shell_ul_xxx",
  "attachments": [
    { "path": "/uploads/data.csv", "mimeType": "text/csv", "name": "data.csv" }
  ]
}
```
- `content` (required): the user's message text
- `modelId` (optional): override the default model for this turn
- `sessionId` (optional): route to a specific session (e.g. the shell's dedicated session). Without this, goes to the user's default active session.
- `attachments` (optional): files staged in the composer. Paths are user-home-relative (start with `/`)

### `history` — Load message history
```json
{ "type": "history", "limit": 50, "sessionId": "optional-session-id" }
```
Server responds with `history` event. Default limit: 100, max: 500. Messages are in ascending order (oldest first).

### `history_more` — Paginate older messages
```json
{ "type": "history_more", "before": "oldest-message-id-in-client", "limit": 50 }
```
Server responds with `history_page` event. `before` is the oldest message id currently displayed.

### `retry` — Retry last failed turn
```json
{ "type": "retry", "modelId": "optional-model-override" }
```
Re-runs the last turn WITHOUT inserting a new user message. Use after a stream_error to resume.

### `abort` — Cancel in-flight prompt
```json
{ "type": "abort" }
```
Cancels the currently running agent turn. Only one prompt runs per socket at a time.

## Server → Client Messages

### Connection & History

| Type | Fields | Description |
|---|---|---|
| `connected` | `tenantId`, `userId` | Identity confirmed after `hello` |
| `history` | `messages[]`, `hasMore` | Initial message history |
| `history_page` | `messages[]`, `hasMore`, `before` | Older page of messages |
| `message_added` | `message`, `sessionId?` | New message persisted (user or assistant) |

### Streaming (Agent Response)

Events arrive in order for each agent turn:

```
stream_start → stream_delta* → stream_end
                              ↗ stream_error (on failure)
```

| Type | Fields | Description |
|---|---|---|
| `stream_start` | — | LLM streaming begins |
| `stream_delta` | `delta` | Incremental text chunk (append to bubble) |
| `stream_end` | `message` | Streaming complete; `message` is the full WireMessage |
| `stream_error` | `reason` | Streaming failed |
| `stream_reset` | `sessionId?` | Discard in-progress bubble (mid-stream retry) |
| `model_retry` | `attempt`, `maxAttempts`, `kind`, `delayMs`, `rateLimited`, `message`, `contentStreamed` | Transient failure being retried |

### Tool Execution

| Type | Fields | Description |
|---|---|---|
| `tool_call` | `callId`, `name`, `arguments` | Agent is calling a tool (show in-progress chip) |
| `tool_result` | `callId`, `name`, `ok`, `text`, `ui?` | Tool finished; `ui` has MCP-UI iframes if any |

### System Events

| Type | Fields | Description |
|---|---|---|
| `history_compacted` | `reason`, `oldSessionId`, `newSessionId`, `summarisedCount`, `keptCount`, `durationMs` | Conversation compacted |
| `plugins_changed` | `enabled[]`, `disabled[]` | Plugin state changed |
| `plugin_event` | `event`, `payload` | Plugin broadcast (e.g. task board updates). `event` is `<pluginId>:<type>` |
| `channel_session_changed` | `channelId` | Channel produced new message |
| `tool_catalog_changed` | `fromVersion`, `toVersion`, `newTools[]` | Available tools changed after upgrade |

## WireMessage Shape

Each message in `history`, `message_added`, `stream_end` has this shape:

```typescript
{
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "toolResult";
  text: string;                              // Human-readable text
  toolCalls?: { id, name, arguments }[];     // Assistant's tool calls
  blocks?: Array<                            // Ordered text + tool-call blocks
    | { kind: "text", text: string }
    | { kind: "toolCall", id, name, arguments }
  >;
  toolResult?: { callId, name, ok, text };   // For tool result messages
  attachments?: { path, mimeType, name?, size? }[];  // User file attachments
  meta?: {                                   // Assistant message metadata
    model?: string;
    usage?: { input, output, totalTokens };
    contextWindow?: number;
  };
  createdAt: number;                         // Unix timestamp ms
}
```

## Complete Chat UI Example

```javascript
let ws;
let streamingText = '';
let shellSessionId = null;

// Step 1: Create/get a dedicated shell session
async function initSession() {
  const res = await fetch('/api/p/custom-ui/session', {
    method: 'POST', credentials: 'include'
  });
  const data = await res.json();
  shellSessionId = data.sessionId;  // e.g. "shell_ul_xxx"
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello' }));
    // Load history for the shell session specifically
    ws.send(JSON.stringify({ type: 'history', limit: 50, sessionId: shellSessionId }));
  };

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
      case 'connected':
        // Identity confirmed: msg.tenantId, msg.userId
        break;
      case 'history':
        // Render msg.messages (ascending order)
        msg.messages.forEach(m => renderMessage(m));
        break;
      case 'message_added':
        // New message: msg.message (could be user echo or system)
        renderMessage(msg.message);
        break;
      case 'stream_start':
        streamingText = '';
        showStreamingBubble();
        break;
      case 'stream_delta':
        streamingText += msg.delta;
        updateStreamingBubble(streamingText);
        break;
      case 'stream_end':
        hideStreamingBubble();
        renderMessage(msg.message);
        break;
      case 'stream_error':
        hideStreamingBubble();
        showError(msg.reason);
        break;
      case 'stream_reset':
        streamingText = '';
        resetStreamingBubble();
        break;
      case 'tool_call':
        showToolChip(msg.name, 'running');
        break;
      case 'tool_result':
        updateToolChip(msg.callId, msg.ok ? 'done' : 'error', msg.text);
        break;
      case 'plugin_event':
        // Handle plugin broadcasts (e.g. task updates)
        break;
    }
  };

  ws.onclose = () => setTimeout(connect, 3000);
}

function sendMessage(text) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  // Route to the shell's dedicated session
  ws.send(JSON.stringify({ type: 'prompt', content: text, sessionId: shellSessionId }));
}

function abortRun() {
  ws?.send(JSON.stringify({ type: 'abort' }));
}

// Boot: create session first, then connect WS
initSession().then(connect);
```
