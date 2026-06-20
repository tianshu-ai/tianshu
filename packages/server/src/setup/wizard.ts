// `tianshu setup --wizard` — interactive first-run setup.
//
// Goal: take a fresh checkout from "no config" to a state where
// `tianshu start` works. We ask 3 questions (provider, key,
// default model), write two files (~/.tianshu/config.json + .env),
// and bail out gracefully on Ctrl-C.
//
// Non-interactive mode (--non-interactive --provider X --api-key Y
// [--default-model Z]) writes the same files without prompting,
// for Docker / CI use cases.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { getGlobalConfigPath, getTianshuHome } from "../core/paths.js";
import { probeDefaultModel } from "./probe-default-model.js";

export interface WizardOpts {
  /** Skip the prompts and apply the supplied params directly. */
  nonInteractive?: boolean;
  /** "anthropic" | "openai" | "google" | "skip" */
  provider?: string;
  /** Literal API key. */
  apiKey?: string;
  /** Override defaultModel (e.g. "anthropic/claude-opus-4-7"). */
  defaultModel?: string;
  /** Override the provider baseUrl. Useful when the user is hitting
   *  a corporate gateway / cloudflare proxy / a local llama-server
   *  rather than the vendor's public API. */
  baseUrl?: string;
  /** Override TIANSHU_HOME. */
  home?: string;
  /** Override CWD for the .env path. */
  cwd?: string;
  /** Don't write — just print what would happen. */
  dryRun?: boolean;
  /** Allow overwriting an existing config.json (default: skip). */
  force?: boolean;
}

interface ProviderProfile {
  id: string;
  name: string;
  envVar: string;
  api: string;
  baseUrl: string;
  models: { id: string; name: string; reasoning?: boolean }[];
  defaultModel: string;
}

const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    envVar: "ANTH…_KEY",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    models: [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true },
    ],
    defaultModel: "anthropic/claude-sonnet-4-6",
  },
  {
    id: "openai",
    name: "OpenAI (GPT)",
    envVar: "OPENAI_API_KEY",
    api: "openai-completions",
    baseUrl: "https://api.openai.com",
    models: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "gpt-5-mini", name: "GPT-5 Mini" },
    ],
    defaultModel: "openai/gpt-5",
  },
  {
    id: "google",
    name: "Google (Gemini)",
    envVar: "GOOGLE_API_KEY",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true },
    ],
    defaultModel: "google/gemini-2.5-flash",
  },
];

export interface WizardResult {
  configPath: string;
  envPath: string;
  wroteConfig: boolean;
  wroteEnv: boolean;
  /** Lines for the outro / non-interactive caller's stdout. */
  notes: string[];
}

