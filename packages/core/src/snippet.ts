import type { Collapse } from "./collapse";
import type { ChangeAtom, Citation, PRFile, StoryStep } from "./types";

/**
 * One row of an atom's snippet. `reindent` is a removed line and an added line whose text differs
 * only in whitespace; it stands for both and carries both line numbers.
 */
export type SnippetRow =
  | { type: "context" | "del" | "add" | "reindent"; text: string; oldLine?: number; newLine?: number }
  | { type: "gap" };

type LineRow = Exclude<SnippetRow, { type: "gap" }>;

/** The line number shown for a row, and used in citations and beat cut points. */
export function rowNumber(r: SnippetRow): number | undefined {
  if (r.type === "gap") return undefined;
  return r.type === "del" ? r.oldLine : r.newLine;
}

/**
 * The diff lines of one atom, with up to `context` unchanged lines around them.
 * Changed lines that belong to other atoms are left out (shown as a gap).
 * With `foldReindent`, runs of lines that only changed indentation become `reindent` rows.
 */
export function atomSnippet(file: PRFile | undefined, atom: ChangeAtom, context = 3, opts: { foldReindent?: boolean } = {}): SnippetRow[] {
  if (!file) return [];
  const fold = opts.foldReindent ?? true;
  const mine = new Set(atom.hunkLines.map((r) => `${r.side}${r.line}`));
  const rows: SnippetRow[] = [];
  for (const h of file.hunks) {
    const keep: boolean[] = h.lines.map((l) =>
      l.type === "del" ? mine.has(`LEFT${l.oldLine}`) : l.type === "add" ? mine.has(`RIGHT${l.newLine}`) : false,
    );
    if (!keep.some(Boolean)) continue;
    const show = h.lines.map((l, i) => {
      if (keep[i]) return true;
      if (l.type !== "context") return false;
      for (let d = 1; d <= context; d++) if (keep[i - d] || keep[i + d]) return true;
      return false;
    });

    const hunkRows: LineRow[] = [];
    const gapBefore: boolean[] = [];
    let gap = rows.length > 0;
    h.lines.forEach((l, i) => {
      if (!show[i]) {
        gap = true;
        return;
      }
      gapBefore.push(gap && (rows.length > 0 || hunkRows.length > 0));
      gap = false;
      if (l.type === "context") hunkRows.push({ type: "context", text: l.text, oldLine: l.oldLine, newLine: l.newLine });
      else if (l.type === "del") hunkRows.push({ type: "del", text: l.text, oldLine: l.oldLine });
      else hunkRows.push({ type: "add", text: l.text, newLine: l.newLine });
    });

    const dropped = fold ? foldReindents(hunkRows) : new Set<number>();
    let pendingGap = false;
    hunkRows.forEach((r, i) => {
      pendingGap ||= gapBefore[i];
      if (dropped.has(i)) return;
      if (pendingGap) rows.push({ type: "gap" });
      pendingGap = false;
      rows.push(r);
    });
  }
  return rows;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * Pair removed and added lines that differ only in whitespace, in order (longest common subsequence),
 * and keep runs of at least 3 pairs where the indentation really changed. Paired added rows become
 * `reindent` rows; the indices of the paired removed rows are returned so the caller drops them.
 */
function foldReindents(rows: LineRow[]): Set<number> {
  const dels: number[] = [];
  const adds: number[] = [];
  rows.forEach((r, i) => (r.type === "del" ? dels.push(i) : r.type === "add" ? adds.push(i) : 0));
  const n = dels.length;
  const m = adds.length;
  if (n < 3 || m < 3 || n * m > 4_000_000) return new Set();

  const D = dels.map((i) => norm(rows[i].text));
  const A = adds.map((i) => norm(rows[i].text));
  // LCS table, filled from the end so pairs can be read forward.
  const w = m + 1;
  const L = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * w + j] = D[i] === A[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);

  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (D[i] === A[j]) pairs.push([i++, j++]);
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) i++;
    else j++;
  }

  // Split into runs that are consecutive on both sides, allowing blank lines in between.
  const blankBetween = (xs: string[], a: number, b: number) => xs.slice(a + 1, b).every((t) => t === "");
  const runs: [number, number][][] = [];
  for (const p of pairs) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (prev && blankBetween(D, prev[0], p[0]) && blankBetween(A, prev[1], p[1])) run.push(p);
    else runs.push([p]);
  }

  const dropped = new Set<number>();
  for (const run of runs) {
    const nonBlank = run.filter(([i]) => D[i] !== "");
    if (run.length < 3 || nonBlank.length < 2) continue;
    const reindented = nonBlank.filter(([i, j]) => rows[dels[i]].text !== rows[adds[j]].text).length;
    if (reindented < nonBlank.length * 0.8) continue; // identical lines moved around are not a re-indent
    for (const [i, j] of run) {
      const del = rows[dels[i]];
      const add = rows[adds[j]];
      rows[adds[j]] = { type: "reindent", text: add.text, oldLine: del.oldLine, newLine: add.newLine };
      dropped.add(dels[i]);
    }
  }
  return dropped;
}

