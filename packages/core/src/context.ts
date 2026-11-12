import type { Node } from "web-tree-sitter";
import { nameOf, STOP_NAMES } from "./atomize";
import { unitSymbols } from "./symbols";
import { isGeneratedPath, isLockfile, packForPath, type LanguagePack } from "./languages";
import type { ParserHost } from "./parse";
import type { ChangeAtom, ContextSnippet, PRInput } from "./types";

/**
 * Finds unchanged files outside the PR that may hold context. Implemented by the host:
 * the CLI uses `git grep` at the head commit; a browser host could use a code-search API.
 */
export type ContextSource = {
  /** Paths (at the head commit) of files that may define one of these symbols. */
  findDefinitions(symbols: string[]): Promise<string[]>;
  /** Paths (at the head commit) of files that may use one of these symbols. */
  findReferences(symbols: string[]): Promise<string[]>;
  readFile(path: string): Promise<string | undefined>;
};

// Rough, language-agnostic patterns for lines that define a name, used by sources that search text.
const KEYWORD_DEF = /\b(?:def|class|function|interface|type|enum|struct|union|trait|fn|func|const|let|var|val|namespace|typedef|module|object|record|protocol)\s+(?:\([^)]*\)\s*)?(?:[\w$]+(?:::|\.))*([\w$]+)/g;
const C_FUNC_DEF = /^[A-Za-z_][\w:<>,\s*&]*?[\s*&:]([A-Za-z_]\w*)\s*\(/; // unindented `int foo(`, `Foo::bar(`
const JAVA_METHOD = /^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|override|virtual|inline)\s+)+[\w<>\[\],\s]*?\s([A-Za-z_]\w*)\s*\(/;
const MACRO_DEF = /^\s*#\s*define\s+([A-Za-z_]\w*)/;

/** Symbol names that a source line defines, by rough language-agnostic patterns. */
export function definedOnLine(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(KEYWORD_DEF)) out.push(m[1]);
  for (const re of [C_FUNC_DEF, JAVA_METHOD, MACRO_DEF]) {
    const m = re.exec(text);
    if (m) out.push(m[1]);
  }
  return out;
}

export type ContextOptions = {
  source?: ContextSource | null;
  maxSnippetsPerStep?: number; // default 3
  maxLinesPerStep?: number; // default 60
  maxExtraFiles?: number; // files read from the source, default 30
};

export type ContextStats = { snippets: number; stepsWithContext: number; extraFiles: number };

/** A named unit of unchanged-or-changed code in a head file: a class, function or top-level statement. */
type Unit = {
  file: string;
  member: boolean; // inside a class, interface or namespace
  name: string; // bare symbol name, or "" when the unit has no identifier-like name
  label: string; // display name, e.g. "Scheduler.replan"
  start: number;
  end: number;
  kind: "class" | "function" | "statement";
  bodyStart?: number; // first line of a class body's members
  docStart?: number; // first line of the comment block right above the unit
  node: Node;
  changed: boolean;
  family: string;
  refs?: Set<string>;
};

type FileIndex = { path: string; lines: string[]; units: Unit[]; inPR: boolean; changed: Set<number> };

const DEF_SNIPPET_MAX = 30; // show a whole definition up to this many lines, else its first lines
const DEF_HEAD_LINES = 14;
const CLASS_HEAD_LINES = 10;
const CALLER_WINDOW = 5; // lines on each side of a call
const MAX_DEFS_PER_NAME = 3; // a name defined in more places than this is too ambiguous to show

/** Languages whose files can refer to each other's symbols. */
export function familyOf(pack: LanguagePack): string {
  if (["typescript", "tsx", "javascript"].includes(pack.id)) return "js";
  if (["c", "cpp"].includes(pack.id)) return "c";
  return pack.id;
}

