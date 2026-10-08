// Barrel re-export for all pi-compat modules.
//
// Consumers import from "./pi-compat/index.js" to get the locally
// maintained types and functions that were removed from
// @earendil-works/pi-agent-core 1.0.

export {
  type Context,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "./context.js";

export {
  // Entry types
  type EntryType,
  type EntryBase,
  type MessageEntry,
  type CompactionEntry,
  type BranchSummaryEntry,
  type CustomEntry,
  type Entry,
  type NewEntry,
  // Value / KV types
  type StoredAddressBase,
  type Value,
  type ValueList,
  type StoredValue,
  type ListElement,
  type ListCursor,
  type ListReadOptions,
  // Write types
  type ValueSetWrite,
  type ValueDeleteWrite,
  type ListAppendWrite,
  type ListDeleteWrite,
  type ValueWrite,
  type ListWrite,
  type EntryWrite,
  type UsageWrite,
  type Write,
  // Scan / Stats types
  type CommitResult,
  type SessionStats,
  type EntryStructure,
  type EntryCursor,
  type BranchScan,
  type StorageBranchScan,
  type EntryScan,
  type UsageRow,
  type UsageScan,
  // Storage
  type Storage,
  // Session types
  type SessionMetadata,
  type IdGenerator,
  type EntryQuery,
  type Branch,
  type SessionReader,
  type SessionMutation,
  type SessionMutator,
  type SessionMutationCallback,
  type Session,
  type ForkOptions,
  type SessionRepo,
  // Runtime class
  StorageBackedSession,
} from "./session-types.js";

export {
  // Compaction types
  type CompactionSettings,
  type ContextUsageEstimate,
  type CompactResult,
  type FileOperations,
  type CompactionPreparation,
  // Compaction constants
  DEFAULT_COMPACTION_SETTINGS,
  // Compaction functions
  calculateContextTokens,
  estimateTokens,
  estimateContextTokens,
  shouldCompact,
} from "./compaction.js";

export {
  // Result
  type Result,
  ok,
  err,
  // Error classes
  type FileErrorCode,
  FileError,
  type ExecutionErrorCode,
  ExecutionError,
  // Filesystem types
  type FileKind,
  type FileInfo,
  type TextLine,
  type TextLineReader,
  // Shell types
  type ShellExecOptions,
  type ShellExecResult,
  // ExecutionEnv
  type ExecutionEnv,
} from "./execution-env.js";
