// Stub `ExecutionEnv` for pi-agent-core's harness.
//
// The harness's filesystem + shell capabilities are meant for
// agent-driven file/exec ops. In tianshu, those flows go through
// plugin tools (the `files` plugin reads/writes via tool calls,
// `microsandbox` runs commands via tool calls). The harness itself
// does NOT need filesystem/shell access — its only references to
// `env` are inside system-prompt callbacks and a few hooks that we
// don't use.
//
// So we hand it a stub that:
//   * fails every fs/shell call with `not_supported`
//   * exposes `cwd` so any callback that reads it gets a sane path
//
// If a future feature actually needs filesystem ops at the
// harness level, we'll route them through the `files` plugin's
// capability instead of growing this stub.

import type {
  ExecutionEnv,
  FileError,
  ExecutionError,
} from "@earendil-works/pi-agent-core";
import { FileError as FileErrorClass, ExecutionError as ExecutionErrorClass } from "@earendil-works/pi-agent-core";
import type { Result } from "@earendil-works/pi-agent-core";

function fileErr(message: string): Result<never, FileError> {
  return {
    ok: false,
    error: new FileErrorClass("not_supported", message),
  };
}

function execErr(message: string): Result<never, ExecutionError> {
  return {
    ok: false,
    error: new ExecutionErrorClass("shell_unavailable", message),
  };
}

export function makeStubExecutionEnv(cwd: string): ExecutionEnv {
  return {
    cwd,
    async absolutePath() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async joinPath() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async readTextFile() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async readTextLines() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async readBinaryFile() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async writeFile() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async appendFile() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async fileInfo() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async listDir() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async canonicalPath() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async exists() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async createDir() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async remove() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async createTempDir() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async createTempFile() {
      return fileErr("filesystem ops not supported in this harness");
    },
    async exec() {
      return execErr("shell exec not supported in this harness");
    },
    async cleanup() {
      // best-effort; nothing to release
    },
  };
}