const identLike = /^[\w$.#:~]+$/;
/** `Class.method` → `method` (qualified names come from `this.method()` calls). */
const bareName = (s: string) => s.slice(s.lastIndexOf(".") + 1);

/**
 * Line numbers (1-based) of a file that are inside comments: `/* … *\/` blocks (with or without a
 * leading `*` on each line), Python docstrings, and lines that are only a comment. Rough, for any language.
 */
export function commentLines(text: string): Set<number> {
  const out = new Set<number>();
  let block: "c" | "py" | null = null;
  text.split("\n").forEach((line, i) => {
    const n = i + 1;
    if (block === "c") {
      out.add(n);
      if (line.includes("*/")) block = null;
      return;
    }
    if (block === "py") {
      out.add(n);
      if (/"""|'''/.test(line)) block = null;
      return;
    }
    const t = line.trim();
    if (t.startsWith("/*")) {
      out.add(n);
      if (!t.slice(2).includes("*/")) block = "c";
      return;
    }
    const doc = /^("""|''')/.exec(t);
    if (doc) {
      out.add(n);
      if ((t.match(/"""|'''/g) ?? []).length === 1) block = "py";
      return;
    }
    if (COMMENT_LINE.test(line)) out.add(n);
  });
  return out;
}

/** A blank line or a comment line (`//`, `/*`, `*`, `#`, `--`, docstring quotes), roughly, across languages. */
const COMMENT_LINE = /^\s*($|\/\/|\/\*|\*|#(?!\s*(include|define|if|ifdef|ifndef|else|elif|endif|pragma|import)\b)|--|"""|''')/;
const bare = (name: string) => (identLike.test(name) ? name.replace(/^.*(\.|::)/, "") : "");

/**
 * Pick unchanged code to show beside each step: definitions of symbols the step uses (that the PR
 * does not itself change), existing callers of what the step modifies, and the header of the class
 * the step's code sits in. Ranked in that order, limited per step, and never shown twice.
 */
export async function retrieveContext(
  pr: PRInput,
  atoms: ChangeAtom[],
  steps: { atomIds: string[] }[],
  host: ParserHost,
  opts: ContextOptions = {},
): Promise<{ context: ContextSnippet[][]; stats: ContextStats }> {
  const maxSnippets = opts.maxSnippetsPerStep ?? 3;
  const maxLines = opts.maxLinesPerStep ?? 60;
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const stats: ContextStats = { snippets: 0, stepsWithContext: 0, extraFiles: 0 };

  // 1. Index the head version of every changed file the PR has text for.
  const index = new Map<string, FileIndex>();
  for (const f of pr.files) {
    if (f.status === "removed" || f.headText === undefined) continue;
    const fi = await indexFile(f.path, f.headText, changedHeadLines(f), host, true);
    if (fi) index.set(f.path, fi);
  }

  const definedInPR = new Set(atoms.flatMap((a) => a.defines));
  // Import lists get no context: the imported code is what later steps use.
  const stepAtoms = steps.map((s) =>
    s.atomIds.map((id) => byId.get(id)).filter((a): a is ChangeAtom => !!a && !a.mechanical && !a.symbolPath.includes("<imports>")),
  );
  // Text of each step's changed lines. Context is about what changed: a name used only in the
  // unchanged lines around a change (elsewhere in the same function) gets no definition shown.
  const files0 = new Map(pr.files.map((f) => [f.path, f]));
  // Which lines of each file version are comments, worked out once per file when needed.
  const commentCache = new Map<string, Set<number>>();
  const commentsOf = (key: string, text: string | undefined) => {
    if (!commentCache.has(key)) commentCache.set(key, commentLines(text ?? ""));
    return commentCache.get(key)!;
  };
  const changedLines = stepAtoms.map((as) => {
    const parts: { text: string; comment: boolean }[] = [];
    for (const a of as) {
      const f = files0.get(a.file);
      const mine = new Set(a.hunkLines.map((r) => `${r.side}${r.line}`));
      for (const h of f?.hunks ?? [])
        for (const l of h.lines) {
          if (l.type === "add" && mine.has(`RIGHT${l.newLine}`)) parts.push({ text: l.text, comment: commentsOf(`head:${a.file}`, f?.headText).has(l.newLine) || COMMENT_LINE.test(l.text) });
          else if (l.type === "del" && mine.has(`LEFT${l.oldLine}`)) parts.push({ text: l.text, comment: commentsOf(`base:${a.file}`, f?.baseText).has(l.oldLine) || COMMENT_LINE.test(l.text) });
        }
    }
    return parts;
  });
  const changedText = changedLines.map((ls) => ls.map((l) => l.text).join("\n"));
  const uses = (text: string, sym: string) => text.split(new RegExp(`(?<![\\w$])${sym.replace(/\$/g, "\\$")}(?![\\w$])`)).length - 1;
  // A change that only touches comments (or blank lines) needs no code beside it.
  const commentOnly = changedLines.map((ls) => ls.length > 0 && ls.every((l) => l.comment));

  // Member-only references (`.b`, from `a.b` reads) are too ambiguous to look up as context.
  const useful = (s: string) => s.length > 2 && !s.startsWith(".") && !STOP_NAMES.has(s) && !definedInPR.has(s);
  const refsForContext = (a: ChangeAtom) => {
    const map = packForPath(a.file)?.contextRef;
    return map ? a.references.map(map) : a.references;
  };
  const stepRefs = stepAtoms.map((as, i) => [...new Set(as.flatMap(refsForContext))].filter((r) => useful(r) && uses(changedText[i], bareName(r)) > 0));
  const modifiedDefs = stepAtoms.map((as) =>
    as.filter((a) => a.kind !== "added").flatMap((a) => a.defines).filter((d) => d.length > 2 && !STOP_NAMES.has(d)),
  );

  // 2. Ask the source for unchanged files that define unresolved symbols or call modified ones.
  if (opts.source) {
    const known = namesIn(index);
    const counts = new Map<string, number>();
    for (const refs of stepRefs) for (const r of refs) if (!known.has(r)) counts.set(r, (counts.get(r) ?? 0) + 1);
    const unresolved = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([s]) => s);
    const changedSyms = [...new Set(modifiedDefs.flat().map(bareName))].slice(0, 40);
    const budget = opts.maxExtraFiles ?? 30;
    const paths: string[] = [];
    try {
      if (unresolved.length) paths.push(...(await opts.source.findDefinitions(unresolved)));
      if (changedSyms.length) paths.push(...(await opts.source.findReferences(changedSyms)));
    } catch {
      // Context is best effort: a failing source just means less of it.
    }
    const prDirs = new Set(pr.files.map((f) => dirOf(f.path)));
    const extra = [...new Set(paths)]
      .filter((p) => !index.has(p) && packForPath(p) && !isLockfile(p) && !isGeneratedPath(p))
      .sort((a, b) => Number(prDirs.has(dirOf(b))) - Number(prDirs.has(dirOf(a))))
      .slice(0, budget);
    for (const p of extra) {
      const text = await opts.source.readFile(p).catch(() => undefined);
      if (text === undefined || text.length > 400_000) continue;
      const fi = await indexFile(p, text, new Set(), host, false);
      if (fi) {
        index.set(p, fi);
        stats.extraFiles++;
      }
    }
  }

  // 3. Unchanged units by name.
  const byName = new Map<string, Unit[]>();
  const leaves: Unit[] = [];
  for (const fi of index.values())
    for (const u of fi.units) {
      if (u.changed) continue;
      if (u.name) byName.set(u.name, [...(byName.get(u.name) ?? []), u]);
      if (u.kind !== "class") leaves.push(u);
    }

  // 4. Rank candidates per step.
  const shown: { file: string; start: number; end: number }[] = [];
  const overlapsShown = (file: string, start: number, end: number) => shown.some((r) => r.file === file && r.start <= end && start <= r.end);

  const context = stepAtoms.map((as, i) => {
    if (!as.length || commentOnly[i]) return [];
    // A small change gets less beside it: the line budget grows with the lines changed.
    const stepMax = maxSnippets;
    const stepLines = Math.min(maxLines, 24 + 3 * changedLines[i].length);
    const files = new Set(as.map((a) => a.file));
    const dirs = new Set(as.map((a) => dirOf(a.file)));
    const family = familyOf(packForPath(as[0].file) ?? ({ id: "" } as LanguagePack));
    const near = (file: string) => (files.has(file) ? 2 : dirs.has(dirOf(file)) ? 1 : 0);
    const stepIsTest = as.some((a) => isTestPath(a.file));
    // In languages with explicit imports, a definition in another file only counts if a step file imports the name.
    const importText = as.map((a) => importLines(files0.get(a.file)?.headText)).join("\n");
    const explicitImports = family === "js" || family === "python";
    const usable = (u: Unit, sym: string) =>
      (stepIsTest || !isTestPath(u.file)) &&
      !(u.member && u.kind === "statement" && u.end === u.start) &&
      (files.has(u.file) || !explicitImports || uses(importText, sym) > 0);
    const candidates: { score: number; snip: ContextSnippet }[] = [];

    // Definitions of symbols the step uses.
    for (const r of stepRefs[i]) {
      // `C.m` (from `this.m()`) only matches C's own `m`.
      const name = bareName(r);
      const candidates0 = (byName.get(name) ?? []).filter((u) => u.family === family && usable(u, name));
      const own = candidates0.filter((u) => name === r || u.label === r || u.label.endsWith(`.${r}`));
      // `self.m()` with no `C.m` in sight: `m` is probably inherited, so any member `m` will do.
      const defs = withoutForwardDecls(own.length || name === r ? own : candidates0.filter((u) => u.member));
      if (!defs.length || defs.length > MAX_DEFS_PER_NAME) continue;
      // A definition outside the PR's files counts only when it is the only one.
      const best = [...defs].sort((a, b) => near(b.file) - near(a.file) || a.end - a.start - (b.end - b.start))[0];
      if (!index.get(best.file)!.inPR && defs.length > 1) continue;
      // A test step is about the code under test, which the PR changes, not general helpers it uses.
      if (stepIsTest && !index.get(best.file)!.inPR) continue;
      const [start, end] = definitionRange(best);
      const n = uses(changedText[i], name);
      candidates.push({ score: 20 + (n ? 10 + Math.min(n, 5) : 0) + 3 * near(best.file), snip: snippet(index, best.file, start, end, "definition", r) });
    }

    // Existing callers of what the step modifies (other tests calling a changed test helper don't help).
    for (const d of stepIsTest ? [] : new Set(modifiedDefs[i])) {
      // A declaration of the same function (a C prototype in a header) is not a caller.
      const declares = (u: Unit) => definedOnLine(index.get(u.file)!.lines[u.start - 1] ?? "").includes(bareName(d));
      const callers = leaves.filter((u) => u.family === family && u.name !== d && (stepIsTest || !isTestPath(u.file)) && refsOf(u).has(d) && !declares(u));
      callers.sort((a, b) => near(b.file) - near(a.file) || a.end - a.start - (b.end - b.start));
      callers.slice(0, 2).forEach((u, k) => {
        const fi = index.get(u.file)!;
        const [start, end] = callerRange(fi, u, bareName(d));
        const snip = snippet(index, u.file, start, end, "caller", d);
        snip.within = u.label;
        const re = symbolRe(bareName(d));
        snip.focus = [];
        for (let l = snip.start; l <= snip.end; l++) if (re.test(fi.lines[l - 1] ?? "")) snip.focus.push(l);
        snip.called = snip.focus.some((l) => new RegExp(`${re.source}\\s*(<[^>]*>)?\\(`).test(fi.lines[l - 1] ?? ""));
        // Without its opening line a slice of a big function or table is hard to place, so keep it.
        const open = u.node.startPosition.row + 1;
        if (snip.start > open) snip.head = { line: open, text: fi.lines[open - 1] ?? "" };
        candidates.push({ score: 30 + 3 * near(u.file) - 4 * k, snip });
      });
    }

    // The header of the class (struct, namespace) the step's code sits in.
    for (const a of as) {
      if (a.symbolPath.length < 2 || !a.headRange) continue;
      const fi = index.get(a.file);
      const owner = fi?.units.find(
        (u) => u.kind === "class" && u.label === a.symbolPath.slice(0, -1).join(".") && u.start <= a.headRange!.start && a.headRange!.end <= u.end,
      );
      if (!fi || !owner || a.headRange.start - owner.start <= 6) continue; // the snippet's own context shows it
      const end = Math.min(owner.bodyStart ?? owner.start, owner.start + CLASS_HEAD_LINES - 1, a.headRange.start - 1);
      if (end <= owner.start || rangeChanged(fi, owner.start, end)) continue; // a lone `class Foo {` line adds nothing
      candidates.push({ score: 10, snip: snippet(index, a.file, owner.start, end, "container", owner.label) });
    }

    candidates.sort((a, b) => b.score - a.score);
    // The best definition and the best caller go first, then the rest by score.
    for (const reason of ["caller", "definition"] as const) {
      const k = candidates.findIndex((c) => c.snip.reason === reason);
      if (k > 0) candidates.unshift(...candidates.splice(k, 1));
    }
    const picked: ContextSnippet[] = [];
    let lines = 0;
    for (const { snip } of candidates) {
      if (picked.length >= stepMax) break;
      const n = snip.end - snip.start + 1;
      if (lines + n > stepLines) continue;
      if (overlapsShown(snip.file, snip.start, snip.end)) continue;
      if (as.some((a) => a.file === snip.file && a.headRange && a.headRange.start <= snip.end && snip.start <= a.headRange.end)) continue;
      picked.push(snip);
      shown.push(snip);
      lines += n;
    }
    if (picked.length) stats.stepsWithContext++;
    stats.snippets += picked.length;
    return picked;
  });

  return { context, stats };
}

