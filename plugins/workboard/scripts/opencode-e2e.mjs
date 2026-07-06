#!/usr/bin/env node
// End-to-end integration check for the opencode worker.
//
// Purpose: prove that a task assigned to the `opencoder` worker,
// using the ENV-configured default tianshu model, actually reaches
// opencode inside the openshell sandbox AND gets back an assistant
// message from the model (i.e. the whole chain works:
//   API -> workboard worker -> openshell sandbox -> opencode
//        -> tianshu opencode-proxy -> real upstream gateway).
//
// This is the reproduction Yu asked for: instead of hand-poking curl
// on the production box, run one command that boots a scratch server,
// fires a task, and tells you EXACTLY which layer broke (proxy 401 /
// upstream 429 / no output / no assistant message).
//
// Usage (from repo root, with a scratch env already exporting
// TIANSHU_HOME + the .env model config, like /tmp/omot-env.sh):
//
//   source /tmp/omot-env.sh
//   node plugins/workboard/scripts/opencode-e2e.mjs
//
// Env knobs:
//   OCE_BASE   base URL of a running tianshu server (default
//              http://localhost:${PORT||3303}). If unset and no
//              server is up, the script tells you to start one.
//   OCE_MODEL  per-task model override (label opencode-model:<id>);
//              default = whatever the opencoder agent is configured
//              with (the ENV default).
//   OCE_PROMPT the task prompt; default asks opencode to just say a
//              word so we only need ONE model round-trip.
//   OCE_TIMEOUT_MS  overall wait budget (default 600000 = 10min).

const BASE = process.env.OCE_BASE || `http://localhost:${process.env.PORT || 3303}`;
const MODEL = process.env.OCE_MODEL || "";
const PROMPT =
  process.env.OCE_PROMPT ||
  "Reply with exactly the single word READY and nothing else. Do not use any tools.";
const TIMEOUT_MS = Number(process.env.OCE_TIMEOUT_MS || 600000);
const POLL_MS = 5000;

function log(...a) {
  console.log("[oce]", ...a);
}
function fail(msg, detail) {
  console.error("\n[oce] ❌ FAIL:", msg);
  if (detail !== undefined) console.error(detail);
  process.exit(1);
}
function ok(msg) {
  console.log("\n[oce] ✅ PASS:", msg);
  process.exit(0);
}

