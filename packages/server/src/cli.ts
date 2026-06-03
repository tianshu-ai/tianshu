// `tianshu` CLI — tenant lifecycle management.
//
// Usage:
//   tianshu tenant list
//   tianshu tenant create <id>
//   tianshu tenant delete <id>      (soft delete: rename to <id>.deleted.<ts>)
//   tianshu user create  <tenantId> <userId> [--provider=dev] [--external-id=<x>]
//
// Run from a checkout via:
//   npx tsx packages/server/src/cli.ts tenant list
//
// After build / publish, the bin entry in package.json will expose this
// as `tianshu`.

import {
  GlobalOps,
  InvalidTenantIdError,
  TenantAlreadyExistsError,
  TenantNotFoundError,
  getTianshuHome,
} from "./core/index.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=", 2);
      options[k!] = v ?? "true";
    } else {
      positional.push(arg);
    }
  }
  const [command, ...rest] = positional;
  return { command: command ?? "", positional: rest, options };
}

function usage(): string {
  return [
    "Usage:",
    "  tianshu tenant list",
    "  tianshu tenant create <id>",
    "  tianshu tenant delete <id>",
    "  tianshu user create <tenantId> <userId> [--provider=dev] [--external-id=<x>] [--display-name=<n>]",
    "",
    `TIANSHU_HOME currently resolves to: ${getTianshuHome()}`,
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
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
        console.error("missing <id>\n" + usage());
        return 2;
      }
      const ctx = ops.create(id);
      console.log(`created tenant ${ctx.tenantId} at ${ctx.root}`);
      return 0;
    }
    if (parsed.command === "tenant" && parsed.positional[0] === "delete") {
      const id = parsed.positional[1];
      if (!id) {
        console.error("missing <id>\n" + usage());
        return 2;
      }
      ops.softDelete(id);
      console.log(`soft-deleted tenant ${id} (renamed to ${id}.deleted.<ts>)`);
      return 0;
    }
    if (parsed.command === "user" && parsed.positional[0] === "create") {
      const [, tenantId, userId] = parsed.positional;
      if (!tenantId || !userId) {
        console.error("missing <tenantId> or <userId>\n" + usage());
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
    console.error(usage());
    return parsed.command === "" ? 0 : 2;
  } catch (err) {
    if (err instanceof InvalidTenantIdError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    if (err instanceof TenantAlreadyExistsError || err instanceof TenantNotFoundError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    return 1;
  } finally {
    ops.closePool();
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
