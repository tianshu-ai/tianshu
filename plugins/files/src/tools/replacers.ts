// Fuzzy-match replacers for edit_file.
//
// edit_file used to do `String.prototype.replace(oldText, newText)`
// — a single exact-string lookup. Whenever the model sent
// whitespace that didn't byte-for-byte match the file (collapsed
// runs of spaces, off-by-one indentation, a missing trailing
// newline) the call failed with "old_text not found", and the
// agent's repair strategy was usually "re-issue the whole
// edit_file" or worse "fall back to write_file with the whole
// content" — which is the failure shape PR #127 was meant to
// reduce.
//
// OpenCode (sst/opencode, MIT) ships nine fuzzy replacers in
// `packages/opencode/src/tool/edit.ts`. They credit cline/cline
// and gemini-cli upstream. We port the four that pull the most
// weight in our setting (TypeScript/Go/Python source files +
// long markdown):
//
//   1. SimpleReplacer            — exact match (kept for the
//                                   common path; fast).
//   2. LineTrimmedReplacer       — strips per-line trailing
//                                   whitespace before matching.
//                                   Catches the "model dropped
//                                   the trailing space at end of
//                                   line" failure mode.
//   3. WhitespaceNormalizedReplacer — collapses runs of inline
//                                   whitespace to single spaces.
//                                   Catches "model sent two
//                                   spaces where the file has one".
//   4. BlockAnchorReplacer       — for ≥3-line blocks, anchors
//                                   on the first + last line and
//                                   accepts whatever's between.
//                                   Catches reformatted-middle
//                                   blocks.
//   5. IndentationFlexibleReplacer — re-derives the indent from
//                                   the first line and accepts
//                                   any consistent shift on the
//                                   rest. Catches "model sent 4
//                                   spaces where the file has a
//                                   tab".
//
// The other four OpenCode replacers (EscapeNormalized, Trimmed-
// Boundary, ContextAware, MultiOccurrence) are not ported in
// this PR — they handle edge cases we haven't observed. We can
// add them later behind the same Replacer interface without
// changing edit_file callers.
//
// Each replacer is a generator that yields candidate substrings
// of `content` that the orchestrator should `indexOf` to locate
// the actual match. This is OpenCode's shape verbatim — keeps
// the "guarded match against the original content" invariant
// that prevents a fuzzy replacer from inventing a slice that
// doesn't exist.

export type Replacer = (
  content: string,
  find: string,
) => Generator<string>;

export interface ReplaceMatch {
  /** The replacer that produced the match. `"exact"` is the
   *  SimpleReplacer's contribution; everything else is a fuzzy
   *  hit and the caller may want to log it. */
  kind: "exact" | "line-trimmed" | "whitespace" | "block-anchor" | "indent";
  /** Byte offset in `content` where the matched span starts. */
  start: number;
  /** Byte offset in `content` where the matched span ends
   *  (exclusive). `content.slice(start, end)` is what gets
   *  replaced. */
  end: number;
  /** The exact substring of `content` that we matched. Useful
   *  for "matched span is much larger than oldString" guards. */
  matched: string;
}

/** Run replacers in order; first match wins. Returns null if
 *  none of the replacers find `find` in `content`.
 *
 *  Caller passes `replaceAll`. When true, the orchestrator
 *  converts the match into a global replace; we still only
 *  return the *first* matched span (the caller does the
 *  global pass with `String.prototype.replaceAll(matched, …)`).
 *  When false, the caller verifies uniqueness against the
 *  exact match span — see edit-file.ts. */
export function findMatch(
  content: string,
  find: string,
): ReplaceMatch | null {
  if (find.length === 0) return null;
  const replacers: Array<{ name: ReplaceMatch["kind"]; fn: Replacer }> = [
    { name: "exact", fn: SimpleReplacer },
    { name: "line-trimmed", fn: LineTrimmedReplacer },
    { name: "whitespace", fn: WhitespaceNormalizedReplacer },
    { name: "block-anchor", fn: BlockAnchorReplacer },
    { name: "indent", fn: IndentationFlexibleReplacer },
  ];
  for (const { name, fn } of replacers) {
    for (const candidate of fn(content, find)) {
      if (candidate.length === 0) continue;
      const start = content.indexOf(candidate);
      if (start < 0) continue;
      // Guard against fuzzy replacers proposing a slice that's
      // wildly larger than the original `find`. OpenCode's
      // isDisproportionateMatch — same threshold (3x len + 50
      // char floor for short oldStrings).
      if (isDisproportionateMatch(candidate, find)) continue;
      return {
        kind: name,
        start,
        end: start + candidate.length,
        matched: candidate,
      };
    }
  }
  return null;
}

/** OpenCode's disproportionate-match guard. Without it, a
 *  short, noisy `find` can fuzzy-resolve to an absurdly large
 *  span (e.g. a one-line `find` matching a 200-line slice via
 *  whitespace normalisation). */
