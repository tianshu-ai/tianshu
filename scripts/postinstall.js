#!/usr/bin/env node
// Thin postinstall wrapper that runs patch-openai-sdk.js if it exists.
// This file is always included in the npm package (via "files" in
// package.json), so `node scripts/postinstall.js` never fails with
// MODULE_NOT_FOUND. The actual patch script may be absent in older
// published versions — that's fine, we just skip it.
const fs = require('fs');
const path = require('path');
const target = path.join(__dirname, 'patch-openai-sdk.js');
if (fs.existsSync(target)) {
  require(target);
} else {
  console.log('[postinstall] patch-openai-sdk.js not found, skipping');
}