/**
 * Stretches of a snippet that can collapse into one "re-indented" row: they start and end with a
 * `reindent` row, contain only `reindent` rows and blank added/removed lines, and hold at least
 * `min` re-indented rows. Returns [start, end, reindentCount] with inclusive indices.
 */
export function reindentRuns(rows: SnippetRow[], min = 4): [number, number, number][] {
  const out: [number, number, number][] = [];
  const blank = (r: SnippetRow | undefined) => !!r && (r.type === "add" || r.type === "del") && r.text.trim() === "";
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== "reindent") continue;
    let end = i;
    let count = 1;
    for (let k = i + 1; k < rows.length; k++) {
      if (rows[k].type === "reindent") {
        end = k;
        count++;
      } else if (!blank(rows[k])) break;
    }
    if (count >= min) out.push([i, end, count]);
    i = end;
  }
  return out;
}

/**
 * Plain-text rendering used in prompts: `  12 + code`, `  10 - code`, `  14 ~ code` (re-indented),
 * with head numbers for context. Long re-indented runs are shortened to their first and last line,
 * and `folds` (see collapse.ts) to one line saying what was left out.
 */
export function snippetText(rows: SnippetRow[], maxRows = Infinity, folds: Collapse[] = []): string {
  const out: string[] = [];
  const runs = new Map(reindentRuns(rows, 6).map(([a, b, c]) => [a, [b, c]]));
  const folded = new Map(folds.map((f) => [f.start, f]));
  let n = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (n >= maxRows) {
      out.push(`  … ${rows.length - n} more lines`);
      break;
    }
    n++;
    // Folded runs (rows of data, the rest of a deleted file) are one line saying what's left out.
    const f = folded.get(k);
    if (f) {
      out.push(`        … ${f.label}, not shown`);
      k = f.end;
      continue;
    }
    if (r.type === "gap") {
      out.push("  …");
      continue;
    }
    const run = runs.get(k);
    if (run) {
      const [end, count] = run;
      out.push(line(r as LineRow), `        ~ … ${count - 2} more lines, unchanged apart from indentation`, line(rows[end] as LineRow));
      n += end - k;
      k = end;
      continue;
    }
    out.push(line(r));
  }
  return out.join("\n");
}

function line(r: LineRow): string {
  const mark = r.type === "add" ? "+" : r.type === "del" ? "-" : r.type === "reindent" ? "~" : " ";
  return `${String(rowNumber(r)).padStart(5)} ${mark} ${r.text}`;
}

// ---------- walkthrough: interleaving explanation beats with the code they cover ----------

/**
 * Code shown after a beat. `joined` marks a chunk that carries straight on from the chunk before it
 * in the same beat (same file, the next lines), so readers draw the two as one block.
 */
