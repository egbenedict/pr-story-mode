// Language packs: how to find atom boundaries, names and identifiers for each grammar.
// Tier 2 packs are hand-tuned; Tier 1 uses generic node-type patterns that work for most grammars;
// files with no grammar are Tier 0 (one atom per hunk).

import type { Node } from "web-tree-sitter";

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

  // Optional rules for one language. A pack without them gets the generic behaviour.
  /** The type a function declared outside it belongs to (Go: the method's receiver type). */
  ownerOf?(fn: Node): string | null;
  /** The path name of a class-like node, when its `name` field is missing (Rust `impl` blocks). */
  classNameOf?(node: Node): string | null;
  /** The type a class path name stands for, for `Type.member` names (Rust `Display for Thing` → `Thing`). */
  ownerType?(name: string): string;
  /** The type `self` means inside a class-like node (Rust `impl` blocks). */
  selfTypeOf?(node: Node): string | null;
  /**
   * The node holding a group's entries, each then its own unit (Go `const ( … )`, Java methods after
   * an enum's constants); null when `node` is no such group.
   */
  declList?(node: Node): Node | null;
  /** A name for a statement the generic rules leave unnamed (Go `package x`). It is always its own atom. */
  unitName?(node: Node): string | null;
  /** Whether a changed comment line joins the declaration right below it (doc comments). */
  docJoins?(line: string): boolean;
  /** The reference identifier `n` makes: a name, null to skip it, or undefined for the generic rules. */
  refOf?(n: Node): string | null | undefined;
  /** Nodes ending at column 0 of a row don't cover that row (Rust doc comments include their newline). */
  endsAtLineStart?: boolean;
  /** Members also define `Type::member`, which `Type::member()` references match exactly (Rust). */
  scopedMembers?: boolean;
  /** How a reference is looked up as unchanged context (Rust `Type::f` → `Type.f`). */
  contextRef?(ref: string): string;
  /** A data format (YAML, TOML): atoms are named by key but define nothing, and are never read as context. */
  data?: boolean;
  /** Lines that are only a comment, which count as leading even where the tree puts them inside the key above. */
  commentLine?(text: string): boolean;
  /** A key whose entries become atoms of their own, named under it (YAML `jobs:` → `jobs.build`). */
  nestedKeys?(node: Node): { list: Node; name: string } | null;
  /** A statement that is always its own atom, never joined with small neighbours (a YAML key holding a block). */
  isBlock?(node: Node): boolean;
  /** A name for a statement, tried before the generic rules (Ruby `LIMIT = 10`, C# fields, PHP properties). */
  statementName?(node: Node): string | null;
  /** A statement that imports, where the node type alone can't tell (Ruby `require "x"`). */
  importNode?(node: Node): boolean;
  /** Whether identifier `n` introduces a local name (a parameter), or undefined for the generic rules. */
  isBinding?(n: Node): boolean | undefined;
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

// ---- Tier 2 on top of the generic patterns: Go, Rust, Java ----

const firstAncestor = (n: Node, test: (t: string) => boolean): Node | null => {
  for (let p = n.parent; p; p = p.parent) if (test(p.type)) return p;
  return null;
};
const isField = (p: Node | null, field: string, n: Node) => !!p && p.childForFieldName(field)?.id === n.id;
/** Doc comments, not file headers or inner docs: Rust `//!` and `/*!` document the enclosing module. */
const notInnerDoc = (line: string) => !/^\s*(\/\/!|\/\*!)/.test(line);

/** `Client`, `*Client`, `List[T]`, `pkg.Client` → the type's own name. */
function goType(n: Node | null | undefined): string | null {
  if (!n) return null;
  switch (n.type) {
    case "type_identifier":
      return n.text;
    case "pointer_type":
    case "parenthesized_type":
      return goType(n.namedChildren[0]);
    case "generic_type":
      return goType(n.childForFieldName("type"));
    case "qualified_type":
      return n.childForFieldName("name")?.text ?? null;
  }
  return null;
}

/** A Go method's receiver: its variable (`c` in `func (c *Client)`) and type. */
function goReceiver(fn: Node | null): { name: string | null; type: string } | null {
  if (fn?.type !== "method_declaration") return null;
  const p = fn.childForFieldName("receiver")?.namedChildren.find((c) => c?.type === "parameter_declaration");
  const type = goType(p?.childForFieldName("type"));
  return type ? { name: p?.childForFieldName("name")?.text ?? null, type } : null;
}

