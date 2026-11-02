# Joule Work Integration

Control SAP Joule Work Desktop (Electron app) on the bridge machine via Chrome DevTools Protocol (CDP).

## Prerequisites

Joule Work must be running with remote debugging enabled on port **9333**.

### Check if Joule is running with CDP

```bash
curl -s http://localhost:9333/json | head -5
```

### Start Joule with debug port

```bash
pkill -f "Joule Work" 2>/dev/null; sleep 2
open -a "Joule Work" --args --remote-debugging-port=9333 --remote-allow-origins="*"
```

Wait 5s, then verify: `curl -s http://localhost:9333/json | head -5`

### Restart Joule (if stuck or unresponsive)

```bash
pkill -9 -f "Joule Work" 2>/dev/null; sleep 3
open -a "Joule Work" --args --remote-debugging-port=9333 --remote-allow-origins="*"
sleep 6
```

## Connection

All interaction uses **Python + websocket-client** through `bridge_exec`. Install once if needed:

```bash
python3 -m pip install websocket-client --break-system-packages
```

### Get WebSocket URL (do this first every time)

```python
import urllib.request, json
resp = urllib.request.urlopen("http://localhost:9333/json")
targets = json.loads(resp.read())
ws_url = targets[0]["webSocketDebuggerUrl"]
```

Page id changes on every Joule restart — **never hardcode** `ws_url`.

## Before Sending: Check for Prior Attempt

You may be resuming a task that was already sent to Joule in a previous attempt (e.g. after a connection drop or worker restart). **Always check Joule's current state first**:

1. Connect via CDP, take a text snapshot of the page
2. Check if Joule already has a conversation matching the task content
3. If yes and Joule is processing or has finished → skip sending, go directly to checking/extracting results
4. If no matching conversation → proceed to send

This prevents duplicate conversations from retried tasks.

## Operations

### Send a message to Joule

The textarea is a React controlled component. Must use `nativeInputValueSetter` + dispatch `input` event — plain `.value =` is silently ignored by React.

```python
# Step 1: Type message (React-safe)
ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
    "expression": """
    (() => {
        const ta = document.querySelector('textarea[placeholder="Message Joule..."]');
        if (!ta) return 'ERROR: textarea not found';
        ta.focus();
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        setter.call(ta, `YOUR_MESSAGE_HERE`);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return 'typed';
    })()
    """
}}))

# Step 2: Press Enter to send (separate call, >=500ms after step 1)
ws.send(json.dumps({"id": 2, "method": "Runtime.evaluate", "params": {
    "expression": """
    (() => {
        const ta = document.querySelector('textarea[placeholder="Message Joule..."]');
        if (!ta) return 'ERROR: no textarea';
        ta.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
        }));
        return 'sent';
    })()
    """
}}))
```

**Critical pitfalls:**
- Do NOT use `ta.value = "..."` — React won't see it, send button stays disabled.
- Do NOT use `dispatchEvent(new Event('change'))` alone — must dispatch `input`.
- Step 1 and Step 2 must be **separate CDP calls** with ~500ms gap.

### Wait for reply — text snapshot (NOT screenshot)

**Always use text snapshot (`document.body.innerText`) to read Joule replies, not screenshots.** Screenshots only capture the visible viewport — long replies with tables, tool results, and multi-section answers get truncated. Text snapshot captures everything.

Joule has three busy states:
- `Thinking...` — initial LLM processing
- `Running ...` — executing MCP tools (e.g. "Running search skills", "Running 2 tools")
- Streaming — text length still growing

The correct wait logic must check ALL three:

