// HTTP route handlers for the MicroSandbox admin page.
//
// These mirror the agent-tool surface (build_sandbox /
// list_sandbox_builds / publish_sandbox / reset_sandbox) but for
// human use from the chat shell's `/admin` UI. We don't try to
// abstract a single "operations" layer between the two — the agent
// tools already encapsulate the workflow nicely, and the routes
// have to deal with HTTP-shaped concerns the tools don't (status
// codes, header-shaped errors). They share the underlying build
// helpers (sandboxfile parser, builder, metadata, pointer) instead.

import * as path from "node:path";
import type { Request, Response } from "express";
import type { SandboxRunner } from "@tianshu/plugin-sdk";
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
import {
  readSandboxfile,
  writeSandboxfile,
} from "./sandboxfile-io.js";
import { previewExec } from "./preview-exec.js";

export interface AdminRoutesDeps {
  /** The active runner exposed by the plugin's activate() — used
   *  for /reset and for status snapshots. May be the nullable
   *  runner if the SDK isn't available. */
  getRunner(): SandboxRunner | null;
  /** Tenant id, captured from the activation context. */
  tenantId: string;
  /** Tenant workspace dir (host fs). Builders bind-mount this. */
  workspaceDir: string;
  /** Tenant root dir. Used to resolve the per-user home for the
   *  current request: `<tenantHomeDir>/tenants/<tenantId>/workspace/users/<userId>`.
   *  Express middleware leaves the userId on `req.ctx.userId`. */
  tenantHomeDir: string;
  /** Stable sandbox name used by the runner; builders prefix from
   *  this so concurrent builds don't collide. */
  sandboxName: string;
}

interface RequestCtx {
  userId: string;
}

function ctx(req: Request): RequestCtx | null {
  // The host's tenantMiddleware leaves `req.ctx = { tenant, userId }`.
  // We don't reach for the full type here to avoid a server-side
  // import in plugin code.
  const c = (req as unknown as { ctx?: { userId?: string } }).ctx;
  if (!c?.userId) return null;
  return { userId: c.userId };
}

