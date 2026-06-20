// Microsandbox readiness check.
//
// Two modes:
//   - quick:  npm package importable + the platform-specific
//             native binding loads. ~30-50ms. Default.
//   - full:   actually boot an alpine sandbox, run `echo`, tear
//             down. ~30s on a cold machine (image pull). Off by
//             default; enable with `tianshu doctor --probe-sandbox`.
//
// Why import-based, not file-path-based:
// The original check looked for `~/.microsandbox/bin/msb`. That
// path is what `npx microsandbox install` populates as a fallback
// for installs where the platform-specific optional dep failed
// to land. On a normal install (`npm install` succeeded, optional
// dep `@superradcompany/microsandbox-<triple>` is present), the
// SDK uses the bundled NAPI binary and never touches that path.
// So the file-path check produced a false negative on a healthy
// install and recommended `npx microsandbox install` — which on
// modern microsandbox versions is `msb install <image>` (a
// completely different command), making the recommendation
// actively harmful.

import { CheckGroup } from "../render.js";

export interface SandboxCheckOpts {
  /** Run a real boot + exec rather than the import-presence probe. */
  full?: boolean;
  /** Timeout for full-mode boot. Default 60s. */
  fullTimeoutMs?: number;
}

export async function checkSandbox(
  opts: SandboxCheckOpts = {},
): Promise<CheckGroup> {
  const lines: CheckGroup["lines"] = [];

  let mod: typeof import("microsandbox") | null = null;
  try {
    mod = await import("microsandbox");
  } catch (err) {
    lines.push({
      severity: "warning",
      text: "microsandbox SDK not available",
      detail:
        `import('microsandbox') failed: ${err instanceof Error ? err.message : String(err)}\n` +
        "Run `npm install` from the tianshu checkout. The SDK + the platform-specific binary " +
        "(`@superradcompany/microsandbox-<triple>`) install together as optional deps.",
    });
    return { title: "Sandbox", lines };
  }

  // Confirm the platform binding actually loaded by touching one
  // of the SDK's classes. import('microsandbox') succeeds even
  // when the native dep is missing — the load error surfaces only
  // when you try to use it. Check now rather than wait for the
  // first build to fail.
  if (typeof (mod as { Sandbox?: unknown }).Sandbox !== "function") {
    lines.push({
      severity: "warning",
      text: "microsandbox SDK loaded but Sandbox class missing",
      detail:
        "The platform-specific binary (@superradcompany/microsandbox-<triple>) may have failed " +
        "to install. Re-run `npm install` from the tianshu checkout; if that still fails, set " +
        "MSB_PATH to a manually installed msb binary.",
    });
    return { title: "Sandbox", lines };
  }

  lines.push({
    severity: "ok",
    text: "microsandbox SDK loaded",
    detail: "platform-specific binding ready",
  });

  if (opts.full) {
    const result = await fullProbe(mod, opts.fullTimeoutMs ?? 60_000);
    if (result.ok) {
      lines.push({
        severity: "ok",
        text: "alpine quick-boot succeeded",
        detail: `${result.durationMs}ms`,
      });
    } else {
      lines.push({
        severity: "blocker",
        text: "alpine quick-boot failed",
        detail: result.error,
      });
    }
  }

  return { title: "Sandbox", lines };
}

interface ProbeResult {
  ok: boolean;
  durationMs: number;
  error?: string;
}

async function fullProbe(
  mod: typeof import("microsandbox"),
  timeoutMs: number,
): Promise<ProbeResult> {
  const start = Date.now();
  const { Sandbox } = mod;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // Low-spec alpine: 1 CPU, 256 MiB. Fast enough to be a probe.
    const sb = await Sandbox.builder("tianshu-doctor-probe")
      .image("alpine")
      .create();
    try {
      await sb.shell("echo doctor-ok");
    } finally {
      await sb.stop().catch(() => {});
    }
    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error:
        err instanceof Error
          ? err.name === "AbortError"
            ? `timeout after ${timeoutMs}ms`
            : err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
