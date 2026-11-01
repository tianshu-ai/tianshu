#!/usr/bin/env node
// wb-send.mjs — Send a message to WorkBuddy AI via CDP. Returns immediately after sending.
// Usage: node wb-send.mjs [--port 9229] [--new] "message text"
// Output: JSON { ok, error? }

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
  console.log(JSON.stringify({ ok: false, error: "usage: node wb-send.mjs [--port 9229] [--new] 'message'" }));
  process.exit(1);
}

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

  await page.waitForTimeout(500);
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
} finally {
  if (browser) await browser.close().catch(() => {});
}
