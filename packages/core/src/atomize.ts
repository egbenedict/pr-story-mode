import type { Node, Tree } from "web-tree-sitter";
import type { ChangeAtom, DiffLineRef, PRFile, PRInput } from "./types";
import {
  isGeneratedPath,
  isGeneratedText,
  isLockfile,
  languageNameForPath,
  packForPath,
  type LanguagePack,
} from "./languages";
import type { ParserHost } from "./parse";
import { stableId } from "./hash";
import { unitSymbols } from "./symbols";

/** Where a changed line lives in the syntax tree. */
type Location =
  | { kind: "unit"; path: string[]; named: boolean; node: Node; start: number; end: number; block: boolean }
  | { kind: "import"; path: string[]; node: Node }
  | { kind: "leading" } // comment/decorator: attaches to the next atom
  | { kind: "none" }; // blank or between units: attaches to a neighbour

type Group = {
  key: string;
  path: string[];
  named: boolean;
  isImport: boolean;
  /** A function or class: always its own atom, never merged with its neighbours. */
  block?: boolean;
  /** For a joined run of declarations, the name of each one. */
  joinedNames?: string[];
  lines: DiffLineRef[];
  baseNodes: Node[];
  headNodes: Node[];
  baseRange?: { start: number; end: number };
  headRange?: { start: number; end: number };
};

export const STOP_NAMES = new Set([
  "constructor", "__init__", "init", "main", "default", "index", "get", "set", "self", "this", "cls",
  "toString", "length", "value", "name", "id", "type", "data", "key", "args", "kwargs", "props", "result",
  "string", "number", "boolean", "any", "void", "true", "false", "null", "undefined", "None", "True", "False",
]);

export async function atomizePR(pr: PRInput, host: ParserHost): Promise<ChangeAtom[]> {
  const atoms: ChangeAtom[] = [];
  for (const file of pr.files) {
    const parts = await atomizeFile(file, pr.headSha, host);
    atoms.push(...(file.status === "removed" ? deletedFileAtoms(file, parts, pr.headSha) : parts));
  }
  // Make IDs unique even in the unlikely event of a hash collision.
  const seen = new Map<string, number>();
  for (const a of atoms) {
    const n = seen.get(a.id) ?? 0;
    seen.set(a.id, n + 1);
    if (n > 0) a.id = `${a.id}_${n}`;
  }
  return atoms;
}

/**
 * A deleted file is one change, not one per function it held: there is nothing to pair its lines
 * with, and the reader shows it folded under a summary of what it defined. Mechanical files
 * (generated, lockfiles, binaries) stay as they are.
 */
function deletedFileAtoms(file: PRFile, parts: ChangeAtom[], headSha: string): ChangeAtom[] {
  const code = parts.filter((a) => !a.mechanical);
  if (!code.length) return parts;
  const defines = [...new Set(code.flatMap((a) => a.defines))];
  const own = new Set(defines);
  const merged: ChangeAtom = {
    id: stableId(file.path, "<deleted>", headSha),
    file: file.path,
    language: code[0]!.language,
    symbolPath: [],
    kind: "removed",
    hunkLines: code.flatMap((a) => a.hunkLines).sort((x, y) => x.line - y.line),
    defines,
    references: [...new Set(code.flatMap((a) => a.references))].filter((r) => !own.has(r)),
    supportTier: Math.max(...code.map((a) => a.supportTier)) as 0 | 1 | 2,
    // What the file held at the top level (functions, classes, types), for its summary.
    deletedFile: { names: [...new Set(code.filter((a) => a.symbolPath.length === 1 && /^[A-Za-z_$][\w$]*$/.test(a.symbolPath[0]!)).map((a) => a.symbolPath[0]!))] },
  };
  return [...parts.filter((a) => a.mechanical), merged];
}

