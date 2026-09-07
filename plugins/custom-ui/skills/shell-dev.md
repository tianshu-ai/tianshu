---
name: shell-dev
description: How to build a custom frontend for a tenant — file location, scaffolding, active plugin checks, development workflow.
---

# Custom UI Shell Development

## Overview

This skill guides developing a custom frontend that completely replaces the default Tianshu UI for this tenant. The custom shell is a standard SPA served from the plugin's `dist/` directory.

## File Location

Write shell UI files to the **tenant shared directory**:

```
_tenant/shell/index.html      ← main entry (required)
_tenant/shell/app.js           ← optional
_tenant/shell/style.css        ← optional
_tenant/shell/assets/          ← images, fonts, etc.
```

Use `write_file path="_tenant/shell/index.html"` — this writes to the tenant's shared config area. The server checks this directory first; if no `index.html` is found, it falls back to the plugin's built-in placeholder.

Each tenant has its own `_tenant/shell/` directory, so different tenants can have completely different UIs.

## Development Workflow

### 0. Check Active Plugins

Before designing the UI, **always check which plugins are active**:

```javascript
const { plugins } = await api('/plugins');
const active = new Set(plugins.filter(p => p.state === 'active').map(p => p.id));
// Only build UI sections for active plugins:
// active.has('workboard') → show task board
// active.has('files')     → show file browser
// active.has('wiki')      → show knowledge base
// active.has('cron')      → show scheduler
// active.has('datasource')→ show data queries
// active.has('board')     → show dashboards
```

Never hardcode plugin assumptions. The UI must adapt to what's actually enabled.

### 1. Understand Requirements
Ask the user:
- What kind of UI? (dashboard, kanban, form-builder, CRM, support desk...)
- Which data to show? (tasks, files, wiki, chat, data sources...)
- Visual style? (dark/light, brand colors, minimal/rich)
- Tech preference? (vanilla JS for simplicity, or React/Vue if they want a build step)

### 2. Scaffold

For **single-file** apps (recommended for v1):
```
_tenant/shell/
└── index.html    ← entire SPA in one file (HTML + CSS + JS)
```

For **multi-file** apps:
```
_tenant/shell/
├── index.html
├── app.js
├── style.css
└── assets/
```

### 3. Essential Boilerplate

The server injects `window.__TIANSHU_SHELL__` into every shell page with identity and a dedicated session id. Every shell must use this:

```javascript
// 1. Read server-injected config (auto-available, no API call needed)
const SHELL = window.__TIANSHU_SHELL__ || {};
const { tenantId, userId, sessionId, pluginId } = SHELL;
// sessionId is a dedicated session for this shell (e.g. "shell_demo_ul_xxx")
// It's auto-created by the server — conversations here are separate from webchat.

// 2. API helper (session cookie is automatic)
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { credentials: 'include', ...opts });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// 3. WebSocket for real-time chat
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${proto}//${location.host}/ws`);

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'hello' }));
  // Load history for the shell's dedicated session
  ws.send(JSON.stringify({ type: 'history', sessionId, limit: 50 }));
});

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case 'connected':     /* identity confirmed */ break;
    case 'history':       /* msg.messages[] — render chat history */ break;
    case 'stream_start':  /* new assistant response starting */ break;
    case 'stream_delta':  /* msg.delta — append to streaming bubble */ break;
    case 'stream_end':    /* msg.message — final complete message */ break;
    case 'stream_error':  /* msg.reason — show error */ break;
    case 'tool_call':     /* msg.name — show tool in-progress */ break;
    case 'tool_result':   /* msg.text, msg.ok — show tool result */ break;
    case 'plugin_event':  /* task updates, etc. */ break;
  }
};

// 4. Send user message — always include sessionId!
function sendMessage(text) {
  ws.send(JSON.stringify({ type: 'prompt', content: text, sessionId }));
}
```

**Critical**: Always pass `sessionId` in `prompt` and `history` messages. Without it, messages go to the default webchat session instead of the shell's dedicated session.

### 4. Session Isolation Checklist

Every custom shell UI **must** follow this pattern to avoid leaking messages into the webchat session:

1. **Read the injected config** — `window.__TIANSHU_SHELL__` is injected by the server into `</head>`. It contains `{ tenantId, userId, sessionId, pluginId }`. The `sessionId` is a dedicated session auto-created by the server (e.g. `shell_demo_ul_xxx`).
2. **Pass `sessionId` in EVERY `prompt` message** — `{ type: 'prompt', content: text, sessionId: shellSid }`. Without this, the message goes to the default webchat session.
3. **Pass `sessionId` in EVERY `history` message** — `{ type: 'history', limit: 50, sessionId: shellSid }`. Without this, you load webchat history instead of shell history.
4. **Send `hello` on connect** — `{ type: 'hello' }` triggers the `connected` event with identity confirmation.
5. **Do NOT use query params on the WS URL** — `ws://host/ws?sessionId=xxx` does nothing. Session routing is done via the JSON message fields.
6. **Do NOT generate random session ids** — The server creates the session in the DB. Random/localStorage ids won't match any real session.

