import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { ParserHost, type GrammarLoader } from "@prstory/core";

const require = createRequire(import.meta.url);

const GRAMMARS: Record<string, string> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  json: "tree-sitter-json/tree-sitter-json.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
  java: "tree-sitter-java/tree-sitter-java.wasm",
};

/** Loads grammar .wasm files from the installed tree-sitter-* packages. */
export const loadGrammar: GrammarLoader = async (grammar) => {
  const spec = GRAMMARS[grammar];
  if (!spec) return null;
  try {
    return new Uint8Array(await readFile(require.resolve(spec)));
  } catch {
    return null;
  }
};

export function createHost(): ParserHost {
  return new ParserHost(loadGrammar);
}
