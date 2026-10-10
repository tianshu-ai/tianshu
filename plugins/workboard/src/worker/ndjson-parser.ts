// Incremental NDJSON (newline-delimited JSON) line parser.
//
// Buffers partial lines across chunks so callers can feed raw
// stdout bytes from `tail -c +offset` and get back parsed events.
// Invalid JSON lines are silently skipped (CLI stderr mixed in, etc.).

export interface NdjsonParser<T = unknown> {
  /** Feed a chunk of bytes (may contain 0..N complete lines).
   *  Returns all newly-parsed events. */
  feed(chunk: string): T[];
  /** Flush any remaining buffered content (call after EOF). */
  flush(): T[];
  /** Number of bytes consumed so far (for offset tracking). */
  readonly bytesConsumed: number;
}

export function createNdjsonParser<T = unknown>(): NdjsonParser<T> {
  let buf = "";
  let consumed = 0;

  function parseLines(input: string): T[] {
    const events: T[] = [];
    buf += input;
    consumed += Buffer.byteLength(input, "utf8");

    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as T);
      } catch {
        // Not valid JSON — skip (stderr noise, partial line, etc.)
      }
    }
    return events;
  }

  return {
    feed: parseLines,
    flush(): T[] {
      if (!buf.trim()) return [];
      try {
        return [JSON.parse(buf.trim()) as T];
      } catch {
        return [];
      } finally {
        buf = "";
      }
    },
    get bytesConsumed() {
      return consumed;
    },
  };
}