function userHomeDir(deps: AdminRoutesDeps, userId: string): string {
  // Same layout the agent tool helpers and runner use.
  return path.join(
    deps.tenantHomeDir,
    "tenants",
    deps.tenantId,
    "workspace",
    "users",
    userId,
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

// ─── routes ────────────────────────────────────────────────────

export function buildAdminRoutes(deps: AdminRoutesDeps) {
  // GET /sandboxfile → { content, exists, path }
  const getSandboxfile = async (req: Request, res: Response) => {
    const c = ctx(req);
    if (!c) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const home = userHomeDir(deps, c.userId);
    try {
      const r = await readSandboxfile(home);
      res.json(r);
    } catch (err) {
      res.status(500).json({
        error: "read_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // PUT /sandboxfile  body: { content }
  const putSandboxfile = async (req: Request, res: Response) => {
    const c = ctx(req);
    if (!c) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const body = req.body as { content?: unknown } | undefined;
    if (typeof body?.content !== "string") {
      res.status(400).json({ error: "missing_content_string" });
      return;
    }
    // Eager-parse as feedback so the user knows whether they just
    // saved a Sandboxfile that won't build. We still write it — the
    // user might be saving a draft — but surface the parse error
    // alongside the success response.
    let parseError: string | null = null;
    try {
      parseSandboxfile(body.content);
    } catch (err) {
      parseError =
        err instanceof SandboxfileError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
    }
    const home = userHomeDir(deps, c.userId);
    try {
      const r = await writeSandboxfile(home, body.content);
      res.json({ ok: true, path: r.path, parseError });
    } catch (err) {
      res.status(500).json({
        error: "write_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // GET /builds → { builds: BuildMetadata[], published: SandboxPointer | null }
  const getBuilds = async (req: Request, res: Response) => {
    const c = ctx(req);
    if (!c) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const home = userHomeDir(deps, c.userId);
    try {
      const builds = await listBuildMetadata(home);
      const pointer = await readPointer(deps.workspaceDir);
      const enriched = builds.map((b) => ({
        ...b,
        published: pointer ? pointer.snapshotName === b.snapshotName : false,
      }));
      res.json({ builds: enriched, published: pointer });
    } catch (err) {
      res.status(500).json({
        error: "list_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // POST /builds  → kick off a build.
  //
  // Two response modes share the same endpoint so we don't have to
  // mint a second route in the manifest:
  //
  //   - default (no `stream` query): block until done, return one
  //     JSON envelope { ok, build }. Test-friendly and equivalent to
  //     the agent-tool path.
  //   - `?stream=1` (or any truthy `stream`): respond with NDJSON
  //     events as the build progresses, one JSON object per line:
  //       {"type":"start","buildId":"…"}
  //       {"type":"log","line":"[builder] apt-get install …"}
  //       …
  //       {"type":"done","build":{…}}                # success
  //       {"type":"error","message":"…","stderr":"…"} # failure
  //     The HTTP status is always 200 in stream mode — callers
  //     decide success from the final event — because we've already
  //     sent the headers by the time the build outcome is known.
  const postBuilds = async (req: Request, res: Response) => {
    const c = ctx(req);
    if (!c) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    if (!deps.getRunner()) {
      res.status(503).json({ error: "runner_not_ready" });
      return;
    }
    const home = userHomeDir(deps, c.userId);
    let spec: SandboxSpec;
    let sandboxfilePath: string;
    try {
      const sf = await readSandboxfile(home);
      if (!sf.exists) {
        res
          .status(400)
          .json({ error: "no_sandboxfile", message: "Save a Sandboxfile first." });
        return;
      }
      spec = parseSandboxfile(sf.content);
      sandboxfilePath = sf.path;
    } catch (err) {
      const message =
        err instanceof SandboxfileError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      res.status(400).json({ error: "sandboxfile_invalid", message });
      return;
    }

    const buildId = pickBuildId();
    const stream =
      req.query.stream !== undefined &&
      req.query.stream !== "" &&
      req.query.stream !== "0" &&
      req.query.stream !== "false";

    if (stream) {
      // NDJSON stream. Set headers up front so the browser starts
      // rendering as soon as the first chunk lands; flush manually
      // after each write because Express + Node's default chunked
      // encoding will otherwise buffer until the stream closes.
      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      // Express's compression middleware (when present) buffers
      // unless we mark the response as no-transform; we set the
      // header above and also call flushHeaders so the client sees
      // 200 immediately.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = res as any;
      if (typeof r.flushHeaders === "function") r.flushHeaders();

      const send = (obj: Record<string, unknown>): void => {
        try {
          res.write(`${JSON.stringify(obj)}\n`);
          if (typeof r.flush === "function") r.flush();
        } catch {
          /* socket gone; let the build finish anyway */
        }
      };

      send({ type: "start", buildId, image: spec.image });

      try {
        const result = await buildSnapshot({
          spec,
          sandboxName: deps.sandboxName,
          buildId,
          tenantId: deps.tenantId,
          workspaceDir: deps.workspaceDir,
          onLog: (line) => send({ type: "log", line }),
        });
        const meta: BuildMetadata = {
          buildId,
          snapshotName: result.snapshotName,
          baseImage: result.baseImage,
          builtAt: new Date().toISOString(),
          durationMs: result.durationMs,
          logTail: result.logTail,
          sandboxfilePath,
        };
        await writeBuildMetadata(home, meta);
        send({ type: "done", build: meta });
      } catch (err) {
        if (err instanceof BuildFailedError) {
          send({ type: "error", message: err.message, stderr: err.stderr });
        } else {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        res.end();
      }
      return;
    }

    // Buffered mode — unchanged from the original implementation.
    try {
      const result = await buildSnapshot({
        spec,
        sandboxName: deps.sandboxName,
        buildId,
        tenantId: deps.tenantId,
        workspaceDir: deps.workspaceDir,
      });
      const meta: BuildMetadata = {
        buildId,
        snapshotName: result.snapshotName,
        baseImage: result.baseImage,
        builtAt: new Date().toISOString(),
        durationMs: result.durationMs,
        logTail: result.logTail,
        sandboxfilePath,
      };
      await writeBuildMetadata(home, meta);
      res.json({ ok: true, build: meta });
    } catch (err) {
      if (err instanceof BuildFailedError) {
        res
          .status(422)
          .json({ error: "build_failed", message: err.message, stderr: err.stderr });
        return;
      }
      res.status(500).json({
        error: "build_threw",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // POST /builds/publish?build_id=…[&reset=1] → makes the build the
  // active sandbox image. With reset=1 we also tear down + restart
  // the live VM so the new snapshot takes effect immediately;
  // without it the pointer is updated but the live VM still runs
  // the old image until the next manual reset (or process restart).
  // We use a query string instead of a path param because v0's
  // plugin route dispatcher does literal-path matching (no `:id`).
  const postPublish = async (req: Request, res: Response) => {
    const c = ctx(req);
    if (!c) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const buildId =
      typeof req.query.build_id === "string" ? req.query.build_id : "";
    if (!buildId) {
      res.status(400).json({ error: "missing_build_id" });
      return;
    }
    const wantReset =
      req.query.reset !== undefined &&
      req.query.reset !== "" &&
      req.query.reset !== "0" &&
      req.query.reset !== "false";
    const home = userHomeDir(deps, c.userId);
    let meta: BuildMetadata | null;
    try {
      meta = await readBuildMetadata(home, buildId);
    } catch (err) {
      res.status(500).json({
        error: "read_metadata_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!meta) {
      res.status(404).json({ error: "build_not_found", buildId });
      return;
    }
    try {
      const exists = await snapshotExists(meta.snapshotName);
      if (!exists) {
        res.status(410).json({
          error: "snapshot_missing",
          message: `snapshot "${meta.snapshotName}" no longer exists; rebuild first`,
        });
        return;
      }
      const pointer: SandboxPointer = {
        snapshotName: meta.snapshotName,
        baseImage: meta.baseImage,
        publishedAt: new Date().toISOString(),
        publishedBy: c.userId,
      };
      await writePointer(deps.workspaceDir, pointer);

      // Optional reset: bring the live VM down and back up so it
      // boots fromSnapshot(<just-published>). Without this the
      // pointer is durable but the running VM stays on the old
      // image until something else triggers a restart.
      let resetResult: "skipped" | "ok" | { failed: string } = "skipped";
      if (wantReset) {
        const runner = deps.getRunner();
        if (!runner) {
          resetResult = { failed: "runner_not_ready" };
        } else {
          try {
            await runner.reset();
            resetResult = "ok";
          } catch (err) {
            resetResult = {
              failed: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }

      res.json({
        ok: true,
        pointer,
        pointerPath: pointerPath(deps.workspaceDir),
        reset: resetResult,
      });
    } catch (err) {
      res.status(500).json({
        error: "publish_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // POST /reset → forces the running runner to reset (restart from
  // the published pointer or the configured default image). Mirrors
  // the agent's `reset_sandbox` tool.
  const postReset = async (_req: Request, res: Response) => {
    const runner = deps.getRunner();
    if (!runner) {
      res.status(503).json({ error: "runner_not_ready" });
      return;
    }
    try {
      await runner.reset();
      const status = await runner.status();
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({
        error: "reset_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // POST /exec  body: { command, workdir?, timeoutMs?, build_id? }
  // Run a one-shot command. Two execution modes share the same
  // endpoint:
  //
  //   - `build_id` omitted (default): run inside the tenant's live
  //     sandbox VM. Cheap, immediate, but reflects whatever is
  //     currently published.
  //   - `build_id` set: spin up a short-lived preview VM
  //     `fromSnapshot(<that build's snapshot>)`, run the command,
  //     tear it down. Lets the user sanity-check a build before
  //     calling publish.
  //
  // We cap the per-call timeout at 5 minutes; the live runner
  // honors that natively, and previews ignore it (no SDK timeout
  // hook in v0.4.x) but cap the boot+run+teardown sequence with
  // their own internal handling.
  const ADMIN_EXEC_DEFAULT_TIMEOUT_MS = 60_000;
  const ADMIN_EXEC_MAX_TIMEOUT_MS = 5 * 60_000;
  const ADMIN_EXEC_OUTPUT_BYTE_CAP = 256 * 1024;

  const postExec = async (req: Request, res: Response) => {
    const c = ctx(req);
    if (!c) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const body = req.body as
      | {
          command?: unknown;
          workdir?: unknown;
          timeoutMs?: unknown;
          build_id?: unknown;
        }
      | undefined;
    const command = typeof body?.command === "string" ? body.command : "";
    if (!command.trim()) {
      res.status(400).json({ error: "missing_command" });
      return;
    }
    const workdir =
      typeof body?.workdir === "string" && body.workdir.length > 0
        ? body.workdir
        : undefined;
    let timeoutMs: number = ADMIN_EXEC_DEFAULT_TIMEOUT_MS;
    if (typeof body?.timeoutMs === "number" && Number.isFinite(body.timeoutMs)) {
      timeoutMs = Math.max(1, Math.floor(body.timeoutMs));
    }
    if (timeoutMs > ADMIN_EXEC_MAX_TIMEOUT_MS) {
      timeoutMs = ADMIN_EXEC_MAX_TIMEOUT_MS;
    }
    const buildId =
      typeof body?.build_id === "string" && body.build_id.length > 0
        ? body.build_id
        : null;

    const half = Math.floor(ADMIN_EXEC_OUTPUT_BYTE_CAP / 2);

    if (buildId) {
      // Preview mode: boot a short-lived VM from the build's
      // snapshot. The live VM is untouched.
      const home = userHomeDir(deps, c.userId);
      let meta;
      try {
        meta = await readBuildMetadata(home, buildId);
      } catch (err) {
        res.status(500).json({
          error: "read_metadata_failed",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (!meta) {
        res.status(404).json({ error: "build_not_found", buildId });
        return;
      }
      try {
        const exists = await snapshotExists(meta.snapshotName);
        if (!exists) {
          res.status(410).json({
            error: "snapshot_missing",
            message: `snapshot "${meta.snapshotName}" no longer exists; rebuild first`,
          });
          return;
        }
        const r = await previewExec({
          snapshotName: meta.snapshotName,
          command,
          workdir,
          workspaceDir: deps.workspaceDir,
          sandboxNamePrefix: deps.sandboxName,
          timeoutMs,
        });
        res.json({
          ok: r.exitCode === 0 && !r.timedOut,
          exitCode: r.exitCode,
          stdout: capUtf8(r.stdout, half),
          stderr: capUtf8(r.stderr, half),
          durationMs: r.durationMs,
          timedOut: r.timedOut,
          target: { kind: "build", buildId, snapshotName: meta.snapshotName },
        });
      } catch (err) {
        res.status(500).json({
          error: "preview_exec_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Live mode (default).
    const runner = deps.getRunner();
    if (!runner) {
      res.status(503).json({ error: "runner_not_ready" });
      return;
    }
    try {
      const r = await runner.exec({ command, workdir, timeoutMs });
      // Cap stdout/stderr so a runaway command can't pin the
      // browser. Each capped to ~128 KB; agent has its own caps
      // upstream of this for tool calls.
      res.json({
        ok: r.exitCode === 0 && !r.timedOut,
        exitCode: r.exitCode,
        stdout: capUtf8(r.stdout, half),
        stderr: capUtf8(r.stderr, half),
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        target: { kind: "live" },
      });
    } catch (err) {
      res.status(500).json({
        error: "exec_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    getSandboxfile,
    putSandboxfile,
    getBuilds,
    postBuilds,
    postPublish,
    postReset,
    postExec,
  };
}

/** Truncate from the head so the most recent output stays visible.
 *  Adds a marker line when truncation occurs. */
function capUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  const sliced = buf.subarray(buf.byteLength - maxBytes).toString("utf8");
  return `[… ${buf.byteLength - maxBytes} bytes truncated …]\n${sliced}`;
}
