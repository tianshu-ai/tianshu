// Build / use agent tools.
//
// Workflow (per ADR design 2026-06-07):
//
//   1. agent edits <userHome>/sandbox/Sandboxfile via the existing
//      file tools (write_file / edit_file) — same per-user fs
//      surface, no new fs primitive needed.
//   2. agent calls `build_sandbox` → plugin reads the Sandboxfile,
//      runs apt/pip/npm/exec inside a short-lived builder VM,
//      captures a Snapshot in microsandbox's DB, drops a metadata
//      json under <userHome>/sandbox/builds/<id>.json. Tenant state
//      not touched.
//   3. agent calls `list_sandbox_builds` to review past builds.
//   4. agent (or a tenant admin) calls `publish_sandbox(build_id)`
//      → plugin writes <tenant>/_tenant/sandbox/current.json
//      pointer. Next sandbox restart (reset_sandbox / next session)
//      starts from the in-use snapshot via fromSnapshot(...).

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { Type } from "typebox";
import {
  errorResult,
  okResult,
  type AgentTool,
  type AgentToolContext,
} from "@tianshu-ai/plugin-sdk";
import {
  buildSnapshot,
  BuildFailedError,
  snapshotExists,
} from "../build/builder.js";
import {
  parseSandboxfile,
  SandboxfileError,
  type SandboxSpec,
} from "../build/sandboxfile.js";
import {
  listBuildMetadata,
  readBuildMetadata,
  writeBuildMetadata,
  type BuildMetadata,
} from "../build/metadata.js";
import {
  pointerPath,
  readPointer,
  writePointer,
  type SandboxPointer,
} from "../build/pointer.js";

const DEFAULT_SANDBOXFILE_REL = "sandbox/Sandboxfile";

// ─── helpers ───────────────────────────────────────────────────

function tenantWorkspaceDir(ctx: AgentToolContext): string {
  // <tenantHomeDir>/tenants/<tenantId>/workspace — same layout
  // microsandbox runner uses for its bind mount.
  return path.join(
    ctx.tenantHomeDir,
    "tenants",
    ctx.tenantId,
    "workspace",
  );
}

function pickBuildId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function loadSpec(
  ctx: AgentToolContext,
  relPath: string,
): Promise<{ spec: SandboxSpec; sourcePath: string } | { error: string }> {
  const full = path.resolve(ctx.userHomeDir, relPath.replace(/^\/+/, ""));
  if (!full.startsWith(ctx.userHomeDir)) {
    return { error: `Sandboxfile path "${relPath}" escapes user home` };
  }
  let raw: string;
  try {
    raw = await fs.readFile(full, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { error: `Sandboxfile not found at ${relPath}` };
    }
    throw err;
  }
  try {
    return { spec: parseSandboxfile(raw), sourcePath: relPath };
  } catch (err) {
    if (err instanceof SandboxfileError) return { error: err.message };
    throw err;
  }
}

// ─── build_sandbox ─────────────────────────────────────────────

