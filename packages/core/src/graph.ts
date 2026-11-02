import type { ChangeAtom } from "./types";

/** `from → to` means `from` defines a symbol that `to` uses. */
export type Edge = { from: string; to: string; symbol: string };

export function buildGraph(atoms: ChangeAtom[]): Edge[] {
  const definers = new Map<string, string[]>();
  for (const a of atoms) for (const d of a.defines) definers.set(d, [...(definers.get(d) ?? []), a.id]);

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const b of atoms) {
    for (const r of b.references) {
      for (const from of definers.get(r) ?? []) {
        if (from === b.id) continue;
        const k = `${from}>${b.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ from, to: b.id, symbol: r });
      }
    }
  }
  return edges;
}

/** Strongly connected components (Tarjan). Returns atom id → component index. */
export function components(ids: string[], edges: Edge[]): Map<string, number> {
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) adj.get(e.from)?.push(e.to);

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  let counter = 0;
  let compCount = 0;

  // Iterative Tarjan to avoid deep recursion on large PRs.
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { v: string; i: number }[] = [{ v: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const nbrs = adj.get(top.v)!;
      if (top.i < nbrs.length) {
        const w = nbrs[top.i++];
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
        }
        if (low.get(top.v) === index.get(top.v)) {
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.set(w, compCount);
          } while (w !== top.v);
          compCount++;
        }
      }
    }
  }
  return comp;
}

/**
 * Deterministic dependency order: definitions before uses, cycles kept together,
 * ties broken by the atoms' original order (file path, then position).
 */
export function dependencyOrder(atoms: ChangeAtom[], edges: Edge[]): string[] {
  const ids = atoms.map((a) => a.id);
  const pos = new Map(ids.map((id, i) => [id, i]));
  const comp = components(ids, edges);

  const members = new Map<number, string[]>();
  for (const id of ids) {
    const c = comp.get(id)!;
    members.set(c, [...(members.get(c) ?? []), id]);
  }
  const indeg = new Map<number, number>([...members.keys()].map((c) => [c, 0]));
  const out = new Map<number, Set<number>>();
  for (const e of edges) {
    const a = comp.get(e.from)!;
    const b = comp.get(e.to)!;
    if (a === b) continue;
    const s = out.get(a) ?? new Set<number>();
    if (!s.has(b)) {
      s.add(b);
      indeg.set(b, indeg.get(b)! + 1);
    }
    out.set(a, s);
  }
  const rank = (c: number) => Math.min(...members.get(c)!.map((id) => pos.get(id)!));
  const ready = [...indeg].filter(([, d]) => d === 0).map(([c]) => c);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((x, y) => rank(x) - rank(y));
    const c = ready.shift()!;
    order.push(...members.get(c)!.sort((x, y) => pos.get(x)! - pos.get(y)!));
    for (const n of out.get(c) ?? []) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) ready.push(n);
    }
  }
  return order;
}
