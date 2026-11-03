// Reusing a previous story after new commits: atoms whose code didn't change keep their place in the
// order and their explanations; only steps with changed or new code are explained again.

import type { Edge } from "./graph";
import { hashString } from "./hash";
import { fallbackLabel } from "./order";
import { atomSnippet, rowNumber, type SnippetRow } from "./snippet";
import { validatePlan, type Plan, type PlanStep } from "./validate";
import type { Beat, ChangeAtom, Citation, ContextSnippet, PRInput, Story, StoryStep } from "./types";

/** A finished story and what it was built from. */
export type PreviousStory = { pr: PRInput; atoms: ChangeAtom[]; story: Story };

export type ReusePlan = {
  plan: Plan;
  /** New step index → the previous story's step, moved onto the new atom IDs and line numbers. */
  reused: Map<number, StoryStep>;
  /** Steps with changed, new or removed code, which need explaining again. */
  changed: number[];
};

/**
 * What an atom's snippet says, regardless of line numbers or commit: its file, symbol, kind, and the
 * kind and text of every row shown (changed lines and the unchanged lines around them).
 */
export function atomFingerprint(file: PRInput["files"][number] | undefined, atom: ChangeAtom): string {
  const rows = atomSnippet(file, atom);
  const body = rows.map((r) => (r.type === "gap" ? "…" : `${r.type[0]}${r.text}`));
  return hashString([atom.file, atom.symbolPath.join("\u0001"), atom.kind, ...body].join("\u0000"));
}

const identity = (a: ChangeAtom) => `${a.file}\u0000${a.symbolPath.join("\u0001")}`;

/**
 * Old shown line number → new one, for two snippets with the same rows. Null when a number can't be
 * moved unambiguously (one old number that lands on two different new ones).
 */
function lineMap(oldRows: SnippetRow[], newRows: SnippetRow[]): Map<number, number | null> {
  const m = new Map<number, number | null>();
  const put = (o: number | undefined, n: number | undefined) => {
    if (o == null || n == null) return;
    if (!m.has(o)) m.set(o, n);
    else if (m.get(o) !== n) m.set(o, null);
  };
  oldRows.forEach((r, i) => {
    const s = newRows[i];
    if (!s || r.type === "gap" || s.type === "gap") return;
    put(rowNumber(r), rowNumber(s));
    if (r.type === "reindent" && s.type === "reindent") put(r.oldLine, s.oldLine);
  });
  return m;
}

/**
 * The previous story's plan, carried over to the new atoms, or null when it shouldn't be reused:
 * too much changed (more than `maxChangedShare` of the steps, default two-thirds, need explaining
 * again), or the new code doesn't fit the old order.
 *
 * - Atoms with the same fingerprint keep their step.
 * - An atom whose code changed (same file and symbol) takes its old atom's place; that step is
 *   explained again. So is a step that lost atoms.
 * - New atoms get a step of their own, after the steps they depend on and before the ones that
 *   use them, next to a step in the same file when one fits.
 */
