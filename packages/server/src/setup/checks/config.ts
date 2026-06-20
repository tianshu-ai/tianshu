// Config-files check: ~/.tianshu/config.json + repo .env.
//
// We don't validate semantics here (provider keys, default model)
// — that's checks/providers.ts. This module only confirms the
// physical files are present and parseable.

import fs from "node:fs";
import path from "node:path";
import { CheckGroup } from "../render.js";
import { getGlobalConfigPath, getTianshuHome } from "../../core/paths.js";

export interface ConfigCheckOpts {
  /** Override TIANSHU_HOME for tests. */
  home?: string;
  /** Override CWD for the .env probe. Defaults to process.cwd(). */
  cwd?: string;
}

export function checkConfig(opts: ConfigCheckOpts = {}): CheckGroup {
  const home = opts.home ?? getTianshuHome();
  const cwd = opts.cwd ?? process.cwd();
  const configPath = getGlobalConfigPath(home);
  const envPath = path.join(cwd, ".env");
  const lines: CheckGroup["lines"] = [];

  // TIANSHU_HOME existence
  if (fs.existsSync(home)) {
    lines.push({ severity: "ok", text: `TIANSHU_HOME`, detail: home });
  } else {
    lines.push({
      severity: "warning",
      text: `TIANSHU_HOME does not exist yet`,
      detail: `${home} (will be created on first start)`,
    });
  }

  // ~/.tianshu/config.json
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      JSON.parse(raw);
      lines.push({
        severity: "ok",
        text: `config.json exists & parses`,
        detail: configPath,
      });
    } catch (err) {
      lines.push({
        severity: "blocker",
        text: `config.json present but invalid JSON`,
        detail: `${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    lines.push({
      severity: "blocker",
      text: `config.json missing`,
      detail: `expected at ${configPath}; run \`tianshu setup --wizard\` to create it.`,
    });
  }

  // .env (repo-local) — only a warning if missing. Users can also
  // export keys directly in their shell, so this isn't a blocker.
  if (fs.existsSync(envPath)) {
    lines.push({ severity: "ok", text: `.env exists`, detail: envPath });
  } else {
    lines.push({
      severity: "warning",
      text: `.env not found at CWD`,
      detail: `${envPath} — fine if you exported provider keys via shell; otherwise \`tianshu setup --wizard\` will create one.`,
    });
  }

  return { title: "Config files", lines };
}
