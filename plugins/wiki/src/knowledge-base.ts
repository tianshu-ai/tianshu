// Knowledge Base — local document ingestion for the wiki plugin.
//
// Scans user-configured folders, discovers files, extracts content
// via LLM, and stores the distilled knowledge as wiki pages under
// `wiki/knowledge/<slug>.md` with source links back to the originals.
//
// Supported file types:
//   - Text: .md, .txt, .rst, .org, .csv, .json, .yaml, .yml
//   - Documents: .pdf (text extraction via LLM vision)
//   - Audio: .mp3, .wav, .m4a, .ogg, .flac (transcription via LLM)
//   - Video: .mp4, .mkv, .webm, .mov (audio track → transcription)
//   - Images: .png, .jpg, .jpeg, .gif, .webp (description via LLM vision)
//
// Large files are chunked before sending to the LLM. Each chunk
// produces a knowledge page; chunks are linked together.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { wikiRoot, safeSlug, writePage, resolvePage, listPages, type Section } from "./vault.js";

// ─── Types ──────────────────────────────────────────────────────

export interface KbFolder {
  /** Absolute path to the folder to scan. */
  path: string;
  /** Optional label for display. */
  label?: string;
}

export interface KbConfig {
  folders: KbFolder[];
}

export interface KbFileEntry {
  /** Absolute path. */
  absPath: string;
  /** Relative path from the folder root (for display). */
  relPath: string;
  /** Folder label or path this came from. */
  folderLabel: string;
  /** File size in bytes. */
  size: number;
  /** Last modified timestamp (ms). */
  mtime: number;
  /** MIME category for processing. */
  category: FileCategory;
}

export type FileCategory = "text" | "document" | "audio" | "video" | "image" | "unknown";

export interface KbStatus {
  folders: { path: string; label?: string; fileCount: number }[];
  totalFiles: number;
  indexedFiles: number;
  pendingFiles: number;
  lastScanAt: number | null;
}

export interface KbIndexEntry {
  absPath: string;
  hash: string;
  processedAt: number;
  wikiSlug: string;
  chunks: number;
}

// ─── File discovery ─────────────────────────────────────────────

const TEXT_EXTS = new Set([
  ".md", ".txt", ".rst", ".org", ".csv", ".json", ".yaml", ".yml",
  ".ts", ".js", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".toml", ".ini", ".cfg", ".sh", ".bash", ".zsh", ".html", ".xml",
]);
const DOC_EXTS = new Set([".pdf"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"]);
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".mov", ".avi"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export function categorizeFile(filePath: string): FileCategory {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) return "text";
  if (DOC_EXTS.has(ext)) return "document";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "unknown";
}

/** Recursively scan a folder for processable files. */
export function scanFolder(folderPath: string, label?: string): KbFileEntry[] {
  const results: KbFileEntry[] = [];
  const folderLabel = label || folderPath;

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip hidden
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const category = categorizeFile(full);
        if (category === "unknown") continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        results.push({
          absPath: full,
          relPath: path.relative(folderPath, full),
          folderLabel,
          size: stat.size,
          mtime: stat.mtimeMs,
          category,
        });
      }
    }
  }

  if (fs.existsSync(folderPath)) walk(folderPath);
  return results;
}

// ─── Index persistence ──────────────────────────────────────────

const KB_META_DIR = ".wiki";
const KB_INDEX_FILE = "kb-index.json";

function indexPath(userHome: string): string {
  return path.join(wikiRoot(userHome), KB_META_DIR, KB_INDEX_FILE);
}

export function loadIndex(userHome: string): Map<string, KbIndexEntry> {
  const p = indexPath(userHome);
  if (!fs.existsSync(p)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as KbIndexEntry[];
    return new Map(data.map((e) => [e.absPath, e]));
  } catch {
    return new Map();
  }
}

export function saveIndex(userHome: string, index: Map<string, KbIndexEntry>): void {
  const p = indexPath(userHome);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify([...index.values()], null, 2));
}

