#!/usr/bin/env node
// wb-history.mjs — Extract conversation history from WorkBuddy AI via CDP.
// Usage: node wb-history.mjs [--port 9229]
// Output: JSON { ok, messages: [{ role, text, timestamp? }], error? }

import { chromium } from "playwright";

const args = process.argv.slice(2);
let port = 9229;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) { port = Number(args[++i]); continue; }
}

let browser;
try {
  browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error("no WorkBuddy page found");

  const messages = await page.evaluate(() => {
    const result = [];
    const listContent = document.querySelector(
      ".cr-message-list__content.cr-message-list__content--revealed",
    );
    if (!listContent) return result;

    // Walk direct children of the message list content
    for (const child of listContent.children) {
      // User message
      const selfMsg = child.querySelector(".cr-self-message");
      if (selfMsg) {
        const bubble = selfMsg.querySelector(".cr-self-bubble .cr-user-content");
        const text = bubble?.innerText?.trim() || selfMsg.innerText?.trim() || "";
        if (text) {
          // Try to find timestamp
          const timeEl = child.querySelector("[class*='time'], [class*='timestamp']");
          result.push({
            role: "user",
            text,
            timestamp: timeEl?.innerText?.trim() || null,
          });
        }
        continue;
      }

      // Bot/agent message
      const agentContent = child.querySelector(".cr-agent__content");
      if (agentContent) {
        // Extract main response text
        const markdownEl = agentContent.querySelector("[class*='markdown']");
        const text = markdownEl?.innerText?.trim() || agentContent.innerText?.trim() || "";

        // Extract tool calls / collapsible sections
        const collapses = child.querySelectorAll(".cr-collapse__content");
        const toolCalls = Array.from(collapses).map((c) => c.innerText?.trim()).filter(Boolean);

        // Check for status (已完成, duration, model)
        const statusEl = child.querySelector("[class*='status'], [class*='完成']");
        const status = statusEl?.innerText?.trim() || null;

        const timeEl = child.querySelector("[class*='time'], [class*='timestamp']");

        if (text || toolCalls.length > 0) {
          result.push({
            role: "assistant",
            text,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            status,
            timestamp: timeEl?.innerText?.trim() || null,
          });
        }
        continue;
      }
    }
    return result;
  });

  console.log(JSON.stringify({ ok: true, messages, count: messages.length }));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
} finally {
  if (browser) await browser.close().catch(() => {});
}
