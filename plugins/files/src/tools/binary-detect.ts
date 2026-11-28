// Binary-vs-text detection for files handed back to the model.
//
// Background: the original implementation used a single heuristic —
// "NUL byte within the first 4 KB" — which is git's
// buffer_is_binary() rule. It is fast and dependency-free, but it
// misses a whole class of files whose header region is printable
// ASCII while the payload is compressed binary. PDF is the canonical
// case: `%PDF-1.6` followed by a plain object dictionary, with the
// binary streams further in. Decoding such a file as UTF-8 yields
// hundreds of thousands of U+FFFD replacement characters.
//
// We layer three progressively more expensive checks:
//
//   L1. Extension allow-list — zero IO, catches the common formats
//       by name (pdf, docx, xlsx, zip, ...). Table inlined rather
//       than adding a dependency for what is essentially data; it
//       mirrors `binary-extensions` (the de-facto ecosystem list
//       used by chokidar / is-binary-path).
//   L2. Magic bytes — authoritative for the formats we know, and
//       immune to a wrong/missing extension (.dat, extensionless).
//   L3. Text plausibility — invalid-UTF-8 replacement-char ratio.
//       Catches unknown formats that slipped past L1/L2.
//
// The NUL-byte probe is kept as L0 because it is the cheapest signal
// available and the file read already gives us the bytes.
//
// Import: `binary-extensions` intentionally NOT taken as a dependency
// — it is a pure JSON array plus a one-line indexOf, and vendoring
// the table keeps the plugin's dependency surface flat.

/** Formats we know are binary and can give a useful extraction hint
 *  for. Anything here short-circuits before content sniffing. */
const BINARY_EXTENSIONS = new Set([
  // documents
  "pdf", "doc", "docm", "docx", "dot", "dotm", "dotx", "epub", "mobi",
  "odt", "ott", "pages", "rtf", "xls", "xlsb", "xlsm", "xlsx", "xlt",
  "xltm", "xltx", "numbers", "ppt", "pptm", "pptx", "pot", "potm",
  "potx", "pps", "ppsm", "ppsx", "key",
  // archives / packages
  "7z", "arj", "bz2", "cab", "cpio", "deb", "dmg", "egg", "gz", "ipa",
  "iso", "jar", "lz", "lzma", "lzo", "rar", "rpm", "snap", "tar", "tbz",
  "tbz2", "tgz", "txz", "whl", "xar", "xz", "z", "zip", "zipx", "apk",
  "appimage", "flatpak", "msi", "nupkg", "xpi",
  // executables / libraries
  "dll", "dylib", "exe", "lib", "o", "so", "wasm", "class", "dex", "pyc",
  "pyo", "bin", "dat", "iso",
  // media — images
  "bmp", "cr2", "cr3", "dng", "gif", "heic", "heif", "icns", "ico",
  "jpeg", "jpg", "jxl", "nef", "png", "psd", "raw", "tga", "tif",
  "tiff", "webp", "xcf", "avif",
  // media — audio / video
  "aac", "aif", "aiff", "ape", "au", "avi", "caf", "flac", "flv", "m4a",
  "m4v", "mid", "midi", "mka", "mkv", "mov", "mp3", "mp4", "mpeg", "mpg",
  "oga", "ogg", "ogv", "opus", "wav", "webm", "wma", "wmv", "3gp", "3g2",
  // fonts
  "eot", "otf", "ttc", "ttf", "woff", "woff2",
  // databases / misc
  "db", "mdb", "sqlite", "sqlite3", "dwg", "dxf", "sketch", "stl", "swf",
]);

/** Magic-byte signatures. Ordered longest-first so the more specific
 *  match wins (e.g. OOXML's PK\x03\x04 before a generic zip guess). */
interface Signature {
  bytes: number[];
  kind: string;
  /** Byte offset the signature starts at (default 0). */
  at?: number;
}

const SIGNATURES: Signature[] = [
  // Documents
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], kind: "pdf" },          // %PDF-
  { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], kind: "ole2" }, // doc/xls/ppt
  // Archives / containers
  { bytes: [0x50, 0x4b, 0x03, 0x04], kind: "zip" },                // PK.. (zip/docx/xlsx/pptx/jar/apk)
  { bytes: [0x50, 0x4b, 0x05, 0x06], kind: "zip" },                // empty archive
  { bytes: [0x1f, 0x8b], kind: "gzip" },
  { bytes: [0x42, 0x5a, 0x68], kind: "bzip2" },                    // BZh
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], kind: "xz" },
  { bytes: [0x28, 0xb5, 0x2f, 0xfd], kind: "zstd" },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], kind: "7z" },
  { bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], kind: "rar" },
  { bytes: [0x75, 0x73, 0x74, 0x61, 0x72], kind: "tar", at: 257 },
  // Images
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], kind: "png" },
  { bytes: [0xff, 0xd8, 0xff], kind: "jpeg" },
  { bytes: [0x47, 0x49, 0x46, 0x38], kind: "gif" },                // GIF8
  { bytes: [0x42, 0x4d], kind: "bmp" },                            // BM
  { bytes: [0x52, 0x49, 0x46, 0x46], kind: "riff" },               // RIFF (webp/wav/avi)
  { bytes: [0x00, 0x00, 0x01, 0x00], kind: "ico" },
  // Audio / video
  { bytes: [0x49, 0x44, 0x33], kind: "mp3" },                      // ID3
  { bytes: [0x66, 0x4c, 0x61, 0x43], kind: "flac" },               // fLaC
  { bytes: [0x4f, 0x67, 0x67, 0x53], kind: "ogg" },                // OggS
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], kind: "matroska" },           // mkv/webm
  { bytes: [0x00, 0x00, 0x00], kind: "mp4", at: 4 },               // ftyp box follows
  // Fonts / executables
  { bytes: [0x77, 0x4f, 0x46, 0x46], kind: "woff" },               // wOFF
  { bytes: [0x77, 0x4f, 0x46, 0x32], kind: "woff2" },              // wOF2
  { bytes: [0x4f, 0x54, 0x54, 0x4f], kind: "otf" },                // OTTO
  { bytes: [0x00, 0x01, 0x00, 0x00], kind: "ttf" },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], kind: "elf" },
  { bytes: [0x4d, 0x5a], kind: "pe" },                             // MZ
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], kind: "macho" },
  { bytes: [0xca, 0xfe, 0xba, 0xbe], kind: "macho" },
  { bytes: [0x00, 0x61, 0x73, 0x6d], kind: "wasm" },
  // Databases
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00], kind: "sqlite" },
];

