import { ParserHost, type GrammarLoader, type QueryLoader } from "@prstory/core";

/** Files are bundled next to the page (build.mjs copies them), so relative URLs work in the extension and in a dev server. */
const asset = (path: string) => new URL(path, location.href).href;

const GRAMMARS = new Set(["typescript", "tsx", "javascript", "python", "json", "c", "cpp", "go", "rust", "java", "yaml", "toml"]);

/** Query files per grammar, as in the CLI: TypeScript's tags only add to JavaScript's, so both are used. */
const QUERIES: Record<string, string[]> = {
  typescript: ["javascript", "typescript"],
  tsx: ["javascript", "typescript"],
  javascript: ["javascript"],
  python: ["python"],
  c: ["c"],
  cpp: ["c", "cpp"],
  go: ["go"],
  rust: ["rust"],
  java: ["java"],
};

const loadGrammar: GrammarLoader = async (grammar) => {
  if (!GRAMMARS.has(grammar)) return null;
  const res = await fetch(asset(`grammars/${grammar}.wasm`));
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
};

const loadQuery: QueryLoader = async (grammar, name) => {
  const out: string[] = [];
  for (const pkg of QUERIES[grammar] ?? []) {
    const res = await fetch(asset(`grammars/${pkg}.${name}.scm`)).catch(() => null);
    if (res?.ok) out.push(await res.text());
  }
  return out.length ? out : null;
};

export function createBrowserHost(): ParserHost {
  return new ParserHost(loadGrammar, { locateFile: () => asset("tree-sitter.wasm") }, loadQuery);
}
