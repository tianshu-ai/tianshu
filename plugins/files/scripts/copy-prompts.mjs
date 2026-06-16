// Copy prompt-text siblings (`*.prompt.md`) from src/ into dist/
// after tsc has run. tsc only emits .js / .d.ts; the prompt files
// are loaded at runtime via fs.readFileSync(new URL(..., import.meta.url))
// and need to land next to the compiled .js with matching layout.
//
// Why a separate script and not an esbuild text loader: this
// plugin builds with plain `tsc`, no bundler. We don't want to
// bring in esbuild just to inline a few hundred bytes of prompt.
//
// Why .prompt.md and not .txt: the prompts ARE markdown (lists,
// code fences). The .prompt.md suffix keeps editors happy with
// markdown highlighting while still signalling "this is LLM
// input, not a doc page".

import { readdir, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const srcRoot = join(pluginRoot, "src");
const dstRoot = join(pluginRoot, "dist");

// Ensure dst exists; we may run before tsc on a fresh checkout
// (predev / prebuild hook). tsc itself will mkdir as needed for
// .js outputs, but the prompt loader expects the prompt files to
// already be there at module-load time.
await mkdir(dstRoot, { recursive: true });

let copied = 0;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(abs);
      continue;
    }
    if (!e.name.endsWith(".prompt.md")) continue;
    const rel = relative(srcRoot, abs);
    const dst = join(dstRoot, rel);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(abs, dst);
    copied++;
  }
}

await walk(srcRoot);
console.log(`copy-prompts: copied ${copied} prompt file(s) to dist/`);
