#!/usr/bin/env node
/**
 * postinstall patch for openai SDK + pi-ai reasoning summary support.
 *
 * 1. openai SDK ResponseStream: _prepareOutputEvent throws for reasoning
 *    summary events → return event as-is instead of throwing.
 * 2. pi-ai openai-responses-shared: add debug logging to output_item.done
 *    to trace reasoning summary processing.
 */
const fs = require('fs');
const path = require('path');

const MARKER = '/* patched:reasoning_summary */';

// ── Patch 1: openai SDK ResponseStream ──
const sdkTarget = path.join(
  __dirname, '..', 'node_modules', 'openai', 'lib', 'responses', 'ResponseStream.js'
);

if (fs.existsSync(sdkTarget)) {
  let src = fs.readFileSync(sdkTarget, 'utf8');
  if (!src.includes(MARKER)) {
    const oldElse = `const existing = tslib_1.__classPrivateFieldGet(this, _ResponseStream_outputPositions, "f").get(index);
            if (existing === undefined) {
                throw new error_1.OpenAIError(\`missing output at index \${index}\`);
            }
            position = existing;`;
    const newElse = `const existing = tslib_1.__classPrivateFieldGet(this, _ResponseStream_outputPositions, "f").get(index);
            if (existing === undefined) {
                return event; ${MARKER}
            }
            position = existing;`;
    if (src.includes(oldElse)) {
      src = src.replace(oldElse, newElse);
      fs.writeFileSync(sdkTarget, src, 'utf8');
      console.log('[patch-openai-sdk] patched ResponseStream.js');
    } else {
      console.log('[patch-openai-sdk] ResponseStream pattern not found, skipping');
    }
  } else {
    console.log('[patch-openai-sdk] ResponseStream already patched');
  }
} else {
  console.log('[patch-openai-sdk] ResponseStream.js not found, skipping');
}

// ── Patch 2: pi-ai openai-responses-shared debug logging ──
const piaiTarget = path.join(
  __dirname, '..', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-responses-shared.js'
);

if (fs.existsSync(piaiTarget)) {
  let src = fs.readFileSync(piaiTarget, 'utf8');
  const logMarker = '/* patched:debug_output_item_done */';
  if (!src.includes(logMarker)) {
    const oldDone = 'else if (event.type === "response.output_item.done") {';
    const newDone = `else if (event.type === "response.output_item.done") { ${logMarker} console.log("[debug-piai] output_item.done item.type=" + event.item?.type + " summary_len=" + (event.item?.summary?.length ?? 0));`;
    if (src.includes(oldDone)) {
      src = src.replace(oldDone, newDone);

      // Add logging for the actual request params sent to OpenAI
      const oldCreate = 'const { data: openaiStream, response } = await retryProviderRequest';
      const newCreate = 'console.log("[debug-piai] create FULL params=" + JSON.stringify({reasoning: params.reasoning, include: params.include, store: params.store, stream: params.stream, model: params.model, tools_count: params.tools?.length})); const { data: openaiStream, response } = await retryProviderRequest';
      const createTarget = path.join(
        __dirname, '..', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-responses.js'
      );
      if (fs.existsSync(createTarget)) {
        let createSrc = fs.readFileSync(createTarget, 'utf8');
        if (!createSrc.includes('[debug-piai] create params.reasoning=')) {
          if (createSrc.includes(oldCreate)) {
            createSrc = createSrc.replace(oldCreate, newCreate);
            fs.writeFileSync(createTarget, createSrc, 'utf8');
            console.log('[patch-openai-sdk] patched pi-ai openai-responses.js with params logging');
          }
        }
      }

      // Also add logging for all event types in the for-await loop
      const oldForAwait = 'for await (const event of openaiStream) {';
      const logForAwait = 'for await (const event of openaiStream) { console.log("[debug-piai] sse event.type=" + event.type);';
      if (src.includes(oldForAwait) && !src.includes('[debug-piai] sse event.type=')) {
        src = src.replace(oldForAwait, logForAwait);
      }

      fs.writeFileSync(piaiTarget, src, 'utf8');
      console.log('[patch-openai-sdk] patched pi-ai openai-responses-shared.js with debug logging');
    } else {
      console.log('[patch-openai-sdk] pi-ai pattern not found, skipping');
    }
  } else {
    console.log('[patch-openai-sdk] pi-ai already patched');
  }
} else {
  console.log('[patch-openai-sdk] pi-ai openai-responses-shared.js not found, skipping');
}
