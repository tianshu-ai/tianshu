// LSPManager — host-level service that owns LSP client lifecycles.
// Plugins (currently `files` for edit/write diagnostics; later
// possibly workboard or a refactor plugin) call into the manager
// via a small typed interface and never touch raw LSP state.
//
// Responsibilities:
//   1. **Tenant isolation.** Each pool entry is keyed by
//      (tenantId, languageId, workspaceRoot). Two tenants editing
//      same-named files at independent paths get independent
//      processes — there is no shared LSP instance.
//   2. **Root resolution.** Walk up from the edited file looking
//      for the language's root markers (`tsconfig.json`, `go.mod`,
//      `pyproject.toml`, …). Stop at the tenant workspace root —
//      we never hand a server a root above the tenant boundary,
//      ever.
//   3. **Pool & eviction.** LRU-cap at N per tenant + N global.
//      Idle eviction after IDLE_MS so a tenant that opens 8
//      languages briefly doesn't pay the resident cost forever.
//   4. **Bootstrap.** First time a `(language)` is needed and the
//      binary is missing on PATH, run the documented install
//      command once per host process. On failure, surface a clear
//      "diagnostics-unavailable: <reason>" so callers can pass it
//      through to the agent. We do not retry.
//   5. **diagnoseAfterEdit().** The single entry point edit/write
//      tools use: hand a file path + new contents, get back a
//      formatted diagnostic block (or undefined if LSP wasn't
//      able to help).
//
// Anti-goals:
//   - LSP completion / hover / go-to-def. Out of scope for v0.1.
//   - Workspace mirroring. We only push files the agent edits.
//   - Sandbox-internal LSP. v0.1 LSP only sees host paths under
//     /data/workspaces/<tenantId>/.

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LSPClient } from "./client.js";
import { formatDiagnostics } from "./format.js";
import {
  allLanguages,
  languageForFile,
  type LanguageDefinition,
} from "./language-registry.js";

const DIAGNOSTICS_TIMEOUT_MS = 3_000;
const DIAGNOSTICS_DEBOUNCE_MS = 150;
const DEFAULT_PER_TENANT_CAP = 8;
const DEFAULT_GLOBAL_CAP = 64;
const IDLE_EVICTION_MS = 10 * 60 * 1000;

type ManagerLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

const noLog: ManagerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface LSPManagerOptions {
  /** Logger; falls back to no-op. */
  log?: ManagerLogger;
  /** Per-tenant LSP process cap. */
  perTenantCap?: number;
  /** Global LSP process cap. */
  globalCap?: number;
  /** Master kill-switch. When false the manager pretends all
   *  languages are uninstalled (`diagnoseAfterEdit` returns
   *  undefined immediately). Used to disable LSP per-tenant or
   *  globally without uninstalling anything. */
  enabled?: boolean;
}

export interface DiagnoseInput {
  tenantId: string;
  /** Workspace root for the tenant (absolute). The manager will
   *  refuse to spawn an LS rooted above this path. */
  tenantWorkspaceRoot: string;
  /** Absolute path of the file the agent just edited/wrote. */
  filePath: string;
  /** New contents of the file (post-edit). The manager will push
   *  these to the LS via didChange before requesting diagnostics. */
  contents: string;
}

export interface DiagnoseResult {
  /** Formatted diagnostic text suitable to append to a tool
   *  result. Empty string when LSP returned no diagnostics. */
  text: string;
  /** True if LSP returned at least one ERROR-severity diagnostic.
   *  Callers may use this for downstream "did this edit break
   *  the build?" decisions. */
  hasErrors: boolean;
  /** Set when diagnostics were unavailable for a known reason.
   *  Manager-side outages (auto-install failed, LS crashed, etc.)
   *  populate this so the tool can surface a one-liner instead of
   *  silently dropping the diagnostics block. */
  unavailable?: string;
}

interface PoolEntry {
  key: string;
  tenantId: string;
  language: LanguageDefinition;
  root: string;
  client: LSPClient;
  createdAt: number;
}

/** Auto-install state per language id, host-wide. */
type InstallState = "unknown" | "ok" | "missing" | "install-failed";

export class LSPManager {
  private opts: Required<Omit<LSPManagerOptions, "log">> & {
    log: ManagerLogger;
  };
  private pool = new Map<string, PoolEntry>();
  /** LRU order: most recently used at the end. */
  private lru: string[] = [];
  private installState = new Map<string, InstallState>();
  private installAttempted = new Set<string>();
  /** Background eviction interval handle. */
  private sweeper?: NodeJS.Timeout;