```python
import time
last_len = 0
stable = 0
for i in range(80):  # up to 240 seconds
    time.sleep(3)
    ws.send(json.dumps({"id": 100+i, "method": "Runtime.evaluate", "params": {
        "expression": """
        (() => {
            const text = document.body.innerText;
            const busy = text.includes('Thinking...') || text.includes('Running');
            return JSON.stringify({busy, len: text.length});
        })()
        """
    }}))
    val = json.loads(json.loads(ws.recv())["result"]["result"]["value"])
    if not val["busy"] and val["len"] == last_len:
        stable += 1
        if stable >= 3:  # stable for 9 seconds
            break
    else:
        stable = 0
    last_len = val["len"]
```

**Why 3 stable checks?** Joule pauses between tool calls — text stops growing briefly while the next tool starts. A single "not busy" check causes premature reads with partial results.

### Read the full reply (text snapshot)

```python
ws.send(json.dumps({"id": 200, "method": "Runtime.evaluate", "params": {
    "expression": "document.body.innerText"
}}))
full = json.loads(ws.recv())["result"]["result"]["value"]

# Extract reply: between user message and input placeholder
user_msg = "YOUR_ORIGINAL_MESSAGE"
idx = full.find(user_msg[:40])  # prefix to avoid escaping issues
end = full.rfind("Message Joule...")  # rfind = last occurrence
if idx > -1 and end > -1:
    reply = full[idx + len(user_msg):end].strip()
```

`full` includes sidebar text (conversation list, nav items). Reply is always between user message and final "Message Joule..." placeholder.

### Take screenshot (visual verification only)

Screenshots are supplementary — use for visual checks, NOT for reading content.

```python
ws.send(json.dumps({"id": 50, "method": "Page.captureScreenshot",
    "params": {"format": "png"}}))
r = json.loads(ws.recv())
import base64
img = base64.b64decode(r["result"]["data"])
with open("/tmp/joule-screenshot.png", "wb") as f:
    f.write(img)
```

### Handle "Activate Connectors" permission dialog

First MCP activation pops "Activate Connectors" dialog with Allow/Decline. Auto-approve:

```python
ws.send(json.dumps({"id": 10, "method": "Runtime.evaluate", "params": {
    "expression": """
    (() => {
        const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Allow');
        if (btn) { btn.click(); return 'clicked Allow'; }
        return 'no dialog';
    })()
    """
}}))
```

Check for this after sending any message that triggers MCP tool use.

### List / click conversations

```python
# List
ws.send(json.dumps({"id": 10, "method": "Runtime.evaluate", "params": {
    "expression": """
    (() => {
        const items = document.querySelectorAll('[class*="navItem"], [class*="conversation"]');
        return JSON.stringify([...items].map(el => el.textContent?.trim()).filter(t => t && t.length > 2 && t.length < 100));
    })()
    """
}}))

# Click specific conversation
ws.send(json.dumps({"id": 11, "method": "Runtime.evaluate", "params": {
    "expression": """
    (() => {
        const target = 'CONVERSATION_TITLE_HERE';
        for (const el of document.querySelectorAll('button, [role=button], a')) {
            if (el.textContent?.trim().includes(target)) { el.click(); return 'clicked'; }
        }
        return 'not found';
    })()
    """
}}))
```

## Complete send-and-receive template

Base for all Joule interactions. Execute with `bridge_exec` + `timeout_ms: 300000`.

