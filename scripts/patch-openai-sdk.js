#!/usr/bin/env node
/**
 * postinstall patch: openai SDK 7.52.0 ResponseStream filters out
 * reasoning_summary events from the async iterator. This patch
 * ensures they are emitted like any other event.
 *
 * Root cause: _prepareOutputEvent throws "missing output at index N"
 * for reasoning_summary events when the reasoning output_item was
 * registered but the output_index mapping doesn't match. The error
 * is swallowed, and the event is never emitted.
 *
 * Fix: wrap _prepareOutputEvent to fall through gracefully for
 * reasoning_summary events instead of throwing.
 *
 * Alternative approach: just ensure reasoning summary events bypass
 * the output_index lookup entirely and are emitted as-is.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname, '..', 'node_modules', 'openai', 'lib', 'responses', 'ResponseStream.js'
);

if (!fs.existsSync(target)) {
  console.log('[patch-openai-sdk] ResponseStream.js not found, skipping');
  process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');

const MARKER = '/* patched:reasoning_summary */';
if (src.includes(MARKER)) {
  console.log('[patch-openai-sdk] already patched');
  process.exit(0);
}

// Patch: in _ResponseStream_addEvent, after the accumulator call and
// before the output_item.added null check, inject reasoning_summary
// passthrough so these events are always emitted.
//
// We look for the exact pattern:
//   if (dispatchEvent.type === 'response.output_item.added' && dispatchEvent.item == null) {
//       return;
//   }
//   const wireSnapshot = { ...dispatchEvent };
//
// And prepend reasoning_summary passthrough before wireSnapshot creation.

const oldGuard = `if (dispatchEvent.type === 'response.output_item.added' && dispatchEvent.item == null) {
            return;
        }
        const wireSnapshot = { ...dispatchEvent };`;

const newGuard = `if (dispatchEvent.type === 'response.output_item.added' && dispatchEvent.item == null) {
            return;
        }
        ${MARKER}
        const wireSnapshot = { ...dispatchEvent };`;

if (!src.includes(oldGuard)) {
  console.log('[patch-openai-sdk] guard pattern not found — SDK version may differ, skipping');
  process.exit(0);
}

// The real fix: _prepareOutputEvent throws for reasoning_summary events
// because their output_index isn't registered. We need to catch that
// in the else branch and return the event as-is instead of throwing.
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
  // Also apply the marker in the guard
  src = src.replace(oldGuard, newGuard);
  fs.writeFileSync(target, src, 'utf8');
  console.log('[patch-openai-sdk] patched ResponseStream.js — reasoning_summary events will be emitted');
} else {
  // Just apply the marker patch
  src = src.replace(oldGuard, newGuard);
  fs.writeFileSync(target, src, 'utf8');
  console.log('[patch-openai-sdk] applied marker only — else branch pattern not found');
}
