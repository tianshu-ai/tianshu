# WorkBuddy Agent Skill

You drive the **WorkBuddy AI** desktop app (Electron) via Chrome DevTools Protocol (CDP) using Playwright on the user's bridge machine.

## Prerequisites

WorkBuddy must be running with `--remote-debugging-port=9229`.

### Check if WorkBuddy is running with CDP

```bash
curl -s http://127.0.0.1:9229/json/version
```

### Start WorkBuddy with debug port

```bash
# Kill existing instance
pkill -f "WorkBuddy AI.app/Contents/MacOS/Electron" 2>/dev/null
sleep 3

# Start with CDP port
nohup '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron' --remote-debugging-port=9229 > /dev/null 2>&1 &
sleep 6

# Verify
curl -s http://127.0.0.1:9229/json/version
```

### Restart WorkBuddy (if stuck or unresponsive)

```bash
pkill -9 -f "WorkBuddy AI.app" 2>/dev/null
sleep 3
nohup '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron' --remote-debugging-port=9229 > /dev/null 2>&1 &
sleep 6
```

## Playwright CDP Connection

Playwright is available in the bridge's node_modules. Always set NODE_PATH or symlink:

```bash
# Ensure node_modules symlink
ln -sf ~/.tianshu-launcher/overrides/bridge/node_modules /tmp/wb-node_modules 2>/dev/null

# Or use NODE_PATH (CJS only, not ESM)
```

### Sample: Connect and screenshot

```javascript
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://localhost:9229");
const page = browser.contexts()[0]?.pages()[0];
await page.screenshot({ path: "/tmp/wb-screenshot.png" });
await browser.close();
```

## How to Send a Message

The WorkBuddy UI changes between versions. **Always screenshot first** to understand the current layout before interacting.

### General approach:

1. **Screenshot** the page to see the current UI state
2. **Find the input area** — look for `[contenteditable="true"]` or `textarea`
3. **Click** on the input area (use coordinates from the screenshot if selectors fail)
4. **Type** the message using `page.keyboard.type(message)`
   - Newlines in `keyboard.type()` send as Shift+Enter (safe in WorkBuddy)
5. **Find and click the send button** — look for a button near the input with send/arrow icon
6. **Wait and check** — screenshot again to verify the message was sent

### Sample: Send a message

```javascript
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://localhost:9229");
const page = browser.contexts()[0]?.pages()[0];

// Screenshot first to understand layout
await page.screenshot({ path: "/tmp/wb-before.png" });

// Find and click input
const editor = await page.$('[contenteditable="true"]');
await editor.click();
await page.keyboard.type("Your message here");

// Find send button (adapt selector to current UI)
// Common patterns: button with aria-label="发送", or the rightmost button near input
const sendBtn = await page.$('button[aria-label="发送"]:not([disabled])');
if (sendBtn) await sendBtn.click();

// Verify
await page.waitForTimeout(2000);
await page.screenshot({ path: "/tmp/wb-after.png" });
await browser.close();
```

### Sample: Create new conversation then send

```javascript
// Click "新建任务" in sidebar
const newBtn = await page.$('text=新建任务');
if (newBtn) { await newBtn.click(); await page.waitForTimeout(1000); }

// Then type and send as above
```

## How to Check Completion

After sending a task, periodically screenshot and examine the page to determine if WorkBuddy has finished:

- Look for "已完成" text indicator
- Check if there's still a loading/spinner/typing indicator
- Read the agent's response text

### Sample: Check status

```javascript
const state = await page.evaluate(() => {
  const text = document.body.innerText;
  return {
    isComplete: text.includes("已完成"),
    isRunning: text.includes("准备中") || text.includes("生成回复中") || text.includes("执行中"),
    // Get last ~2000 chars of visible text for context
    pageText: text.slice(-2000),
  };
});
```

## How to Extract Conversation History

```javascript
const history = await page.evaluate(() => {
  // Adapt selectors to current UI version
  const messages = [];
  // User messages often have class containing "self" or "user"
  // Bot messages often have class containing "bot" or "agent"
  const allText = document.querySelector('[class*="message-list"]')?.innerText || document.body.innerText;
  return allText.slice(-5000); // Last 5000 chars
});
```

## Important Notes

- **Always screenshot before acting** — the UI can change between WorkBuddy versions
- **If selectors fail, use coordinates** from the screenshot
- **Don't assume specific class names** — probe the page first
- **WorkBuddy takes time** for complex tasks — check periodically, don't poll too fast
- **Multiple retries create multiple conversations** — always verify you're in the right conversation
- **ESM scripts need node_modules** — symlink or run from a directory with playwright installed

## Writing Scripts

When you write a `.mjs` script to run on the bridge:
1. Save it to `/tmp/wb-task-<id>.mjs`
2. Make sure playwright is accessible (symlink node_modules or use a dir that has it)
3. Run via `bridge_exec`: `cd <dir-with-node_modules> && node /tmp/wb-task-<id>.mjs`
4. Output results as JSON to stdout
5. Clean up temp files when done

## Error Recovery

- **CDP connection refused**: WorkBuddy not running or wrong port → restart with debug port
- **No page found**: WorkBuddy window may be minimized or crashed → restart
- **Selectors not matching**: UI updated → screenshot and adapt
- **Message not sent**: Input not focused → try clicking coordinates directly
- **Stuck/timeout**: WorkBuddy may be hung → kill and restart
