// Bundles the CLI into dist/: one script plus the parser files, so it runs with just Node (20 or
// later) and needs no `npm install` on the computer that uses it. Copy the folder anywhere.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`The CLI needs Node 20 or later to build and run; this is Node ${process.versions.node}.`);
  process.exit(1);
}

// The build needs the repository's packages (esbuild, tree-sitter). Say so plainly when they're missing.
let build;
try {
  ({ build } = await import("esbuild"));
} catch {
  console.error(
    "The build tools aren't installed. Run `npm install` in the repository folder first, then `npm run build:cli` again.\n" +
      "If this computer can't install packages from npm (a work laptop, say), build on one that can and copy packages/cli/dist over: the built folder needs only Node.",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const require = createRequire(import.meta.url);

// Grammar wasm files, named as src/grammars.ts looks for them.
const GRAMMARS = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  json: "tree-sitter-json/tree-sitter-json.wasm",
  c: "tree-sitter-c/tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp/tree-sitter-cpp.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
  java: "tree-sitter-java/tree-sitter-java.wasm",
  yaml: "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm",
  toml: "@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm",
  ruby: "tree-sitter-ruby/tree-sitter-ruby.wasm",
  csharp: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  php: "tree-sitter-php/tree-sitter-php.wasm",
};
const QUERY_PACKAGES = ["javascript", "typescript", "python", "c", "cpp", "go", "rust", "java", "ruby", "c-sharp", "php"];

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "grammars"), { recursive: true });

await build({
  entryPoints: [join(here, "src/main.ts")],
  outfile: join(out, "pr-story.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "linked",
  logLevel: "info",
  // Some dependencies call require(); give the ES module one.
  banner: { js: 'import { createRequire as __prsRequire } from "node:module"; const require = __prsRequire(import.meta.url);' },
});
// esbuild keeps the source's `npx tsx` first line; the bundle runs on plain Node.
const script = join(out, "pr-story.mjs");
writeFileSync(script, `#!/usr/bin/env node\n${readFileSync(script, "utf8").replace(/^#!.*\n/, "")}`);
chmodSync(script, 0o755);

cpSync(require.resolve("web-tree-sitter/tree-sitter.wasm"), join(out, "tree-sitter.wasm"));
for (const [name, spec] of Object.entries(GRAMMARS)) cpSync(require.resolve(spec), join(out, "grammars", `${name}.wasm`));
for (const lang of QUERY_PACKAGES) {
  const queries = join(dirname(require.resolve(`tree-sitter-${lang}/package.json`)), "queries");
  if (!existsSync(queries)) continue;
  for (const f of readdirSync(queries)) if (f.endsWith(".scm")) cpSync(join(queries, f), join(out, "grammars", `${lang}.${f}`));
}

// `pr-story` and `pr-story.cmd`, so the folder can go on the PATH.
writeFileSync(join(out, "pr-story"), '#!/bin/sh\nexec node "$(dirname "$0")/pr-story.mjs" "$@"\n', { mode: 0o755 });
writeFileSync(join(out, "pr-story.cmd"), '@node "%~dp0pr-story.mjs" %*\r\n');
console.log(`Built ${out}`);
