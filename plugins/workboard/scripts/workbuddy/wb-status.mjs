#!/usr/bin/env node
// wb-status.mjs — Get current WorkBuddy conversation state via CDP.
// Usage: node wb-status.mjs [--port 9229]
// Output: JSON { ok, status, lastMessage, isComplete, pageText, error? }

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

  const state = await page.evaluate(() => {
    const listContent = document.querySelector(
      ".cr-message-list__content.cr-message-list__content--revealed",
    );
    if (!listContent) return { status: "no_conversation", lastMessage: "", pageText: "" };

    const fullText = listContent.innerText || "";

    // Check for completion indicators
    const isComplete = fullText.includes("已完成");

    // Check for in-progress indicators
    const isRunning = fullText.includes("准备中") ||
      fullText.includes("执行中") ||
      fullText.includes("思考中") ||
      fullText.includes("搜索中") ||
      !!document.querySelector('[class*="loading"], [class*="spinner"], [class*="typing"]');

    // Get the last agent message
    const agentBlocks = document.querySelectorAll(".cr-agent__content");
    let lastAgentText = "";
    if (agentBlocks.length > 0) {
      const last = agentBlocks[agentBlocks.length - 1];
      const md = last.querySelector("[class*='markdown']");
      lastAgentText = (md || last).innerText?.trim() || "";
    }

    // Get the last user message
    const userMsgs = document.querySelectorAll(".cr-self-message .cr-user-content");
    let lastUserText = "";
    if (userMsgs.length > 0) {
      lastUserText = userMsgs[userMsgs.length - 1].innerText?.trim() || "";
    }

    // Get status text (duration, model, etc.)
    let statusText = "";
    const statusEls = listContent.querySelectorAll("[class*='status'], [class*='duration'], [class*='meta']");
    for (const el of statusEls) {
      const t = el.innerText?.trim();
      if (t && (t.includes("已完成") || t.includes("s") || t.includes("Auto"))) {
        statusText = t;
        break;
      }
    }

    return {
      status: isComplete ? "complete" : isRunning ? "running" : "idle",
      isComplete,
      isRunning,
      lastAgentText: lastAgentText.slice(0, 2000),
      lastUserText: lastUserText.slice(0, 500),
      statusText,
      // Truncate full page text to avoid huge output
      pageText: fullText.slice(-3000),
    };
  });

  console.log(JSON.stringify({ ok: true, ...state }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
} finally {
  if (browser) await browser.close().catch(() => {});
}
