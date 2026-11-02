import type { ChangeAtom, PRInput } from "./types";

type Texts = { del: string[]; add: string[] };

/** Text of the removed and added lines of each atom, in diff order. */
export function atomTexts(pr: PRInput, atoms: ChangeAtom[]): Map<string, Texts> {
  const byFile = new Map<string, Map<string, string>>();
  for (const f of pr.files) {
    const m = new Map<string, string>();
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.type === "del") m.set(`L${l.oldLine}`, l.text);
        else if (l.type === "add") m.set(`R${l.newLine}`, l.text);
      }
    byFile.set(f.path, m);
  }
  const out = new Map<string, Texts>();
  for (const a of atoms) {
    const m = byFile.get(a.file);
    const t: Texts = { del: [], add: [] };
    for (const r of a.hunkLines) {
      const text = m?.get(`${r.side === "LEFT" ? "L" : "R"}${r.line}`) ?? "";
      (r.side === "LEFT" ? t.del : t.add).push(text);
    }
    out.set(a.id, t);
  }
  return out;
}

/**
 * Tag mechanical atoms (formatting-only, pure renames, import reshuffles) and detect moved code.
 * Lockfiles and generated files are already tagged by the atomizer. Mutates and returns `atoms`.
 */
export function classifyAtoms(pr: PRInput, atoms: ChangeAtom[]): ChangeAtom[] {
  const texts = atomTexts(pr, atoms);

  for (const a of atoms) {
    if (a.mechanical) continue;
    const t = texts.get(a.id)!;
    if (t.del.length + t.add.length === 0) continue;
    if (a.symbolPath[a.symbolPath.length - 1] === "<imports>" && isReshuffle(t)) a.mechanical = "imports";
    else if (isFormatOnly(t)) a.mechanical = "format";
  }

  tagRenames(pr, atoms, texts);
  tagMoves(atoms, texts);
  return atoms;
}

const squash = (lines: string[]) => lines.join("\n").replace(/\s+/g, "");

function isFormatOnly(t: Texts): boolean {
  return squash(t.del) === squash(t.add);
}

function isReshuffle(t: Texts): boolean {
  const norm = (xs: string[]) =>
    xs
      .map((x) => x.trim())
      .filter(Boolean)
      .sort()
      .join("\n");
  return norm(t.del) === norm(t.add);
}

const TOKEN = /[A-Za-z_$][\w$]*|\d+|\S/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * An atom is a pure rename when its removed and added lines differ only by identifier substitutions
 * old→new that are consistent across the whole PR, where `new` never appeared in the base file
 * and `old` never appears in the added lines. This rejects swapped or replaced arguments,
 * which are real changes.
 */
function tagRenames(pr: PRInput, atoms: ChangeAtom[], texts: Map<string, Texts>) {
  const candidates: { atom: ChangeAtom; map: Map<string, string> }[] = [];
  for (const a of atoms) {
    if (a.mechanical) continue;
    const t = texts.get(a.id)!;
    if (t.del.length === 0 || t.del.length !== t.add.length) continue;
    const map = new Map<string, string>();
    let ok = true;
    for (let i = 0; i < t.del.length && ok; i++) {
      const x = t.del[i].match(TOKEN) ?? [];
      const y = t.add[i].match(TOKEN) ?? [];
      if (x.length !== y.length) {
        ok = false;
        break;
      }
      for (let k = 0; k < x.length; k++) {
        if (x[k] === y[k]) continue;
        if (!IDENT.test(x[k]) || !IDENT.test(y[k])) {
          ok = false;
          break;
        }
        const prev = map.get(x[k]);
        if (prev !== undefined && prev !== y[k]) {
          ok = false;
          break;
        }
        map.set(x[k], y[k]);
      }
    }
    if (ok && map.size > 0) candidates.push({ atom: a, map });
  }
  if (!candidates.length) return;

  // Merge mappings PR-wide; drop any old name that maps to two different new names.
  const global = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const c of candidates)
    for (const [o, n] of c.map) {
      const prev = global.get(o);
      if (prev !== undefined && prev !== n) conflicted.add(o);
      global.set(o, n);
    }

  const baseTokens = new Map<string, Set<string>>();
  const tokensOf = (s: string | undefined) => new Set(s?.match(TOKEN) ?? []);
  for (const f of pr.files) baseTokens.set(f.path, tokensOf(f.baseText));

  for (const { atom, map } of candidates) {
    const t = texts.get(atom.id)!;
    const added = new Set(t.add.flatMap((l) => l.match(TOKEN) ?? []));
    const removed = new Set(t.del.flatMap((l) => l.match(TOKEN) ?? []));
    const base = baseTokens.get(atom.file);
    const pure = [...map].every(
      ([o, n]) => !conflicted.has(o) && !added.has(o) && !removed.has(n) && !(base && base.size && base.has(n)),
    );
    if (pure) atom.mechanical = "rename";
  }
}

/** Removed code that reappears verbatim elsewhere is a move, not a delete plus an add. */
function tagMoves(atoms: ChangeAtom[], texts: Map<string, Texts>) {
  const removed = new Map<string, ChangeAtom[]>();
  for (const a of atoms) {
    const t = texts.get(a.id)!;
    if (a.kind === "removed" && t.add.length === 0) {
      const k = squash(t.del);
      if (k.length >= 40) removed.set(k, [...(removed.get(k) ?? []), a]);
    }
  }
  for (const a of atoms) {
    const t = texts.get(a.id)!;
    if (a.kind !== "added" || t.del.length) continue;
    const match = removed.get(squash(t.add));
    if (match?.length) {
      const src = match.shift()!;
      src.kind = "moved";
      a.kind = "moved";
    }
  }
}
