// Minimal zip writer for the studio export bundle.
//
// We intentionally don't pull in an extra dep (yazl / archiver /
// adm-zip / etc.) because:
//   1. Our content is small (a few skill .md files + JSON), so a
//      one-shot in-memory write is fine.
//   2. Adding an npm dep to a built-in plugin grows the install
//      footprint and forces us to vet license/maintenance.
//   3. Node's zlib has deflateRawSync, which gives us everything
//      we need (DEFLATE stream) — the ZIP envelope is a few
//      hundred bytes of well-documented binary headers.
//
// Output: a single Buffer holding a valid ZIP file. Tested with
// macOS Finder + `unzip -l` + Linux `bsdtar -tzvf`.

import { deflateRawSync, crc32 } from "node:zlib";

import type { WorkforceSnapshot } from "@tianshu-ai/plugin-sdk";

interface ZipEntry {
  /** Path inside the archive. Forward slashes only. */
  path: string;
  /** Body to compress. */
  body: Buffer;
}

interface PreparedEntry {
  pathBytes: Buffer;
  raw: Buffer;
  compressed: Buffer;
  crc: number;
  method: number;
  rawSize: number;
  /** Offset of the local header for this entry in the final zip.
   *  Filled in after we lay the bytes out. */
  localHeaderOffset: number;
}

const ZIP_VERSION = 20; // 2.0 — supports DEFLATE
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
// Fixed mtime so the archive is deterministic across runs. Real
// metadata (tenantId / generatedAt / version) lives inside the
// payload — we don't need the filesystem timestamps to match. Use
// 1980-01-01 because that's the lower bound of MS-DOS time, the
// format ZIP entries use.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // year=0 (=1980), month=1, day=1

/**
 * Build a {@link Buffer} containing the studio bundle for the
 * given snapshot. The bundle structure is:
 *
 *   README.md                Top-level overview + safety warning
 *   _meta.json               Snapshot metadata (tenant, version, …)
 *   main-agent/
 *     system-prompt.md       Composed system prompt (runtime)
 *     tools.md               Tools table + JSON schema dump
 *     skills/<path>          Skill .md files (verbatim)
 *   workers/<slug>/
 *     agent.md               Worker spec (kind, model, source, …)
 *     system-prompt.md       Stored SOUL.md (or "<empty>")
 *     tools.md               Effective tools after toolsAllow filter
 *     skills/<path>          Skill .md files visible to this worker
 */
export function buildZipBytes(snapshot: WorkforceSnapshot): Buffer {
  const entries: ZipEntry[] = [];
  entries.push({
    path: "README.md",
    body: Buffer.from(renderReadme(snapshot), "utf8"),
  });
  entries.push({
    path: "_meta.json",
    body: Buffer.from(JSON.stringify(metaPayload(snapshot), null, 2), "utf8"),
  });
  entries.push({
    path: "plugins.md",
    body: Buffer.from(renderPluginsMarkdown(snapshot), "utf8"),
  });
  // Main agent
  entries.push({
    path: "main-agent/system-prompt.md",
    body: Buffer.from(snapshot.main.systemPrompt, "utf8"),
  });
  entries.push({
    path: "main-agent/tools.md",
    body: Buffer.from(renderToolsMarkdown(snapshot.main.tools), "utf8"),
  });
  for (const s of snapshot.main.skills) {
    entries.push({
      path: `main-agent/skills/${s.relativePath}`,
      body: Buffer.from(s.body, "utf8"),
    });
  }
  // Workers
  for (const w of snapshot.workers) {
    const base = `workers/${w.slug}`;
    entries.push({
      path: `${base}/agent.md`,
      body: Buffer.from(renderWorkerAgentMd(w), "utf8"),
    });
    entries.push({
      path: `${base}/system-prompt.md`,
      body: Buffer.from(
        w.systemPrompt.trim().length > 0
          ? w.systemPrompt
          : "<!-- worker has no SOUL.md / system prompt set -->\n",
        "utf8",
      ),
    });
    entries.push({
      path: `${base}/tools.md`,
      body: Buffer.from(renderToolsMarkdown(w.tools), "utf8"),
    });
    for (const s of w.skills) {
      entries.push({
        path: `${base}/skills/${s.relativePath}`,
        body: Buffer.from(s.body, "utf8"),
      });
    }
  }
  return encodeZip(entries);
}

