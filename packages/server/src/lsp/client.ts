// Minimal LSP client: spawn a language-server process, run the
// initialize handshake, push file contents via didOpen/didChange,
// listen for publishDiagnostics, expose a synchronous-ish
// `waitForDiagnostics(file, timeoutMs)` for the edit/write tools.
//
// Modelled on OpenCode's lsp/client.ts (sst/opencode) but trimmed:
//   - push diagnostics only (no pull / textDocument/diagnostic);
//     all three v0.1 servers (typescript / gopls / pyright)
//     publish without us asking.
//   - no dynamic capability registration listener.
//   - no document version tracking; we send incrementing ints
//     and don't validate echoes.
//   - hard timeouts at every blocking step so a wedged LS can't
//     wedge an edit_file call.
//
// The client is owned by LSPManager: one per (tenant, language,
// root) tuple. The client doesn't know about tenants — that
// scoping happens one layer up.

import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";
import type { LanguageDefinition } from "./language-registry.js";

const INIT_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

export type { Diagnostic };

export interface LSPClientOptions {
  language: LanguageDefinition;
  /** Workspace root the LS will be scoped to. Absolute path,
   *  must be inside the tenant's workspace boundary (caller
   *  enforces). */
  root: string;
  /** Optional logger. Falls back to no-op. */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

interface OpenDoc {
  version: number;
  uri: string;
  languageId: string;
}

const noLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class LSPClient {
  private proc: ChildProcess;
  private conn: MessageConnection;
  private opts: LSPClientOptions;
  private log: NonNullable<LSPClientOptions["log"]>;

  /** Latest diagnostics keyed by absolute file path, replaced on
   *  every publishDiagnostics. */
  private diagnostics = new Map<string, Diagnostic[]>();

  /** Wall-clock ms of the most recent publish per file, used by
   *  `waitForDiagnostics` to know "is this fresh?" */
  private lastPublishMs = new Map<string, number>();

  /** Pending listeners waiting for a fresh publish for a given file. */
  private waiters = new Map<string, Array<() => void>>();

  /** Files we've already sent didOpen for. */
  private openDocs = new Map<string, OpenDoc>();

  private initialized = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private lastUsedMs = Date.now();

  constructor(opts: LSPClientOptions) {
    this.opts = opts;
    this.log = opts.log ?? noLog;

    this.proc = spawn(opts.language.command, [...opts.language.args], {
      cwd: opts.root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      if (code !== 0 && code !== null) {
        this.log.warn(
          `lsp[${opts.language.id}] exited code=${code} signal=${signal}`,
        );
      }
    });
    this.proc.on("error", (err) => {
      this.log.error(`lsp[${opts.language.id}] spawn error: ${String(err)}`);
      this.closed = true;
    });
    this.proc.stderr?.on("data", (buf) => {
      // gopls and pyright are noisy on stderr; downgrade to debug.
      // We keep this discardable but log at debug level.
      const text = buf.toString("utf8").trim();
      if (text) this.log.info(`lsp[${opts.language.id}] stderr: ${text}`);
    });

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error(
        `LSPClient: spawn produced no stdio for ${opts.language.id}`,
      );
    }
    this.conn = createMessageConnection(
      new StreamMessageReader(this.proc.stdout),
      new StreamMessageWriter(this.proc.stdin),
    );

    // Diagnostics: route every publish into the local map and
    // wake up any waiter that's parked on this file.
    this.conn.onNotification(
      "textDocument/publishDiagnostics",
      (params: { uri: string; diagnostics: Diagnostic[] }) => {
        const filePath = uriToPath(params.uri);
        if (!filePath) return;
        this.diagnostics.set(filePath, params.diagnostics);
        this.lastPublishMs.set(filePath, Date.now());
        const ws = this.waiters.get(filePath);
        if (ws) {
          this.waiters.delete(filePath);
          for (const w of ws) w();
        }
      },
    );

    // Workspace folders + configuration: replies that satisfy
    // most servers' init expectations without us configuring
    // anything tenant-specific.
    this.conn.onRequest(
      "workspace/workspaceFolders",
      async (): Promise<Array<{ name: string; uri: string }>> => [
        { name: "workspace", uri: pathToFileURL(opts.root).href },
      ],
    );
    this.conn.onRequest("workspace/configuration", async () => null);
    this.conn.onRequest("client/registerCapability", async () => null);
    this.conn.onRequest("client/unregisterCapability", async () => null);
    this.conn.onRequest("window/workDoneProgress/create", async () => null);

    this.conn.listen();
  }

