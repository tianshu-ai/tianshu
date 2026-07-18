#!/usr/bin/env node
// Standalone embedding-model probe for the wiki plugin.
//
// Reads the embedding model configured in ~/.tianshu/config.json
// (Settings → Models → a `mode: "embedding"` model) exactly the way the
// server resolves it (env placeholders expanded), then sends ONE real
// embedding request and prints request/response so you can see whether
// the model works and, if not, WHY (auth scheme, endpoint, body shape).
//
// Usage:
//   node scripts/test-embedding.mjs                # first embedding model
//   node scripts/test-embedding.mjs <provider/model># a specific one
//   TIANSHU_HOME=/path node scripts/test-embedding.mjs
//
// Nothing is written; this only reads config + makes one HTTP call.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.TIANSHU_HOME || path.join(os.homedir(), ".tianshu");
const CONFIG = path.join(HOME, "config.json");

function expandEnv(v) {
  if (!v) return v;
  return v.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, name, fb) =>
    process.env[name] ?? fb ?? "",
  );
}
function keyHint(k) {
  if (!k) return "MISSING (none configured)";
  return `present, ${k.length} chars, starts "${k.slice(0, 4)}…", ends "…${k.slice(-4)}"`;
}

function loadEmbeddingModels() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const providers = cfg.models?.providers ?? {};
  const out = [];
  for (const [pid, p] of Object.entries(providers)) {
    for (const m of p.models ?? []) {
      if (m.mode !== "embedding") continue;
      out.push({
        id: `${pid}/${m.id}`,
        providerId: pid,
        model: m.id,
        baseUrl: p.baseUrl ?? "",
        api:
          p.api ??
          ({ openai: "openai-completions", google: "google-generative-ai", anthropic: "anthropic-messages" }[pid]) ??
          "openai-completions",
        apiKey: expandEnv(p.apiKey) ?? "",
        dimensions: m.dimensions,
      });
    }
  }
  return out;
}

async function embedOpenAI(cfg, input) {
  const base = (cfg.baseUrl || "").replace(/\/$/, "");
  const url = `${base}/embeddings`;
  const body = { model: cfg.model, input: [input] };
  if (cfg.dimensions) body.dimensions = cfg.dimensions;
  console.log(`\n→ POST ${url}`);
  console.log(`  Authorization: Bearer ${cfg.apiKey ? "<key>" : "(none)"}`);
  console.log(`  body: ${JSON.stringify(body).slice(0, 200)}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res;
}

async function embedGemini(cfg, input) {
  let base = (cfg.baseUrl || "").replace(/\/$/, "");
  if (!/\/v\d/.test(base)) base = `${base}/v1beta`;
  const modelId = String(cfg.model).replace(/^models\//, "");
  const url = `${base}/models/${modelId}:embedContent`;
  const body = {
    instances: [
      {
        content: input,
        task_type: "RETRIEVAL_DOCUMENT",
        ...(cfg.dimensions ? { output_dimensionality: cfg.dimensions } : {}),
      },
    ],
  };
  console.log(`\n→ POST ${url}`);
  console.log(`  Authorization: Bearer ${cfg.apiKey ? "<key>" : "(none)"}`);
  console.log(`  body: ${JSON.stringify(body).slice(0, 200)}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res;
}

function findVectorLen(json) {
  const asVals = (o) => {
    if (Array.isArray(o) && typeof o[0] === "number") return o.length;
    if (o && typeof o === "object") {
      if (Array.isArray(o.values) && typeof o.values[0] === "number") return o.values.length;
      if (o.embedding) return asVals(o.embedding);
    }
    return null;
  };
  if (Array.isArray(json.predictions)) {
    for (const p of json.predictions) {
      const n = asVals(p.embeddings ?? p);
      if (n) return n;
    }
  }
  if (Array.isArray(json.embeddings)) {
    const n = asVals(json.embeddings[0]);
    if (n) return n;
  }
  if (Array.isArray(json.data)) {
    const n = asVals(json.data[0]);
    if (n) return n;
  }
  const single = asVals(json.embedding);
  if (single) return single;
  return null;
}

async function main() {
  if (!fs.existsSync(CONFIG)) {
    console.error(`No config at ${CONFIG}. Set TIANSHU_HOME to your data dir.`);
    process.exit(2);
  }
  const models = loadEmbeddingModels();
  if (models.length === 0) {
    console.error(
      "No embedding models found. In Settings → Models, add a model with mode=embedding.",
    );
    process.exit(2);
  }
  const want = process.argv[2];
  const cfg = want ? models.find((m) => m.id === want) : models[0];
  if (!cfg) {
    console.error(`Model "${want}" not found. Available:`);
    for (const m of models) console.error(`  - ${m.id}`);
    process.exit(2);
  }

  console.log("=== Embedding model under test ===");
  console.log(`  id:        ${cfg.id}`);
  console.log(`  api:       ${cfg.api}`);
  console.log(`  baseUrl:   ${cfg.baseUrl}`);
  console.log(`  model:     ${cfg.model}`);
  console.log(`  dimensions:${cfg.dimensions ?? "(default)"}`);
  console.log(`  apiKey:    ${keyHint(cfg.apiKey)}`);

  const input = "This is a wiki embedding connectivity test.";
  let res;
  try {
    res =
      cfg.api === "google-generative-ai"
        ? await embedGemini(cfg, input)
        : await embedOpenAI(cfg, input);
  } catch (err) {
    console.error(`\n✗ Network/connection error: ${err.message}`);
    console.error("  → Is the baseUrl reachable from this host? Proxy running?");
    process.exit(1);
  }

  const text = await res.text();
  console.log(`\n← HTTP ${res.status} ${res.statusText}`);
  if (!res.ok) {
    console.log(`  body: ${text.slice(0, 500)}`);
    console.error(`\n✗ FAILED (${res.status}).`);
    if (res.status === 401 || res.status === 403) {
      console.error("  → Auth rejected. The API key is wrong for this proxy,");
      console.error("    or the proxy wants a different header/scheme.");
      console.error("    Compare with the key your WORKING chat model uses.");
    } else if (res.status === 404) {
      console.error("  → Endpoint not found. baseUrl/version/model path mismatch.");
    }
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`\n✗ Response was not JSON:\n${text.slice(0, 300)}`);
    process.exit(1);
  }
  const dim = findVectorLen(json);
  console.log(`  response keys: ${Object.keys(json).join(", ")}`);
  if (dim) {
    console.log(`\n✓ SUCCESS — got an embedding vector of ${dim} dimensions.`);
    console.log("  The wiki can use this model. Rebuild the index in the panel.");
    process.exit(0);
  }
  console.error(
    `\n✗ Got HTTP 200 but no embedding vector recognised in the response.`,
  );
  console.error(`  Raw (first 500 chars): ${text.slice(0, 500)}`);
  console.error(
    "  → The proxy's response shape isn't one we parse. Send this output" +
      " so extractGeminiVectors can be extended.",
  );
  process.exit(1);
}

main();
