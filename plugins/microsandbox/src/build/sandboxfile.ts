// Sandboxfile parser (microsandbox plugin v0).
//
// We don't reach for js-yaml — the v0 Sandboxfile spec is restricted
// enough that a hand-rolled parser handles it cleanly:
//
//   image: python:3.12-slim          # required, scalar
//   cpus: 4                          # optional, integer
//   memory_mib: 4096                 # optional, integer
//   apt: [pkg, pkg, ...]             # OR multi-line list (- entry)
//   pip: [pkg, ...]
//   npm: [pkg, ...]
//   exec:                            # raw shell commands, in order
//     - apt-get update -qq
//     - cp /workspace/.../my.whl /tmp/
//     - pip install /tmp/my.whl
//
// Comments (`#`) and blank lines are skipped. Multi-line strings,
// nested maps, anchors, references — none of that. If a tenant
// outgrows v0, swap in js-yaml; this file's surface is tiny.

export interface SandboxSpec {
  image: string;
  cpus?: number;
  memoryMib?: number;
  apt?: string[];
  pip?: string[];
  npm?: string[];
  exec?: string[];
}

export class SandboxfileError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`Sandboxfile line ${line}: ${message}`);
    this.line = line;
    this.name = "SandboxfileError";
  }
}

const SCALAR_KEYS = new Set(["image", "cpus", "memory_mib"]);
const LIST_KEYS = new Set(["apt", "pip", "npm", "exec"]);

interface ParsedRaw {
  image?: string;
  cpus?: number;
  memory_mib?: number;
  apt?: string[];
  pip?: string[];
  npm?: string[];
  exec?: string[];
}

export function parseSandboxfile(source: string): SandboxSpec {
  const raw = parseRaw(source);
  if (typeof raw.image !== "string" || raw.image.length === 0) {
    throw new SandboxfileError("`image:` is required", 0);
  }
  return {
    image: raw.image,
    ...(raw.cpus !== undefined ? { cpus: raw.cpus } : {}),
    ...(raw.memory_mib !== undefined ? { memoryMib: raw.memory_mib } : {}),
    ...(raw.apt && raw.apt.length > 0 ? { apt: raw.apt } : {}),
    ...(raw.pip && raw.pip.length > 0 ? { pip: raw.pip } : {}),
    ...(raw.npm && raw.npm.length > 0 ? { npm: raw.npm } : {}),
    ...(raw.exec && raw.exec.length > 0 ? { exec: raw.exec } : {}),
  };
}

function parseRaw(source: string): ParsedRaw {
  const out: ParsedRaw = {};
  const lines = source.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    i++;
    const stripped = stripComment(raw);
    if (stripped.trim().length === 0) continue;
    if (/^\s/.test(stripped)) {
      throw new SandboxfileError(
        "unexpected indented line at top level",
        lineNo,
      );
    }
    const colon = stripped.indexOf(":");
    if (colon < 0) {
      throw new SandboxfileError(`expected "key: value", got "${stripped}"`, lineNo);
    }
    const key = stripped.slice(0, colon).trim();
    const rest = stripped.slice(colon + 1).trim();

    if (SCALAR_KEYS.has(key)) {
      if (rest.length === 0) {
        throw new SandboxfileError(
          `key "${key}" expects a scalar value on the same line`,
          lineNo,
        );
      }
      const val = unquote(rest);
      if (key === "image") {
        out.image = val;
      } else {
        const n = Number(val);
        if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
          throw new SandboxfileError(
            `key "${key}" expects a positive integer, got "${val}"`,
            lineNo,
          );
        }
        if (key === "cpus") out.cpus = n;
        else if (key === "memory_mib") out.memory_mib = n;
      }
      continue;
    }

    if (LIST_KEYS.has(key)) {
      let list: string[] = [];
      if (rest.length > 0) {
        // Inline JSON-ish list: `apt: [a, b]`
        list = parseInlineList(rest, lineNo);
      } else {
        // Multi-line: `- entry` per line, until next non-indented line.
        while (i < lines.length) {
          const next = lines[i]!;
          const nextStripped = stripComment(next);
          if (nextStripped.trim().length === 0) {
            i++;
            continue;
          }
          if (!/^\s/.test(nextStripped)) break; // back to top level
          const m = /^\s+-\s*(.*)$/.exec(nextStripped);
          if (!m) {
            throw new SandboxfileError(
              `expected "- entry" under "${key}:", got "${nextStripped.trim()}"`,
              i + 1,
            );
          }
          const entry = unquote(m[1]!.trim());
          if (entry.length > 0) list.push(entry);
          i++;
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[key] = list;
      continue;
    }

    throw new SandboxfileError(`unknown key "${key}"`, lineNo);
  }

  return out;
}

function stripComment(line: string): string {
  // Strip a trailing `# ...` outside of quotes. Sandboxfile values
  // are simple enough that quote handling is just "ignore # inside
  // ` ` `' '` `"`.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function unquote(s: string): string {
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function parseInlineList(s: string, lineNo: number): string[] {
  if (!s.startsWith("[") || !s.endsWith("]")) {
    throw new SandboxfileError(
      `inline list must look like [a, b, c]`,
      lineNo,
    );
  }
  const inner = s.slice(1, -1);
  if (inner.trim().length === 0) return [];
  // Split on commas not inside quotes. Sandboxfile entries don't
  // legitimately contain commas in v0 (apt/pip/npm package names
  // don't, raw exec lines belong on multi-line form).
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (const c of inner) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c === "," && !inSingle && !inDouble) {
      parts.push(unquote(buf.trim()));
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim().length > 0) parts.push(unquote(buf.trim()));
  return parts;
}
