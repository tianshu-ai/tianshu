// `tianshu doctor` — full diagnostic command.
//
// Runs every check, renders a clack-style report, and (when called
// from the CLI) exits with a meaningful code:
//   0 — all OK or only warnings
//   1 — at least one blocker
//
// Two flavours:
//   - `runDoctor()` — full diagnostic; called from CLI
//   - `runQuickReadinessCheck()` — startup hook; runs only the
//     synchronous, no-network checks needed to refuse a server
//     boot when LLM provider is missing or config is unparseable.

import * as p from "@clack/prompts";
import {
  CheckGroup,
  renderGroup,
  renderOutro,
  tallyGroups,
} from "./render.js";
import { checkRuntime } from "./checks/runtime.js";
import { checkVersion } from "./checks/version.js";
import { checkConfig } from "./checks/config.js";
import { checkProviders } from "./checks/providers.js";
import { checkNetwork } from "./checks/network.js";
import { checkSandbox } from "./checks/sandbox.js";
import {
  discoverPluginSetupSpecs,
  evaluatePluginSetup,
  pluginSetupToCheckGroup,
} from "./checks/plugin-setup.js";
import { getBuiltinConfigDir } from "../core/plugins/discovery.js";
import * as path from "node:path";
import { checkTenants } from "./checks/tenants.js";
import { checkDb } from "./checks/db.js";
import { checkAuth } from "./checks/auth.js";

export interface DoctorOpts {
  /** When true, hit each provider's /v1/models endpoint to test
   *  reachability + auth. Default false (skip — slow). */
  probeProviders?: boolean;
  /** When true, boot a real microsandbox VM as a smoke test.
   *  Pulls the alpine image on first run; ~30s. Default false. */
  probeSandbox?: boolean;
  /** Skip the npm-registry probe for new versions. Default
   *  false (do check). Useful for offline / CI runs. */
  skipVersionCheck?: boolean;
  /** Emit JSON instead of the clack ASCII report. */
  json?: boolean;
}

export interface DoctorReport {
  groups: CheckGroup[];
  ok: number;
  warning: number;
  blocker: number;
}

export async function collectDoctorReport(
  opts: DoctorOpts = {},
): Promise<DoctorReport> {
  const groups: CheckGroup[] = [];
  groups.push(checkRuntime());
  groups.push(await checkVersion({ skipRemote: opts.skipVersionCheck }));
  groups.push(checkConfig());
  groups.push(
    await checkProviders({
      probe: opts.probeProviders,
    }),
  );
  groups.push(await checkNetwork());
  groups.push(await checkSandbox({ full: opts.probeSandbox }));
  groups.push(checkTenants());
  groups.push(checkDb());
  groups.push(checkAuth());
  // Per-plugin host prerequisites (manifest.setup). Plugins that
  // don't declare a setup spec contribute nothing here. Verify
  // probes have a 5s/command timeout so a hung daemon can't wedge
  // the doctor; see plugin-setup.ts for the kill-on-group fix.
  const pluginsRoot = path.join(getBuiltinConfigDir(), "plugins");
  const setupSpecs = discoverPluginSetupSpecs(pluginsRoot);
  for (const spec of setupSpecs) {
    const status = await evaluatePluginSetup(
      spec.pluginId,
      spec.displayName,
      spec.spec,
    );
    groups.push(pluginSetupToCheckGroup(status));
  }
  const tally = tallyGroups(groups);
  return { groups, ...tally };
}

/** Pretty-printed CLI doctor. Returns the exit code. */
export async function runDoctor(opts: DoctorOpts = {}): Promise<number> {
  const report = await collectDoctorReport(opts);
  if (opts.json) {
    // Stable, scriptable shape — keep field names compatible
    // across versions.
    process.stdout.write(
      JSON.stringify(
        {
          ok: report.ok,
          warning: report.warning,
          blocker: report.blocker,
          groups: report.groups,
        },
        null,
        2,
      ) + "\n",
    );
    return report.blocker > 0 ? 1 : 0;
  }
  p.intro("Tianshu doctor");
  for (const g of report.groups) renderGroup(g);
  const tally = { ok: report.ok, warning: report.warning, blocker: report.blocker };
  const suggestion =
    report.blocker > 0
      ? "Run `tianshu setup --wizard` for an interactive fix, or edit the files mentioned above."
      : report.warning > 0
        ? "Warnings are advisory — `tianshu start` should still work."
        : undefined;
  renderOutro(tally, suggestion);
  return report.blocker > 0 ? 1 : 0;
}

/** Synchronous-ish startup hook: only the checks that don't need
 *  external IO (no provider /v1/models probe, no sandbox boot).
 *  Used by `tianshu start` / `npm run dev` to refuse to start when
 *  the config is plainly broken. */
export async function runQuickReadinessCheck(): Promise<{
  ok: boolean;
  blockers: { title: string; lines: CheckGroup["lines"] }[];
}> {
  const groups: CheckGroup[] = [
    checkRuntime(),
    checkConfig(),
    await checkProviders({ probe: false }),
  ];
  const blockers = groups
    .map((g) => ({
      title: g.title,
      lines: g.lines.filter((l) => l.severity === "blocker"),
    }))
    .filter((g) => g.lines.length > 0);
  return { ok: blockers.length === 0, blockers };
}
