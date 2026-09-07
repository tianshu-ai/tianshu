# Tianshu REST API Reference

Complete reference for all REST APIs available to custom shell UIs. All endpoints require authentication via session cookie (same-origin requests carry it automatically).

⚠️ **Plugin APIs are only available when the plugin is active.** Always call `GET /api/plugins` first and gate on `state === "active"`.

## Core APIs (always available)

### Identity & Auth

```
GET  /api/me
```
Returns current user identity.
```json
{ "userId": "ul_xxx", "tenantId": "demo", "displayName": "admin", "role": "admin", "defaultModel": "anthropic/claude-sonnet-4-6" }
```

```
GET  /api/auth/config
```
Returns auth configuration (whether auth is enabled, available providers).
```json
{ "enabled": true, "providers": [...], "localLogin": true, "allowRegistration": false }
```

```
POST /api/auth/login
Body: { "username": "admin", "password": "..." }
```
Returns `{ "ok": true, "userId": "...", "tenantId": "...", "tenants": ["default", "demo"] }`. Sets session cookie.

```
POST /api/auth/switch-tenant
Body: { "tenantId": "demo" }
```
Switch the session to a different tenant. Returns `{ "ok": true, "tenantId": "demo" }`.

```
POST /api/auth/logout
```

### Models

```
GET  /api/models
```
List available LLM models for the current tenant.
```json
{
  "models": [
    { "id": "anthropic/claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "provider": "anthropic", "contextWindow": 200000, "reasoning": false },
    ...
  ],
  "defaultModel": "anthropic/claude-sonnet-4-6"
}
```

### Direct LLM Chat (non-agent)

```
POST /api/llm/chat
Body: {
  "model": "anthropic/claude-sonnet-4-6",
  "messages": [{ "role": "user", "content": "Hello" }],
  "system": "You are a helpful assistant",
  "maxTokens": 4096,
  "temperature": 0.7
}
```
Direct LLM call without the agent loop (no tools, no session). Returns:
```json
{ "ok": true, "text": "...", "model": "claude-sonnet-4-6", "usage": { "input": 10, "output": 50, "totalTokens": 60 } }
```

### Plugins

```
GET  /api/plugins
```
List all plugins for the current tenant.
```json
{
  "plugins": [
    {
      "id": "board",
      "displayName": "Boards",
      "state": "active",
      "contributes": { "topBarButtons": [...], "rightPanels": [...] },
      ...
    }
  ]
}
```

```
PATCH /api/plugins/:id
Body: { "enabled": true }
```
Enable or disable a plugin. Returns the updated full plugin list.

### Tools & Skills

```
GET  /api/tools
```
List all agent tools available for the current tenant.

```
GET  /api/skills
```
List all agent skills available for the current tenant.

### User Preferences

```
GET  /api/preferences/:key
POST /api/preferences/:key
Body: { "value": "..." }
```
Read/write per-user preferences (e.g. `ui.openPanel`, `board.selectedBoard`).

---

## Plugin APIs

### Files (`files` plugin)

```
GET  /api/p/files/list?path=/
```
List directory contents. `path` is relative to user home.
```json
{
  "entries": [
    { "name": "projects", "kind": "directory", "size": 0, "mtime": 1720000000000 },
    { "name": "USER.md", "kind": "file", "size": 234, "mtime": 1720000000000 }
  ]
}
```

```
GET  /api/p/files/read?path=/USER.md
```
Read file content as text.
```json
{ "content": "# User profile\n...", "path": "/USER.md", "size": 234 }
```

```
GET  /api/p/files/raw?path=/uploads/image.png
```
Download raw file bytes (binary). Returns the file with appropriate Content-Type.

```
POST /api/p/files/upload
Content-Type: multipart/form-data
Fields: file (binary), path (target directory)
```

### Task Board (`workboard` plugin)

```
GET  /api/p/workboard/tasks?status=ready,in_progress,done&project=my-project
```
List tasks, optionally filtered by status and project.
```json
{
  "tasks": [
    {
      "id": "uuid",
      "title": "Research competitors",
      "status": "in_progress",
      "project": "competitor-analysis",
      "workerAgentId": "researcher",
      "resultSummary": null,
      "createdAt": 1720000000000
    }
  ]
}
```

```
POST /api/p/workboard/tasks
Body: {
  "title": "Research LAPP products",
  "description": "## Goal\nResearch LAPP cable products...",
  "project": "competitor-analysis",
  "workerAgentId": "researcher",
  "dependencies": ["other-task-id"]
}
```

```
PATCH /api/p/workboard/tasks/:id
Body: { "status": "done", "resultSummary": "..." }
```

```
GET  /api/p/workboard/tasks/:id/history
```
Get the execution history (agent messages) for a task.

```
GET  /api/p/workboard/projects
```
List all projects (derived from task project fields).

```
GET  /api/p/workboard/workers/status
```
Worker pool status (running workers, queue depth).