  /** Run the LSP initialize handshake. Throws on timeout. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    const rootUri = pathToFileURL(this.opts.root).href;
    await withTimeout(
      this.conn.sendRequest("initialize", {
        processId: this.proc.pid ?? null,
        rootUri,
        workspaceFolders: [{ name: "workspace", uri: rootUri }],
        capabilities: {
          textDocument: {
            synchronization: { didOpen: true, didChange: true },
            publishDiagnostics: { versionSupport: false },
          },
          workspace: {
            configuration: true,
            workspaceFolders: true,
          },
        },
      }),
      INIT_TIMEOUT_MS,
      `lsp[${this.opts.language.id}] initialize timed out`,
    );
    this.conn.sendNotification("initialized", {});
    this.initialized = true;
    this.log.info(
      `lsp[${this.opts.language.id}] ready (root=${this.opts.root})`,
    );
  }

  /** Tell the LS the contents of a file. First call is didOpen;
   *  subsequent calls are didChange (full sync). */
  notifyChanged(absPath: string, contents: string): void {
    if (!this.initialized || this.closed) return;
    this.lastUsedMs = Date.now();
    const uri = pathToFileURL(absPath).href;
    const existing = this.openDocs.get(absPath);
    if (!existing) {
      this.conn.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.opts.language.id,
          version: 1,
          text: contents,
        },
      });
      this.openDocs.set(absPath, {
        version: 1,
        uri,
        languageId: this.opts.language.id,
      });
      return;
    }
    existing.version += 1;
    this.conn.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text: contents }],
    });
  }

  /** Block up to `timeoutMs` for diagnostics fresh enough to
   *  reflect the most recent `notifyChanged`. Returns whatever's
   *  in the cache for this file (may be empty array if no errors,
   *  or null if no publish ever arrived). */
  async waitForDiagnostics(
    absPath: string,
    sinceMs: number,
    timeoutMs: number,
  ): Promise<Diagnostic[] | null> {
    this.lastUsedMs = Date.now();
    const last = this.lastPublishMs.get(absPath) ?? 0;
    if (last >= sinceMs) {
      return this.diagnostics.get(absPath) ?? null;
    }
    return new Promise<Diagnostic[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(absPath, wake);
        resolve(this.diagnostics.get(absPath) ?? null);
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve(this.diagnostics.get(absPath) ?? null);
      };
      const ws = this.waiters.get(absPath) ?? [];
      ws.push(wake);
      this.waiters.set(absPath, ws);
    });
  }

  private removeWaiter(absPath: string, w: () => void): void {
    const ws = this.waiters.get(absPath);
    if (!ws) return;
    const idx = ws.indexOf(w);
    if (idx >= 0) ws.splice(idx, 1);
    if (ws.length === 0) this.waiters.delete(absPath);
  }

  /** ms since last activity, used by manager LRU/idle eviction. */
  idleMs(): number {
    return Date.now() - this.lastUsedMs;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      try {
        if (this.initialized && !this.closed) {
          // Best-effort graceful shutdown; ignore failures.
          await Promise.race([
            this.conn.sendRequest("shutdown"),
            new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
          ]).catch(() => undefined);
          try {
            this.conn.sendNotification("exit");
          } catch {
            /* ignored */
          }
        }
      } finally {
        try {
          this.conn.dispose();
        } catch {
          /* ignored */
        }
        if (!this.closed) {
          this.proc.kill("SIGTERM");
          this.closed = true;
        }
      }
    })();
    return this.closePromise;
  }
}

function uriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    const u = new URL(uri);
    return path.normalize(decodeURIComponent(u.pathname));
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  err: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(err)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