// ---------- indexing ----------

async function indexFile(path: string, text: string, changed: Set<number>, host: ParserHost, inPR: boolean): Promise<FileIndex | null> {
  const pack = packForPath(path);
  if (!pack || pack.id === "json" || pack.data) return null;
  const tree = await host.parse(pack.grammar, text);
  if (!tree) return null;
  const units: Unit[] = [];
  walk(tree.rootNode, [], pack, units, path, 0);
  for (const u of units) {
    u.changed = false;
    for (let l = u.start; l <= u.end && !u.changed; l++) if (changed.has(l)) u.changed = true;
  }
  return { path, lines: text.split("\n"), units, inPR, changed };
}

function walk(node: Node, path: string[], pack: LanguagePack, out: Unit[], file: string, depth: number) {
  if (depth > 8) return;
  const family = familyOf(pack);
  let docStart: number | undefined;
  const push = (n: Node, label: string, kind: Unit["kind"], start = n.startPosition.row + 1) => {
    const full = [...path, label].join(".");
    const u: Unit = { file, member: path.length > 0, name: bare(label), label: full, start, end: n.endPosition.row + 1, kind, node: n, changed: false, family, docStart };
    out.push(u);
    packs.set(u, pack);
    return u;
  };
  let lead: number | null = null; // first row of the current run of comments
  let leadEnd = -2;
  for (const child of node.namedChildren) {
    if (!child) continue;
    const t = child.type;
    if (pack.isLeading(t)) {
      if (lead === null || child.startPosition.row > leadEnd + 1) lead = child.startPosition.row;
      leadEnd = child.endPosition.row;
      continue;
    }
    docStart = lead !== null && leadEnd >= child.startPosition.row - 1 ? lead + 1 : undefined;
    lead = null;
    if (pack.isImport(t)) continue;
    if (pack.isWrapper(t)) {
      const before = out.length;
      const outerDoc = docStart;
      walk(child, path, pack, out, file, depth + 1);
      // `export function f`, `@decorated def f`: the unit starts at the wrapper.
      if (out.length > before && out[before].node.parent?.id === child.id) {
        out[before].start = child.startPosition.row + 1;
        out[before].docStart ??= outerDoc;
      }
      docStart = outerDoc;
      if (out.length === before) {
        const name = nameOf(child);
        if (name) push(child, name, "statement");
      }
      continue;
    }
    if (pack.isClassLike(t)) {
      const name = pack.classNameOf?.(child) ?? nameOf(child);
      if (!name) continue;
      const u = push(child, name, "class");
      const body = child.childForFieldName("body") ?? child.namedChildren.find((c) => c && pack.isBody(c.type)) ?? null;
      if (body) {
        const first = body.namedChildren.find((c) => c && !pack.isLeading(c.type));
        u.bodyStart = first ? first.startPosition.row : body.startPosition.row + 1;
        walk(body, [...path, name], pack, out, file, depth + 1);
      }
      continue;
    }
    const name = nameOf(child);
    if (!name) continue;
    push(child, name, pack.isFunctionLike(t) ? "function" : "statement");
  }
}