export function planFromPrevious(prev: PreviousStory, pr: PRInput, atoms: ChangeAtom[], edges: Edge[], opts: { maxChangedShare?: number } = {}): ReusePlan | null {
  const oldFiles = new Map(prev.pr.files.map((f) => [f.path, f]));
  const newFiles = new Map(pr.files.map((f) => [f.path, f]));
  const oldById = new Map(prev.atoms.map((a) => [a.id, a]));

  // 1. Match atoms: same code first, then same file and symbol.
  const byPrint = new Map<string, ChangeAtom[]>();
  for (const a of prev.atoms) {
    const k = atomFingerprint(oldFiles.get(a.file), a);
    byPrint.set(k, [...(byPrint.get(k) ?? []), a]);
  }
  const same = new Map<string, ChangeAtom>(); // new id → old atom with identical code
  for (const a of atoms) {
    const q = byPrint.get(atomFingerprint(newFiles.get(a.file), a));
    if (q?.length) same.set(a.id, q.shift()!);
  }
  const usedOld = new Set([...same.values()].map((a) => a.id));
  const byIdentity = new Map<string, ChangeAtom[]>();
  for (const a of prev.atoms) if (!usedOld.has(a.id)) byIdentity.set(identity(a), [...(byIdentity.get(identity(a)) ?? []), a]);
  const newOf = new Map<string, string>(); // old id → new id
  for (const [id, o] of same) newOf.set(o.id, id);
  for (const a of atoms) {
    if (same.has(a.id)) continue;
    const q = byIdentity.get(identity(a));
    if (q?.length) newOf.set(q.shift()!.id, a.id);
  }

  // 2. Carry the old steps over.
  type Draft = PlanStep & { old: number; changed: boolean };
  const steps: Draft[] = [];
  prev.story.steps.forEach((s, i) => {
    const ids = s.atomIds.map((o) => newOf.get(o)).filter((x): x is string => !!x);
    if (!ids.length) return;
    const changed = ids.length !== s.atomIds.length || ids.some((id) => !same.has(id));
    steps.push({ atomIds: ids, label: s.label, ...(s.orderOverride ? { orderOverride: s.orderOverride } : {}), old: i, changed });
  });
  const mechanical = prev.story.mechanical.map((o) => newOf.get(o)).filter((x): x is string => !!x);

  // 3. Place new atoms.
  const placed = new Set([...steps.flatMap((s) => s.atomIds), ...mechanical]);
  for (const a of atoms) {
    if (placed.has(a.id)) continue;
    if (a.mechanical) {
      mechanical.push(a.id);
      continue;
    }
    const stepOf = new Map<string, number>();
    steps.forEach((s, i) => s.atomIds.forEach((id) => stepOf.set(id, i)));
    let after = -1;
    let before = steps.length;
    for (const e of edges) {
      if (e.to === a.id && stepOf.has(e.from)) after = Math.max(after, stepOf.get(e.from)!);
      if (e.from === a.id && stepOf.has(e.to)) before = Math.min(before, stepOf.get(e.to)!);
    }
    if (after >= before) return null; // it would have to sit both before and after something
    // Positions after+1 … before all keep the order; prefer one right after a step in the same file.
    let pos = -1;
    for (let i = before - 1; i > after; i--)
      if (steps[i].atomIds.some((id) => atoms.find((x) => x.id === id)?.file === a.file)) {
        pos = i + 1;
        break;
      }
    if (pos < 0) pos = before < steps.length ? before : after >= 0 ? after + 1 : steps.length;
    steps.splice(pos, 0, { atomIds: [a.id], label: fallbackLabel(a), old: -1, changed: true });
    placed.add(a.id);
  }

  const plan: Plan = { summary: prev.story.summary, steps: steps.map(({ old: _o, changed: _c, ...s }) => s), mechanical };
  if (validatePlan(plan, atoms, edges).errors.length) return null;

  // 4. Move unchanged steps' explanations onto the new atom IDs and line numbers.
  const reused = new Map<number, StoryStep>();
  steps.forEach((s, i) => {
    if (s.changed) return;
    const old = prev.story.steps[s.old];
    const maps = new Map<string, { id: string; lines: Map<number, number | null> }>();
    for (const o of old.atomIds) {
      const id = newOf.get(o)!;
      const oa = oldById.get(o)!;
      const na = atoms.find((x) => x.id === id)!;
      maps.set(o, { id, lines: lineMap(atomSnippet(oldFiles.get(oa.file), oa), atomSnippet(newFiles.get(na.file), na)) });
    }
    const step = moveStep(old, maps);
    if (step) reused.set(i, { ...step, label: s.label });
    else s.changed = true;
  });

  const changed = steps.flatMap((s, i) => (s.changed ? [i] : []));
  if (!steps.length || changed.length / steps.length > (opts.maxChangedShare ?? 0.67)) return null;
  return { plan, reused, changed };
}

/** An old step with atom IDs and atom line numbers moved; null when a line can't be moved. */
function moveStep(old: StoryStep, maps: Map<string, { id: string; lines: Map<number, number | null> }>): StoryStep | null {
  let ok = true;
  const line = (atomId: string, n: number) => {
    const v = maps.get(atomId)?.lines.get(n);
    if (v == null) ok = false;
    return v ?? n;
  };
  const cite = (c: Citation): Citation => {
    if (c.file || !c.atomId) return c; // unchanged context: moved separately, once the new context is known
    const m = maps.get(c.atomId);
    if (!m) return (ok = false), c;
    return { atomId: m.id, lines: [line(c.atomId, c.lines[0]), line(c.atomId, c.lines[1])] };
  };
  const beat = (b: Beat): Beat => ({
    text: b.text,
    cites: b.cites.map(cite),
    ...(b.through ? { through: { atomId: maps.get(b.through.atomId)?.id ?? b.through.atomId, line: line(b.through.atomId, b.through.line) } } : {}),
  });
  const step: StoryStep = {
    atomIds: old.atomIds.map((o) => maps.get(o)!.id),
    label: old.label,
    ...(old.orderOverride ? { orderOverride: old.orderOverride } : {}),
    ...(old.context ? { context: old.context } : {}),
    explanation: old.explanation.map(beat),
  };
  return ok ? step : null;
}

const sameSnippet = (a: ContextSnippet, b: ContextSnippet) =>
  a.file === b.file && a.code === b.code && a.reason === b.reason && a.symbol === b.symbol && a.within === b.within && a.head?.text === b.head?.text;

/**
 * A reused step with the context found for the new head: kept when the context shows the same code
 * (citations into it follow it to its new lines), null when the context changed.
 */
export function withNewContext(step: StoryStep, context: ContextSnippet[] | undefined): StoryStep | null {
  const before = step.context ?? [];
  const after = context ?? [];
  if (before.length !== after.length || before.some((c, i) => !sameSnippet(c, after[i]))) return null;
  const moveCite = (c: Citation): Citation => {
    if (!c.file) return c;
    const k = before.findIndex((s) => s.file === c.file && c.lines[0] >= (s.head?.line ?? s.start) && c.lines[1] <= s.end);
    if (k < 0) return c;
    const s = before[k];
    const t = after[k];
    const shift = (n: number) => (s.head && n === s.head.line && t.head ? t.head.line : n + t.start - s.start);
    return { ...c, lines: [shift(c.lines[0]), shift(c.lines[1])] };
  };
  const { context: _c, ...rest } = step;
  return { ...rest, ...(after.length ? { context: after } : {}), explanation: step.explanation.map((b) => ({ ...b, cites: b.cites.map(moveCite) })) };
}
