// Snap a byte slice to UTF-8 character boundaries.
//
// Paging by byte offset (`read_file`'s `offset` / `limit`) has an
// unavoidable edge: the chunk boundary can land in the middle of a
// multi-byte character. Decoding such a slice produces U+FFFD at the
// seam, and because the *next* page begins at the same byte, the
// split character is never legible in either page — it is lost.
//
// Two independent seams need fixing:
//
//   - HEAD: if `offset` landed mid-character, the leading continuation
//     bytes (0b10xxxxxx) belong to a character that started in the
//     previous page. Drop them — the previous page already carried that
//     character (see the tail rule below).
//
//   - TAIL: if the last character is incomplete, keep its bytes for the
//     NEXT page by trimming them. Next call starts at the same byte,
//     so the character is decoded whole exactly once.
//
// The caller keeps using byte offsets for `nextOffset`; this helper
// only decides *which* bytes are decoded into the returned string.
// `bytesRead` therefore stays the true read length — trimming is a
// display concern, not a read concern.

export interface AlignedSlice {
  /** Bytes to decode, trimmed to character boundaries. */
  bytes: Buffer;
  /** How many leading bytes were dropped (mid-character start). */
  droppedHead: number;
  /** How many trailing bytes were held over for the next page. */
  heldTail: number;
}

/** True when `b` is a UTF-8 continuation byte (0b10xxxxxx). */
function isContinuation(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

/**
 * Number of bytes that make up a UTF-8 sequence starting at `b`.
 * Returns 1 for a lead byte that is invalid (stray continuation or a
 * 0b11111xxx overlong prefix), so the caller can make progress
 * instead of looping.
 */
function sequenceLength(b: number): number {
  if ((b & 0x80) === 0x00) return 1; // 0xxxxxxx  ASCII
  if ((b & 0xe0) === 0xc0) return 2; // 110xxxxx
  if ((b & 0xf0) === 0xe0) return 3; // 1110xxxx
  if ((b & 0xf8) === 0xf0) return 4; // 11110xxx
  return 1;
}

/**
 * Trim `buf` to whole UTF-8 characters.
 *
 * @param buf   The raw bytes read for this page.
 * @param opts.atEnd  True when this page reaches EOF. At EOF there is
 *   no next page to hand a partial character to, so the tail is left
 *   intact (a genuinely truncated final character is file corruption,
 *   not a paging artefact).
 */
export function alignUtf8Boundaries(
  buf: Buffer,
  opts: { atEnd?: boolean } = {},
): AlignedSlice {
  let start = 0;

  // Head: skip leading continuation bytes — they belong to a character
  // whose lead byte sits in the previous page.
  while (start < buf.length && isContinuation(buf[start]!)) {
    start++;
  }

  let end = buf.length;

  // Tail: if the final character is incomplete, hold its bytes over.
  // Scan back over at most 3 continuation bytes to find the lead byte.
  if (!opts.atEnd && end > start) {
    let leadIndex = end - 1;
    let back = 0;
    while (leadIndex > start && isContinuation(buf[leadIndex]!) && back < 4) {
      leadIndex--;
      back++;
    }
    const lead = buf[leadIndex];
    if (lead !== undefined && !isContinuation(lead)) {
      const needed = sequenceLength(lead);
      const available = end - leadIndex;
      if (needed > 1 && available < needed) {
        // Incomplete character at the seam: trim it so the next page
        // decodes it whole.
        end = leadIndex;
      }
    }
  }

  // Degenerate case: the whole slice was continuation bytes (a very
  // small `limit` inside a 4-byte character). Nothing is decodable
  // here; the caller's next page starts at the same offset the scan
  // would have reached, so returning an empty slice is safe and
  // keeps the offset maths monotonic.
  if (end < start) end = start;

  return {
    bytes: buf.subarray(start, end),
    droppedHead: start,
    heldTail: buf.length - end,
  };
}