const packs = new WeakMap<Unit, LanguagePack>();

function refsOf(u: Unit): Set<string> {
  if (!u.refs) {
    u.refs = new Set();
    const pack = packs.get(u);
    if (pack) u.refs = unitSymbols([u.node], pack, null).refs;
  }
  return u.refs;
}

/** Head line numbers a file's diff touches, including the spots where lines were deleted. */
function changedHeadLines(f: PRInput["files"][number]): Set<number> {
  const out = new Set<number>();
  for (const h of f.hunks) {
    let n = h.newStart;
    for (const l of h.lines) {
      if (l.type === "add") out.add(l.newLine);
      if (l.type === "del") {
        out.add(n);
        if (n > 1) out.add(n - 1);
      } else n++;
    }
  }
  return out;
}

/**
 * Drop one-line declarations (`int f(int);` in a header, `def f(x): ...` stubs) when a fuller
 * definition of the same name exists, so a declaration and its body count as one definition.
 */
function withoutForwardDecls(defs: Unit[]): Unit[] {
  if (defs.length < 2) return defs;
  const full = defs.filter((u) => u.kind !== "statement" || u.end > u.start);
  return full.length && full.length < defs.length ? full : defs;
}

function namesIn(index: Map<string, FileIndex>): Set<string> {
  const s = new Set<string>();
  for (const fi of index.values()) for (const u of fi.units) if (u.name) s.add(u.name);
  return s;
}

