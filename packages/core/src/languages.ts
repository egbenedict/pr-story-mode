// Language packs: how to find atom boundaries, names and identifiers for each grammar.
// Tier 2 packs are hand-tuned; Tier 1 uses generic node-type patterns that work for most grammars;
// files with no grammar are Tier 0 (one atom per hunk).

export type LanguagePack = {
  id: string;
  tier: 1 | 2;
  grammar: string; // key passed to the grammar loader, e.g. "typescript", "tsx", "python"
  extensions: string[];
  /** Nodes whose body we descend into, so their members become atoms (classes, interfaces, namespaces). */
  isClassLike(type: string): boolean;
  /** Body nodes of class-like nodes (class_body, block, declaration_list). */
  isBody(type: string): boolean;
  /** Named functions and methods: an atom never splits below one of these. */
  isFunctionLike(type: string): boolean;
  /** Transparent nodes we look through (export_statement, decorated_definition). */
  isWrapper(type: string): boolean;
  isImport(type: string): boolean;
  /** Comments, decorators and attributes: their lines attach to the next atom. */
  isLeading(type: string): boolean;
  isIdentifier(type: string): boolean;
};

const set = (...xs: string[]) => {
  const s = new Set(xs);
  return (t: string) => s.has(t);
};

const tsCommon = {
  tier: 2 as const,
  isClassLike: set("class_declaration", "abstract_class_declaration", "class", "interface_declaration", "internal_module", "module"),
  isBody: set("class_body", "interface_body", "object_type", "statement_block"),
  isFunctionLike: set(
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "method_signature",
    "abstract_method_signature",
    "function_signature",
  ),
  isWrapper: set("export_statement", "ambient_declaration", "expression_statement"),
  isImport: set("import_statement"),
  isLeading: set("comment", "decorator"),
  isIdentifier: set("identifier", "type_identifier", "property_identifier", "private_property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern"),
};

export const TYPESCRIPT: LanguagePack = { id: "typescript", grammar: "typescript", extensions: [".ts", ".mts", ".cts"], ...tsCommon };
export const TSX: LanguagePack = { id: "tsx", grammar: "tsx", extensions: [".tsx"], ...tsCommon };
export const JAVASCRIPT: LanguagePack = {
  id: "javascript",
  grammar: "javascript",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  ...tsCommon,
};

export const PYTHON: LanguagePack = {
  id: "python",
  tier: 2,
  grammar: "python",
  extensions: [".py", ".pyi"],
  isClassLike: set("class_definition"),
  isBody: set("block"),
  isFunctionLike: set("function_definition"),
  isWrapper: set("decorated_definition"),
  isImport: set("import_statement", "import_from_statement", "future_import_statement"),
  isLeading: set("comment", "decorator"),
  isIdentifier: set("identifier"),
};

// ---- Tier 1: generic patterns ----

const genericClass = /^(class|interface|enum|struct|trait|impl|module|namespace|object|record|protocol|extension)_(declaration|definition|item|specifier)$|^(impl_item|mod_item|trait_item)$/;
const genericBody = /(^|_)body$|^block$|^declaration_list$|^field_declaration_list$|^class_body$/;
const genericFunction = /(function|method|constructor|func)_?(declaration|definition|item|spec)?$/;

function genericPack(id: string, grammar: string, extensions: string[]): LanguagePack {
  return {
    id,
    tier: 1,
    grammar,
    extensions,
    isClassLike: (t) => genericClass.test(t),
    isBody: (t) => genericBody.test(t),
    isFunctionLike: (t) => genericFunction.test(t) && !/call|literal|expression|type$/.test(t),
    isWrapper: (t) => t === "export_statement" || t === "decorated_definition",
    isImport: (t) => /^(import_declaration|import_statement|import_spec_list|use_declaration|using_directive|import_from_statement)$/.test(t),
    isLeading: (t) => /comment|^attribute_item$|^annotation$|^marker_annotation$|^decorator$/.test(t),
    isIdentifier: (t) => /identifier$/.test(t),
  };
}

/** C and C++: generic patterns, plus looking through templates, extern "C" blocks and #if regions (include guards). */
function cFamily(id: string, grammar: string, extensions: string[]): LanguagePack {
  const g = genericPack(id, grammar, extensions);
  const wrappers = new Set(["template_declaration", "linkage_specification", "declaration_list", "preproc_if", "preproc_ifdef", "preproc_else", "preproc_elif", "preproc_elifdef"]);
  return {
    ...g,
    isClassLike: (t) => /^(class|struct|union|enum)_specifier$|^namespace_definition$/.test(t),
    isBody: (t) => t === "field_declaration_list" || t === "declaration_list" || t === "enumerator_list",
    isFunctionLike: (t) => t === "function_definition",
    isWrapper: (t) => wrappers.has(t),
    isImport: (t) => t === "preproc_include" || t === "using_declaration",
    isLeading: (t) => t === "comment",
  };
}

export const C = cFamily("c", "c", [".c"]);
export const CPP = cFamily("cpp", "cpp", [".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".inl", ".ipp"]);

export const GO = genericPack("go", "go", [".go"]);
export const RUST = genericPack("rust", "rust", [".rs"]);
export const JAVA = genericPack("java", "java", [".java"]);

/** JSON: one atom per changed top-level key. */
export const JSON_PACK: LanguagePack = {
  id: "json",
  tier: 1,
  grammar: "json",
  extensions: [".json", ".jsonc"],
  isClassLike: () => false,
  isBody: () => false,
  isFunctionLike: () => false,
  isWrapper: set("object"),
  isImport: () => false,
  isLeading: set("comment"),
  isIdentifier: () => false,
};

export const LANGUAGE_PACKS: LanguagePack[] = [TYPESCRIPT, TSX, JAVASCRIPT, PYTHON, C, CPP, GO, RUST, JAVA, JSON_PACK];

/** Lockfiles and generated files never need a grammar: they go straight to the mechanical list. */
const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "npm-shrinkwrap.json",
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

const GENERATED = [
  /(^|\/)(dist|build|vendor|node_modules|__generated__|generated|gen)\//,
  /\.min\.(js|css)$/,
  /\.pb\.go$/,
  /_pb2(_grpc)?\.pyi?$/,
  /\.generated\.\w+$/,
  /\.snap$/,
  /(^|\/)__snapshots__\//,
  /\.map$/,
];

export function isGeneratedPath(path: string): boolean {
  return GENERATED.some((re) => re.test(path));
}

export function isGeneratedText(text: string | undefined): boolean {
  if (!text) return false;
  const head = text.slice(0, 600);
  return /@generated|DO NOT EDIT|Code generated .* DO NOT EDIT|auto-generated/i.test(head);
}

export function packForPath(path: string): LanguagePack | null {
  const lower = path.toLowerCase();
  for (const p of LANGUAGE_PACKS) {
    if (p.extensions.some((e) => lower.endsWith(e))) return p;
  }
  return null;
}

/** Best-effort language name for Tier 0 files, used only for display. */
export function languageNameForPath(path: string): string | null {
  const pack = packForPath(path);
  if (pack) return pack.id;
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ?? null;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
