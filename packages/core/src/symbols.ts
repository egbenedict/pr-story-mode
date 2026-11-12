import type { Node, Query } from "web-tree-sitter";
import type { LanguagePack } from "./languages";

/**
 * Definitions and references of a piece of syntax (an atom's unit, or an unchanged unit used for
 * context).
 *
 * Definitions come from the grammar's `tags.scm` query where it ships one, limited to names the
 * unit itself defines (not functions nested inside it, nor object-literal properties).
 *
 * References are identifiers, minus names bound inside the unit (parameters, local variables,
 * loop and catch variables), keyword-argument names and member names being declared. Members:
 * - `this.b` / `self.b` (read, written or called) inside class `C` is recorded as `C.b`, so it
 *   links only to C's own member (or an inherited one, see buildGraph);
 * - `a.b()` and `@a.b` are recorded as `b`;
 * - other reads and writes `a.b`, and object keys `{ b: 1 }`, are recorded as `.b`: member-only,
 *   so they link to a class or interface member named `b` but never to a global `b`.
 */
export function unitSymbols(nodes: Node[], pack: LanguagePack, tags: Query | null): { defs: string[]; refs: Set<string> } {
  const defs = new Set<string>();
  const nested = new Set<string>(); // names defined deeper inside (local functions, classes)
  if (tags)
    for (const unit of nodes) {
      let matches: ReturnType<Query["matches"]> = [];
      try {
        matches = tags.matches(unit);
      } catch {
        // a query failure only means fewer definitions
      }
      for (const m of matches) {
        const def = m.captures.find((c) => c.name.startsWith("definition."));
        const name = m.captures.find((c) => c.name === "name");
        if (!def || !name) continue;
        // `{ f: () => … }` and `a.f = () => …` define properties, not names.
        if (def.node.type === "pair" || (name.node.parent && PROPERTY_FIELD[name.node.parent.type])) continue;
        (ownedBy(def.node, unit, pack) ? defs : nested).add(name.node.text);
      }
    }

  const bound = new Set<string>(nested);
  const used: { node: Node; text: string; key?: boolean }[] = [];
  for (const unit of nodes) {
    const stack: Node[] = [unit];
    let visited = 0;
    while (stack.length && visited < 20000) {
      const n = stack.pop()!;
      visited++;
      if (pack.isIdentifier(n.type)) {
        if (isBinding(n)) bound.add(n.text);
        else if (isObjectKey(n)) used.push({ node: n, text: n.text, key: true });
        else if (!isNameOnly(n)) used.push({ node: n, text: n.text });
        // Look inside `Ns::name` / `crate::name` so the bare name is found too.
        if (!/qualified|scoped/.test(n.type)) continue;
      }
      for (const c of n.namedChildren) if (c) stack.push(c);
    }
  }

  const refs = new Set<string>();
  for (const { node, text, key } of used) {
    const own = pack.refOf?.(node);
    if (own !== undefined) {
      if (own !== null) refs.add(own);
      continue;
    }
    if (key) {
      refs.add(`.${text}`);
      continue;
    }
    const prop = propertyOf(node);
    if (prop) {
      const cls = prop.onSelf ? enclosingClass(node, pack) : null;
      if (cls) refs.add(`${cls}.${text}`);
      else refs.add(prop.called ? text : `.${text}`);
    } else if (!bound.has(text)) refs.add(text);
  }
  for (const d of defs) refs.delete(d);
  return { defs: [...defs], refs };
}

/** True when `def` belongs to `unit` itself rather than to a function or class nested inside it. */
function ownedBy(def: Node, unit: Node, pack: LanguagePack): boolean {
  for (let p = def.parent; p && p.id !== unit.id; p = p.parent) {
    if (pack.isFunctionLike(p.type) || pack.isClassLike(p.type) || pack.isBody(p.type) || /^(arrow_function|function_expression|lambda|closure_expression|function_item)$/.test(p.type)) return false;
  }
  return true;
}

const is = (p: Node | null, field: string, n: Node) => !!p && p.childForFieldName(field)?.id === n.id;