/** Package names a Go file imports: the alias, or the import path's last part (`…/cli/v2/api` → `api`). */
const goImports = new WeakMap<object, Set<string>>();
function goPackages(n: Node): Set<string> {
  const tree = n.tree;
  let names = goImports.get(tree);
  if (names) return names;
  names = new Set();
  for (const d of tree.rootNode.namedChildren) {
    if (d?.type !== "import_declaration") continue;
    for (const spec of d.descendantsOfType("import_spec")) {
      if (!spec) continue;
      const alias = spec.childForFieldName("name")?.text;
      if (alias) {
        if (alias !== "_" && alias !== ".") names.add(alias);
        continue;
      }
      const parts = (spec.childForFieldName("path")?.text ?? "").replace(/^["`]|["`]$/g, "").split("/");
      let last = parts.pop() ?? "";
      if (/^v\d+$/.test(last) && parts.length) last = parts.pop()!;
      last = last.replace(/^go-/, "").replace(/[.-]v\d+$/, "").replace(/-go$/, "");
      if (/^[A-Za-z_]\w*$/.test(last)) names.add(last);
    }
  }
  goImports.set(tree, names);
  return names;
}

const GO_BASE = genericPack("go", "go", [".go"]);
export const GO: LanguagePack = {
  ...GO_BASE,
  tier: 2,
  // `func (c *Client) Send()` belongs to Client: named `Client.Send`.
  ownerOf: (fn) => goReceiver(fn)?.type ?? null,
  // `const ( … )`, `var ( … )` and `type ( … )` hold one declaration per entry.
  declList(node) {
    if (!/^(const|var|type)_declaration$/.test(node.type)) return null;
    const holder = node.namedChildren.find((c) => c?.type === "var_spec_list") ?? node;
    return holder.children.some((c) => c?.type === "(") ? holder : null;
  },
  unitName: (node) => (node.type === "package_clause" ? `package ${node.namedChildren[0]?.text ?? ""}`.trim() : null),
  docJoins: () => true,
  refOf(n) {
    if (n.type === "package_identifier") return null; // `api` in `api.Client`
    const p = n.parent;
    if (p?.type !== "selector_expression") return undefined;
    const operand = p.childForFieldName("operand");
    if (operand?.type !== "identifier") return undefined;
    if (isField(p, "field", n)) {
      // `c.flush()` inside a method on Client means Client's own flush.
      const recv = goReceiver(firstAncestor(n, (t) => t === "method_declaration"));
      if (recv?.name && operand.text === recv.name) return `${recv.type}.${n.text}`;
      // `api.Default` names a package-level declaration, called or not.
      if (goPackages(n).has(operand.text)) return n.text;
    } else if (operand.id === n.id && goPackages(n).has(n.text)) return null;
    return undefined;
  },
};

/** `Thing`, `Thing<T>`, `&Thing`, `std::sync::Arc<T>` → the type's own name. */
function rustType(n: Node | null | undefined): string | null {
  if (!n) return null;
  switch (n.type) {
    case "type_identifier":
    case "primitive_type":
      return n.text;
    case "generic_type":
    case "reference_type":
    case "pointer_type":
      return rustType(n.childForFieldName("type"));
    case "scoped_type_identifier":
      return n.childForFieldName("name")?.text ?? null;
  }
  return null;
}
const rustImplType = (n: Node | null): string | null => (n?.type === "impl_item" ? rustType(n.childForFieldName("type")) : null);

const RUST_BASE = genericPack("rust", "rust", [".rs"]);
export const RUST: LanguagePack = {
  ...RUST_BASE,
  tier: 2,
  // `impl<T> Sp<T>` → `Sp`; `impl From<io::Error> for Error` → `From<io::Error> for Error`, so each trait impl stays apart.
  classNameOf(node) {
    if (node.type !== "impl_item") return null;
    const type = rustType(node.childForFieldName("type"));
    const trait = node.childForFieldName("trait");
    if (!type) return null;
    // `Self` in the trait is the type itself, so `From<Self>` and `From<Thing>` name the same impl.
    return trait ? `${trait.text.replace(/\s+/g, " ").replace(/\bSelf\b/g, type)} for ${type}` : type;
  },
  ownerType: (name) => /\sfor\s(\S+)$/.exec(name)?.[1] ?? name,
  selfTypeOf: rustImplType,
  docJoins: notInnerDoc,
  endsAtLineStart: true,
  scopedMembers: true,
  contextRef: (r) => r.replace(/^(\w+)::(\w+)$/, "$1.$2"),
  refOf(n) {
    const p = n.parent;
    // `Thing::new()` and `Self::make()` name one type's own function: `Thing::new`, matched exactly,
    // never any other type's `new`.
    const typePath = (s: Node): string | null => {
      const path = s.childForFieldName("path");
      if (path?.type !== "identifier") return null;
      if (path.text === "Self") return rustImplType(firstAncestor(s, (t) => t === "impl_item"));
      return /^[A-Z]/.test(path.text) ? path.text : null;
    };
    if (n.type === "scoped_identifier") {
      const type = typePath(n);
      const name = n.childForFieldName("name");
      return type && name ? `${type}::${name.text}` : undefined;
    }
    if (p?.type === "scoped_identifier" && typePath(p)) {
      if (isField(p, "name", n)) return null; // counted with the type above
      if (n.text === "Self") return null;
    }
    // `Self` as a type or struct literal means the impl's type.
    if (n.text === "Self") return rustImplType(firstAncestor(n, (t) => t === "impl_item"));
    return undefined;
  },
};

const JAVA_CLASS = /^(class|interface|enum|record|annotation_type)_declaration$/;
const JAVA_BASE = genericPack("java", "java", [".java"]);
export const JAVA: LanguagePack = {
  ...JAVA_BASE,
  tier: 2,
  // `enum E { A, B; void helper() {} }`: the methods after the constants are members of E.
  declList: (node) => (node.type === "enum_body_declarations" ? node : null),
  unitName: (node) => (node.type === "package_declaration" ? `package ${node.namedChildren.find((c) => c && /identifier$/.test(c.type))?.text ?? ""}`.trim() : null),
  docJoins: () => true,
  refOf(n) {
    const p = n.parent;
    if (p?.type !== "method_invocation" || !isField(p, "name", n)) return undefined;
    const obj = p.childForFieldName("object");
    // `helper()` and `this.helper()` call the enclosing class's own method; `Util.helper()` Util's.
    if (!obj || obj.type === "this") {
      for (let a = p.parent; a; a = a.parent) {
        if (a.type === "class_body" && a.parent?.type === "object_creation_expression") return undefined; // anonymous class
        if (JAVA_CLASS.test(a.type)) {
          const name = a.childForFieldName("name")?.text;
          return name ? `${name}.${n.text}` : undefined;
        }
      }
      return undefined;
    }
    if (obj.type === "identifier" && /^[A-Z]/.test(obj.text)) return `${obj.text}.${n.text}`;
    return undefined;
  },
};

// ---- Tier 2 on top of the generic patterns: Ruby, C#, PHP ----

/** A string argument as a label: `"adds items"`, shortened past 60 characters. */
function quoted(text: string): string {
  const q = text[0] ?? '"';
  const body = text.slice(1, -1).replace(/\s+/g, " ");
  return `${q}${body.length > 60 ? body.slice(0, 59).trimEnd() + "…" : body}${q}`;
}

/** `Shop::Cart` → `Cart`. */
const rubyLast = (s: string) => s.replace(/^.*::/, "");

/** The class or module a Ruby node sits in (`Cart` for `class Shop::Cart`); `class << self` is skipped. */
function rubyClass(n: Node): string | null {
  const c = firstAncestor(n, (t) => t === "class" || t === "module");
  const name = c?.childForFieldName("name")?.text;
  return name ? rubyLast(name) : null;
}

/**
 * A label for a Ruby call statement, by method and first argument: `it("adds items")`,
 * `has_many(:posts)`, `include(Enumerable)`, `RSpec.describe(Cart)`, `before`. Null for calls on
 * other receivers (`expect(x).to …`) and for calls without a plain first argument or a block.
 */
function rubyCallLabel(call: Node): string | null {
  if (call.type !== "call") return null;
  const method = call.childForFieldName("method");
  if (method?.type !== "identifier") return null;
  const recv = call.childForFieldName("receiver");
  if (recv && recv.type !== "constant" && recv.type !== "scope_resolution") return null;
  const name = recv ? `${recv.text}.${method.text}` : method.text;
  const first = call.childForFieldName("arguments")?.namedChildren[0];
  if (!first) return call.childForFieldName("block") ? name : null;
  if (first.type === "string") return `${name}(${quoted(first.text)})`;
  if (/^(simple_symbol|constant|scope_resolution)$/.test(first.type)) return `${name}(${first.text})`;
  return null;
}

/** Blocks whose statements are units of their own: RSpec groups, and route and config blocks. */
const RUBY_GROUPS = new Set(["describe", "context", "feature", "shared_examples", "shared_examples_for", "shared_context", "draw", "namespace", "scope", "configure"]);

/** An RSpec group, or a routes or config block: `describe X do`, `Rails.application.routes.draw do`. */
function rubyGroup(node: Node): boolean {
  if (node.type !== "call" || !RUBY_GROUPS.has(node.childForFieldName("method")?.text ?? "")) return false;
  const recv = node.childForFieldName("receiver");
  return !recv || /^(RSpec|Rails\.application(\.routes)?)$/.test(recv.text);
}
/** Whether the nearest call around `node` is a group, with no class or method in between. */
function rubyInGroup(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "call") return rubyGroup(p);
    if (p.type === "class" || p.type === "module" || /method$/.test(p.type)) return false;
  }
  return false;
}

const RUBY_BASE = genericPack("ruby", "ruby", [".rb", ".rake", ".gemspec", ".ru", "gemfile", "rakefile"]);
export const RUBY: LanguagePack = {
  ...RUBY_BASE,
  tier: 2,
  isClassLike: set("class", "module", "singleton_class"),
  isBody: set("body_statement"),
  isFunctionLike: set("method", "singleton_method"),
  isWrapper: () => false,
  isImport: () => false,
  isLeading: set("comment"),
  isIdentifier: set("identifier", "constant"),
  // `class << self` holds class methods.
  classNameOf: (node) => (node.type === "singleton_class" ? `class << ${node.childForFieldName("value")?.text ?? "self"}` : null),
  ownerType: rubyLast,
  importNode(node) {
    if (node.type !== "call" || node.childForFieldName("receiver")) return false;
    return /^(require|require_relative|load|autoload)$/.test(node.childForFieldName("method")?.text ?? "");
  },
  statementName(node) {
    // `LIMIT = 10`
    if ((node.type === "assignment" || node.type === "operator_assignment") && node.childForFieldName("left")?.type === "constant") return node.childForFieldName("left")!.text;
    if (node.type !== "call") return null;
    // `private def helper … end` is the method `helper`.
    const first = node.childForFieldName("arguments")?.namedChildren[0];
    if (first && (first.type === "method" || first.type === "singleton_method") && !node.childForFieldName("receiver")) return first.childForFieldName("name")?.text ?? null;
    return rubyCallLabel(node);
  },
  // `describe Cart do … end`: each `it`, `let` and `before` inside is its own atom, named under it.
  // So are the examples in a loop inside a group (`%w[a b].each do |x| it … end`).
  nestedKeys(node) {
    const list = node.type === "call" ? node.childForFieldName("block")?.childForFieldName("body") : null;
    if (!list) return null;
    if (rubyGroup(node)) return { list, name: rubyCallLabel(node) ?? node.childForFieldName("method")!.text };
    const method = node.childForFieldName("method")?.text ?? "";
    const recv = node.childForFieldName("receiver");
    if (!recv || !/^each(_with_index|_pair)?$/.test(method) || !rubyInGroup(node)) return null;
    const params = node.childForFieldName("block")?.childForFieldName("parameters")?.text ?? "";
    return { list, name: recv.text.length <= 30 ? `${recv.text}.${method}` : `${method} ${params}`.trim() };
  },
  // A comment line belongs to what follows, even where the tree files it inside the item above.
  commentLine: (text) => /^\s*#/.test(text),
  docJoins: () => true,
  isBinding(n) {
    const p = n.parent;
    if (!p || n.type !== "identifier") return undefined;
    if (/^(method_parameters|block_parameters|lambda_parameters|destructured_parameter|left_assignment_list|exception_variable)$/.test(p.type)) return true;
    if (/^(optional_parameter|keyword_parameter|splat_parameter|hash_splat_parameter|block_parameter)$/.test(p.type)) return isField(p, "name", n);
    if (p.type === "for") return isField(p, "pattern", n);
    return undefined;
  },
  refOf(n) {
    const p = n.parent;
    // `private` on its own line changes visibility; it names nothing.
    if (n.type === "identifier" && p?.type === "body_statement" && /^(private|protected|public|module_function)$/.test(n.text)) return null;
    if (p?.type !== "call" || !isField(p, "method", n)) return undefined;
    const recv = p.childForFieldName("receiver");
    // Inside a method, `recalc()` and `self.recalc` call the class's own method; `Cart.build` is Cart's.
    // Calls in a class body (`has_many :posts`) stay plain.
    if (!recv || recv.type === "self") {
      const inMethod = firstAncestor(n, (t) => /^(method|singleton_method|class|module)$/.test(t));
      const cls = inMethod && /method$/.test(inMethod.type) ? rubyClass(n) : null;
      return cls ? `${cls}.${n.text}` : undefined;
    }
    if (recv.type === "constant" || recv.type === "scope_resolution") return n.text === "new" ? null : `${rubyLast(recv.text)}.${n.text}`;
    return undefined;
  },
};

const CSHARP_CLASS = /^(class|struct|record|record_struct|interface|enum)_declaration$/;
const csClass = (n: Node) => firstAncestor(n, (t) => CSHARP_CLASS.test(t))?.childForFieldName("name")?.text ?? null;

const CSHARP_BASE = genericPack("csharp", "csharp", [".cs", ".csx"]);
export const CSHARP: LanguagePack = {
  ...CSHARP_BASE,
  tier: 2,
  isClassLike: (t) => CSHARP_CLASS.test(t) || t === "namespace_declaration",
  // An `#if` that splits a signature leaves the parser with an error region; its declarations are still units.
  declList: (node) => (node.type === "ERROR" ? node : null),
  isBody: set("declaration_list"),
  isFunctionLike: set("method_declaration", "constructor_declaration", "destructor_declaration", "local_function_statement"),
  isWrapper: () => false,
  isImport: set("using_directive", "extern_alias_directive"),
  isLeading: set("comment"),
  isIdentifier: set("identifier", "implicit_parameter"),
  statementName(node) {
    if (node.type === "file_scoped_namespace_declaration") return `namespace ${node.childForFieldName("name")?.text ?? ""}`.trim();
    // `private readonly List<Item> _items = new();`
    if (node.type === "field_declaration" || node.type === "event_field_declaration") {
      const decl = node.namedChildren.find((c) => c?.type === "variable_declaration")?.namedChildren.find((c) => c?.type === "variable_declarator");
      return decl?.childForFieldName("name")?.text ?? null;
    }
    return null;
  },
  docJoins: () => true,
  isBinding(n) {
    if (n.type === "implicit_parameter") return true; // `x` in `x => x + 1`
    const p = n.parent;
    switch (p?.type) {
      case "parameter":
      case "catch_declaration":
      case "declaration_pattern":
      case "var_pattern":
      case "declaration_expression":
        return isField(p, "name", n);
      case "foreach_statement":
        return isField(p, "left", n);
    }
    return undefined;
  },
  refOf(n) {
    if (n.type !== "identifier") return undefined;
    const p = n.parent;
    // Namespace names in `using` and `namespace` lines aren't uses of a declaration.
    const named = firstAncestor(n, (t) => t !== "qualified_name");
    if (named && /^(using_directive|namespace_declaration|file_scoped_namespace_declaration)$/.test(named.type) && (p?.type === "qualified_name" || isField(named, "name", n) || named.type === "using_directive")) return null;
    // `Recalc()` calls the enclosing class's own method.
    if (p?.type === "invocation_expression" && isField(p, "function", n)) {
      const cls = csClass(n);
      return cls ? `${cls}.${n.text}` : undefined;
    }
    if (p?.type !== "member_access_expression" || !isField(p, "name", n)) return undefined;
    const obj = p.childForFieldName("expression");
    const g = p.parent;
    const called = g?.type === "invocation_expression" && isField(g, "function", p);
    // `this.Recalc()` and `this.Total`: the class's own member; `Helpers.Log()` Helpers'.
    if (obj?.type === "this") return `${csClass(n) ?? ""}.${n.text}`;
    if (called && obj?.type === "identifier" && /^[A-Z]/.test(obj.text)) return `${obj.text}.${n.text}`;
    // Other calls name the method; other reads are member-only, as `a.b` is in other languages.
    return called ? n.text : `.${n.text}`;
  },
};

const PHP_CLASS = /^(class|interface|trait|enum)_declaration$/;
const phpClass = (n: Node) => firstAncestor(n, (t) => PHP_CLASS.test(t))?.childForFieldName("name")?.text ?? null;
/** `Helpers`, `\App\Support\Helpers` → `Helpers`. */
const phpLast = (s: string) => s.replace(/^.*\\/, "");

/** `Foo::m()` and `self::LIMIT`: `Foo.m`, or the enclosing class's own member for self and static. */
function phpScoped(scope: Node | null | undefined, n: Node): string | null | undefined {
  if (!scope) return undefined;
  if (scope.type === "relative_scope") return scope.text === "parent" ? n.text : `${phpClass(n) ?? ""}.${n.text}`;
  const last = phpLast(scope.text);
  return /^\w+$/.test(last) ? `${last}.${n.text}` : n.text;
}

/** A label for a call statement with a string first argument: `Route::get('/cart')`, `it('adds items')`. */
function phpCallLabel(node: Node): string | null {
  if (node.type !== "expression_statement") return null;
  const call = node.namedChildren[0];
  let fn: string | null = null;
  if (call?.type === "function_call_expression") fn = call.childForFieldName("function")?.text ?? null;
  else if (call?.type === "scoped_call_expression") fn = `${call.childForFieldName("scope")?.text ?? ""}::${call.childForFieldName("name")?.text ?? ""}`;
  const first = call?.childForFieldName("arguments")?.namedChildren[0]?.namedChildren[0];
  if (!fn || fn.length > 40 || !first || !/^(string|encapsed_string)$/.test(first.type)) return null;
  return `${fn}(${quoted(first.text)})`;
}

const PHP_BASE = genericPack("php", "php", [".php"]);
export const PHP: LanguagePack = {
  ...PHP_BASE,
  tier: 2,
  isClassLike: (t) => PHP_CLASS.test(t) || t === "namespace_definition",
  isBody: set("declaration_list", "enum_declaration_list", "compound_statement"),
  isFunctionLike: set("method_declaration", "function_definition"),
  isWrapper: () => false,
  isImport: set("namespace_use_declaration"),
  // The opening `<?php` belongs with what follows it.
  isLeading: set("comment", "php_tag"),
  isIdentifier: set("name"),
  // `namespace App\Models;` names a line, like Java's `package`; a braced namespace holds its declarations.
  classNameOf: (node) => (node.type === "namespace_definition" && !node.childForFieldName("body") ? `namespace ${node.childForFieldName("name")?.text ?? ""}`.trim() : null),
  importNode: (node) => node.type === "expression_statement" && /^(require|require_once|include|include_once)_expression$/.test(node.namedChildren[0]?.type ?? ""),
  statementName(node) {
    // `const LIMIT = 10;` and `private array $items = [];` (named without the `$`)
    if (node.type === "const_declaration") return node.namedChildren.find((c) => c?.type === "const_element")?.namedChildren.find((c) => c?.type === "name")?.text ?? null;
    if (node.type === "property_declaration") return node.namedChildren.find((c) => c?.type === "property_element")?.childForFieldName("name")?.namedChildren.find((c) => c?.type === "name")?.text ?? null;
    return phpCallLabel(node);
  },
  docJoins: () => true,
  refOf(n) {
    if (n.type !== "name") return undefined;
    const p = n.parent;
    if (!p) return undefined;
    // `$item` is a variable, `App` in `App\Models\User` a namespace: neither names a declaration.
    if (p.type === "variable_name" || p.type === "namespace_name") return null;
    switch (p.type) {
      case "member_call_expression":
      case "nullsafe_member_call_expression":
      case "member_access_expression":
      case "nullsafe_member_access_expression": {
        if (!isField(p, "name", n)) return undefined;
        // `$this->recalc()` and `$this->items`: the class's own member.
        if (p.childForFieldName("object")?.text === "$this") return `${phpClass(n) ?? ""}.${n.text}`;
        return /call/.test(p.type) ? n.text : `.${n.text}`;
      }
      case "scoped_call_expression":
        return isField(p, "name", n) ? phpScoped(p.childForFieldName("scope"), n) : undefined;
      case "class_constant_access_expression": {
        const kids = p.namedChildren;
        if (kids.length < 2 || kids[kids.length - 1]?.id !== n.id) return undefined; // the class itself
        return n.text === "class" ? null : phpScoped(kids[0], n);
      }
    }
    return undefined;
  },
};

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

/** The text of a YAML scalar node, without quotes. */
const yamlText = (n: Node | null | undefined) => (n ? n.text.replace(/^["']|["']$/g, "").trim() : "");
/** The value of key `key` in a YAML mapping node (`block_node` holding a `block_mapping`). */
function yamlValue(node: Node | null | undefined, key: string): Node | null {
  const mapping = node?.type === "block_node" ? node.namedChildren.find((c) => c?.type === "block_mapping") : null;
  for (const pair of mapping?.namedChildren ?? []) {
    if (pair?.type === "block_mapping_pair" && yamlText(pair.childForFieldName("key")) === key) return pair.childForFieldName("value");
  }
  return null;
}

/** YAML: one atom per changed top-level key, per document. */
export const YAML_PACK: LanguagePack = {
  id: "yaml",
  tier: 1,
  grammar: "yaml",
  extensions: [".yaml", ".yml"],
  // Documents are containers, so the same key in two `---` documents stays apart.
  isClassLike: set("document"),
  classNameOf(doc) {
    if (doc.type !== "document") return null;
    const docs = (doc.parent?.namedChildren ?? []).filter((d) => d?.type === "document");
    if (docs.length <= 1) return "<document>";
    // Kubernetes-style manifests: `kind` and `metadata.name` name the document.
    const body = doc.namedChildren.find((c) => c?.type === "block_node");
    const kind = yamlText(yamlValue(body, "kind"));
    const name = yamlText(yamlValue(yamlValue(body, "metadata"), "name"));
    if (kind && /^[\w.-]{1,40}$/.test(kind)) return name && /^[\w.-]{1,60}$/.test(name) ? `${kind} ${name}` : kind;
    return `document ${docs.findIndex((d) => d?.id === doc.id) + 1}`;
  },
  isBody: set("block_node"),
  isFunctionLike: () => false,
  isWrapper: set("block_mapping", "block_sequence"),
  isImport: () => false,
  isLeading: set("comment"),
  isIdentifier: () => false,
  // A top-level list item (Ansible tasks, say) is named by its `name`.
  unitName(node) {
    if (node.type !== "block_sequence_item") return null;
    const name = yamlText(yamlValue(node.namedChildren.find((c) => c?.type === "block_node"), "name"));
    return name ? name.slice(0, 60) : null;
  },
  docJoins: () => true,
  data: true,
  // The parser files a comment under the key above it; a comment at the start of a line belongs to what follows.
  commentLine: (text) => /^#/.test(text),
  // A top-level key holding keys (`jobs:`, `on:`, `spec:`) splits into them: `jobs.build`, `jobs.test`.
  nestedKeys(node) {
    if (node.type !== "block_mapping_pair" || node.parent?.parent?.parent?.type !== "document") return null;
    const name = yamlText(node.childForFieldName("key"));
    const value = node.childForFieldName("value");
    const list = value?.type === "block_node" ? value.namedChildren.find((c) => c?.type === "block_mapping") : null;
    return name && list ? { list, name } : null;
  },
  // A key holding a block (a job, a list of steps) stands alone; small `key: value` neighbours may join.
  isBlock: (node) =>
    node.type === "block_mapping_pair" &&
    !!node.childForFieldName("value")?.namedChildren.some((c) => c?.type === "block_mapping" || c?.type === "block_sequence"),
};

/** TOML: one atom per changed table (`[package]`, `[[bin]]`) or top-level key. */
export const TOML_PACK: LanguagePack = {
  id: "toml",
  tier: 1,
  grammar: "toml",
  extensions: [".toml"],
  isClassLike: () => false,
  isBody: () => false,
  isFunctionLike: () => false,
  isWrapper: () => false,
  isImport: () => false,
  isLeading: set("comment"),
  isIdentifier: () => false,
  unitName(node) {
    const key = node.namedChildren.find((c) => c && /_key$/.test(c.type))?.text.replace(/\s+/g, "");
    if (!key) return null;
    if (node.type === "table") return `[${key}]`;
    if (node.type === "table_array_element") return `[[${key}]]`;
    return node.type === "pair" ? key : null;
  },
  docJoins: () => true,
  data: true,
  commentLine: (text) => /^\s*#/.test(text),
};

export const LANGUAGE_PACKS: LanguagePack[] = [TYPESCRIPT, TSX, JAVASCRIPT, PYTHON, C, CPP, GO, RUST, JAVA, RUBY, CSHARP, PHP, JSON_PACK, YAML_PACK, TOML_PACK];

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
  if (lower.endsWith(".blade.php")) return null; // Blade templates are HTML to the PHP grammar
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
