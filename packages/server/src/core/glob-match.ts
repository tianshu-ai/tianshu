/**
 * Simple glob matching for tool allow/deny lists.
 * Supports `*` as wildcard (matches any characters).
 * E.g. `bridge_*_exec` matches `bridge_myhost_exec`.
 */
export function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(value);
}

/**
 * Check if `name` matches any entry in `patterns`.
 * Entries without `*` are exact matches; entries with `*` are glob.
 */
export function matchesAny(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (globMatch(p, name)) return true;
  }
  return false;
}
