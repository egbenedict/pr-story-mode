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

/** Where a changed line lives in the syntax tree. */
type Location =
  | { kind: "unit"; path: string[]; named: boolean; node: Node; start: number; end: number }
  | { kind: "import"; path: string[]; node: Node }
  | { kind: "leading" } // comment/decorator: attaches to the next atom
  | { kind: "none" }; // blank or between units: attaches to a neighbour

type Group = {
  key: string;
  path: string[];
  named: boolean;
  isImport: boolean;
  lines: DiffLineRef[];
  baseNodes: Node[];
  headNodes: Node[];
  baseRange?: { start: number; end: number };
  headRange?: { start: number; end: number };
};

const STOP_NAMES = new Set([
  "constructor", "__init__", "init", "main", "default", "index", "get", "set", "self", "this", "cls",
  "toString", "length", "value", "name", "id", "type", "data", "key", "args", "kwargs", "props", "result",
  "string", "number", "boolean", "any", "void", "true", "false", "null", "undefined", "None", "True", "False",
]);

export async function atomizePR(pr: PRInput, host: ParserHost): Promise<ChangeAtom[]> {
  const atoms: ChangeAtom[] = [];
  for (const file of pr.files) atoms.push(...(await atomizeFile(file, pr.headSha, host)));
  // Make IDs unique even in the unlikely event of a hash collision.
  const seen = new Map<string, number>();
  for (const a of atoms) {
    const n = seen.get(a.id) ?? 0;
    seen.set(a.id, n + 1);
    if (n > 0) a.id = `${a.id}_${n}`;
  }
  return atoms;
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

  // 1. Locate each changed line in its tree.
  const located: { line: LineInfo; loc: Location }[] = allLines.map((line) => {
    if (!parsed) return { line, loc: { kind: "none" } as Location };
    if (line.text.trim() === "") return { line, loc: { kind: "none" } as Location };
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
      return key;
    }
    if (loc.kind === "import") {
      const key = loc.path.join(".");
      addToGroup(groups, key, loc.path, true, true, line, loc.node, loc.node.startPosition.row + 1, loc.node.endPosition.row + 1);
      return key;
    }
    return null;
  });

  for (let i = 0; i < located.length; i++) {
    if (keyOf[i] !== null) continue;
    const { line, loc } = located[i];
    const hunk = line.hunk;
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

  // 3. Turn groups into atoms.
  const out: ChangeAtom[] = [];
  for (const g of groups.values()) {
    const defines: string[] = [];
    if (g.named && !g.isImport) {
      const last = g.path[g.path.length - 1];
      if (last && /^[\w$.#]+$/.test(last)) defines.push(last.replace(/^.*\./, ""));
    }
    const refs = new Set<string>();
    if (pack && tier > 0) {
      const nodes = g.headNodes.length ? g.headNodes : g.baseNodes;
      for (const n of nodes) collectIdentifiers(n, pack, refs);
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
      defines: defines.filter((d) => !STOP_NAMES.has(d)),
      references: [...refs].filter((r) => r.length > 1 && !STOP_NAMES.has(r)).slice(0, 300),
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
  let unit: { node: Node; start: number; end: number; named: boolean; path: string[] } | null = null;
  let wrapperStart: number | null = null;

  for (;;) {
    const child = childAt(node, row);
    if (!child) break;
    const t = child.type;

    if (pack.isLeading(t)) return { kind: "leading" };
    if (pack.isImport(t)) return { kind: "import", path: [...path, "<imports>"], node: child };

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
      const name = nameOf(child) ?? `<${t}>`;
      path.push(name);
      unit = { node: child, start, end: child.endPosition.row + 1, named: true, path: [...path] };
      const body = child.childForFieldName("body") ?? child.namedChildren.find((c) => c && pack.isBody(c.type)) ?? null;
      if (body && body.startPosition.row <= row && row <= body.endPosition.row) {
        node = body;
        continue;
      }
      break;
    }

    if (pack.isFunctionLike(t)) {
      const name = nameOf(child) ?? "<anonymous>";
      unit = { node: child, start, end: child.endPosition.row + 1, named: true, path: [...path, name] };
      break;
    }

    // Any other statement directly inside a container (module, class body) is its own unit.
    const name = nameOf(child);
    unit = { node: child, start, end: child.endPosition.row + 1, named: name !== null, path: name ? [...path, name] : [...path] };
    break;
  }

  return unit ? unitLocation(unit) : { kind: "none" };
}

function unitLocation(u: { node: Node; start: number; end: number; named: boolean; path: string[] }): Location {
  return { kind: "unit", path: u.path, named: u.named, node: u.node, start: u.start, end: u.end };
}

function childAt(node: Node, row: number): Node | null {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.startPosition.row <= row && row <= c.endPosition.row) return c;
    if (c.startPosition.row > row) break;
  }
  return null;
}

function nameOf(node: Node): string | null {
  if (/^(assignment|augmented_assignment|assignment_expression)$/.test(node.type)) {
    const left = node.childForFieldName("left");
    if (left && /identifier|attribute|member_expression/.test(left.type)) return cleanName(left.text);
  }
  const direct = node.childForFieldName("name") ?? node.childForFieldName("key");
  if (direct) return cleanName(direct.text);

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

function cleanName(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, "").replace(/\s+/g, " ").slice(0, 80);
}

function collectIdentifiers(node: Node, pack: LanguagePack, out: Set<string>) {
  const stack: Node[] = [node];
  let visited = 0;
  while (stack.length && visited < 20000) {
    const n = stack.pop()!;
    visited++;
    if (pack.isIdentifier(n.type)) {
      out.add(n.text);
      continue;
    }
    for (const c of n.namedChildren) if (c) stack.push(c);
  }
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
