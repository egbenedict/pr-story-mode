import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ParserHost, type GrammarLoader, type QueryLoader } from "@prstory/core";

const require = createRequire(import.meta.url);

/**
 * The bundled CLI (npm run build:cli) ships the parser files in a `grammars` folder beside it, so
 * it needs no installed packages. Run from source, they come from node_modules.
 */
const here = dirname(fileURLToPath(import.meta.url));
const BUNDLED = existsSync(join(here, "grammars")) ? join(here, "grammars") : null;

const GRAMMARS: Record<string, string> = {
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

/** Loads grammar .wasm files from the installed tree-sitter-* packages. */
export const loadGrammar: GrammarLoader = async (grammar) => {
  const spec = GRAMMARS[grammar];
  if (!spec) return null;
  try {
    return new Uint8Array(await readFile(BUNDLED ? join(BUNDLED, `${grammar}.wasm`) : require.resolve(spec)));
  } catch {
    return null;
  }
};

/** Query files per grammar. TypeScript's tags only add to JavaScript's, so both are used. */
const QUERIES: Record<string, string[]> = {
  typescript: ["tree-sitter-javascript/queries", "tree-sitter-typescript/queries"],
  tsx: ["tree-sitter-javascript/queries", "tree-sitter-typescript/queries"],
  javascript: ["tree-sitter-javascript/queries"],
  python: ["tree-sitter-python/queries"],
  c: ["tree-sitter-c/queries"],
  cpp: ["tree-sitter-c/queries", "tree-sitter-cpp/queries"],
  go: ["tree-sitter-go/queries"],
  rust: ["tree-sitter-rust/queries"],
  java: ["tree-sitter-java/queries"],
  ruby: ["tree-sitter-ruby/queries"],
  csharp: ["tree-sitter-c-sharp/queries"],
  php: ["tree-sitter-php/queries"],
};

/** Loads query files (such as tags.scm) shipped with the tree-sitter-* packages. */
export const loadQuery: QueryLoader = async (grammar, name) => {
  const out: string[] = [];
  for (const dir of QUERIES[grammar] ?? []) {
    try {
      const pkgName = dir.split("/")[0]!;
      if (BUNDLED) {
        out.push(await readFile(join(BUNDLED, `${pkgName.replace(/^tree-sitter-/, "")}.${name}.scm`), "utf8"));
        continue;
      }
      const pkg = dirname(require.resolve(`${pkgName}/package.json`));
      out.push(await readFile(join(pkg, dir.split("/").slice(1).join("/"), `${name}.scm`), "utf8"));
    } catch {
      // not shipped
    }
  }
  return out.length ? out : null;
};

export function createHost(): ParserHost {
  const runtime = join(here, "tree-sitter.wasm");
  return new ParserHost(loadGrammar, BUNDLED && existsSync(runtime) ? { locateFile: () => runtime } : undefined, loadQuery);
}