/** Quick file hash (first 8KB + size + mtime) for change detection. */
export function fileFingerprint(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(Math.min(8192, stat.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const h = crypto.createHash("sha256");
    h.update(buf);
    h.update(`${stat.size}:${stat.mtimeMs}`);
    return h.digest("hex").slice(0, 16);
  } catch {
    return "error";
  }
}

// ─── Scan + diff ────────────────────────────────────────────────

export interface ScanResult {
  /** Files that are new or changed since last index. */
  pending: KbFileEntry[];
  /** Files already indexed and unchanged. */
  indexed: KbFileEntry[];
  /** Files that were indexed but no longer exist (deleted/moved). */
  stale: KbIndexEntry[];
  /** Total discovered. */
  total: number;
}

export function scanAndDiff(userHome: string, config: KbConfig): ScanResult {
  const index = loadIndex(userHome);
  const allFiles: KbFileEntry[] = [];
  for (const folder of config.folders) {
    allFiles.push(...scanFolder(folder.path, folder.label));
  }

  const pending: KbFileEntry[] = [];
  const indexed: KbFileEntry[] = [];

  // Track which indexed paths are still present
  const seenPaths = new Set<string>();

  for (const file of allFiles) {
    seenPaths.add(file.absPath);
    const existing = index.get(file.absPath);
    const hash = fileFingerprint(file.absPath);
    if (existing && existing.hash === hash) {
      indexed.push(file);
    } else {
      pending.push(file);
    }
  }

  // Find stale entries: indexed but no longer on disk
  const stale: KbIndexEntry[] = [];
  for (const [absPath, entry] of index) {
    if (!seenPaths.has(absPath)) {
      stale.push(entry);
    }
  }

  return { pending, indexed, stale, total: allFiles.length };
}

// ─── Stale cleanup ──────────────────────────────────────────────

/** Remove wiki pages and index entries for files that no longer exist. */
export function cleanupStale(
  userHome: string,
  stale: KbIndexEntry[],
): { removed: string[] } {
  const index = loadIndex(userHome);
  const removed: string[] = [];

  for (const entry of stale) {
    // Delete the wiki page(s)
    const pageFile = resolvePage(userHome, "knowledge", entry.wikiSlug.replace("knowledge/", ""));
    if (pageFile && fs.existsSync(pageFile)) {
      fs.unlinkSync(pageFile);
      removed.push(entry.wikiSlug);
    }
    // If it was multi-chunk, also remove part files
    if (entry.chunks > 1) {
      const baseSlug = entry.wikiSlug.replace("knowledge/", "").replace(/-part\d+$/, "");
      for (let i = 1; i <= entry.chunks; i++) {
        const chunkFile = resolvePage(userHome, "knowledge", `${baseSlug}-part${i}`);
        if (chunkFile && fs.existsSync(chunkFile)) {
          fs.unlinkSync(chunkFile);
          if (!removed.includes(`knowledge/${baseSlug}-part${i}`)) {
            removed.push(`knowledge/${baseSlug}-part${i}`);
          }
        }
      }
    }
    // Remove from index
    index.delete(entry.absPath);
  }

  saveIndex(userHome, index);
  return { removed };
}

/** Remove wiki pages for a file that's about to be re-indexed (content changed). */
export function cleanupBeforeReindex(
  userHome: string,
  absPath: string,
): void {
  const index = loadIndex(userHome);
  const entry = index.get(absPath);
  if (!entry) return;

  const pageFile = resolvePage(userHome, "knowledge", entry.wikiSlug.replace("knowledge/", ""));
  if (pageFile && fs.existsSync(pageFile)) {
    fs.unlinkSync(pageFile);
  }
  if (entry.chunks > 1) {
    const baseSlug = entry.wikiSlug.replace("knowledge/", "").replace(/-part\d+$/, "");
    for (let i = 1; i <= entry.chunks; i++) {
      const chunkFile = resolvePage(userHome, "knowledge", `${baseSlug}-part${i}`);
      if (chunkFile && fs.existsSync(chunkFile)) {
        fs.unlinkSync(chunkFile);
      }
    }
  }
  // Don't remove from index here — the re-index will overwrite it
}

// ─── Content extraction helpers ─────────────────────────────────

const MAX_TEXT_CHUNK_BYTES = 30_000; // ~30KB per chunk for text files

/** Read a text file and split into chunks if needed. */
export function readTextChunks(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.length <= MAX_TEXT_CHUNK_BYTES) return [content];

  // Split at paragraph boundaries
  const chunks: string[] = [];
  let current = "";
  const paragraphs = content.split(/\n\n+/);
  for (const para of paragraphs) {
    if (current.length + para.length > MAX_TEXT_CHUNK_BYTES && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += para + "\n\n";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [content.slice(0, MAX_TEXT_CHUNK_BYTES)];
}

// ─── KB config persistence ──────────────────────────────────────

const KB_CONFIG_FILE = "kb-config.json";

function configPath(userHome: string): string {
  return path.join(wikiRoot(userHome), KB_META_DIR, KB_CONFIG_FILE);
}

export function loadKbConfig(userHome: string): KbConfig {
  const p = configPath(userHome);
  if (!fs.existsSync(p)) return { folders: [] };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as KbConfig;
  } catch {
    return { folders: [] };
  }
}

export function saveKbConfig(userHome: string, config: KbConfig): void {
  const p = configPath(userHome);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
}

// ─── Status ─────────────────────────────────────────────────────

export function getKbStatus(userHome: string): KbStatus {
  const config = loadKbConfig(userHome);
  const index = loadIndex(userHome);

  const folders = config.folders.map((f) => ({
    path: f.path,
    label: f.label,
    fileCount: scanFolder(f.path, f.label).length,
  }));

  const allFiles: KbFileEntry[] = [];
  for (const folder of config.folders) {
    allFiles.push(...scanFolder(folder.path, folder.label));
  }

  let pendingCount = 0;
  for (const file of allFiles) {
    const existing = index.get(file.absPath);
    const hash = fileFingerprint(file.absPath);
    if (!existing || existing.hash !== hash) pendingCount++;
  }

  // Last scan time from index entries
  let lastScanAt: number | null = null;
  for (const entry of index.values()) {
    if (!lastScanAt || entry.processedAt > lastScanAt) {
      lastScanAt = entry.processedAt;
    }
  }

  return {
    folders,
    totalFiles: allFiles.length,
    indexedFiles: allFiles.length - pendingCount,
    pendingFiles: pendingCount,
    lastScanAt,
  };
}

// ─── Writing knowledge pages ────────────────────────────────────

export interface KnowledgePageInput {
  /** The extracted/distilled content from the LLM. */
  content: string;
  /** Title for the wiki page. */
  title: string;
  /** Source file absolute path. */
  sourcePath: string;
  /** Relative path for display. */
  sourceRelPath: string;
  /** Which chunk (1-based) if multi-chunk, or null for single. */
  chunkIndex?: number;
  /** Total chunks if multi-chunk. */
  totalChunks?: number;
}

export function writeKnowledgePage(
  userHome: string,
  input: KnowledgePageInput,
): string {
  const slug = safeSlug(input.title);
  const chunkSuffix = input.totalChunks && input.totalChunks > 1
    ? `-part${input.chunkIndex}`
    : "";
  const finalSlug = slug + chunkSuffix;

  const frontmatter = [
    `---`,
    `title: "${input.title.replace(/"/g, '\\"')}"`,
    `source: "${input.sourcePath}"`,
    `sourceRel: "${input.sourceRelPath}"`,
    ...(input.totalChunks && input.totalChunks > 1
      ? [`chunk: ${input.chunkIndex}/${input.totalChunks}`]
      : []),
    `indexedAt: ${new Date().toISOString()}`,
    `---`,
  ].join("\n");

  const body = `${frontmatter}\n\n# ${input.title}\n\n> Source: \`${input.sourceRelPath}\`\n\n${input.content}`;

  const file = resolvePage(userHome, "knowledge", finalSlug);
  if (!file) throw new Error(`Invalid knowledge page slug: ${finalSlug}`);
  writePage(file, body);
  return `knowledge/${finalSlug}`;
}

// ─── Prompt for the KB worker ───────────────────────────────────

export const KB_WORKER_ROLE = "wiki-kb";

export function buildKbScanPrompt(pending: KbFileEntry[]): string {
  const fileList = pending
    .slice(0, 50) // cap per run
    .map((f) => `- [${f.category}] ${f.relPath} (${humanSize(f.size)})`)
    .join("\n");

  return [
    "You are indexing the user's local knowledge base into their wiki.",
    "Process EACH file listed below:",
    "",
    "For each file:",
    "1. Call wiki_kb_read_file to get its content (text files) or a description prompt (media files).",
    "2. Distill the key knowledge, facts, and insights from the content.",
    "3. Call wiki_kb_save_knowledge to store the distilled page with a descriptive title.",
    "4. After processing all files, call wiki_kb_mark_done to finalize.",
    "",
    "Guidelines:",
    "- Extract KNOWLEDGE, not just summaries. Focus on facts, decisions, patterns, relationships.",
    "- Use [[wikilinks]] to link to existing entities/concepts/topics when relevant.",
    "- For code files: extract architecture decisions, API patterns, key algorithms.",
    "- For documents: extract key facts, conclusions, action items.",
    "- For audio/video transcripts: extract key points, decisions, Q&A.",
    "- Keep each page focused on one coherent topic/file.",
    "",
    `Files to process (${pending.length} total):`,
    fileList,
    "",
    pending.length > 50
      ? `(${pending.length - 50} more files will be processed in the next run)`
      : "",
  ].join("\n");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