  constructor(opts: LSPManagerOptions = {}) {
    this.opts = {
      log: opts.log ?? noLog,
      perTenantCap: opts.perTenantCap ?? DEFAULT_PER_TENANT_CAP,
      globalCap: opts.globalCap ?? DEFAULT_GLOBAL_CAP,
      enabled: opts.enabled ?? true,
    };
    if (this.opts.enabled) {
      // Periodic idle sweep; cheap and bounded.
      this.sweeper = setInterval(
        () => this.sweepIdle(),
        Math.max(IDLE_EVICTION_MS / 4, 30_000),
      ).unref?.();
    }
  }

  /** Edit/write tool entry point. Returns a diagnose result; the
   *  caller should append `result.text` to the tool output if
   *  non-empty, and surface `result.unavailable` (if set) as a
   *  one-liner. Never throws — we catch and degrade. */
  async diagnoseAfterEdit(input: DiagnoseInput): Promise<DiagnoseResult> {
    if (!this.opts.enabled) {
      return { text: "", hasErrors: false };
    }
    try {
      const lang = languageForFile(input.filePath);
      if (!lang) {
        return { text: "", hasErrors: false };
      }
      // Boundary check FIRST — we don't want to spawn an install
      // (or anything else) for a file we'd have refused anyway.
      const root = this.resolveRoot(
        input.filePath,
        input.tenantWorkspaceRoot,
        lang,
      );
      if (!root) {
        return {
          text: "",
          hasErrors: false,
          unavailable: "file is outside the tenant workspace boundary",
        };
      }
      // Install gate. Only block on the first attempt per host.
      const installed = this.ensureInstalled(lang);
      if (!installed.ok) {
        return {
          text: "",
          hasErrors: false,
          unavailable: `${lang.displayName} not available: ${installed.reason}`,
        };
      }

      const entry = await this.getOrCreate(input.tenantId, lang, root);
      const editedAt = Date.now();
      entry.client.notifyChanged(input.filePath, input.contents);
      // Small debounce so a server that publishes synchronously
      // on didChange has time to dispatch its message.
      await sleep(DIAGNOSTICS_DEBOUNCE_MS);
      const diags = await entry.client.waitForDiagnostics(
        input.filePath,
        editedAt,
        DIAGNOSTICS_TIMEOUT_MS,
      );
      if (!diags) {
        return { text: "", hasErrors: false };
      }
      const text = formatDiagnostics(diags);
      const hasErrors = diags.some((d) => (d.severity ?? 1) === 1);
      return { text, hasErrors };
    } catch (err) {
      this.opts.log.error(
        `lsp: diagnoseAfterEdit failed: ${(err as Error).message}`,
      );
      return {
        text: "",
        hasErrors: false,
        unavailable: `LSP error: ${(err as Error).message}`,
      };
    }
  }

  /** Shut every pooled client down. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    const entries = [...this.pool.values()];
    this.pool.clear();
    this.lru = [];
    await Promise.all(entries.map((e) => e.client.close()));
  }

  /** Test/debug surface: number of pooled processes. */
  poolSize(): number {
    return this.pool.size;
  }

  // ─── Internals ──────────────────────────────────────────────

  private ensureInstalled(
    lang: LanguageDefinition,
  ): { ok: true } | { ok: false; reason: string } {
    const cached = this.installState.get(lang.id);
    if (cached === "ok") return { ok: true };
    if (cached === "install-failed") {
      return { ok: false, reason: "install previously failed" };
    }

    if (whichSync(lang.command)) {
      this.installState.set(lang.id, "ok");
      return { ok: true };
    }

    if (this.installAttempted.has(lang.id)) {
      this.installState.set(lang.id, "install-failed");
      return { ok: false, reason: "binary not on PATH after install attempt" };
    }
    this.installAttempted.add(lang.id);
    this.opts.log.info(
      `lsp: ${lang.displayName} missing — running '${lang.installCommand}'`,
    );
    try {
      // Inherit stdio so the user can see install progress; we
      // don't capture output. Synchronous because install is a
      // first-edit blocking concern.
      execSync(lang.installCommand, { stdio: "inherit" });
    } catch (err) {
      this.opts.log.error(
        `lsp: install of ${lang.displayName} failed: ${(err as Error).message}`,
      );
      this.installState.set(lang.id, "install-failed");
      return { ok: false, reason: `install command failed` };
    }
    if (!whichSync(lang.command)) {
      this.installState.set(lang.id, "install-failed");
      return {
        ok: false,
        reason: `${lang.command} still not on PATH after install`,
      };
    }
    this.installState.set(lang.id, "ok");
    return { ok: true };
  }