export type WalkChunk = { atomId: string; rows: SnippetRow[]; first: boolean; joined?: boolean };
export type WalkBeat = { text: string; cites: Citation[]; code: WalkChunk[] };

/**
 * Cut each atom's snippet at the beats' `through` points, so every beat is followed by exactly the
 * lines it covers. Each row is shown once: rows no beat reached are added after the last beat.
 * A cut point that does not match a shown line snaps to the nearest one after the previous cut, and
 * a cut moves past closing brackets right after it, so a lone \`}\` never starts the next chunk.
 * Rows left over at the end join the atom's last chunk instead of trailing in a box of their own.
 * An atom no beat cut into goes with the first beat that cites it, so the code follows the text
 * even when the text takes the atoms in another order; one that is never cited goes next to its
 * neighbour in the step's order.
 * With \`fileOf\`, chunks that continue straight on in the same file are marked \`joined\`.
 */
export function walkthrough(
  step: StoryStep,
  snippets: Map<string, SnippetRow[]>,
  fileOf?: (atomId: string) => string | undefined,
): { beats: WalkBeat[]; snapped: number } {
  const cursor = new Map<string, number>(step.atomIds.map((id) => [id, 0]));
  const started = new Set<string>();
  const latest = new Map<string, WalkChunk>();
  let snapped = 0;

  const take = (atomId: string, end: number): WalkChunk | null => {
    const rows = snippets.get(atomId) ?? [];
    const start = cursor.get(atomId)!;
    // Unchanged lines after the atom's last change go with the beat that showed that change,
    // instead of trailing alone after the step's last beat.
    if (!rows.slice(end + 1).some((r) => r.type !== "context" && r.type !== "gap")) end = rows.length - 1;
    let slice = rows.slice(start, end + 1);
    cursor.set(atomId, end + 1);
    while (slice[0]?.type === "gap") slice = slice.slice(1);
    while (slice[slice.length - 1]?.type === "gap") slice = slice.slice(0, -1);
    if (!slice.length) return null;
    const first = !started.has(atomId);
    started.add(atomId);
    const chunk: WalkChunk = { atomId, rows: slice, first };
    latest.set(atomId, chunk);
    return chunk;
  };

  const beats: WalkBeat[] = step.explanation.map((e) => ({ text: e.text, cites: e.cites, code: [] }));
  step.explanation.forEach((e, i) => {
    if (!e.through) return;
    const { atomId, line } = e.through;
    const rows = snippets.get(atomId);
    const start = cursor.get(atomId);
    if (!rows || start === undefined || start >= rows.length) {
      snapped++;
      return;
    }
    let idx = -1;
    for (let k = start; k < rows.length; k++) if (rowNumber(rows[k]) === line) {
      idx = k;
      break;
    }
    if (idx < 0) {
      snapped++;
      let best = Infinity;
      for (let k = start; k < rows.length; k++) {
        const num = rowNumber(rows[k]);
        if (num === undefined) continue;
        const d = Math.abs(num - line);
        if (d <= best) {
          best = d;
          idx = k;
        }
      }
      if (idx < 0) return;
    }
    const chunk = take(atomId, pastClosers(rows, keepReplacement(rows, idx, line)));
    if (chunk) beats[i].code.push(chunk);
  });

  // Whatever no beat reached: the rest of an atom a beat already showed carries on in that block;
  // a whole atom goes with the first beat that cites it, else beside its neighbour in the step.
  if (!beats.length) beats.push({ text: "", cites: [], code: [] });
  const last = beats[beats.length - 1];
  const citedIn = new Map<string, number>();
  step.explanation.forEach((e, i) => e.cites.forEach((c) => c.atomId && !citedIn.has(c.atomId) && citedIn.set(c.atomId, i)));
  const uncited: WalkChunk[] = [];
  for (const id of step.atomIds) {
    const rows = snippets.get(id) ?? [];
    const from = cursor.get(id)!;
    if (from >= rows.length) continue;
    const prev = latest.get(id);
    if (prev) {
      let rest = rows.slice(from);
      while (rest[rest.length - 1]?.type === "gap") rest = rest.slice(0, -1);
      if (rest.some((r) => r.type !== "gap")) prev.rows = [...prev.rows, ...rest];
      cursor.set(id, rows.length);
      continue;
    }
    const chunk = take(id, rows.length - 1);
    if (!chunk) continue;
    const b = citedIn.get(id);
    if (b === undefined) {
      uncited.push(chunk);
      continue;
    }
    // Within the beat, in the order its citations name the atoms.
    const cites = step.explanation[b].cites;
    const rank = (atomId: string) => {
      const k = cites.findIndex((c) => c.atomId === atomId);
      return k < 0 ? Infinity : k;
    };
    const code = beats[b].code;
    const at = code.findIndex((c) => rank(c.atomId) > rank(id));
    code.splice(at < 0 ? code.length : at, 0, chunk);
  }
  const where = (atomId: string, fromEnd: boolean): [WalkBeat, number] | null => {
    const order = fromEnd ? [...beats].reverse() : beats;
    for (const b of order) {
      const ids = b.code.map((c) => c.atomId);
      const k = fromEnd ? ids.lastIndexOf(atomId) : ids.indexOf(atomId);
      if (k >= 0) return [b, k];
    }
    return null;
  };
  for (const chunk of uncited) {
    const k = step.atomIds.indexOf(chunk.atomId);
    let spot: [WalkBeat, number] | null = null;
    for (let j = k + 1; j < step.atomIds.length && !spot; j++) spot = where(step.atomIds[j], false);
    if (spot) {
      spot[0].code.splice(spot[1], 0, chunk);
      continue;
    }
    for (let j = k - 1; j >= 0 && !spot; j--) spot = where(step.atomIds[j], true);
    if (spot) spot[0].code.splice(spot[1] + 1, 0, chunk);
    else last.code.push(chunk);
  }
  if (fileOf)
    for (const b of beats)
      b.code.forEach((c, k) => {
        const before = b.code[k - 1];
        if (!before || before.atomId === c.atomId || fileOf(before.atomId) !== fileOf(c.atomId)) return;
        // Unchanged lines around two neighbouring atoms overlap: show them once, in the first block.
        const rows = withoutShared(before.rows, c.rows);
        if (rows.length && follows(before.rows, rows)) {
          c.rows = rows;
          c.joined = true;
        }
      });
  return { beats, snapped };
}

