// Probe-classification tests. We don't want to mock the full
// `completeSimple` network path here — that lives in pi-ai's
// own test suite. We exercise the reachable-without-network
// branches: missing config, missing default model, sentinel
// api key.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { probeDefaultModel } from "./probe-default-model.js";

describe("probeDefaultModel", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-probe-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("returns no-default-model when config has no providers", async () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({}),
    );
    const r = await probeDefaultModel({ home });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("no-default-model");
  });

  it("returns no-api-key when key resolves to the test-key sentinel", async () => {
    delete process.env.TIANSHU_PROBE_TEST_KEY;
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        defaultModel: "anthropic/sonnet",
        models: {
          providers: {
            anthropic: {
              api: "anthropic-messages",
              baseUrl: "https://api.anthropic.com",
              apiKey: "${TIANSHU_PROBE_TEST_KEY}",
              models: [{ id: "sonnet", contextWindow: 200_000 }],
            },
          },
        },
      }),
    );
    const r = await probeDefaultModel({ home });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("no-api-key");
  });

  it("returns no-config when ~/.tianshu/config.json is missing", async () => {
    // home dir exists but no config file; loadGlobalConfig returns
    // an empty object → that flows into no-default-model. The
    // explicit no-config path triggers when loadGlobalConfig
    // throws, which only happens for malformed JSON.
    fs.writeFileSync(path.join(home, "config.json"), "{ this isn't json");
    const r = await probeDefaultModel({ home });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("no-config");
  });

  // Note: error-classification heuristics (bad-key 401,
  // model-not-found 404, network ECONNREFUSED, AbortError
  // timeouts) are best validated by hand against real provider
  // backends — mocking them in the test runner is fragile
  // because pi-ai's transports vary by Api type. The unit
  // surface above covers the cases that don't need a live
  // network round-trip; the integration surface (live provider)
  // is exercised by `tianshu doctor --probe-providers`.
});
