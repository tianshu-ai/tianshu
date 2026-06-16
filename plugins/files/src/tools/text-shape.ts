// Helpers for preserving the on-disk shape of a text file across
// `edit_file` round-trips: line ending (LF vs CRLF) and BOM
// (UTF-8 BOM only — UTF-16 BOMs imply a non-UTF-8 file we can't
// safely string-edit anyway, so we leave those alone and let the
// existing binary-detection path or the edit failure surface them).
//
// Why: the model can't see what line ending or BOM a file uses.
// It will send `old_text: "foo\nbar"` even on a CRLF file. Without
// normalisation:
//   - the find fails (old_text is LF, file is CRLF)
//   - or, if the find succeeds via some accident, new_text lands
//     in the file with mismatched endings, leaving a mixed-ending
//     mess that's annoying to clean up.
// And a UTF-8 BOM on the source silently disappears when we
// fs.writeFileSync the new contents back, because we read
// utf8-with-BOM into a string and write a string back without
// re-prepending it.
//
// Strategy (mirrors OpenCode's edit.ts):
//   1. On read, peel a leading UTF-8 BOM (\uFEFF) if present,
//      remember that we did.
//   2. Detect line ending: if the original contains \r\n at all,
//      treat it as a CRLF file; else LF.
//   3. Normalise each `old_text` / `new_text` to the file's line
//      ending before string-replace.
//   4. On write, re-prepend the BOM if the source had one.
//
// Step 3 means: if the source is CRLF and the model sends LF,
// we convert; if the source is LF and the model sends CRLF, we
// also convert (collapse to LF). The file's existing convention
// always wins; the model's input is treated as conventionally
// LF and adapted on the way in.

const BOM = "\uFEFF";

export interface ShapedSource {
  /** File contents with any leading UTF-8 BOM removed. */
  text: string;
  /** True if the original bytes started with a UTF-8 BOM. */
  hadBom: boolean;
  /** "\r\n" if the file uses CRLF anywhere, else "\n". */
  ending: "\n" | "\r\n";
}

/** Inspect a freshly-read file's contents and return the
 *  normalised text plus shape metadata for round-tripping. */
export function shapeOf(raw: string): ShapedSource {
  const hadBom = raw.length > 0 && raw.charCodeAt(0) === 0xfeff;
  const text = hadBom ? raw.slice(1) : raw;
  const ending = text.includes("\r\n") ? "\r\n" : "\n";
  return { text, hadBom, ending };
}

/** Normalise a model-supplied snippet to a target line ending.
 *  Collapses any \r\n in the input to \n first (so mixed input is
 *  cleaned), then expands to the target. Idempotent for already-
 *  normalised input. */
export function normaliseEnding(
  input: string,
  target: "\n" | "\r\n",
): string {
  const lf = input.replace(/\r\n/g, "\n");
  if (target === "\n") return lf;
  return lf.replace(/\n/g, "\r\n");
}

/** Re-prepend a BOM if the source had one. Always pass the
 *  already-edited text in. */
export function applyShape(text: string, source: ShapedSource): string {
  return source.hadBom ? BOM + text : text;
}
