// ExecutionEnv types extracted from pi-agent-core 0.87.1.
//
// pi-agent-core 1.0 removed the harness layer including ExecutionEnv,
// FileError, ExecutionError, and Result. Tianshu's stub-execution-env
// module still needs these contracts to provide the harness's
// filesystem/shell stub (which rejects all calls with "not_supported").

import type { Context } from "./context.js";

// ─── Result ───────────────────────────────────────────────────

/** Result of a fallible operation. Expected failures are returned as `ok: false` instead of thrown. */
export type Result<TValue, TError> =
  | { ok: true; value: TValue }
  | { ok: false; error: TError };

/** Create a successful {@link Result}. */
export function ok<TValue, TError>(
  value: TValue,
): Result<TValue, TError> {
  return { ok: true, value };
}

/** Create a failed {@link Result}. */
export function err<TValue, TError>(
  error: TError,
): Result<TValue, TError> {
  return { ok: false, error };
}

// ─── FileError ────────────────────────────────────────────────

/** Stable, backend-independent file error codes. */
export type FileErrorCode =
  | "aborted"
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "unknown";

/** Error returned by {@link FileSystem} file operations. */
export class FileError extends Error {
  /** Backend-independent error code. */
  code: FileErrorCode;
  /** Absolute addressed path associated with the failure, when available. */
  path?: string;
  constructor(
    code: FileErrorCode,
    message: string,
    path?: string,
    cause?: Error,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FileError";
    this.code = code;
    this.path = path;
  }
}

// ─── ExecutionError ───────────────────────────────────────────

/** Stable, backend-independent execution error codes. */
export type ExecutionErrorCode =
  | "aborted"
  | "timeout"
  | "shell_unavailable"
  | "spawn_error"
  | "callback_error"
  | "unknown";

/** Error returned by {@link ExecutionEnv.exec}. */
export class ExecutionError extends Error {
  /** Backend-independent error code. */
  code: ExecutionErrorCode;
  constructor(
    code: ExecutionErrorCode,
    message: string,
    cause?: Error,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExecutionError";
    this.code = code;
  }
}

// ─── Filesystem types ─────────────────────────────────────────

export type FileKind = "file" | "directory" | "symlink";

export interface FileInfo {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

export interface TextLine {
  text: string;
  terminated: boolean;
}

export interface TextLineReader {
  readLine(
    context: Context,
  ): Promise<Result<TextLine | undefined, FileError>>;
  close(context: Context): Promise<void>;
}

// ─── Shell types (minimal) ────────────────────────────────────

export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeout?: number;
  capture?: unknown;
  onUpdate?: unknown;
}

export interface ShellExecResult {
  exitCode: number;
  truncation?: unknown;
  spillPath?: string;
  lastLineBytes?: number;
}

// ─── ExecutionEnv ─────────────────────────────────────────────

/**
 * Filesystem and process execution environment used by the harness.
 * Tianshu uses a stub that rejects every call; this interface exists
 * solely to type that stub.
 */
export interface ExecutionEnv {
  cwd: string;
  absolutePath(
    path: string,
    context: Context,
  ): Promise<Result<string, FileError>>;
  joinPath(
    parts: string[],
    context: Context,
  ): Promise<Result<string, FileError>>;
  readTextFile(
    path: string,
    context: Context,
  ): Promise<Result<string, FileError>>;
  openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>>;
  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>>;
  readBinaryFile(
    path: string,
    context: Context,
  ): Promise<Result<Uint8Array, FileError>>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>>;
  appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>>;
  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>>;
  fileInfo(
    path: string,
    context: Context,
  ): Promise<Result<FileInfo, FileError>>;
  listDir(
    path: string,
    context: Context,
  ): Promise<Result<FileInfo[], FileError>>;
  canonicalPath(
    path: string,
    context: Context,
  ): Promise<Result<string, FileError>>;
  exists(
    path: string,
    context: Context,
  ): Promise<Result<boolean, FileError>>;
  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>>;
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>>;
  createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>>;
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>>;
  exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>>;
  cleanup(context: Context): Promise<void>;
}
