// Static registry of language-server bootstrap info. Modelled on
// OpenCode's `Server.Info` (packages/opencode/src/lsp/server.ts) but
// trimmed to what v0.1 ships: 3 languages, push diagnostics, no
// experimental flags, no special initialization quirks beyond
// what each server documents.
//
// Adding a language is a registry entry — no code change in the
// manager or client.

export interface LanguageDefinition {
  /** Stable id used as the LSP pool key segment. Matches OpenCode's
   *  ids so prompts / docs read the same. */
  id: "typescript" | "gopls" | "pyright";

  /** File extensions this language owns (lowercase, with dot). */
  extensions: readonly string[];

  /** Project markers walked up from the edited file to find the
   *  workspace root. First hit wins; if none found we fall back to
   *  the tenant workspace root (the manager enforces the upper
   *  bound). */
  rootMarkers: readonly string[];

  /** Spawn command. `which` resolves it; auto-install runs the
   *  install script if missing. */
  command: string;

  /** Args for `command`. Most LS take `--stdio`. */
  args: readonly string[];

  /** Lazy install hook — invoked at most once per host process if
   *  `command` is missing. Returns the shell command(s) that
   *  install the binary. */
  installCommand: string;

  /** Human-readable name, used in error messages. */
  displayName: string;
}

const LANGUAGES: readonly LanguageDefinition[] = [
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    command: "typescript-language-server",
    args: ["--stdio"],
    installCommand: "npm install -g typescript-language-server typescript",
    displayName: "TypeScript Language Server",
  },
  {
    id: "gopls",
    extensions: [".go"],
    rootMarkers: ["go.mod", "go.work"],
    command: "gopls",
    args: [],
    installCommand: "go install golang.org/x/tools/gopls@latest",
    displayName: "gopls",
  },
  {
    id: "pyright",
    extensions: [".py", ".pyi"],
    rootMarkers: [
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
    ],
    command: "pyright-langserver",
    args: ["--stdio"],
    installCommand: "npm install -g pyright",
    displayName: "Pyright",
  },
];

const byExtension = new Map<string, LanguageDefinition>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) {
    byExtension.set(ext.toLowerCase(), lang);
  }
}

/** Look up the language that owns a file by its extension.
 *  Returns undefined for unsupported types. */
export function languageForFile(absPath: string): LanguageDefinition | undefined {
  const dot = absPath.lastIndexOf(".");
  if (dot < 0) return undefined;
  return byExtension.get(absPath.slice(dot).toLowerCase());
}

/** All known languages, for diagnostics / status surfaces. */
export function allLanguages(): readonly LanguageDefinition[] {
  return LANGUAGES;
}