```
GET  /api/p/workboard/agents
```
List configured worker agents.

### Scheduler (`cron` plugin)

```
GET  /api/p/cron/schedules
```
List all scheduled jobs.
```json
{
  "schedules": [
    {
      "id": "uuid",
      "title": "Weekly dashboard refresh",
      "scheduleType": "cron",
      "cronExpr": "0 9 * * 1",
      "timezone": "Asia/Shanghai",
      "enabled": true,
      "nextRunAt": 1720000000000
    }
  ]
}
```

```
POST /api/p/cron/schedules
Body: {
  "title": "Daily product check",
  "scheduleType": "cron",
  "cronExpr": "0 17 * * *",
  "timezone": "Asia/Shanghai",
  "message": "Check for new products in the database"
}
```

```
PUT    /api/p/cron/schedules/:id   — update job
DELETE /api/p/cron/schedules/:id   — delete job
```

### Wiki / Knowledge Base (`wiki` plugin)

```
GET  /api/p/wiki/list
```
List all wiki pages.
```json
{
  "pages": [
    { "id": "page-id", "title": "Competitor Analysis", "section": "topics", "updatedAt": "2026-09-07T..." }
  ]
}
```

```
GET  /api/p/wiki/read?id=page-id
```
Read a wiki page.
```json
{ "id": "page-id", "title": "...", "content": "# Markdown content...", "section": "topics" }
```

```
GET  /api/p/wiki/search?q=competitor
```
Keyword search across wiki pages.

```
GET  /api/p/wiki/semantic-search?q=how+do+we+compare+to+LAPP
```
Semantic (embedding) search. Only available if an embedding model is configured.

```
GET  /api/p/wiki/graph
```
Knowledge graph data (nodes + edges) for visualization.
```json
{ "nodes": [{ "id": "...", "label": "...", "section": "..." }], "edges": [{ "source": "...", "target": "..." }] }
```

```
GET  /api/p/wiki/status
```
Wiki indexing status (days indexed, KB pages, embedding progress).

```
POST /api/p/wiki/record
```
Record current conversation into the wiki.

### Boards / Dashboards (`board` plugin)

```
GET  /api/p/board/boards
```
List available HTML dashboards.
```json
{ "boards": ["competitor-dashboard", "sales-overview"] }
```

```
GET  /api/p/board/boards/:name/index.html
```
Serve a board's HTML. Can be loaded in an iframe.

### Data Sources (`datasource` plugin)

```
GET  /api/p/datasource/connections
```
List configured data source connections.
```json
{
  "connections": [
    { "name": "helu-graph", "type": "neo4j", "description": "HELU product knowledge graph" }
  ]
}
```

```
POST /api/p/datasource/query
Body: { "source": "helu-graph", "query": "MATCH (p:Product) RETURN p.title LIMIT 10" }
```
Execute a read query. Returns:
```json
{ "columns": ["p.title"], "rows": [{ "p.title": "JZ-500" }], "rowCount": 10 }
```

```
GET  /api/p/datasource/schema/:name
```
Inspect data source schema (tables, labels, properties).

### Custom UI Shell (`example-shell` plugin)

```
GET  /api/p/example-shell/status
```
Draft and published shell state.
```json
{
  "draft": { "exists": true, "files": [{ "path": "index.html", "size": 15000, "mtime": "..." }] },
  "published": { "exists": true, "files": [...] }
}
```

```
POST /api/p/example-shell/publish
```
Copy draft shell to tenant shared dir (goes live for all users).
```json
{ "ok": true, "files": ["index.html", "app.js"] }
```

```
GET  /api/p/example-shell/preview
```
Serve the draft `index.html` for iframe preview.

---

## Admin APIs (require admin role)

```
GET    /api/admin/tenants           — list tenants
POST   /api/admin/tenants           — create tenant
PATCH  /api/admin/tenants/:id       — update tenant
GET    /api/admin/users             — list users
POST   /api/admin/users             — create user
DELETE /api/admin/users/:id         — delete user
PATCH  /api/admin/users/:id/password — change password
PUT    /api/admin/users/:id/roles/:tenantId — set role
GET    /api/admin/models/providers  — list model providers config
GET    /api/admin/auth              — get auth config
PATCH  /api/admin/auth              — update auth config
```

---

## Usage Pattern

```javascript
// API helper with auth
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include'  // ← critical: sends session cookie
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// Check which plugins are active before using their APIs
const { plugins } = await api('GET', '/plugins');
const active = new Set(plugins.filter(p => p.state === 'active').map(p => p.id));

if (active.has('workboard')) {
  const { tasks } = await api('GET', '/p/workboard/tasks');
}
if (active.has('wiki')) {
  const { pages } = await api('GET', '/p/wiki/list');
}
if (active.has('datasource')) {
  const data = await api('POST', '/p/datasource/query', {
    source: 'my-db', query: 'SELECT * FROM users LIMIT 10'
  });
}
```
