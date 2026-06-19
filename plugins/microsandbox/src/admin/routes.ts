// HTTP route handlers for the MicroSandbox admin page.
//
// These mirror the agent-tool surface (build_sandbox /
// list_sandbox_builds / use_sandbox_build / reset_sandbox) but for
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
  readPointers,
  writePointer,
  writePointers,
  type SandboxPointer,
  type SandboxRole,
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
  /** Active per-task SandboxPool. The route layer uses it for the
   *  task-pool monitoring page. May be null when microsandbox
   *  hasn't activated yet. */
  getPool?(): import("../runner/pool.js").SandboxPool | null;
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

  // GET /builds → each build is annotated with `roles: { browser, task }`
  // booleans so the UI can render the per-role pills. The legacy
  // `published` field stays on the wire (== browser-role pointer)
  // for backwards compat with older clients reading via that name.
  const getBuilds = async (req: Request, res: Response) => {
    const c = ctx(req);
    if (!c) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const home = userHomeDir(deps, c.userId);
    try {
      const builds = await listBuildMetadata(home);
      const pointers = await readPointers(deps.workspaceDir);
      const enriched = builds.map((b) => {
        const browserActive = pointers.browser?.snapshotName === b.snapshotName;
        const taskActive = pointers.task?.snapshotName === b.snapshotName;
        return {
          ...b,
          // Legacy field — older UIs / scripts read this.
          published: browserActive,
          roles: {
            browser: browserActive,
            task: taskActive,
          },
        };
      });
      res.json({
        builds: enriched,
        // Legacy field; matches the browser pointer.
        published: pointers.browser,
        pointers,
      });
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
    // Optional: layer this build on top of an existing snapshot
    // instead of pulling Sandboxfile's `image:` from the
    // registry. Accepts the snapshot name, not the build id, so
    // the UI sends e.g. `tianshu-default-build-20260619-abc123`.
    const fromSnapshotParam =
      typeof req.query.from_snapshot === "string"
        ? req.query.from_snapshot.trim()
        : typeof (req.body as { from_snapshot?: unknown })?.from_snapshot ===
            "string"
          ? ((req.body as { from_snapshot: string }).from_snapshot).trim()
          : "";
    const fromSnapshot: string | undefined = fromSnapshotParam || undefined;

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

      send({
        type: "start",
        buildId,
        image: spec.image,
        ...(fromSnapshot ? { fromSnapshot } : {}),
      });

      try {
        const result = await buildSnapshot({
          spec,
          sandboxName: deps.sandboxName,
          buildId,
          tenantId: deps.tenantId,
          workspaceDir: deps.workspaceDir,
          onLog: (line) => send({ type: "log", line }),
          fromSnapshot,
        });
        const meta: BuildMetadata = {
          buildId,
          snapshotName: result.snapshotName,
          baseImage: result.baseImage,
          builtAt: new Date().toISOString(),
          durationMs: result.durationMs,
          logTail: result.logTail,
          sandboxfilePath,
          ...(fromSnapshot ? { basedOnSnapshot: fromSnapshot } : {}),
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
        fromSnapshot,
      });
      const meta: BuildMetadata = {
        buildId,
        snapshotName: result.snapshotName,
        baseImage: result.baseImage,
        builtAt: new Date().toISOString(),
        durationMs: result.durationMs,
        logTail: result.logTail,
        sandboxfilePath,
        ...(fromSnapshot ? { basedOnSnapshot: fromSnapshot } : {}),
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

  // POST /builds/use?build_id=…[&reset=1] → mark a build as the
  // one this tenant uses. With reset=1 we also tear down + restart
  // the live VM so the new snapshot takes effect immediately;
  // without it the pointer is updated but the live VM still runs
  // the old image until the next manual reset (or process restart).
  // We use a query string instead of a path param because v0's
  // plugin route dispatcher does literal-path matching (no `:id`).
  //
  // Why "use" and not "publish": this is a tenant-internal switch,
  // not an external publication. "Publish" implied broadcasting
  // outside the tenant.
  const postUseBuild = async (req: Request, res: Response) => {
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
    // Which role pointer(s) to update. Defaults to `both` to
    // preserve pre-split behaviour where one snapshot served both
    // the long-lived browser sandbox and (future) per-task pool.
    const roleParam =
      typeof req.query.role === "string" ? req.query.role : "both";
    const targetRoles: SandboxRole[] =
      roleParam === "browser"
        ? ["browser"]
        : roleParam === "task"
          ? ["task"]
          : roleParam === "both"
            ? ["browser", "task"]
            : ([] as SandboxRole[]);
    if (targetRoles.length === 0) {
      res.status(400).json({
        error: "invalid_role",
        message: `role must be one of: browser, task, both (got ${JSON.stringify(roleParam)})`,
      });
      return;
    }
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
      // Read current state then patch only the selected roles, so
      // toggling "task" doesn't accidentally clobber "browser" (and
      // vice-versa).
      const currentPointers = await readPointers(deps.workspaceDir);
      const nextPointers = { ...currentPointers };
      for (const role of targetRoles) {
        nextPointers[role] = pointer;
      }
      await writePointers(deps.workspaceDir, nextPointers);

      // Optional reset: bring the live VM down and back up so it
      // boots fromSnapshot(<just-selected>). Without this the
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
        pointers: nextPointers,
        roles: targetRoles,
        pointerPath: pointerPath(deps.workspaceDir),
        reset: resetResult,
      });
    } catch (err) {
      res.status(500).json({
        error: "use_build_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // POST /reset → forces the running runner to reset (restart from
  // the in-use build pointer or the configured default image). Mirrors
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
  //     currently in use.
  //   - `build_id` set: spin up a short-lived preview VM
  //     `fromSnapshot(<that build's snapshot>)`, run the command,
  //     tear it down. Lets the user sanity-check a build before
  //     switching the tenant to it.
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

  // GET /task-pool — list every per-task microVM tracked by the
  // pool plus any orphan tianshu-task-* VMs still on disk. Useful
  // when an operator wants to see what sandboxes are around
  // (running, stopped, or zombie from a prior process incarnation).
  const getTaskPool = async (req: Request, res: Response) => {
    const c = ctx(req);
    if (!c) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const pool = deps.getPool?.();
    const inMemory = pool ? pool.list() : [];
    const inMemoryByName = new Map(
      inMemory.map((e) => [e.sandboxName, e]),
    );
    // Merge with the SDK's view: there can be sandboxes on disk
    // (named `tianshu-task-<tenantId>-*`) that aren't in our
    // in-memory pool yet — e.g. residual VMs from the previous
    // process run that we haven't acquireTask'd this incarnation.
    type Entry = {
      taskId: string;
      sandboxName: string;
      // pool's view ("running"/"stopped"/"starting"/"error" or
      // "orphan" when the SDK knows about it but the pool doesn't)
      poolState: string;
      // SDK's stored status string ("started"/"stopped"/…)
      sdkStatus: string | null;
      createdAt: string | null;
      startError: string | null;
    };
    const merged: Entry[] = [];
    const taskPrefix = `tianshu-task-${deps.tenantId}-`;
    try {
      const sdkMod = await import("microsandbox").catch(() => null);
      const Sandbox: { list?: () => Promise<unknown[]> } | undefined = (
        sdkMod as { Sandbox?: { list?: () => Promise<unknown[]> } } | null
      )?.Sandbox;
      if (Sandbox?.list) {
        const handles = (await Sandbox.list()) as Array<{
          name: string;
          status?: string;
          createdAt?: Date | string | null;
        }>;
        for (const h of handles) {
          if (!h.name.startsWith(taskPrefix)) continue;
          const taskId = h.name.slice(taskPrefix.length);
          const inMem = inMemoryByName.get(h.name);
          merged.push({
            taskId,
            sandboxName: h.name,
            poolState: inMem ? inMem.state : "orphan",
            sdkStatus: typeof h.status === "string" ? h.status : null,
            createdAt:
              h.createdAt instanceof Date
                ? h.createdAt.toISOString()
                : typeof h.createdAt === "string"
                  ? h.createdAt
                  : null,
            startError: inMem?.startError ?? null,
          });
        }
      }
    } catch (err) {
      // SDK unavailable (probe failed or not installed) — fall
      // back to whatever we have in memory.
    }
    // Also fold in pool entries that the SDK didn't return (rare;
    // can happen when the VM was created out-of-band and the SDK
    // index is stale). Avoids hiding state from the operator.
    for (const inMem of inMemory) {
      if (merged.some((e) => e.sandboxName === inMem.sandboxName)) continue;
      merged.push({
        taskId: inMem.taskId,
        sandboxName: inMem.sandboxName,
        poolState: inMem.state,
        sdkStatus: null,
        createdAt: null,
        startError: inMem.startError,
      });
    }
    // Sort newest-first by createdAt (nulls last).
    merged.sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      if (a.createdAt) return -1;
      if (b.createdAt) return 1;
      return a.sandboxName.localeCompare(b.sandboxName);
    });
    res.json({ entries: merged });
  };

  // POST /task-pool/destroy?sandbox_name=<name> — stop + remove
  // a per-task microVM. Used by the admin UI's "Forget" button on
  // orphan / stopped task sandboxes.
  const postTaskPoolDestroy = async (req: Request, res: Response) => {
    const c = ctx(req);
    if (!c) {
      res.status(401).json({ error: "no_user" });
      return;
    }
    const sandboxName =
      typeof req.query.sandbox_name === "string"
        ? req.query.sandbox_name
        : "";
    if (!sandboxName) {
      res.status(400).json({ error: "missing_sandbox_name" });
      return;
    }
    const taskPrefix = `tianshu-task-${deps.tenantId}-`;
    if (!sandboxName.startsWith(taskPrefix)) {
      res.status(400).json({
        error: "unsupported_sandbox",
        message: `only ${taskPrefix}* sandboxes can be destroyed via this route`,
      });
      return;
    }
    const taskId = sandboxName.slice(taskPrefix.length);
    const pool = deps.getPool?.();
    try {
      if (pool) {
        // The pool path stops + removes; if the entry isn't in
        // memory it falls through to a direct Sandbox.remove.
        await pool.destroyTask(taskId);
      } else {
        // Pool not active — best-effort SDK remove so an orphan
        // VM can still be reclaimed.
        const sdkMod = await import("microsandbox").catch(() => null);
        const Sandbox = (
          sdkMod as {
            Sandbox?: {
              get?: (name: string) => Promise<{ remove(): Promise<void> }>;
            };
          } | null
        )?.Sandbox;
        if (Sandbox?.get) {
          const handle = await Sandbox.get(sandboxName);
          await handle.remove();
        }
      }
      res.json({ ok: true, sandboxName });
    } catch (err) {
      res.status(500).json({
        error: "destroy_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    getSandboxfile,
    putSandboxfile,
    getBuilds,
    postBuilds,
    postUseBuild,
    postReset,
    postExec,
    getTaskPool,
    postTaskPoolDestroy,
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