const DOC_MAX = 15; // a longer comment block above a definition is left out

function definitionRange(u: Unit): [number, number] {
  const from = u.docStart !== undefined && u.start - u.docStart <= DOC_MAX ? u.docStart : u.start;
  if (u.end - from + 1 <= DEF_SNIPPET_MAX) return [from, u.end];
  if (u.kind === "class") return [from, Math.min(u.end, Math.max(u.bodyStart ?? u.start, u.start + CLASS_HEAD_LINES - 1))];
  return [from, Math.max(u.start, from + DEF_HEAD_LINES - 1)];
}

/** Matches a whole-word use of `symbol`. */
function symbolRe(symbol: string): RegExp {
  return new RegExp(`(?<![\\w$])${symbol.replace(/[$]/g, "\\$")}(?![\\w$])`);
}

function callerRange(fi: FileIndex, u: Unit, symbol: string): [number, number] {
  if (u.end - u.start + 1 <= 2 * CALLER_WINDOW + 3) return [u.start, u.end];
  const re = symbolRe(symbol);
  let hit = u.start;
  for (let l = u.start + 1; l <= u.end; l++)
    if (re.test(fi.lines[l - 1] ?? "")) {
      hit = l;
      break;
    }
  // Start right after the opening line rather than leave a one-line gap.
  let start = Math.max(u.start, hit - CALLER_WINDOW);
  const open = u.node.startPosition.row + 1;
  if (start === open + 1) start = open;
  return [start, Math.min(u.end, start + 2 * CALLER_WINDOW)];
}