  /** Walk up from `filePath` to find the closest root marker for
   *  this language, never crossing `tenantRoot`. Returns
   *  `tenantRoot` if no marker found before the boundary.
   *  Returns undefined if `filePath` is outside `tenantRoot`. */
  private resolveRoot(
    filePath: string,
    tenantRoot: string,
    lang: LanguageDefinition,
  ): string | undefined {
    const tenantNorm = path.resolve(tenantRoot);
    const fileNorm = path.resolve(filePath);
    if (
      fileNorm !== tenantNorm &&
      !fileNorm.startsWith(tenantNorm + path.sep)
    ) {
      return undefined;
    }
    let dir = path.dirname(fileNorm);
    while (true) {
      for (const marker of lang.rootMarkers) {
        if (fs.existsSync(path.join(dir, marker))) {
          return dir;
        }
      }
      if (dir === tenantNorm) return tenantNorm;
      const parent = path.dirname(dir);
      if (parent === dir) return tenantNorm; // hit fs root
      dir = parent;
    }
  }

  private async getOrCreate(
    tenantId: string,
    lang: LanguageDefinition,
    root: string,
  ): Promise<PoolEntry> {
    const key = poolKey(tenantId, lang.id, root);
    let entry = this.pool.get(key);
    if (entry && entry.client.isClosed()) {
      // Server died since we last looked. Drop and recreate.
      this.removeEntry(key);
      entry = undefined;
    }
    if (entry) {
      this.touchLru(key);
      return entry;
    }

    // Capacity check. Per-tenant first, then global.
    this.evictIfOverCap(tenantId);

    const client = new LSPClient({ language: lang, root, log: this.opts.log });
    await client.init();
    entry = {
      key,
      tenantId,
      language: lang,
      root,
      client,
      createdAt: Date.now(),
    };
    this.pool.set(key, entry);
    this.lru.push(key);
    return entry;
  }

  private touchLru(key: string): void {
    const idx = this.lru.indexOf(key);
    if (idx >= 0) this.lru.splice(idx, 1);
    this.lru.push(key);
  }

  private removeEntry(key: string): void {
    const entry = this.pool.get(key);
    if (!entry) return;
    this.pool.delete(key);
    const idx = this.lru.indexOf(key);
    if (idx >= 0) this.lru.splice(idx, 1);
    void entry.client.close();
  }

  private evictIfOverCap(addingTenantId: string): void {
    const tenantEntries = [...this.pool.values()].filter(
      (e) => e.tenantId === addingTenantId,
    );
    while (tenantEntries.length >= this.opts.perTenantCap) {
      // Oldest in LRU among this tenant.
      const oldest = this.lru.find((k) => {
        const e = this.pool.get(k);
        return e !== undefined && e.tenantId === addingTenantId;
      });
      if (!oldest) break;
      this.removeEntry(oldest);
      const idx = tenantEntries.findIndex((e) => e.key === oldest);
      if (idx >= 0) tenantEntries.splice(idx, 1);
    }
    while (this.pool.size >= this.opts.globalCap && this.lru.length > 0) {
      const oldest = this.lru[0]!;
      this.removeEntry(oldest);
    }
  }

  private sweepIdle(): void {
    for (const [key, entry] of this.pool) {
      if (entry.client.idleMs() > IDLE_EVICTION_MS) {
        this.opts.log.info(
          `lsp: evicting idle ${entry.language.id} for tenant ${entry.tenantId}`,
        );
        this.removeEntry(key);
      } else if (entry.client.isClosed()) {
        this.removeEntry(key);
      }
    }
  }
}

function poolKey(tenantId: string, langId: string, root: string): string {
  return `${tenantId}::${langId}::${root}`;
}

function whichSync(cmd: string): boolean {
  // Cross-platform "is this binary on PATH". Avoid posix-only `which`.
  const probe = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [cmd] : ["-v", cmd];
  try {
    const r = spawnSync(probe, args, { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export for callers that want to inspect the registry directly.
export { allLanguages, languageForFile, type LanguageDefinition };