function encodeZip(entries: ZipEntry[]): Buffer {
  // Prepare each entry: compress body, compute CRC, etc. We
  // pick DEFLATE only when it shrinks the payload (a tiny JSON
  // doesn't benefit from compression overhead).
  const prepared: PreparedEntry[] = entries.map((e) => {
    const raw = e.body;
    const deflated = deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    return {
      pathBytes: Buffer.from(e.path, "utf8"),
      raw,
      compressed: useDeflate ? deflated : raw,
      crc: crc32(raw),
      method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
      rawSize: raw.length,
      localHeaderOffset: 0,
    };
  });

  // Lay out local file records first.
  const localChunks: Buffer[] = [];
  let cursor = 0;
  for (const p of prepared) {
    p.localHeaderOffset = cursor;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    header.writeUInt16LE(0, 6); // general purpose flag
    header.writeUInt16LE(p.method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(p.crc, 14);
    header.writeUInt32LE(p.compressed.length, 18);
    header.writeUInt32LE(p.rawSize, 22);
    header.writeUInt16LE(p.pathBytes.length, 26);
    header.writeUInt16LE(0, 28); // no extra
    localChunks.push(header, p.pathBytes, p.compressed);
    cursor += header.length + p.pathBytes.length + p.compressed.length;
  }

  // Central directory.
  const centralChunks: Buffer[] = [];
  const centralStart = cursor;
  for (const p of prepared) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(ZIP_VERSION, 4); // version made by
    cd.writeUInt16LE(ZIP_VERSION, 6); // version needed
    cd.writeUInt16LE(0, 8); // gp flag
    cd.writeUInt16LE(p.method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(p.crc, 16);
    cd.writeUInt32LE(p.compressed.length, 20);
    cd.writeUInt32LE(p.rawSize, 24);
    cd.writeUInt16LE(p.pathBytes.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(p.localHeaderOffset, 42);
    centralChunks.push(cd, p.pathBytes);
    cursor += cd.length + p.pathBytes.length;
  }
  const centralSize = cursor - centralStart;

  // End of central directory.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_END, 0);
  eocd.writeUInt16LE(0, 4); // disk #
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(prepared.length, 8); // entries on disk
  eocd.writeUInt16LE(prepared.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

function renderReadme(snapshot: WorkforceSnapshot): string {
  const generated = new Date(snapshot.generatedAt).toISOString();
  return `# Workforce Studio export

| Field | Value |
| --- | --- |
| Tenant | \`${snapshot.tenantId}\` |
| User | \`${snapshot.userId}\` |
| Tianshu | \`${snapshot.tianshuVersion}\` |
| Generated | \`${generated}\` |
| Workers | ${snapshot.workers.length} |

## Layout

- \`README.md\` (this file)
- \`_meta.json\` — machine-readable metadata, useful for tooling.
- \`plugins.md\` — every plugin visible to the tenant, with origin
  (🏢 core / 📦 built-in / 🏡 tenant) and tool/skill counts.
- \`main-agent/\`
  - \`system-prompt.md\` — composed prompt the main agent would see
    on its next turn.
  - \`tools.md\` — every tool currently visible to the main agent.
  - \`skills/<plugin>/<skill>.md\` — markdown bodies of every
    skill the main agent has access to.
- \`workers/<slug>/\` (one directory per worker)
  - \`agent.md\` — kind, model, source, enabled status.
  - \`system-prompt.md\` — the worker's stored \`SOUL.md\` body, or a
    placeholder when none is set.
  - \`tools.md\` — effective tool list after the worker's allow-list
    is applied.
  - \`skills/<plugin>/<skill>.md\` — skills the worker can load.

## ⚠️ Sensitive data warning

This bundle includes **full system prompts and skill bodies**. If
a plugin or your own user notes embedded API keys, tokens, or
private context into a system prompt or skill, those strings are
in this zip. **Audit before sharing.**

## Notes & limitations (Phase 1)

- Worker system prompt is the **stored SOUL.md**, not the fully
  composed runtime prompt (which also injects host execution-bias
  rules, plugin fragments, runtime context blocks, …). A future
  phase will surface the composed text the same way the main
  agent's prompt is captured here.
- Tools listed are the host catalog the agent **could** call. The
  agent decides on each turn which to actually use.
- The export is read-only. Round-tripping (import a modified zip)
  lands in a later phase.
`;
}

function metaPayload(snapshot: WorkforceSnapshot): Record<string, unknown> {
  return {
    schema: "workforce-studio.snapshot.v1",
    tenantId: snapshot.tenantId,
    userId: snapshot.userId,
    tianshuVersion: snapshot.tianshuVersion,
    generatedAt: snapshot.generatedAt,
    generatedAtIso: new Date(snapshot.generatedAt).toISOString(),
    counts: {
      mainTools: snapshot.main.tools.length,
      mainSkills: snapshot.main.skills.length,
      workers: snapshot.workers.length,
    },
  };
}

function renderToolsMarkdown(
  tools: ReadonlyArray<{
    name: string;
    description: string;
    pluginId: string;
    since: string | null;
    parameters: unknown;
    origin: string;
  }>,
): string {
  if (tools.length === 0) {
    return "# Tools\n\n_None_\n";
  }
  const lines: string[] = ["# Tools", ""];
  lines.push("| Name | Origin | Plugin | Since | Description |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of tools) {
    const desc = t.description
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ")
      .trim()
      .slice(0, 240);
    lines.push(
      `| \`${t.name}\` | ${originLabel(t.origin)} | \`${t.pluginId}\` | ${
        t.since ?? "—"
      } | ${desc} |`,
    );
  }
  lines.push("");
  lines.push("## Schemas");
  for (const t of tools) {
    lines.push(`### \`${t.name}\``);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(t.parameters ?? null, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function renderPluginsMarkdown(snapshot: WorkforceSnapshot): string {
  if (snapshot.plugins.length === 0) {
    return "# Plugins\n\n_No plugins discovered for this tenant._\n";
  }
  const lines: string[] = [
    "# Plugins",
    "",
    `${snapshot.plugins.length} plugin(s) visible to the tenant. "Origin" tells you whether a plugin ships with this Tianshu install or was added per-tenant.`,
    "",
    "| Plugin | Origin | Version | State | Tools | Skills | Description |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
  ];
  for (const p of snapshot.plugins) {
    const desc = (p.description ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ")
      .trim()
      .slice(0, 200);
    const state =
      p.state === "active"
        ? "✅ active"
        : p.state === "failed"
        ? `❌ failed${p.failureReason ? `: ${p.failureReason}` : ""}`
        : p.state;
    lines.push(
      `| **${p.displayName}** \`${p.id}\` | ${originLabel(p.origin)} | ${
        p.version
      } | ${state} | ${p.toolCount} | ${p.skillCount} | ${desc} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function originLabel(o: string): string {
  if (o === "core") return "🏢 core";
  if (o === "builtin-plugin") return "📦 built-in";
  if (o === "tenant-plugin") return "🏡 tenant";
  return o;
}

function renderWorkerAgentMd(w: {
  slug: string;
  name: string;
  description: string | null;
  kind: string;
  source: "builtin" | "user";
  enabled: boolean;
  modelId: string | null;
}): string {
  return [
    `# Worker: ${w.name}`,
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Slug | \`${w.slug}\` |`,
    `| Kind | \`${w.kind}\` |`,
    `| Source | \`${w.source}\` |`,
    `| Enabled | ${w.enabled ? "✅" : "❌"} |`,
    `| Model | ${w.modelId ? "`" + w.modelId + "`" : "_(default)_"} |`,
    "",
    "## Description",
    "",
    w.description ?? "_(none)_",
    "",
  ].join("\n");
}