```javascript
// ✅ Correct pattern
const SHELL = window.__TIANSHU_SHELL__ || {};
const shellSid = SHELL.sessionId;

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'hello' }));
  ws.send(JSON.stringify({ type: 'history', limit: 50, sessionId: shellSid }));
};

function sendMessage(text) {
  ws.send(JSON.stringify({ type: 'prompt', content: text, sessionId: shellSid }));
}

// ❌ Wrong — these all break session isolation:
// ws.send(JSON.stringify({ type: 'prompt', content: text }));  // no sessionId → webchat
// new WebSocket(`ws://host/ws?sessionId=${id}`);  // query params ignored
// const id = 'shell_' + Math.random();  // random id doesn't exist in DB
```

### 4. Common Patterns (only use if plugin is active)

Always gate on the active plugins set from step 0.

**Tasks (requires: workboard):**
```javascript
if (active.has('workboard')) {
  const { tasks } = await api('/p/workboard/tasks');
  const workers = await api('/p/workboard/workers/status');
}
```

**Files (requires: files):**
```javascript
if (active.has('files')) {
  const files = await api('/p/files/list?path=/');
}
```

**Data source (requires: datasource):**
```javascript
if (active.has('datasource')) {
  const { connections } = await api('/p/datasource/connections');
  const result = await api('/p/datasource/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'my-db', query: 'SELECT * FROM ...' })
  });
}
```

**Wiki (requires: wiki):**
```javascript
if (active.has('wiki')) {
  const pages = await api('/p/wiki/list');
  const page = await api('/p/wiki/read?id=' + pageId);
}
```

**Scheduler (requires: cron):**
```javascript
if (active.has('cron')) {
  const schedules = await api('/p/cron/schedules');
}
```

**Boards (requires: board):**
```javascript
if (active.has('board')) {
  const boards = await api('/p/board/boards');
}
```

### 5. Iterate

After writing the initial `dist/index.html`:
- The user refreshes their browser to see changes (server serves from dist/ directly)
- No build step needed for single-file apps
- For hot-reload during development, the plugin can declare `uiShell.devServer.target` in manifest.json to proxy to an external vite/webpack dev server

## Key Conventions

### File Location
- **Write to**: `_tenant/shell/index.html` (and any other assets under `_tenant/shell/`)
- **Command**: `write_file path="_tenant/shell/index.html" content="..."`
- **Resolves to**: `<tianshuHome>/tenants/<tenantId>/workspace/_tenant/shell/`
- **Per-tenant**: each tenant has its own `_tenant/shell/` — different tenants can have different UIs
- **Shared across users**: all users of the same tenant see the same shell UI

### Server Loading Priority
1. `_tenant/shell/index.html` — tenant-specific (agent writes here) ✅
2. Plugin `dist/index.html` — built-in placeholder ("ask the agent")
3. Neither → default `@tianshu/web` chat UI

### Runtime Rules
- **Same-origin**: API calls use session cookies automatically, no CORS issues
- **SPA fallback**: Any URL under `/shell/tenants/...` returns `index.html` — handle routing client-side

### URL Entry Points

| URL | What it serves |
|---|---|
| `/tenants/<tenantId>/users/<userId>` | Native UI (always available) |
| `/shell/tenants/<tenantId>/users/<userId>` | Custom shell UI (when plugin active + shell published) |

Both can be used simultaneously. The native UI sidebar shows a "Custom Shell" link when shell sessions have messages.
- **Plugin API prefix**: Plugin-specific routes are at `/api/p/<pluginId>/...`
- **No server-side rendering**: The shell is purely client-side; the server only serves static files
- **One shell per tenant**: If another shell plugin is active, it must be disabled first (`exclusiveGroup: "ui-shell"`)
- **No restart needed**: After writing/updating shell files, user just refreshes the browser
- **Check active plugins**: Always call `GET /api/plugins` first — only use plugin APIs when `state === "active"`