/** \`b\` without the leading unchanged lines that \`a\` already shows. */
function withoutShared(a: SnippetRow[], b: SnippetRow[]): SnippetRow[] {
  const shown = new Set(a.flatMap((r) => (r.type === "context" && r.newLine !== undefined ? [r.newLine] : [])));
  let k = 0;
  while (k < b.length && (b[k].type === "gap" || (b[k].type === "context" && shown.has((b[k] as LineRow).newLine!)))) k++;
  return k === 0 ? b : b.slice(k);
}

/** Closing brackets and \`end\`-style lines belong with the code they close. */
const CLOSER = /^\s*(?:[)\]}>]+[;,)]*|end|fi|done|esac|endif|#endif)\s*[;,]?\s*$/;

function pastClosers(rows: SnippetRow[], end: number): number {
  let k = end;
  while (k + 1 < rows.length) {
    const r = rows[k + 1];
    if (r.type === "gap" || !CLOSER.test(r.text)) break;
    k++;
  }
  return k === end ? end : keepReplacement(rows, k, rowNumber(rows[k]) ?? 0);
}

/** True when \`b\` starts on the line after \`a\` ends (one blank line between is allowed). */
function follows(a: SnippetRow[], b: SnippetRow[]): boolean {
  const side = (rows: SnippetRow[], pick: (ns: number[]) => number) => {
    const head = rows.flatMap((r) => (r.type !== "gap" && r.type !== "del" && r.newLine !== undefined ? [r.newLine] : []));
    const base = rows.flatMap((r) => (r.type !== "gap" && r.oldLine !== undefined ? [r.oldLine] : []));
    return { head: head.length ? pick(head) : undefined, base: base.length ? pick(base) : undefined };
  };
  const end = side(a, (ns) => Math.max(...ns));
  const start = side(b, (ns) => Math.min(...ns));
  const near = (x?: number, y?: number) => x !== undefined && y !== undefined && y - x >= 1 && y - x <= 2;
  // Compare new-file lines when both have them, else old-file lines (a deletion has only those).
  if (end.head !== undefined && start.head !== undefined) return near(end.head, start.head);
  return near(end.base, start.base);
}

