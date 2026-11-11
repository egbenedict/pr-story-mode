// Bundles the extension into dist/: scripts, pages, the tree-sitter runtime and grammars.
import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const require = createRequire(import.meta.url);
const watch = process.argv.includes("--watch");
// --release: the build that goes in the store zip (no source maps).
const release = process.argv.includes("--release");

// Grammar wasm files and the query folders their tags come from (see src/grammars.ts).
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
};
const QUERY_PACKAGES = ["javascript", "typescript", "python", "c", "cpp", "go", "rust", "java"];

function copyStatic() {
  mkdirSync(join(out, "grammars"), { recursive: true });
  cpSync(join(here, "manifest.json"), join(out, "manifest.json"));
  mkdirSync(join(out, "icons"), { recursive: true });
  for (const size of [16, 32, 48, 128]) cpSync(join(here, "icons", `icon-${size}.png`), join(out, "icons", `icon-${size}.png`));
  cpSync(join(here, "src/reader/reader.html"), join(out, "reader.html"));
  cpSync(join(here, "src/options/options.html"), join(out, "options.html"));
  cpSync(require.resolve("web-tree-sitter/tree-sitter.wasm"), join(out, "tree-sitter.wasm"));
  for (const [name, spec] of Object.entries(GRAMMARS)) cpSync(require.resolve(spec), join(out, "grammars", `${name}.wasm`));
  for (const lang of QUERY_PACKAGES) {
    const pkg = dirname(require.resolve(`tree-sitter-${lang}/package.json`));
    const tags = join(pkg, "queries", "tags.scm");
    if (existsSync(tags)) cpSync(tags, join(out, "grammars", `${lang}.tags.scm`));
  }
}

const common = {
  outdir: out,
  bundle: true,
  platform: "browser",
  target: "chrome120",
  jsx: "automatic",
  sourcemap: release ? false : "linked",
  minify: !watch,
  logLevel: "info",
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
};

// Content scripts run as classic scripts, so this one is an IIFE.
const contentOptions = { ...common, entryPoints: { content: join(here, "src/content.ts") }, format: "iife" };

const options = {
  ...common,
  entryPoints: {
    background: join(here, "src/background.ts"),
    reader: join(here, "src/reader/main.tsx"),
    options: join(here, "src/options/main.tsx"),
  },
  format: "esm",
  // web-tree-sitter only imports these when running under Node.
  external: ["fs", "fs/promises", "module", "path", "url"],
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyStatic();
if (watch) {
  for (const o of [contentOptions, options]) await (await context(o)).watch();
} else {
  await Promise.all([build(contentOptions), build(options)]);
}