```python
import websocket, json, base64, urllib.request, time

# Connect
resp = urllib.request.urlopen("http://localhost:9333/json")
targets = json.loads(resp.read())
ws_url = targets[0]["webSocketDebuggerUrl"]
ws = websocket.create_connection(ws_url, timeout=15)

MESSAGE = "your message here"

# Type (React-safe)
ws.send(json.dumps({"id":1,"method":"Runtime.evaluate","params":{"expression":f"""
(() => {{
    const ta = document.querySelector('textarea[placeholder="Message Joule..."]');
    if(!ta) return 'ERROR';
    ta.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta, `{MESSAGE}`);
    ta.dispatchEvent(new Event('input',{{bubbles:true}}));
    return 'typed';
}})()
"""}}))
print("Type:", json.loads(ws.recv())["result"]["result"]["value"])
time.sleep(0.8)

# Send
ws.send(json.dumps({"id":2,"method":"Runtime.evaluate","params":{"expression":"""
(() => {
    const ta = document.querySelector('textarea[placeholder="Message Joule..."]');
    ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
    return 'sent';
})()
"""}}))
print("Send:", json.loads(ws.recv())["result"]["result"]["value"])

# Wait (busy + stability triple-check)
last_len = 0
stable = 0
for i in range(80):
    time.sleep(3)
    ws.send(json.dumps({"id":100+i,"method":"Runtime.evaluate","params":{"expression":"""
    (() => {
        const text = document.body.innerText;
        const busy = text.includes('Thinking...') || text.includes('Running');
        return JSON.stringify({busy, len: text.length});
    })()
    """}}))
    val = json.loads(json.loads(ws.recv())["result"]["result"]["value"])
    if not val["busy"] and val["len"] == last_len:
        stable += 1
        if stable >= 3:
            print(f"Done after {(i+1)*3}s")
            break
    else:
        stable = 0
        if i % 5 == 0:
            print(f"  processing... {(i+1)*3}s ({val['len']} chars)")
    last_len = val["len"]

# Read full reply via text snapshot
ws.send(json.dumps({"id":200,"method":"Runtime.evaluate","params":{
    "expression":"document.body.innerText"
}}))
full = json.loads(ws.recv())["result"]["result"]["value"]

idx = full.find(MESSAGE[:40])
end = full.rfind("Message Joule...")
if idx > -1 and end > -1:
    reply = full[idx + len(MESSAGE):end].strip()
else:
    reply = full[-3000:]
print("REPLY:", reply)

ws.close()
```

## Task Completion

After Joule finishes, you MUST:

1. **Extract the full response** via text snapshot (`document.body.innerText`), NOT screenshot
2. **Include the response in task_complete** — the `resultSummary` parameter should contain Joule's actual output
3. If Joule produced files, render_ui cards, or Space updates, mention them in the summary

The person who created the task expects to see Joule's actual answer in the task result.

## When to use Joule (capabilities Tianshu does NOT have)

Delegate to Joule when the user needs:

| Capability | Joule tools |
|------------|-------------|
| **Outlook email** | `list_emails`, `search_emails`, `get_email`, `get_attachment_content` |
| **Outlook calendar** | `list_calendar_events`, `get_calendar_event`, `search_calendar_events` |
| **Spaces (dashboards)** | `create_space`, `add_card_to_space`, etc. |
| **Skill marketplace** | `create_skill`, `install_asset`, `activate_mcp_servers` |
| **SAP internal knowledge** | `search_internal_sap_knowledge`, `list_available_data_sources` |
| **JIRA** | JIRA MCP connector |
| **render_ui cards** | `render_ui` (KPI, table, chart, detail, list) |

Do NOT delegate web search, code execution, file ops, or task management — Tianshu is better at those.

## Error Recovery

- **CDP connection refused**: Joule not running or wrong port → restart with debug port 9333
- **No page found**: Joule window may be minimized or crashed → restart
- **`textarea not found`**: Non-chat page → click "Conversations" nav item first
- **Message typed but not sent**: React ignored value → must use `nativeInputValueSetter`
- **Send button stays disabled**: No `input` event → dispatch `new Event('input', {bubbles:true})`
- **Reply truncated**: Used screenshot to read → use text snapshot instead
- **Permission dialog blocks**: First MCP activation → auto-click "Allow" button
- **`websocket` not found**: `pip install websocket-client --break-system-packages`
- **Page id changed**: Joule restarted → re-fetch from `http://localhost:9333/json`

### Connection drop / retry

If the bridge connection drops during a send, **before retrying, check Joule's state first** via text snapshot. If Joule shows the message and is already processing it, do NOT resend — just proceed to the wait/check phase.