/**
 * A changed line has the same number on both sides (old 53 removed, new 53 added), so a cut "at 53"
 * can land between them. A cut on a removed line that added lines replace moves to the added line
 * with that number, or to the end of the added lines, so a change is never shown half done.
 * A cut inside a pure deletion stays where it is.
 */
function keepReplacement(rows: SnippetRow[], idx: number, line: number): number {
  if (rows[idx].type !== "del") return idx;
  let k = idx;
  while (rows[k + 1]?.type === "del") k++;
  if (rows[k + 1]?.type !== "add") return idx;
  while (rows[k + 1]?.type === "add") {
    k++;
    if (rowNumber(rows[k]) === line) return k;
  }
  return k;
}

// ---------- expanding a snippet with the lines around it, as GitHub's expand arrows do ----------

/**
 * Every line of a file as rows in diff order: hunk lines as they are, and the unchanged lines between
 * and around hunks from the file's text. A stretch whose text is missing becomes a gap row.
 */
export function fileRows(file: PRFile): SnippetRow[] {
  const useHead = file.headText != null;
  const text = file.headText ?? file.baseText;
  const lines = text == null ? null : text.replace(/\n$/, "").split("\n");
  const rows: SnippetRow[] = [];
  let oldN = 1;
  let newN = 1;
  // Unchanged lines up to (not including) the given line numbers; Infinity runs to the end of the text.
  const fill = (untilOld: number, untilNew: number) => {
    if (!lines) {
      if (newN < untilNew && untilNew !== Infinity) rows.push({ type: "gap" });
      return;
    }
    while (oldN < untilOld && newN < untilNew) {
      const t = lines[(useHead ? newN : oldN) - 1];
      if (t === undefined) return;
      rows.push({ type: "context", text: t, oldLine: oldN++, newLine: newN++ });
    }
  };
  for (const h of file.hunks) {
    // A side with no lines in the hunk gives the line before it as its start.
    const o = h.oldLines ? h.oldStart : h.oldStart + 1;
    const n = h.newLines ? h.newStart : h.newStart + 1;
    fill(o, n);
    for (const l of h.lines) rows.push({ ...l });
    oldN = o + h.oldLines;
    newN = n + h.newLines;
  }
  fill(Infinity, Infinity);
  return rows;
}

/** Where a snippet row sits in `fileRows`, as [first, last] index (a reindent row stands for two lines). */
export function rowPositions(all: SnippetRow[]): (r: SnippetRow) => [number, number] | null {
  const byOld = new Map<number, number>();
  const byNew = new Map<number, number>();
  all.forEach((r, i) => {
    if (r.type === "gap") return;
    if (r.type !== "add" && r.oldLine != null) byOld.set(r.oldLine, i);
    if (r.type !== "del" && r.newLine != null) byNew.set(r.newLine, i);
  });
  return (r) => {
    if (r.type === "gap") return null;
    const a = r.type === "add" ? undefined : r.oldLine != null ? byOld.get(r.oldLine) : undefined;
    const b = r.type === "del" ? undefined : r.newLine != null ? byNew.get(r.newLine) : undefined;
    if (r.type === "del") return a == null ? null : [a, a];
    if (r.type === "reindent") return a == null || b == null ? (a ?? b) == null ? null : [(a ?? b)!, (a ?? b)!] : [Math.min(a, b), Math.max(a, b)];
    return b == null ? null : [b, b];
  };
}