/** A name being introduced in a local scope: parameter, local variable, loop or catch variable. */
function isBinding(n: Node): boolean {
  let cur = n;
  let p = n.parent;
  // C/C++: `int *x`, `int &x`, `int x[3]`, `int x = 1` wrap the name in declarators.
  while (p && /^(pointer|reference|array|init|parenthesized)_declarator$/.test(p.type) && is(p, "declarator", cur)) {
    cur = p;
    p = p.parent;
  }
  if (!p) return false;
  const t = p.type;
  if (/^(formal_parameters|parameters|lambda_parameters|closure_parameters|inferred_parameters|identifier_list|pattern_list|tuple_pattern|list_pattern|array_pattern|object_pattern|rest_pattern|list_splat_pattern|dictionary_splat_pattern|as_pattern_target|typed_parameter|slice_pattern)$/.test(t))
    return !is(p, "type", cur);
  switch (t) {
    case "variable_declarator":
      return is(p, "name", cur) || is(p, "declarator", cur);
    case "required_parameter":
    case "optional_parameter":
      return is(p, "pattern", cur);
    case "assignment_pattern":
    case "object_assignment_pattern":
      return is(p, "left", cur);
    case "pair_pattern":
      return is(p, "value", cur);
    case "default_parameter":
    case "typed_default_parameter":
    case "formal_parameter":
    case "catch_formal_parameter":
    case "spread_parameter":
    case "enhanced_for_statement":
    case "var_spec":
    case "const_spec":
      return is(p, "name", cur);
    case "parameter_declaration":
    case "optional_parameter_declaration":
      return is(p, "declarator", cur) || is(p, "name", cur);
    case "declaration":
    case "for_range_loop":
    case "condition_clause":
      return is(p, "declarator", cur);
    case "arrow_function":
      return is(p, "parameter", cur);
    case "catch_clause":
      return is(p, "parameter", cur);
    case "for_in_statement":
    case "for_statement":
    case "for_in_clause":
    case "assignment": // Python: assignment makes a local name
      return is(p, "left", cur);
    case "let_declaration":
    case "parameter":
    case "for_expression":
    case "let_condition":
      return is(p, "pattern", cur);
    case "match_pattern":
      return true;
    case "tuple_struct_pattern":
    case "struct_pattern":
      return !is(p, "type", cur);
    case "expression_list": {
      const g = p.parent;
      return !!g && /^(short_var_declaration|range_clause)$/.test(g.type) && is(g, "left", p);
    }
  }
  return false;
}

/** Names that label something rather than use it: keys, keyword arguments, declared members. */
function isNameOnly(n: Node): boolean {
  const p = n.parent;
  if (!p) return false;
  switch (p.type) {
    case "pair":
      return is(p, "key", n); // keys of non-object pairs; object keys are handled by isObjectKey
    case "keyword_argument":
      return is(p, "name", n);
    case "field_designator":
    case "labeled_statement":
    case "statement_identifier":
      return true;
    case "property_signature":
    case "public_field_definition":
    case "method_definition":
    case "method_signature":
    case "abstract_method_signature":
    case "field_definition":
      return is(p, "name", n);
    case "field_declaration":
      return is(p, "declarator", n) || is(p, "name", n);
    case "enumerator":
      return is(p, "name", n);
  }
  return false;
}

/** `b` in an object literal `{ b: 1 }` (JS/TS). */
function isObjectKey(n: Node): boolean {
  return n.parent?.type === "pair" && is(n.parent, "key", n) && n.parent.parent?.type === "object";
}

const PROPERTY_FIELD: Record<string, string> = {
  member_expression: "property",
  attribute: "attribute",
  field_expression: "field",
  selector_expression: "field",
  field_access: "field",
};

/** For `a.b` / `a->b` with `n` the `b`: whether it is called (or a decorator), and whether `a` is this/self. */
function propertyOf(n: Node): { called: boolean; onSelf: boolean } | null {
  const p = n.parent;
  if (!p) return null;
  const field = PROPERTY_FIELD[p.type];
  if (!field || !is(p, field, n)) return null;
  const g = p.parent;
  const called = !!g && ((/^(call_expression|call)$/.test(g.type) && is(g, "function", p)) || g.type === "decorator");
  const obj = p.childForFieldName("object") ?? p.childForFieldName("argument") ?? p.childForFieldName("operand") ?? p.childForFieldName("value");
  const onSelf = !!obj && /^(this|self)$/.test(obj.text);
  return { called, onSelf };
}

function enclosingClass(n: Node, pack: LanguagePack): string | null {
  for (let p = n.parent; p; p = p.parent) {
    if (pack.isClassLike(p.type)) {
      const own = pack.selfTypeOf?.(p);
      if (own) return own;
      const name = p.childForFieldName("name");
      return name ? name.text : null;
    }
  }
  return null;
}
