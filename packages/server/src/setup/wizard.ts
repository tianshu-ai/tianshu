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

export interface WizardOpts {
  /** Skip the prompts and apply the supplied params directly. */
  nonInteractive?: boolean;
  /** "anthropic" | "openai" | "google" | "skip" */
  provider?: string;
  /** Literal API key. */
  apiKey?: string;
  /** Override defaultModel (e.g. "anthropic/claude-opus-4-7"). */
  defaultModel?: string;
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

  // Resolve which provider, key, model we're going to write.
  let providerId: string;
  let apiKey: string | undefined;
  let defaultModel: string | undefined;

  if (opts.nonInteractive) {
    if (!opts.provider) {
      throw new Error(
        "--non-interactive requires --provider (anthropic|openai|google|skip)",
      );
    }
    providerId = opts.provider;
    apiKey = opts.apiKey;
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

      const m = await p.select({
        message: "Default model? (you can change later):",
        options: profile.models.map((m, idx) => ({
          value: `${profile.id}/${m.id}`,
          label: m.name,
          hint: idx === 0 ? "recommended" : m.reasoning ? "thinking-mode" : undefined,
        })),
      });
      if (p.isCancel(m)) {
        p.cancel("Setup cancelled.");
        return {
          configPath,
          envPath,
          wroteConfig: false,
          wroteEnv: false,
          notes: ["cancelled"],
        };
      }
      defaultModel = m as string;
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
    const cfg = buildConfig(profile, defaultModel ?? profile.defaultModel);

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
    p.outro(
      [
        "Setup complete.",
        ...notes,
        "",
        "Next: run `tianshu doctor` to verify, then `tianshu start` (or `npm run dev` in a checkout).",
      ].join("\n"),
    );
  }

  return { configPath, envPath, wroteConfig, wroteEnv, notes };
}

function buildConfig(profile: ProviderProfile, defaultModel: string) {
  return {
    defaultModel,
    models: {
      providers: {
        [profile.id]: {
          api: profile.api,
          baseUrl: profile.baseUrl,
          apiKey: `\${${profile.envVar}}`,
          group: "Cloud",
          models: profile.models.map((m) => ({
            id: m.id,
            name: m.name,
            ...(m.reasoning ? { reasoning: true } : {}),
            contextWindow: 200000,
            maxTokens: 8192,
          })),
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