/** How far a chunk is opened: extra lines above and below, and per gap row (by index) lines shown from its top and bottom. */
export type Expansion = { above: number; below: number; gaps: Record<number, [number, number]> };

export type ExpandedChunk = {
  rows: SnippetRow[];
  /** Rows added by expanding (not part of the atom's snippet). */
  extra: Set<SnippetRow>;
  /** Lines still available above and below the chunk. */
  moreAbove: number;
  moreBelow: number;
  /** For each gap row still shown: the chunk gap it belongs to and how many lines it hides. */
  gaps: Map<SnippetRow, { gap: number; hidden: number }>;
};

/**
 * A chunk's rows opened by `e`, using the file's rows. Lines at positions in `taken` (shown elsewhere
 * in the step) are never added above or below, so nothing appears twice.
 */
export function expandChunk(rows: SnippetRow[], all: SnippetRow[], pos: (r: SnippetRow) => [number, number] | null, taken: Set<number>, e: Expansion): ExpandedChunk {
  const extra = new Set<SnippetRow>();
  const gaps = new Map<SnippetRow, { gap: number; hidden: number }>();
  const spans = rows.map(pos);
  const firstPos = spans.find((x) => x)?.[0];
  const lastPos = [...spans].reverse().find((x) => x)?.[1];
  const usable = (i: number) => all[i] && all[i].type !== "gap" && !taken.has(i);

  const up: SnippetRow[] = [];
  if (firstPos != null) for (let i = firstPos - 1; i >= 0 && usable(i); i--) up.unshift(all[i]);
  const down: SnippetRow[] = [];
  if (lastPos != null) for (let i = lastPos + 1; i < all.length && usable(i); i++) down.push(all[i]);

  const out: SnippetRow[] = [];
  const shownUp = up.slice(Math.max(0, up.length - e.above));
  for (const r of shownUp) (extra.add(r), out.push(r));
  rows.forEach((r, k) => {
    if (r.type !== "gap") return void out.push(r);
    const before = spans.slice(0, k).reverse().find((x) => x)?.[1];
    const after = spans.slice(k + 1).find((x) => x)?.[0];
    const between: SnippetRow[] = [];
    if (before != null && after != null) for (let i = before + 1; i < after; i++) if (all[i].type !== "gap") between.push(all[i]);
    const [t, b] = e.gaps[k] ?? [0, 0];
    if (!between.length) return void (out.push(r), gaps.set(r, { gap: k, hidden: 0 }));
    for (const x of between.slice(0, t)) (extra.add(x), out.push(x));
    const hidden = Math.max(0, between.length - t - b);
    if (hidden) {
      out.push(r);
      gaps.set(r, { gap: k, hidden });
    }
    if (t < between.length) for (const x of between.slice(Math.max(t, between.length - b))) (extra.add(x), out.push(x));
  });
  const shownDown = down.slice(0, e.below);
  for (const r of shownDown) (extra.add(r), out.push(r));
  return { rows: out, extra, moreAbove: up.length - shownUp.length, moreBelow: down.length - shownDown.length, gaps };
}

export function atomLabel(atom: ChangeAtom): string {
  const sym = atom.symbolPath.filter((s) => !s.startsWith("<")).join(".");
  if (atom.symbolPath.includes("<imports>")) return `${atom.file} imports`;
  return sym ? `${atom.file} › ${sym}` : atom.file;
}

export function lineCounts(atom: ChangeAtom): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const r of atom.hunkLines) r.side === "RIGHT" ? add++ : del++;
  return { add, del };
}