export async function runSetupWizard(
  opts: WizardOpts = {},
): Promise<WizardResult> {
  const home = opts.home ?? getTianshuHome();
  const cwd = opts.cwd ?? process.cwd();
  const configPath = getGlobalConfigPath(home);
  const envPath = path.join(cwd, ".env");

  // Smart-skip: if the user already has a working config, skip
  // the provider/key/model questions and hand straight off to the
  // in-CLI agent for the rest of setup. The agent runs run_doctor
  // immediately and walks the user through plugins / tenants /
  // search keys conversationally.
  //
  // Only meaningful in interactive mode — non-interactive callers
  // (--non-interactive --provider X --api-key ***) want the
  // wizard to *write* config, not check existing config.
  if (!opts.nonInteractive) {
    const s = p.spinner();
    s.start("Checking your default model...");
    const probe = await probeDefaultModel({ home });
    if (probe.ok) {
      s.stop(
        `\u2713 ${probe.modelId} reachable (${probe.durationMs}ms via ${probe.baseUrl ?? "vendor default"})`,
      );
      if (!opts.dryRun) {
        const { runCliAgent } = await import("./cli-agent.js");
        try {
          await runCliAgent({ home });
        } catch (err) {
          p.log.error(
            `setup agent crashed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return {
        configPath,
        envPath,
        wroteConfig: false,
        wroteEnv: false,
        notes: [
          `default model ${probe.modelId} reachable; handed off to CLI agent`,
        ],
      };
    }
    s.stop(
      probe.error?.kind === "no-config"
        ? "No config yet \u2014 let's set one up."
        : `Default model didn't respond: ${probe.error?.kind ?? "unknown"}.`,
    );
    if (probe.error?.message) {
      p.log.info(probe.error.message);
    }
  }

  // Resolve which provider, key, baseUrl, model we're going to
  // write.
  let providerId: string;
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let defaultModel: string | undefined;

  if (opts.nonInteractive) {
    if (!opts.provider) {
      throw new Error(
        "--non-interactive requires --provider (anthropic|openai|google|skip)",
      );
    }
    providerId = opts.provider;
    apiKey = opts.apiKey;
    baseUrl = opts.baseUrl;
    defaultModel = opts.defaultModel;
  } else {
    p.intro("Tianshu setup");

    const choice = await p.select({
      message: "Pick your LLM provider:",
      options: [
        ...PROVIDER_PROFILES.map((pf) => ({
          value: pf.id,
          label: pf.name,
          hint: pf.envVar,
        })),
        {
          value: "skip",
          label: "skip — I'll configure manually",
          hint: "Edit ~/.tianshu/config.json yourself",
        },
      ],
    });
    if (p.isCancel(choice)) {
      p.cancel("Setup cancelled.");
      return {
        configPath,
        envPath,
        wroteConfig: false,
        wroteEnv: false,
        notes: ["cancelled"],
      };
    }
    providerId = choice as string;

    if (providerId !== "skip") {
      const profile = PROVIDER_PROFILES.find((p) => p.id === providerId);
      if (!profile) throw new Error(`unknown provider id: ${providerId}`);

      // Step 2: API key.
      const k = await p.password({
        message: `Paste your ${profile.envVar} (input is hidden, written to .env):`,
        validate: (v) =>
          !v || v.length < 8
            ? "Looks too short to be a real key — try again or pick `skip`."
            : undefined,
      });
      if (p.isCancel(k)) {
        p.cancel("Setup cancelled.");
        return {
          configPath,
          envPath,
          wroteConfig: false,
          wroteEnv: false,
          notes: ["cancelled"],
        };
      }
      apiKey = k as string;

      // Step 3: endpoint. Default offered first, but a corporate
      // gateway / cloudflare proxy / local llama-server is common
      // enough we ask. Empty input keeps the default.
      const url = await p.text({
        message: `API endpoint:`,
        placeholder: profile.baseUrl,
        defaultValue: profile.baseUrl,
        validate: (v) => {
          if (!v) return undefined; // accept empty → default
          try {
            const u = new URL(v);
            if (!/^https?:$/.test(u.protocol))
              return "URL must be http:// or https://";
            return undefined;
          } catch {
            return "Not a valid URL.";
          }
        },
      });
      if (p.isCancel(url)) {
        p.cancel("Setup cancelled.");
        return {
          configPath,
          envPath,
          wroteConfig: false,
          wroteEnv: false,
          notes: ["cancelled"],
        };
      }
      // Treat empty / unchanged input as 'use default'.
      baseUrl =
        url && (url as string).trim() && (url as string).trim() !== profile.baseUrl
          ? (url as string).trim()
          : undefined;

      // Step 4: default model. If the user supplied a custom
      // baseUrl, the canonical model ids may not exist on the
      // proxy — give them a free-text option.
      const modelChoice = await p.select({
        message: "Default model? (you can change later):",
        options: [
          ...profile.models.map((m, idx) => ({
            value: `${profile.id}/${m.id}`,
            label: m.name,
            hint:
              idx === 0
                ? "recommended"
                : m.reasoning
                  ? "thinking-mode"
                  : undefined,
          })),
          {
            value: "__custom__",
            label: "custom — type a model id",
            hint: "e.g. for proxies / local servers",
          },
        ],
      });
      if (p.isCancel(modelChoice)) {
        p.cancel("Setup cancelled.");
        return {
          configPath,
          envPath,
          wroteConfig: false,
          wroteEnv: false,
          notes: ["cancelled"],
        };
      }
      if (modelChoice === "__custom__") {
        const custom = await p.text({
          message: `Custom model id (without the "${profile.id}/" prefix):`,
          placeholder: profile.models[0]?.id ?? "my-model",
          validate: (v) =>
            !v || !(v as string).trim()
              ? "Model id can't be empty."
              : undefined,
        });
        if (p.isCancel(custom)) {
          p.cancel("Setup cancelled.");
          return {
            configPath,
            envPath,
            wroteConfig: false,
            wroteEnv: false,
            notes: ["cancelled"],
          };
        }
        defaultModel = `${profile.id}/${(custom as string).trim()}`;
      } else {
        defaultModel = modelChoice as string;
      }
    }
  }

  const notes: string[] = [];
  let wroteConfig = false;
  let wroteEnv = false;

  if (providerId === "skip") {
    notes.push(
      "skipped provider config — edit ~/.tianshu/config.json yourself before running tianshu start.",
    );
  } else {
    const profile = PROVIDER_PROFILES.find((p) => p.id === providerId);
    if (!profile) throw new Error(`unknown provider id: ${providerId}`);
    const cfg = buildConfig(
      profile,
      defaultModel ?? profile.defaultModel,
      baseUrl,
    );

    const verb = opts.dryRun ? "would write" : "wrote";
    if (fs.existsSync(configPath) && !opts.force) {
      notes.push(
        `~/.tianshu/config.json already exists — kept as-is (pass --force to overwrite). Add this entry under \`models.providers\` if you want this provider added:\n${JSON.stringify(cfg.models.providers[providerId], null, 2)}`,
      );
    } else {
      if (!opts.dryRun) writeJsonAtomic(configPath, cfg);
      notes.push(`${verb} ${configPath}`);
      wroteConfig = true;
    }

    if (apiKey) {
      const envVerb = opts.dryRun ? "would set" : "set";
      if (!opts.dryRun) appendEnvKey(envPath, profile.envVar, apiKey);
      notes.push(
        `${envVerb} ${profile.envVar} in ${envPath}${
          !opts.dryRun && fs.existsSync(envPath) ? "" : " (created)"
        }`,
      );
      wroteEnv = true;
    } else if (!opts.nonInteractive) {
      // Shouldn't reach here in interactive mode — we'd have
      // bailed on cancel — but defensively note the omission.
      notes.push(
        `no API key supplied; set ${profile.envVar} in .env or your shell before starting.`,
      );
    }
  }

  if (!opts.nonInteractive) {
    p.log.info(
      [
        `Files written:`,
        ...notes.map((n) => `  \u00b7 ${n}`),
      ].join("\n"),
    );

    // The wizard just wrote (or appended to) .env. dotenv was
    // already loaded once at process start — the new key isn't
    // in process.env yet. Force-reload so the probe + agent see
    // it without requiring the user to restart the CLI.
    if (wroteEnv) {
      const { loadEnv } = await import("./load-env.js");
      loadEnv({ force: true });
    }

    // Verify the LLM works before handing off to the agent. If
    // ping fails the agent has nothing to talk through, so we
    // surface the failure loudly and bail. Users were getting
    // 'Setup complete' messages with a silently-broken model;
    // structured failure messages tell them which knob to turn.
    const probeS = p.spinner();
    probeS.start("Pinging your default model to verify it works...");
    const probe = await probeDefaultModel({ home });
    if (!probe.ok) {
      probeS.stop(
        `\u2717 Default model is NOT working (${probe.error?.kind ?? "unknown"}).`,
      );
      p.log.error(
        renderProbeFailureMessage(probe, configPath, envPath),
      );
      p.outro(
        "\u26a0\ufe0f  Setup is INCOMPLETE \u2014 fix the issue above and re-run `tianshu setup --wizard`.",
      );
      return { configPath, envPath, wroteConfig, wroteEnv, notes };
    }
    probeS.stop(
      `\u2713 ${probe.modelId} responded in ${probe.durationMs}ms (via ${probe.baseUrl ?? "vendor default"}).`,
    );
    p.log.success(
      "Default model verified. LLM provider is working.",
    );

    // Hand off to the in-CLI agent for the rest of setup.
    if (!opts.dryRun) {
      const { runCliAgent } = await import("./cli-agent.js");
      try {
        await runCliAgent({ home });
      } catch (err) {
        p.log.error(
          `setup agent crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return { configPath, envPath, wroteConfig, wroteEnv, notes };
}

function buildConfig(
  profile: ProviderProfile,
  defaultModel: string,
  baseUrlOverride?: string,
) {
  // If the user picked a custom model id ("__custom__" branch in
  // the wizard), it won't appear in profile.models. Add a stub
  // entry so config.json's `models` array reflects what the user
  // actually intends to call — otherwise the model picker UI
  // shows a model that's defaultModel but not in the list.
  const slash = defaultModel.indexOf("/");
  const defaultModelId = slash > 0 ? defaultModel.slice(slash + 1) : defaultModel;
  const knownIds = new Set(profile.models.map((m) => m.id));
  const models = profile.models.map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.reasoning ? { reasoning: true } : {}),
    contextWindow: 200000,
    maxTokens: 8192,
  }));
  if (!knownIds.has(defaultModelId)) {
    models.unshift({
      id: defaultModelId,
      name: defaultModelId,
      contextWindow: 200000,
      maxTokens: 8192,
    });
  }
  return {
    defaultModel,
    models: {
      providers: {
        [profile.id]: {
          api: profile.api,
          baseUrl: baseUrlOverride ?? profile.baseUrl,
          apiKey: `\${${profile.envVar}}`,
          group: "Cloud",
          models,
        },
      },
    },
  };
}

function writeJsonAtomic(filepath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const tmp = `${filepath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmp, filepath);
}

/**
 * Render a clear, actionable failure message for a probe error.
 * Each error kind gets a hand-written block that names the
 * specific file / env var / setting the user has to touch — not
 * the raw provider error string.
 */
function renderProbeFailureMessage(
  probe: { modelId?: string; baseUrl?: string; error?: { kind: string; message: string } },
  configPath: string,
  envPath: string,
): string {
  const kind = probe.error?.kind ?? "unknown";
  const lines: string[] = [];
  lines.push(
    `Wrote ${configPath} and ${envPath}, but the LLM didn't respond when pinged.`,
  );
  lines.push("");
  lines.push(`Model: ${probe.modelId ?? "(unknown)"}`);
  if (probe.baseUrl) lines.push(`Endpoint: ${probe.baseUrl}`);
  lines.push("");
  lines.push("What's likely wrong:");
  switch (kind) {
    case "no-config":
      lines.push("  \u00b7 Config file is malformed or missing. Re-run the wizard.");
      break;
    case "no-default-model":
      lines.push(
        "  \u00b7 No model picked, or `defaultModel` doesn't match a configured provider.",
      );
      lines.push("  \u00b7 Re-run the wizard and pick a model.");
      break;
    case "no-api-key":
      lines.push(
        `  \u00b7 The API key reference (\${VAR}) in config.json resolves to empty.`,
      );
      lines.push(
        `  \u00b7 Check ${envPath} actually has the key set, with no quotes / spaces.`,
      );
      lines.push(
        `  \u00b7 Or export the variable in your shell before re-running.`,
      );
      break;
    case "bad-key":
      lines.push(
        "  \u00b7 The API key was rejected (401 / unauthorized).",
      );
      lines.push(
        `  \u00b7 Open ${envPath}, fix the key, re-run \`tianshu setup --wizard\`.`,
      );
      break;
    case "model-not-found":
      lines.push(
        "  \u00b7 The provider says the model id doesn't exist (404 / not found).",
      );
      lines.push(
        `  \u00b7 Edit ${configPath}'s \`defaultModel\` to a model your endpoint actually serves.`,
      );
      if (probe.baseUrl && !probe.baseUrl.includes("anthropic.com")) {
        lines.push(
          `  \u00b7 You're hitting a custom baseUrl (${probe.baseUrl}); proxies often expose different model ids than the vendor.`,
        );
      }
      break;
    case "network":
      lines.push(
        `  \u00b7 Could not reach ${probe.baseUrl ?? "the endpoint"}: connection refused / DNS failed.`,
      );
      lines.push(
        "  \u00b7 If you're behind a corporate proxy / VPN: make sure it's connected.",
      );
      lines.push(
        "  \u00b7 If you set a custom baseUrl: confirm the URL is reachable (curl it).",
      );
      break;
    case "timeout":
      lines.push(
        "  \u00b7 The endpoint accepted the request but didn't respond within 6s.",
      );
      lines.push(
        "  \u00b7 Slow corporate gateway? Re-run later, or increase the wizard timeout.",
      );
      break;
    default:
      lines.push(
        `  \u00b7 Unrecognised failure: ${probe.error?.message ?? "(no detail)"}`,
      );
      lines.push(
        "  \u00b7 Run \`tianshu doctor --probe-providers\` for a fuller diagnostic.",
      );
  }
  if (probe.error?.message) {
    lines.push("");
    lines.push(`Raw error: ${probe.error.message.slice(0, 200)}`);
  }
  return lines.join("\n");
}

/** Append (or replace) one KEY=value line in a .env file, preserving
 *  the rest of the file. Creates the file if missing. */
function appendEnvKey(envPath: string, key: string, value: string): void {
  let body = "";
  if (fs.existsSync(envPath)) body = fs.readFileSync(envPath, "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(body)) {
    body = body.replace(re, line);
  } else {
    if (body.length > 0 && !body.endsWith(os.EOL)) body += os.EOL;
    body += line + os.EOL;
  }
  fs.writeFileSync(envPath, body, { mode: 0o600 });
}