async function api(path, init) {
  const url = `${BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
    });
  } catch (err) {
    fail(`cannot reach server at ${url}`, String(err?.message || err));
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

async function main() {
  log(`server:  ${BASE}`);
  log(`model:   ${MODEL || "(opencoder agent default from ENV)"}`);
  log(`prompt:  ${JSON.stringify(PROMPT)}`);
  log(`timeout: ${TIMEOUT_MS}ms`);

  // 0. sanity: server up + opencoder worker exists.
  const me = await api("/api/me");
  if (me.status !== 200) {
    fail(
      `server not authenticated / not up (GET /api/me -> ${me.status}). ` +
        `Start a scratch server first: source /tmp/omot-env.sh && npm run serve`,
      me.json,
    );
  }
  const agents = await api("/api/p/workboard/agents");
  const list = Array.isArray(agents.json?.agents) ? agents.json.agents : [];
  const oc = list.find((a) => a.id === "opencoder");
  if (!oc) {
    fail(
      "no `opencoder` worker agent registered — cannot run an opencode task",
      list.map((a) => a.id),
    );
  }
  log(`opencoder agent modelId: ${oc.modelId || "(none!)"}`);
  if (!MODEL && !oc.modelId) {
    fail("opencoder agent has no modelId and no OCE_MODEL override given");
  }

  // 1. create the task.
  const labels = MODEL ? [`opencode-model:${MODEL}`] : [];
  const created = await api("/api/p/workboard/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "oce: agent-message probe",
      input: PROMPT,
      workerAgentId: "opencoder",
      labels,
    }),
  });
  // create returns 200/201; single create may come back as a batch
  // envelope { results: [{ ok, task }] } or a plain { task }.
  const createdTask =
    created.json?.task ||
    (Array.isArray(created.json?.results) && created.json.results[0]?.task) ||
    null;
  if ((created.status !== 200 && created.status !== 201) || !createdTask?.id) {
    fail(`create task failed (${created.status})`, created.json);
  }
  const taskId = createdTask.id;
  log(`task created: ${taskId}`);

  // 2. poll until terminal or timeout.
  const deadline = Date.now() + TIMEOUT_MS;
  let last = "";
  let task;
  for (;;) {
    if (Date.now() > deadline) {
      log("timed out — dumping opencode log for diagnosis:");
      await dumpLog(taskId);
      fail(`task ${taskId} did not finish within ${TIMEOUT_MS}ms (status=${last})`);
    }
    const r = await api(`/api/p/workboard/tasks?include_aborted=1`);
    task =
      (Array.isArray(r.json?.tasks) ? r.json.tasks : []).find(
        (t) => t.id === taskId,
      ) || null;
    const st = task?.status || "unknown";
    if (st !== last) {
      log(`status: ${st}`);
      last = st;
    }
    if (st === "done" || st === "failed" || st === "awaiting_intervention") break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // 3. read the transcript + raw opencode log.
  const hist = await api(`/api/p/workboard/tasks/${taskId}/history`);
  const entries = Array.isArray(hist.json?.entries) ? hist.json.entries : [];
  const assistantMsgs = entries.filter(
    (e) => e.role === "assistant" && typeof e.text === "string" && e.text.trim(),
  );

  log(`final status: ${task.status}`);
  log(`transcript entries: ${entries.length} (assistant w/ text: ${assistantMsgs.length})`);
  if (task.resultSummary) log(`resultSummary: ${String(task.resultSummary).slice(0, 200)}`);
  if (task.failureReason) log(`failureReason: ${String(task.failureReason).slice(0, 300)}`);

  // Scan the raw opencode log for the tell-tale failure signatures so
  // the verdict names the exact broken layer.
  const rawLog = await getLog(taskId);
  const sig = classify(rawLog);
  if (sig) log(`opencode.log signal: ${sig}`);

  // 4. verdict.
  if (assistantMsgs.length > 0) {
    console.log("\n--- first assistant message ---");
    console.log(assistantMsgs[0].text.slice(0, 500));
    ok(
      `opencode returned an assistant message via the ENV default model. ` +
        `Full chain works (proxy -> upstream -> opencode -> agent msg).`,
    );
  }

  // No assistant message — say why.
  if (sig === "proxy-401")
    fail(
      "opencode got 401 Unauthorized from the tianshu proxy. The proxy " +
        "rejected the token OR the upstream returned 401. Check proxy " +
        "token validity + the provider apiKey the proxy injects.",
    );
  if (sig === "upstream-429")
    fail(
      "upstream returned 429 (rate limit). The chain is WIRED CORRECTLY — " +
        "proxy forwarded to the gateway and the gateway reached the real " +
        "provider; it's just throttled. Retry later.",
    );
  if (sig === "models-dev-403")
    fail(
      "opencode's startup models.dev fetch was 403'd (egress/opencode.exe " +
        "authorization). Update to >=0.4.41.",
    );
  fail(
    `task ended '${task.status}' with no assistant message and no known ` +
      `failure signature. See dumped log above.`,
    rawLog ? rawLog.slice(-1500) : "(no opencode log captured)",
  );
}

async function getLog(taskId) {
  const r = await api(`/api/p/workboard/tasks/${taskId}/opencode-log`);
  return typeof r.json?.log === "string" ? r.json.log : "";
}
async function dumpLog(taskId) {
  const l = await getLog(taskId);
  if (l) console.error(l.slice(-2000));
  else console.error("(no opencode log available)");
}
function classify(logText) {
  if (!logText) return null;
  if (/Failed to fetch models\.dev.*403/.test(logText)) return "models-dev-403";
  if (/stream error.*Unauthorized|401|AI_APICallError: Unauthorized/.test(logText))
    return "proxy-401";
  if (/429|rate.?limit|RATE_LIMIT/i.test(logText)) return "upstream-429";
  return null;
}

main().catch((e) => fail("unexpected error", String(e?.stack || e)));