export async function atomizeFile(file: PRFile, headSha: string, host: ParserHost): Promise<ChangeAtom[]> {
  const path = file.path;
  const language = languageNameForPath(path);
  const allLines = collectLines(file);
  const base = { file: path, language, defines: [], references: [] };

  // Binary files and pure renames have no lines but still need to be shown.
  if (file.binary || (allLines.length === 0 && file.hunks.length === 0)) {
    const kind = file.status === "renamed" ? "renamed" : file.status === "added" ? "added" : file.status === "removed" ? "removed" : "modified";
    return [
      {
        ...base,
        id: stableId(path, file.binary ? "<binary>" : "<rename>", headSha),
        symbolPath: [],
        kind,
        hunkLines: [],
        mechanical: file.binary ? "generated" : "rename",
        supportTier: 0,
      },
    ];
  }

  // Lockfiles and generated files: one atom for the whole file, listed with mechanical changes.
  const lock = isLockfile(path);
  if (lock || isGeneratedPath(path) || isGeneratedText(file.headText ?? file.baseText)) {
    return [
      {
        ...base,
        id: stableId(path, "<file>", headSha),
        symbolPath: [],
        kind: fileKind(file),
        hunkLines: allLines.map((l) => l.ref),
        mechanical: lock ? "lockfile" : "generated",
        supportTier: 0,
      },
    ];
  }

  const pack = packForPath(path);
  let baseTree: Tree | null = null;
  let headTree: Tree | null = null;
  if (pack) {
    if (file.status !== "added" && file.baseText !== undefined) baseTree = await host.parse(pack.grammar, file.baseText);
    if (file.status !== "removed" && file.headText !== undefined) headTree = await host.parse(pack.grammar, file.headText);
  }
  const needBase = allLines.some((l) => l.ref.side === "LEFT");
  const needHead = allLines.some((l) => l.ref.side === "RIGHT");
  const parsed = pack && (!needBase || baseTree) && (!needHead || headTree);
  const tier: 0 | 1 | 2 = parsed ? pack!.tier : 0;
  const tags = parsed ? await host.query(pack!.grammar, "tags") : null;

  // 1. Locate each changed line in its tree.
  const located: { line: LineInfo; loc: Location }[] = allLines.map((line) => {
    if (!parsed) return { line, loc: { kind: "none" } as Location };
    if (line.text.trim() === "") return { line, loc: { kind: "none" } as Location };
    if (pack!.commentLine?.(line.text)) return { line, loc: { kind: "leading" } as Location };
    const tree = line.ref.side === "LEFT" ? baseTree! : headTree!;
    return { line, loc: locate(tree.rootNode, line.ref.line - 1, pack!) };
  });

  // 2. Group located lines; unassigned lines attach to a neighbour in the same hunk.
  const groups = new Map<string, Group>();
  const keyOf: (string | null)[] = located.map(({ line, loc }) => {
    if (loc.kind === "unit") {
      // Unnamed statements group by hunk, so a modified statement's removed and added lines stay
      // together. In added or removed files there is nothing to pair, so each statement stands alone.
      const anon = file.status === "added" || file.status === "removed" ? `<stmt ${loc.start}>` : `<hunk ${line.hunk}>`;
      const key = loc.named ? loc.path.join(".") : [...loc.path, anon].join(".");
      addToGroup(groups, key, loc.path, loc.named, false, line, loc.node, loc.start, loc.end);
      if (loc.block) groups.get(key)!.block = true;
      return key;
    }
    if (loc.kind === "import") {
      const key = loc.path.join(".");
      addToGroup(groups, key, loc.path, true, true, line, loc.node, loc.node.startPosition.row + 1, loc.node.endPosition.row + 1);
      return key;
    }
    return null;
  });

  // Doc comments join the declaration right below them, where the pack asks for it.
  const fileLines: Partial<Record<"LEFT" | "RIGHT", string[]>> = {};
  const documented = (ref: DiffLineRef): Location | null => {
    const tree = ref.side === "LEFT" ? baseTree : headTree;
    if (!tree || !pack) return null;
    const lines = (fileLines[ref.side] ??= ((ref.side === "LEFT" ? file.baseText : file.headText) ?? "").split("\n"));
    for (let r = ref.line; r < lines.length; r++) {
      const loc = locate(tree.rootNode, r, pack);
      if (loc.kind === "leading" || pack.commentLine?.(lines[r])) continue; // more of the comment, or another one
      if (lines[r].trim() === "") return null; // a blank line: the comment isn't attached
      return loc.kind === "unit" && loc.named && loc.start === r + 1 ? loc : null;
    }
    return null;
  };

  for (let i = 0; i < located.length; i++) {
    if (keyOf[i] !== null) continue;
    const { line, loc } = located[i];
    const hunk = line.hunk;
    if (loc.kind === "leading" && parsed && pack!.docJoins?.(line.text)) {
      const doc = documented(line.ref);
      if (doc && doc.kind === "unit") {
        const key = doc.path.join(".");
        addToGroup(groups, key, doc.path, true, false, line, doc.node, doc.start, doc.end);
        if (doc.block) groups.get(key)!.block = true;
        keyOf[i] = key;
        continue;
      }
    }
    // Comments and decorators prefer the next unit; blank lines prefer the previous one.
    const order = loc.kind === "leading" ? [1, -1] : [-1, 1];
    let target: string | null = null;
    for (const dir of order) {
      for (let j = i + dir; j >= 0 && j < located.length && located[j].line.hunk === hunk; j += dir) {
        if (keyOf[j] !== null) {
          target = keyOf[j];
          break;
        }
      }
      if (target) break;
    }
    if (target) {
      groups.get(target)!.lines.push(line.ref);
    } else {
      const key = `<hunk ${hunk}>`;
      const g = groups.get(key) ?? { key, path: [], named: false, isImport: false, lines: [], baseNodes: [], headNodes: [] };
      g.lines.push(line.ref);
      groups.set(key, g);
    }
    keyOf[i] = target ?? `<hunk ${hunk}>`;
  }

  // 3. Turn groups into atoms, after joining runs of small adjacent declarations.
  const out: ChangeAtom[] = [];
  for (const g of mergeDeclarationRuns([...groups.values()])) {
    const defines: string[] = [];
    // Keys in a data file (YAML, TOML) name its atoms but define nothing code can use.
    const data = !!pack?.data;
    if (g.named && !g.isImport && !data)
      for (const name of g.joinedNames ?? [g.path[g.path.length - 1]])
        if (name && /^[\w$.#:~]+$/.test(name)) defines.push(name.replace(/^.*(\.|::)/, ""));
    let refs = new Set<string>();
    if (pack && tier > 0 && !data) {
      const nodes = g.headNodes.length ? g.headNodes : g.baseNodes;
      const sym = unitSymbols(nodes, pack, tags);
      refs = sym.refs;
      // The grammar's tags catch names the unit name misses, e.g. `const a = 1, b = 2`.
      if (!g.isImport) for (const d of sym.defs) if (!defines.includes(d) && /^[\w$#~]+$/.test(d)) defines.push(d);
    }
    // A member is also known by its class, so `this.m()` / `self.m()` links only to the class's own `m`.
    const pathOwner = g.path.length >= 2 ? g.path[g.path.length - 2] : null;
    const owner = pathOwner && pack?.ownerType ? pack.ownerType(pathOwner) : pathOwner;
    if (g.named && !g.isImport && defines.length && owner && /^[\w$]+$/.test(owner)) {
      // A joined run of fields defines each of them on the class.
      const own = g.joinedNames ? [...defines] : [defines[0]];
      for (const d of own) defines.push(`${owner}.${d}`);
      if (pack?.scopedMembers) for (const d of own) defines.push(`${owner}::${d}`);
    }
    for (const d of defines) refs.delete(d);

    out.push({
      id: stableId(path, g.key, headSha),
      file: path,
      language,
      symbolPath: g.path.filter((p) => !p.startsWith("<hunk") && !p.startsWith("<stmt")),
      kind: atomKind(file, g),
      baseRange: g.baseRange,
      headRange: g.headRange,
      hunkLines: sortRefs(g.lines),
      defines: defines.filter((d) => !STOP_NAMES.has(d.slice(d.lastIndexOf(".") + 1))),
      references: [...refs].filter((r) => r.length > 1 && !STOP_NAMES.has(r.slice(r.lastIndexOf(".") + 1))).slice(0, 300),
      supportTier: tier,
    });
  }
  // Order atoms by their first line in the file, for stable output.
  out.sort((a, b) => firstLine(a) - firstLine(b));
  return out;
}

// ---------- tree walking ----------

function locate(root: Node, row: number, pack: LanguagePack): Location {
  const path: string[] = [];
  let node: Node = root;
  let unit: { node: Node; start: number; end: number; named: boolean; path: string[]; block?: boolean } | null = null;
  let wrapperStart: number | null = null;

  for (;;) {
    const child = childAt(node, row, pack);
    if (!child) break;
    const t = child.type;

    if (pack.isLeading(t)) return { kind: "leading" };
    if (pack.isImport(t)) return { kind: "import", path: [...path, "<imports>"], node: child };

    // A key whose entries are units of their own, named under it.
    const nested = pack.nestedKeys?.(child);
    if (nested) {
      if (!childAt(nested.list, row, pack)) return row === child.startPosition.row ? { kind: "leading" } : { kind: "none" };
      path.push(nested.name);
      node = nested.list;
      wrapperStart = null; // its entries start where they start, not where an enclosing wrapper did
      continue;
    }

    // A group of declarations: each entry is its own unit. The group's opening line joins the entry
    // below it, and its closing line the one above.
    const list = pack.declList?.(child);
    if (list) {
      if (!childAt(list, row, pack)) return row === child.startPosition.row ? { kind: "leading" } : { kind: "none" };
      node = list;
      wrapperStart = null;
      continue;
    }

    if (pack.isWrapper(t)) {
      wrapperStart ??= child.startPosition.row;
      // If nothing more specific is found inside, the wrapper itself is the unit.
      const name = nameOf(child);
      unit = {
        node: child,
        start: child.startPosition.row + 1,
        end: child.endPosition.row + 1,
        named: name !== null,
        path: name ? [...path, name] : [...path],
      };
      node = child;
      continue;
    }

    const start = (wrapperStart ?? child.startPosition.row) + 1;
    wrapperStart = null;

    if (pack.isClassLike(t)) {
      const name = pack.classNameOf?.(child) ?? nameOf(child) ?? `<${t}>`;
      path.push(name);
      unit = { node: child, start, end: child.endPosition.row + 1, named: true, path: [...path], block: true };
      const body = child.childForFieldName("body") ?? child.namedChildren.find((c) => c && pack.isBody(c.type)) ?? null;
      if (body && body.startPosition.row <= row && row <= body.endPosition.row) {
        node = body;
        continue;
      }
      break;
    }

    if (pack.isFunctionLike(t)) {
      const name = nameOf(child) ?? "<anonymous>";
      const owner = pack.ownerOf?.(child) ?? null;
      unit = { node: child, start, end: child.endPosition.row + 1, named: true, path: owner ? [...path, owner, name] : [...path, name], block: true };
      break;
    }

    // Any other statement directly inside a container (module, class body) is its own unit.
    const name = nameOf(child);
    const packName = name === null ? (pack.unitName?.(child) ?? null) : null;
    if (packName) {
      unit = { node: child, start, end: child.endPosition.row + 1, named: true, path: [...path, packName], block: true };
      break;
    }
    unit = { node: child, start, end: child.endPosition.row + 1, named: name !== null, path: name ? [...path, name] : [...path] };
    if (pack.isBlock?.(child)) unit.block = true;
    break;
  }

  return unit ? unitLocation(unit) : { kind: "none" };
}

function unitLocation(u: { node: Node; start: number; end: number; named: boolean; path: string[]; block?: boolean }): Location {
  return { kind: "unit", path: u.path, named: u.named, node: u.node, start: u.start, end: u.end, block: !!u.block };
}

/** A declaration this long or shorter can join its neighbours. */
export const MERGE_MAX_LINES = 8;

/**
 * Join runs of small declarations that sit next to each other in the same scope (consts, fields,
 * assignments, short statements) into one group, so three changed lines and the one below them
 * read as one piece of code. Functions, classes and imports stay on their own.
 */
function mergeDeclarationRuns(groups: Group[]): Group[] {
  const range = (g: Group) => g.headRange ?? g.baseRange;
  const small = (g: Group) => {
    const r = range(g);
    return !g.block && !g.isImport && !!r && r.end - r.start + 1 <= MERGE_MAX_LINES;
  };
  const scope = (g: Group) => (g.named ? g.path.slice(0, -1) : g.path).join("\u0000");
  const adjacent = (a: Group, b: Group) => {
    const side = a.headRange && b.headRange ? "headRange" : !a.headRange && !b.headRange && a.baseRange && b.baseRange ? "baseRange" : null;
    if (!side) return false;
    const gap = b[side]!.start - a[side]!.end - 1;
    return gap >= 0 && gap <= 1;
  };
  const sorted = [...groups].sort((a, b) => (range(a)?.start ?? Infinity) - (range(b)?.start ?? Infinity));
  const out: Group[] = [];
  let run: Group[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) out.push(joinGroups(run));
    run = [];
  };
  for (const g of sorted) {
    const prev = run[run.length - 1];
    if (prev && small(g) && scope(prev) === scope(g) && adjacent(prev, g)) run.push(g);
    else {
      flush();
      if (small(g)) run.push(g);
      else out.push(g);
    }
  }
  flush();
  return out;
}

function joinGroups(run: Group[]): Group {
  const names = run.filter((g) => g.named).map((g) => g.path[g.path.length - 1]!);
  const scope = run[0].named ? run[0].path.slice(0, -1) : run[0].path;
  const label = names.length === 0 ? null : names.length <= 3 ? names.join(", ") : `${names[0]}, …, ${names[names.length - 1]}`;
  const span = (pick: (g: Group) => { start: number; end: number } | undefined) => {
    const rs = run.map(pick).filter((r): r is { start: number; end: number } => !!r);
    return rs.length ? { start: Math.min(...rs.map((r) => r.start)), end: Math.max(...rs.map((r) => r.end)) } : undefined;
  };
  return {
    key: run.map((g) => g.key).join(" + "),
    path: label ? [...scope, label] : scope,
    named: !!label,
    isImport: false,
    lines: run.flatMap((g) => g.lines),
    baseNodes: run.flatMap((g) => g.baseNodes),
    headNodes: run.flatMap((g) => g.headNodes),
    baseRange: span((g) => g.baseRange),
    headRange: span((g) => g.headRange),
    joinedNames: names,
  };
}

function childAt(node: Node, row: number, pack?: LanguagePack): Node | null {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (pack?.endsAtLineStart && c.endPosition.row === row && c.endPosition.column === 0 && c.startPosition.row < row) continue;
    if (c.startPosition.row <= row && row <= c.endPosition.row) return c;
    if (c.startPosition.row > row) break;
  }
  return null;
}

export function nameOf(node: Node): string | null {
  if (/^(assignment|augmented_assignment|assignment_expression)$/.test(node.type)) {
    const left = node.childForFieldName("left");
    if (left && /identifier|attribute|member_expression/.test(left.type)) return cleanName(left.text);
  }
  const direct = node.childForFieldName("name") ?? node.childForFieldName("key");
  if (direct) return cleanName(direct.text);

  // C/C++: the name sits under one or more declarators, e.g. `static int *f(int x)` or `Foo::bar() const`.
  const declName = declaratorName(node);
  if (declName) return declName;

  // test("does X", ...), it(...), describe(...), app.get("/path", ...): name by callee and first string.
  const call = /^(call_expression|call)$/.test(node.type)
    ? node
    : node.type === "expression_statement"
      ? (node.namedChildren.find((c) => c && /^(call_expression|call|await_expression)$/.test(c.type)) ?? null)
      : null;
  if (call) {
    const inner = call.type === "await_expression" ? call.namedChildren[0] : call;
    const fn = inner?.childForFieldName("function");
    const first = inner?.childForFieldName("arguments")?.namedChildren[0];
    // C/C++ macros such as LUAU_FASTFLAGVARIABLE(Name, false) or DEFINE_FLAG(name): they define their first argument.
    if (fn && /^[A-Z][A-Z0-9_]{2,}$/.test(fn.text) && first && /identifier$/.test(first.type)) return cleanName(first.text);
    if (fn && fn.text.length <= 40 && first && /string/.test(first.type)) {
      const q = first.text[0];
      const body = first.text.slice(1, -1).replace(/\s+/g, " ");
      return `${cleanName(fn.text)}(${q}${body.length > 60 ? body.slice(0, 59).trimEnd() + "…" : body}${q})`;
    }
  }

  // Rust `impl Foo { ... }`
  if (node.type === "impl_item") {
    const ty = node.childForFieldName("type");
    if (ty) return cleanName(ty.text);
  }

  for (const c of node.namedChildren) {
    if (!c) continue;
    // const x = ..., let y = ..., Go `type Foo struct`, `var x = ...`
    if (/declarator$|_spec$/.test(c.type)) {
      const n = c.childForFieldName("name");
      if (n) return cleanName(n.text);
    }
    // Python `x = ...` / `self.x = ...` statements
    if (c.type === "assignment" || c.type === "augmented_assignment") {
      const left = c.childForFieldName("left");
      if (left && (left.type === "identifier" || left.type === "attribute")) return cleanName(left.text);
    }
    // TypeScript `foo.bar = ...` at top level
    if (c.type === "assignment_expression") {
      const left = c.childForFieldName("left");
      if (left && /identifier|member_expression/.test(left.type)) return cleanName(left.text);
    }
  }
  return null;
}

function declaratorName(node: Node): string | null {
  let d = node.childForFieldName("declarator");
  for (let depth = 0; d && depth < 8; depth++) {
    if (/identifier$|^qualified_identifier$|^destructor_name$|^operator_name$/.test(d.type)) return cleanName(d.text);
    // `int x = 1;` has an init_declarator whose own declarator is the name.
    d = d.childForFieldName("declarator") ?? d.namedChildren.find((c) => c && /declarator$|identifier$/.test(c.type)) ?? null;
  }
  return null;
}

function cleanName(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "").replace(/\s+/g, " ").slice(0, 80);
}

// ---------- helpers ----------

type LineInfo = { ref: DiffLineRef; text: string; hunk: number };

function collectLines(file: PRFile): LineInfo[] {
  const out: LineInfo[] = [];
  file.hunks.forEach((h, hi) => {
    for (const l of h.lines) {
      if (l.type === "del") out.push({ ref: { side: "LEFT", line: l.oldLine }, text: l.text, hunk: hi });
      else if (l.type === "add") out.push({ ref: { side: "RIGHT", line: l.newLine }, text: l.text, hunk: hi });
    }
  });
  return out;
}

function addToGroup(
  groups: Map<string, Group>,
  key: string,
  path: string[],
  named: boolean,
  isImport: boolean,
  line: LineInfo,
  node: Node,
  start: number,
  end: number,
) {
  let g = groups.get(key);
  if (!g) {
    g = { key, path, named, isImport, lines: [], baseNodes: [], headNodes: [] };
    groups.set(key, g);
  }
  g.lines.push(line.ref);
  const isBase = line.ref.side === "LEFT";
  const nodes = isBase ? g.baseNodes : g.headNodes;
  if (!nodes.some((n) => n.id === node.id)) nodes.push(node);
  const range = isBase ? g.baseRange : g.headRange;
  const merged = range ? { start: Math.min(range.start, start), end: Math.max(range.end, end) } : { start, end };
  if (isBase) g.baseRange = merged;
  else g.headRange = merged;
}

function fileKind(file: PRFile): ChangeAtom["kind"] {
  return file.status === "added" ? "added" : file.status === "removed" ? "removed" : "modified";
}

function atomKind(file: PRFile, g: Group): ChangeAtom["kind"] {
  if (file.status === "added") return "added";
  if (file.status === "removed") return "removed";
  const left = g.lines.filter((l) => l.side === "LEFT");
  const right = g.lines.filter((l) => l.side === "RIGHT");
  if (right.length === 0 && g.baseRange && covers(left, g.baseRange)) return "removed";
  if (left.length === 0 && g.headRange && covers(right, g.headRange)) return "added";
  return "modified";
}

function covers(lines: DiffLineRef[], r: { start: number; end: number }): boolean {
  const s = new Set(lines.map((l) => l.line));
  for (let i = r.start; i <= r.end; i++) if (!s.has(i)) return false;
  return true;
}

function sortRefs(refs: DiffLineRef[]): DiffLineRef[] {
  return [...refs].sort((a, b) => (a.side === b.side ? a.line - b.line : a.side === "LEFT" ? -1 : 1));
}

function firstLine(a: ChangeAtom): number {
  return a.headRange?.start ?? a.baseRange?.start ?? a.hunkLines[0]?.line ?? 0;
}
