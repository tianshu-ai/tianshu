// `tianshu` CLI — top-level dispatch.
//
// Commands:
//   tianshu doctor [--probe-providers] [--probe-sandbox] [--json]
//   tianshu setup [--wizard] [--non-interactive --provider X --api-key Y [--base-url URL] [--default-model Z]] [--force] [--dry-run]
//   tianshu start | stop | restart | status [--json] [--no-wait]
//   tianshu logs [--follow] [--lines=N] [--stream=out|err|both]
//   tianshu tenant list|create <id>|delete <id>
//   tianshu user create <tenantId> <userId> [--provider=dev] [--external-id=<x>]
//   tianshu version
//   tianshu help [<command>]
//
// Service lifecycle commands wrap launchctl so users (and
// debugging agents) don't need to know launchd plist paths
// and `bootstrap gui/$(id -u) ~/Library/LaunchAgents/...`
// invocations. `tianshu logs` reads the same files the wizard
// configured the agent to write into.

import {
  GlobalOps,
  InvalidTenantIdError,
  TenantAlreadyExistsError,
  TenantNotFoundError,
  getTianshuHome,
} from "./core/index.js";
import { loadEnv } from "./setup/load-env.js";
import { runDoctor } from "./setup/doctor.js";
import { runSetupWizard } from "./setup/wizard.js";
import {
  runStart,
  runStop,
  runRestart,
  runStatus,
  runLogs,
} from "./setup/service.js";

// Load .env up front, same as the server boot path. Without this,
// `tianshu doctor` would diagnose the user's setup using whatever
// the shell happens to export — typically nothing — and report
// every provider as 'API key not set' even though the keys are
// sitting in .env right next to the config it just validated.
loadEnv();

export interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, string>;
  flags: Set<string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags.add(arg.slice(2));
      }
    } else {
      positional.push(arg);
    }
  }
  const [command, ...rest] = positional;
  return { command: command ?? "", positional: rest, options, flags };
}

function topLevelUsage(): string {
  return [
    "Usage:",
    "  tianshu doctor [--probe-providers] [--probe-sandbox] [--json]",
    "  tianshu setup [--wizard] [--non-interactive --provider X --api-key Y [--base-url URL] [--default-model Z]]",
    "  tianshu start | stop | restart | status [--json] [--no-wait]",
    "  tianshu logs [--follow] [--lines=N] [--stream=out|err|both]",
    "  tianshu tenant list|create <id>|delete <id>",
    "  tianshu user create <tenantId> <userId> [--provider=dev] [--external-id=<x>]",
    "  tianshu version",
    "  tianshu help [<command>]",
    "",
    `TIANSHU_HOME currently resolves to: ${getTianshuHome()}`,
  ].join("\n");
}

async function getPackageVersion(): Promise<string> {
  // Single source of truth: the root package.json. The CLI is
  // short-lived so reading from disk per invocation is fine.
  try {
    const fs = await import("node:fs");
    const url = new URL("../../../package.json", import.meta.url);
    const json = JSON.parse(fs.readFileSync(url, "utf8")) as {
      version?: string;
    };
    return json.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  // Top-level lifecycle commands first.
  switch (parsed.command) {
    case "":
    case "help": {
      const target = parsed.positional[0];
      if (!target) {
        console.log(topLevelUsage());
        return 0;
      }
      // For now help <cmd> just prints the same top-level usage —
      // sub-commands' own help is implicit. Easy to expand later.
      console.log(topLevelUsage());
      return 0;
    }
    case "version":
    case "--version":
    case "-v":
      console.log(await getPackageVersion());
      return 0;

    case "doctor":
      return runDoctor({
        probeProviders: parsed.flags.has("probe-providers"),
        probeSandbox: parsed.flags.has("probe-sandbox"),
        json: parsed.flags.has("json"),
      });

    case "setup": {
      try {
        const res = await runSetupWizard({
          nonInteractive: parsed.flags.has("non-interactive"),
          provider: parsed.options.provider,
          apiKey: parsed.options["api-key"],
          baseUrl: parsed.options["base-url"],
          defaultModel: parsed.options["default-model"],
          force: parsed.flags.has("force"),
          dryRun: parsed.flags.has("dry-run"),
        });
        if (parsed.flags.has("non-interactive")) {
          for (const note of res.notes) console.log(note);
        }
        return 0;
      } catch (err) {
        console.error(
          `setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    case "start":
      return runStart({
        wait: !parsed.flags.has("no-wait"),
        json: parsed.flags.has("json"),
      });
    case "stop":
      return runStop({ json: parsed.flags.has("json") });
    case "restart":
      return runRestart({
        wait: !parsed.flags.has("no-wait"),
        json: parsed.flags.has("json"),
      });
    case "status":
      return runStatus({ json: parsed.flags.has("json") });
    case "logs": {
      const linesOpt = parsed.options.lines;
      const streamOpt = parsed.options.stream;
      const stream =
        streamOpt === "out" || streamOpt === "err" || streamOpt === "both"
          ? streamOpt
          : undefined;
      return runLogs({
        follow: parsed.flags.has("follow") || parsed.flags.has("f"),
        lines: linesOpt ? Number.parseInt(linesOpt, 10) : undefined,
        stream,
      });
    }
  }

  // Tenant / user commands keep their original semantics.
  const ops = new GlobalOps();
  try {
    if (parsed.command === "tenant" && parsed.positional[0] === "list") {
      const ids = ops.list();
      if (ids.length === 0) console.log("(no tenants)");
      else for (const id of ids) console.log(id);
      return 0;
    }
    if (parsed.command === "tenant" && parsed.positional[0] === "create") {
      const id = parsed.positional[1];
      if (!id) {
        console.error("missing <id>\n" + topLevelUsage());
        return 2;
      }
      const ctx = ops.create(id);
      console.log(`created tenant ${ctx.tenantId} at ${ctx.root}`);
      return 0;
    }
    if (parsed.command === "tenant" && parsed.positional[0] === "delete") {
      const id = parsed.positional[1];
      if (!id) {
        console.error("missing <id>\n" + topLevelUsage());
        return 2;
      }
      ops.softDelete(id);
      console.log(`soft-deleted tenant ${id} (renamed to ${id}.deleted.<ts>)`);
      return 0;
    }
    if (parsed.command === "user" && parsed.positional[0] === "create") {
      const [, tenantId, userId] = parsed.positional;
      if (!tenantId || !userId) {
        console.error("missing <tenantId> or <userId>\n" + topLevelUsage());
        return 2;
      }
      const ctx = ops.open(tenantId);
      ops.ensureUser(ctx, {
        userId,
        provider: parsed.options.provider ?? "dev",
        externalId: parsed.options["external-id"] ?? `${userId}@local`,
        displayName: parsed.options["display-name"],
      });
      console.log(`ensured user ${userId} in tenant ${ctx.tenantId}`);
      return 0;
    }
    console.error(topLevelUsage());
    return 2;
  } catch (err) {
    if (err instanceof InvalidTenantIdError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    if (
      err instanceof TenantAlreadyExistsError ||
      err instanceof TenantNotFoundError
    ) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    return 1;
  } finally {
    ops.closePool();
  }
}

// Direct invocation: `node dist/cli.js …`. The `bin/tianshu.mjs`
// shim also calls `main()` after dynamic-importing this module,
// so we only auto-run when the module *is* the entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
