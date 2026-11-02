import { Language, Parser, Query, type Tree } from "web-tree-sitter";

/** Returns the bytes of a grammar's .wasm file. The host (CLI, extension) decides where they come from. */
export type GrammarLoader = (grammar: string) => Promise<Uint8Array | null>;

/** Returns the source of a grammar's query file (e.g. "tags"), or several to combine. */
export type QueryLoader = (grammar: string, name: string) => Promise<string[] | null>;

/**
 * Loads grammars lazily and parses source text. One instance per pipeline run is enough.
 * `initOptions` is forwarded to web-tree-sitter's Parser.init (e.g. `locateFile` in a browser).
 */
export class ParserHost {
  private static initPromise: Promise<void> | null = null;
  private languages = new Map<string, Promise<Language | null>>();
  private queries = new Map<string, Promise<Query | null>>();
  private parser: Parser | null = null;

  constructor(
    private loadGrammar: GrammarLoader,
    private initOptions?: object,
    private loadQuery?: QueryLoader,
  ) {}

  /**
   * A compiled query for a grammar, such as its `tags.scm`. When several sources are given they are
   * combined; a source that does not compile against this grammar is left out. Null when none load.
   */
  query(grammar: string, name: string): Promise<Query | null> {
    const key = `${grammar}:${name}`;
    let q = this.queries.get(key);
    if (!q) {
      q = (async () => {
        const lang = await this.language(grammar);
        const sources = lang && this.loadQuery ? await this.loadQuery(grammar, name).catch(() => null) : null;
        if (!lang || !sources?.length) return null;
        const compile = (src: string) => {
          try {
            return new Query(lang, src);
          } catch {
            return null;
          }
        };
        return compile(sources.join("\n")) ?? sources.map(compile).find((x) => x) ?? null;
      })();
      this.queries.set(key, q);
    }
    return q;
  }

  private async init(): Promise<Parser> {
    if (!ParserHost.initPromise) ParserHost.initPromise = Parser.init(this.initOptions);
    await ParserHost.initPromise;
    if (!this.parser) this.parser = new Parser();
    return this.parser;
  }

  private language(grammar: string): Promise<Language | null> {
    let p = this.languages.get(grammar);
    if (!p) {
      p = (async () => {
        await this.init();
        const bytes = await this.loadGrammar(grammar);
        if (!bytes) return null;
        try {
          return await Language.load(bytes);
        } catch {
          return null;
        }
      })();
      this.languages.set(grammar, p);
    }
    return p;
  }

  /** Parse text with the given grammar; null when the grammar is unavailable or parsing fails. */
  async parse(grammar: string, text: string): Promise<Tree | null> {
    const lang = await this.language(grammar);
    if (!lang) return null;
    const parser = await this.init();
    parser.setLanguage(lang);
    try {
      return parser.parse(text);
    } catch {
      return null;
    }
  }
}
