# Custom UI Shell Development

## Overview

This skill guides developing a custom frontend that completely replaces the default Tianshu UI for this tenant. The custom shell is a standard SPA served from the plugin's `dist/` directory.

## File Location

Write all UI files to the shell plugin's dist directory. The agent has `write_file` access to the workspace; the built files need to land in the plugin's dist path.

## Development Workflow

### 1. Understand Requirements
Ask the user:
- What kind of UI? (dashboard, kanban, form-builder, CRM, support desk...)
- Which data to show? (tasks, files, wiki, chat, data sources...)
- Visual style? (dark/light, brand colors, minimal/rich)
- Tech preference? (vanilla JS for simplicity, or React/Vue if they want a build step)

### 2. Scaffold

For **single-file** apps (recommended for v1):
```
dist/
└── index.html    ← entire SPA in one file (HTML + CSS + JS)
```

For **multi-file** apps:
```
dist/
├── index.html
├── app.js
├── style.css
└── assets/
```

### 3. Essential Boilerplate

Every shell must handle:

```javascript
// 1. Extract identity from URL
const m = location.pathname.match(/\/tenants\/([^/]+)\/users\/([^/]+)/);
const tenantId = m?.[1];
const userId = m?.[2];

// 2. API helper (session cookie is automatic)
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, { credentials: 'include', ...opts });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// 3. WebSocket for real-time
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${proto}//${location.host}/ws`);
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case 'connected': /* identity confirmed */ break;
    case 'message_added': /* new chat message */ break;
    case 'stream_delta': /* LLM streaming chunk */ break;
    case 'stream_end': /* streaming done */ break;
    case 'plugin_event': /* task updates, etc. */ break;
  }
};

// 4. Send chat message
function sendMessage(text) {
  ws.send(JSON.stringify({ type: 'chat', text }));
}
```

### 4. Common Patterns

**Load tasks:**
```javascript
const { tasks } = await api('/p/workboard/tasks');
```

**Load files:**
```javascript
const files = await api('/p/files/list?path=/');
```

**Query data source:**
```javascript
const result = await api('/p/datasource/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: 'my-db', query: 'SELECT * FROM ...' })
});
```

**Wiki pages:**
```javascript
const pages = await api('/p/wiki/list');
const page = await api('/p/wiki/read?id=' + pageId);
```

**Scheduled jobs:**
```javascript
const schedules = await api('/p/cron/schedules');
```

### 5. Iterate

After writing the initial `dist/index.html`:
- The user refreshes their browser to see changes (server serves from dist/ directly)
- No build step needed for single-file apps
- For hot-reload during development, the plugin can declare `uiShell.devServer.target` in manifest.json to proxy to an external vite/webpack dev server

## Key Constraints

- **Same-origin**: API calls use session cookies automatically, no CORS issues
- **SPA fallback**: Any URL under the tenant prefix returns `index.html` — handle routing client-side
- **Plugin API prefix**: Plugin-specific routes are at `/api/p/<pluginId>/...`
- **No server-side rendering**: The shell is purely client-side; the server only serves static files
- **One shell per tenant**: If another shell plugin is active, it must be disabled first (`exclusiveGroup: "ui-shell"`)