function rangeChanged(fi: FileIndex, start: number, end: number): boolean {
  for (let l = start; l <= end; l++) if (fi.changed.has(l)) return true;
  return false;
}

function snippet(index: Map<string, FileIndex>, file: string, start: number, end: number, reason: ContextSnippet["reason"], symbol: string): ContextSnippet {
  const lines = index.get(file)!.lines;
  // Trim blank lines at the edges.
  while (start < end && !lines[start - 1]?.trim()) start++;
  while (end > start && !lines[end - 1]?.trim()) end--;
  return { file, start, end, reason, symbol, code: lines.slice(start - 1, end).join("\n") };
}

export function isTestPath(p: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs|testing|test-d)\//.test(p) || /[._-](test|spec)\.[^/]+$/.test(p) || /(^|\/)test_[^/]+\.py$|_test\.(go|py|rs|cpp|cc)$/.test(p);
}

/** Import and require lines of a file, for checking that a name really comes from elsewhere. */
function importLines(text: string | undefined): string {
  if (!text) return "";
  return text
    .split("\n")
    .filter((l) => /^\s*(import|from|export\s+(\*|\{|type))\b|require\(/.test(l) || /^\s+[\w$]+,?\s*$/.test(l) || /^\s*\}\s*from\b/.test(l))
    .join("\n");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
