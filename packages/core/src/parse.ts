import { Language, Parser, type Tree } from "web-tree-sitter";

/** Returns the bytes of a grammar's .wasm file. The host (CLI, extension) decides where they come from. */
export type GrammarLoader = (grammar: string) => Promise<Uint8Array | null>;

/**
 * Loads grammars lazily and parses source text. One instance per pipeline run is enough.
 * `initOptions` is forwarded to web-tree-sitter's Parser.init (e.g. `locateFile` in a browser).
 */
export class ParserHost {
  private static initPromise: Promise<void> | null = null;
  private languages = new Map<string, Promise<Language | null>>();
  private parser: Parser | null = null;

  constructor(
    private loadGrammar: GrammarLoader,
    private initOptions?: object,
  ) {}

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
