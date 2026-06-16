// Public surface of the LSP service. Importers use the singleton
// returned by `getLSPManager()`; the underlying class is exported
// for tests.

import { LSPManager } from "./manager.js";

export { LSPManager } from "./manager.js";
export {
  allLanguages,
  languageForFile,
  type LanguageDefinition,
} from "./language-registry.js";
export type {
  DiagnoseInput,
  DiagnoseResult,
  LSPManagerOptions,
} from "./manager.js";
export { formatDiagnostics } from "./format.js";

let singleton: LSPManager | undefined;

/** Returns the process-wide LSPManager. Created lazily on first
 *  call so test harnesses that don't touch LSP don't pay the
 *  spawn-interval cost.
 *
 *  The singleton is host-wide (not per-tenant) — tenant scoping
 *  is enforced inside the manager via the tenantId argument on
 *  every call.
 *
 *  Honours TIANSHU_LSP_ENABLED env var: when set to "0" or "false"
 *  the manager is created with `enabled: false`, which short-
 *  circuits diagnoseAfterEdit to a no-op. */
export function getLSPManager(): LSPManager {
  if (!singleton) {
    const flag = (process.env.TIANSHU_LSP_ENABLED ?? "").toLowerCase();
    const enabled = flag !== "0" && flag !== "false";
    singleton = new LSPManager({ enabled });
  }
  return singleton;
}

/** Test-only: replace the singleton (or clear it). */
export function _setLSPManagerForTests(m: LSPManager | undefined): void {
  singleton = m;
}