function isDisproportionateMatch(matched: string, find: string): boolean {
  const min = Math.max(50, find.length);
  return matched.length > min * 3;
}

// ---------- replacers ----------

/** Exact match. The fast path. */
const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

/** Per-line trailing-whitespace strip. The model sometimes
 *  drops trailing spaces / tabs from `old_text`; this lets the
 *  match succeed against a file that has them. */
const LineTrimmedReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  const findStripped = findLines.map((l) => l.replace(/[ \t]+$/u, ""));
  const contentLines = content.split("\n");
  const contentStripped = contentLines.map((l) =>
    l.replace(/[ \t]+$/u, ""),
  );
  // Walk the stripped content looking for the stripped find;
  // when we land it, reconstruct the original-content slice
  // from the unstripped contentLines and yield that.
  outer: for (
    let i = 0;
    i <= contentStripped.length - findStripped.length;
    i++
  ) {
    for (let j = 0; j < findStripped.length; j++) {
      if (contentStripped[i + j] !== findStripped[j]) continue outer;
    }
    yield contentLines.slice(i, i + findStripped.length).join("\n");
  }
};

/** Inline-whitespace normalisation: collapse runs of spaces and
 *  tabs to a single space before comparing. Leading whitespace
 *  is preserved (handled by the indent replacer instead).
 *
 *  Example match: file has `foo  =  1`, model sent `foo = 1`. */
const WhitespaceNormalizedReplacer: Replacer = function* (
  content,
  find,
) {
  const norm = (s: string) =>
    // Normalise inline whitespace runs but keep leading
    // whitespace intact so 4-space blocks don't collide.
    s.replace(/(\S)[ \t]+/gu, "$1 ");
  const findN = norm(find);
  // For each starting position in content, take the same length
  // of normalised content and compare. We yield the *original*
  // span (not the normalised one) so the caller's indexOf can
  // locate it.
  const contentLines = content.split("\n");
  const findLines = find.split("\n");
  outer: for (
    let i = 0;
    i <= contentLines.length - findLines.length;
    i++
  ) {
    const slice = contentLines.slice(i, i + findLines.length);
    if (norm(slice.join("\n")) === findN) {
      yield slice.join("\n");
      continue outer;
    }
  }
};

/** First-and-last-line anchor for blocks of 3+ lines. The
 *  middle lines are accepted as-is from the file. Useful when
 *  the model copy-pasted a block but reformatted the middle
 *  (e.g. switched `, ` to `,\n` or shuffled an import list). */
const BlockAnchorReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  // Strip a single trailing empty line that's almost always
  // a `find` artefact (model put a `\n` at the end).
  if (findLines.length > 0 && findLines.at(-1) === "") {
    findLines.pop();
  }
  if (findLines.length < 3) return;
  const firstLine = findLines[0]!.trim();
  const lastLine = findLines.at(-1)!.trim();
  const span = findLines.length;
  const contentLines = content.split("\n");
  for (let i = 0; i <= contentLines.length - span; i++) {
    if (contentLines[i]!.trim() !== firstLine) continue;
    if (contentLines[i + span - 1]!.trim() !== lastLine) continue;
    yield contentLines.slice(i, i + span).join("\n");
  }
};

/** Whole-block indent shift. The model sent `find` indented
 *  one way (often unindented or at 0 spaces); the file has it
 *  at some other indent level. We try every plausible shift. */
const IndentationFlexibleReplacer: Replacer = function* (
  content,
  find,
) {
  const findLines = find.split("\n");
  if (findLines.length === 0) return;
  // Re-indent `find` by adding `prefix` to every non-empty line.
  const reindent = (prefix: string) =>
    findLines
      .map((l) => (l.length === 0 ? l : prefix + l))
      .join("\n");
  // Try a handful of common indent prefixes. We don't enumerate
  // every line in `content` — that's too slow on big files. The
  // common shifts are: 0, 2, 4, 8 spaces, and a single tab.
  for (const prefix of ["", "  ", "    ", "        ", "\t"]) {
    const candidate = reindent(prefix);
    if (candidate === find) continue; // same as exact match
    if (content.includes(candidate)) {
      yield candidate;
    }
  }
  // Also try detecting the indent from the first line of the
  // file's match, if find's first line trimmed appears
  // somewhere. This catches non-standard widths.
  const firstTrim = findLines[0]?.trimStart();
  if (firstTrim && firstTrim.length > 0) {
    const idx = content.indexOf(firstTrim);
    if (idx > 0) {
      // Walk back from idx to BOL; that's the indent the file uses.
      let bol = idx;
      while (bol > 0 && content[bol - 1] !== "\n") bol--;
      const indent = content.slice(bol, idx);
      if (indent && /^[ \t]+$/u.test(indent)) {
        const shifted = reindent(indent);
        if (shifted !== find && content.includes(shifted)) {
          yield shifted;
        }
      }
    }
  }
};

