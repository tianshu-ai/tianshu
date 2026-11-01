#!/usr/bin/env node
// wb-send.mjs — Send a message to WorkBuddy AI via CDP and wait for response.
// Usage: node wb-send.mjs [--port 9229] [--new] "message text"
// Output: JSON { ok, response, duration_ms, error? }

import { chromium } from "playwright";

const args = process.argv.slice(2);
let port = 9229;
let newTask = false;
let message = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && args[i + 1]) { port = Number(args[++i]); continue; }
  if (args[i] === "--new") { newTask = true; continue; }
  message = args[i];
}

if (!message) {
  console.error(JSON.stringify({ ok: false, error: "usage: node wb-send.mjs [--port 9229] [--new] 'message'" }));
  process.exit(1);
}

const TIMEOUT_MS = 300_000; // 5 min max wait
const POLL_MS = 2000;
const STABLE_CHECKS = 3; // response must be stable for 3 consecutive polls

let browser;
try {
  browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error("no WorkBuddy page found");

  // Optionally create a new task/conversation
  if (newTask) {
    const btn = await page.$("text=新建任务");
    if (btn) {
      await btn.click();
      await page.waitForTimeout(1000);
    }
  }

  // Count existing bot messages before sending
  const beforeCount = await page.$$eval(
    ".cr-message-list__content .cr-agent__content",
    (els) => els.length,
  );

  // Focus input and type message
  const editor = await page.$('.cr-input-editor-host [contenteditable="true"]');
  if (!editor) throw new Error("input editor not found");
  await editor.click();
  await editor.evaluate((el) => { el.innerText = ""; });
  await page.keyboard.type(message, { delay: 10 });
  await page.waitForTimeout(300);

  // Click send button or press Enter
  const sendBtn = await page.$('button[aria-label="发送"]:not([disabled])');
  if (sendBtn) {
    await sendBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  // Wait for bot response to appear and stabilize
  const t0 = Date.now();
  let lastText = "";
  let stableCount = 0;

  while (Date.now() - t0 < TIMEOUT_MS) {
    await page.waitForTimeout(POLL_MS);

    // Check for "已完成" indicator on the latest agent block
    const result = await page.evaluate((prevCount) => {
      const blocks = document.querySelectorAll(
        ".cr-message-list__content .cr-agent__content, .cr-message-list__content [class*='cr-bot']",
      );
      // Only look at blocks after the ones that existed before we sent
      const newBlocks = Array.from(blocks).slice(prevCount);
      if (newBlocks.length === 0) return { text: "", done: false };

      const latest = newBlocks[newBlocks.length - 1];
      // The entire message list item that contains this block
      const listItem = latest.closest(".cr-message-list__content") || latest.parentElement;
      const fullText = listItem?.innerText || latest.innerText || "";

      // WorkBuddy shows "已完成" when the agent finishes
      const done = fullText.includes("已完成");

      // Extract just the response text (skip metadata)
      const responseEl = latest.querySelector("[class*='markdown'], [class*='content']") || latest;
      const responseText = responseEl.innerText?.trim() || "";

      return { text: responseText, done, fullText: fullText.slice(0, 500) };
    }, beforeCount);

    if (result.done && result.text) {
      console.log(JSON.stringify({
        ok: true,
        response: result.text,
        duration_ms: Date.now() - t0,
      }));
      process.exit(0);
    }

    // Fallback: check text stability (in case "已完成" selector doesn't match)
    if (result.text && result.text.length > 0) {
      if (result.text === lastText) {
        stableCount++;
        if (stableCount >= STABLE_CHECKS) {
          console.log(JSON.stringify({
            ok: true,
            response: result.text,
            duration_ms: Date.now() - t0,
            note: "stabilized without 已完成 indicator",
          }));
          process.exit(0);
        }
      } else {
        stableCount = 0;
      }
    }
    lastText = result.text;
  }

  console.log(JSON.stringify({ ok: false, error: "timeout", partial: lastText, duration_ms: Date.now() - t0 }));
  process.exit(1);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
} finally {
  if (browser) await browser.close().catch(() => {});
}