export const BuildSandboxTool: AgentTool = {
  schema: {
    name: "build_sandbox",
    description: `Build a custom sandbox image from your Sandboxfile.

Reads <user-home>/sandbox/Sandboxfile (or whatever \`spec_path\` points at), \
boots a short-lived builder VM from the spec's base image, runs the apt/pip/npm/exec \
steps in order, captures a snapshot into microsandbox's local store, and drops a \
metadata json under <user-home>/sandbox/builds/<build_id>.json so you can list the \
result later.

This does NOT change the tenant's currently-running sandbox \u2014 your build is \
private to you until you call \`publish_sandbox(build_id)\`.

Sandboxfile shape (YAML-ish, v0):
\`\`\`yaml
image: python:3.12-slim          # required
cpus: 4                          # optional, default 4
memory_mib: 4096                 # optional, default 4096
apt: [libreoffice-writer, fonts-noto-cjk]
pip: [pandas, numpy]
npm: [tsx, typescript]
exec:
  - cp /workspace/users/<your-userId>/sandbox/my.whl /tmp/
  - pip install /tmp/my.whl
\`\`\`

Returns the build id, snapshot name, base image, and a tail of the build log.`,
    parameters: Type.Object({
      spec_path: Type.Optional(
        Type.String({
          description: `Path to the Sandboxfile, relative to your user home. Default "${DEFAULT_SANDBOXFILE_REL}".`,
        }),
      ),
    }),
  },

  async available(ctx) {
    return ctx.capabilities.has("sandbox.shell");
  },

  async execute(args, ctx) {
    const specPath = ((args as { spec_path?: unknown }).spec_path as string) ??
      `/${DEFAULT_SANDBOXFILE_REL}`;
    const loaded = await loadSpec(ctx, specPath);
    if ("error" in loaded) return errorResult(loaded.error);

    const buildId = pickBuildId();
    const sandboxName = `tianshu-${ctx.tenantId}`;
    const wsDir = tenantWorkspaceDir(ctx);

    // Capture every onLog line. The host doesn't yet stream
    // tool-internal log lines to the chat UI, but we (a) tee them
    // through ctx.log.info for the server console, and (b) include
    // a tail (or full body on failure) in the agent-visible result
    // so the agent isn't staring at a black box for 5+ minutes.
    const log: string[] = [];
    const onLog = (line: string) => {
      log.push(line);
      ctx.log.info(`[build_sandbox] ${line}`);
    };

    try {
      const result = await buildSnapshot({
        spec: loaded.spec,
        sandboxName,
        buildId,
        tenantId: ctx.tenantId,
        workspaceDir: wsDir,
        onLog,
      });
      const meta: BuildMetadata = {
        buildId,
        snapshotName: result.snapshotName,
        baseImage: result.baseImage,
        builtAt: new Date().toISOString(),
        durationMs: result.durationMs,
        logTail: result.logTail,
        sandboxfilePath: loaded.sourcePath,
      };
      await writeBuildMetadata(ctx.userHomeDir, meta);
      return okResult(
        `Built ${result.snapshotName} in ${(result.durationMs / 1000).toFixed(1)}s. ` +
          `Run publish_sandbox("${buildId}") to make it the tenant's active sandbox image.\n\n` +
          `Build log tail:\n${result.logTail}`,
        meta,
      );
    } catch (err) {
      if (err instanceof BuildFailedError) {
        // Surface the failing step + stderr in the human-visible
        // text. The agent reads `text` first; previously this only
        // had "build failed: <step>" with the stderr stashed in the
        // structured payload, which several models silently ignored.
        const tail = log.slice(-40).join("\n");
        return errorResult(
          `build failed: ${err.message}\n\n` +
            `--- stderr ---\n${err.stderr}\n` +
            `--- last log lines ---\n${tail}`,
          { stderr: err.stderr, logTail: tail },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`build threw: ${msg}`);
    }
  },
};

// ─── list_sandbox_builds ───────────────────────────────────────

export const ListSandboxBuildsTool: AgentTool = {
  schema: {
    name: "list_sandbox_builds",
    description: `List past sandbox builds in your user home, newest first. Each row \
includes build id, base image, build time, duration, and whether it's currently \
in use as the tenant's sandbox image.`,
    parameters: Type.Object({}),
  },

  async available(ctx) {
    return ctx.capabilities.has("sandbox.shell");
  },

  async execute(_args, ctx) {
    const builds = await listBuildMetadata(ctx.userHomeDir);
    const wsDir = tenantWorkspaceDir(ctx);
    const pointer = await readPointer(wsDir);
    const enriched = builds.map((b) => ({
      build_id: b.buildId,
      snapshot_name: b.snapshotName,
      base_image: b.baseImage,
      built_at: b.builtAt,
      duration_ms: b.durationMs,
      sandboxfile_path: b.sandboxfilePath,
      published: pointer ? pointer.snapshotName === b.snapshotName : false,
    }));
    if (enriched.length === 0) {
      return okResult("No builds yet. Use build_sandbox to make one.", {
        builds: [],
        published: pointer?.snapshotName ?? null,
      });
    }
    const summary =
      `${enriched.length} build(s); in use: ${pointer?.snapshotName ?? "(none)"}\n` +
      enriched
        .map(
          (b) =>
            `  ${b.published ? "*" : " "} ${b.build_id}  ${b.base_image}  ${(b.duration_ms / 1000).toFixed(1)}s`,
        )
        .join("\n");
    return okResult(summary, { builds: enriched, published: pointer?.snapshotName ?? null });
  },
};

// ─── use_sandbox_build ─────────────────────────────────────────

export const UseSandboxBuildTool: AgentTool = {
  schema: {
    name: "use_sandbox_build",
    description: `Switch the tenant to a previously-built sandbox image. Writes \
<tenant>/_tenant/sandbox/current.json so the next reset_sandbox (or the next \
session) boots from this snapshot instead of the configured default image.

This is a tenant-scoped switch — it does not publish anything outside the \
tenant. The currently-running sandbox VM is **not** automatically restarted. \
Call \`reset_sandbox\` after this to make it live now.`,
    parameters: Type.Object({
      build_id: Type.String({
        description:
          "Build id from list_sandbox_builds (e.g. \"20260607-084230\"). Use list_sandbox_builds first if you don't remember.",
      }),
    }),
  },

  async available(ctx) {
    return ctx.capabilities.has("sandbox.shell");
  },

  async execute(args, ctx) {
    const buildId = String((args as { build_id?: unknown }).build_id ?? "");
    if (!buildId) return errorResult("build_id is required");

    const meta = await readBuildMetadata(ctx.userHomeDir, buildId);
    if (!meta) {
      return errorResult(
        `build "${buildId}" not found in your home (run list_sandbox_builds to see what's available)`,
      );
    }
    const exists = await snapshotExists(meta.snapshotName);
    if (!exists) {
      return errorResult(
        `snapshot "${meta.snapshotName}" no longer exists in microsandbox; rebuild with build_sandbox`,
      );
    }
    const wsDir = tenantWorkspaceDir(ctx);
    const pointer: SandboxPointer = {
      snapshotName: meta.snapshotName,
      baseImage: meta.baseImage,
      // Field names on disk stay publishedAt/publishedBy to keep
      // existing pointer files readable without a migration. The
      // user-facing terminology is "in use" / "switch".
      publishedAt: new Date().toISOString(),
      publishedBy: ctx.userId,
    };
    await writePointer(wsDir, pointer);
    return okResult(
      `Switched tenant to ${meta.snapshotName}. Call reset_sandbox to apply it to the running VM.`,
      { pointer, pointerPath: pointerPath(wsDir) },
    );
  },
};
