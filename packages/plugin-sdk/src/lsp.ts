// Plugin-side surface of the host's `host.lsp` capability.
//
// The host (server/src/lsp/) owns the LSP manager: spawning,
// pooling, tenant-scoping, auto-install, debounce, formatting.
// Plugins don't see any of that; they just call
// `diagnoseAfterEdit({filePath, contents})` and append the
// returned text to their tool result.
//
// The capability is exclusive (one provider per host) and the
// only consumer today is `plugins/files`. We expose it through
// SDK types so a future plugin (say a refactor tool) doesn't
// have to re-import server internals to consume diagnostics.
//
// Failure model: the call NEVER throws. LSP outages, missing
// language servers, timeouts — all degrade to a cleanly-typed
// result with `unavailable` set. The plugin's tool reports
// success on the underlying edit regardless.

export interface LspDiagnoseInput {
  /** Absolute path of the file the agent just wrote/edited.
   *  Must live under the calling tenant's workspace; the host
   *  refuses paths above the tenant boundary as a safety
   *  measure (ADR-0005 §multi-tenancy). */
  filePath: string;
  /** Post-edit contents of the file. Pushed to the LS via
   *  `textDocument/didChange` before requesting diagnostics. */
  contents: string;
}

export interface LspDiagnoseResult {
  /** Formatted diagnostic block suitable to append to tool
   *  output. Empty string when the LS reported no diagnostics
   *  or when LSP didn't run for this file (no matching
   *  language, capability disabled, etc). */
  text: string;
  /** True if at least one diagnostic was ERROR-severity. Plugins
   *  may use this to flag the tool result without dropping the
   *  edit's success state. */
  hasErrors: boolean;
  /** Set when diagnostics were unavailable for a known reason
   *  (missing binary, LS crashed, timeout). The plugin should
   *  surface this as a one-line note, not a tool failure. */
  unavailable?: string;
}

/** The shape registered at `host.lsp`. */
export interface LspCapability {
  /** Diagnose `input.filePath` and return formatted output.
   *  Always resolves; never throws. */
  diagnoseAfterEdit(input: LspDiagnoseInput): Promise<LspDiagnoseResult>;
}