export type BinaryKind =
  | { kind: "extension"; ext: string }
  | { kind: "magic"; kind_: string }
  | { kind: "nul" }
  | { kind: "text-ratio"; badRatio: number };

export interface BinaryVerdict {
  binary: boolean;
  /** How the verdict was reached (for logging / tests). */
  via?: "extension" | "magic" | "nul" | "text-ratio";
  /** Detected format label, when known. */
  format?: string;
}

/** Replace `/`-style backslashes and lowercase, for extension lookup. */
function extensionOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

function matchesSignature(buf: Buffer, sig: Signature): boolean {
  const at = sig.at ?? 0;
  if (buf.length < at + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buf[at + i] !== sig.bytes[i]) return false;
  }
  return true;
}

/** L1 — extension allow-list. Cheap, but a wrong extension defeats it. */
export function binaryByExtension(filePath: string): string | null {
  const ext = extensionOf(filePath);
  return ext && BINARY_EXTENSIONS.has(ext) ? ext : null;
}

/** L2 — magic bytes. Independent of the filename. */
export function binaryByMagic(head: Buffer): string | null {
  for (const sig of SIGNATURES) {
    if (matchesSignature(head, sig)) return sig.kind;
  }
  return null;
}

/** L0 — git's rule: a NUL byte in the probe window means binary. */
export function hasNulByte(probe: Buffer): boolean {
  return probe.includes(0);
}

/** L3 — decode plausibility. A text file round-tripping through UTF-8
 *  keeps its replacement-char count near zero; binary garbage pushes
 *  it up sharply. Threshold is deliberately loose so that a Latin-1
 *  file with a few odd bytes still reads as text. */
export const MAX_BAD_CHAR_RATIO = 0.05;

export function badCharRatio(text: string): number {
  if (text.length === 0) return 0;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) bad++;
  }
  return bad / text.length;
}

/**
 * Decide whether a file is binary. `head` should be the leading bytes
 * of the file (a few KB is enough for every signature above).
 *
 * Order matters: extension and magic are cheap and high-precision, so
 * they run before the file is decoded. L3 needs the decoded text and
 * is therefore applied by the caller after reading.
 */
export function detectBinary(
  filePath: string,
  head: Buffer,
): BinaryVerdict {
  const ext = binaryByExtension(filePath);
  if (ext) return { binary: true, via: "extension", format: ext };

  const magic = binaryByMagic(head);
  if (magic) return { binary: true, via: "magic", format: magic };

  if (hasNulByte(head)) return { binary: true, via: "nul" };

  return { binary: false };
}

/** Human/agent-facing extraction hint. `read_file` surfaces this so
 *  the model gets an actionable next step instead of a dead end. */
export function extractionHint(
  filePath: string,
  format: string | undefined,
  workspaceUri: string,
): string {
  const ext = format ?? extensionOf(filePath);
  const common = [
    "pdf",
    "doc", "docm", "docx", "odt", "rtf",
    "xls", "xlsm", "xlsx", "ods", "csv",
    "ppt", "pptm", "pptx", "odp",
  ];
  if (ext === "pdf") {
    return (
      `This is a PDF (${workspaceUri}). Read_file cannot show it directly. ` +
      `Extract the text instead: run \`pdftotext -layout "${workspaceUri}" -\` ` +
      `through the shell/exec tool if available. For scanned PDFs with no ` +
      `text layer, render pages to images (\`pdftoppm -png\`) and view those.`
    );
  }
  if (common.includes(ext)) {
    return (
      `This is a ${ext.toUpperCase()} document (${workspaceUri}), not plain ` +
      `text. Convert it first — e.g. \`pandoc\`, \`python-docx\`, or ` +
      `\`openpyxl\` in a sandbox/exec tool — then read the extracted text.`
    );
  }
  if (ext === "zip" || BINARY_EXTENSIONS.has(ext)) {
    return (
      `This is a ${ext.toUpperCase()} binary file (${workspaceUri}); its bytes ` +
      `are not readable as text. Unpack it (e.g. \`unzip -l\`) or use a ` +
      `format-specific tool to extract what you need.`
    );
  }
  return (
    `This looks like a binary file (${workspaceUri}). Its bytes are not ` +
    `readable as text; use a format-specific tool to extract the content.`
  );
}