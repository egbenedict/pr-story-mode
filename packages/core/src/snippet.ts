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
 * with head numbers for context. Long re-indented runs are shortened to their first and last line.
 */
export function snippetText(rows: SnippetRow[], maxRows = Infinity): string {
  const out: string[] = [];
  const runs = new Map(reindentRuns(rows, 6).map(([a, b, c]) => [a, [b, c]]));
  let n = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (n >= maxRows) {
      out.push(`  … ${rows.length - n} more lines`);
      break;
    }
    n++;
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

export type WalkChunk = { atomId: string; rows: SnippetRow[]; first: boolean };
export type WalkBeat = { text: string; cites: Citation[]; code: WalkChunk[] };

/**
 * Cut each atom's snippet at the beats' `through` points, so every beat is followed by exactly the
 * lines it covers. Each row is shown once: rows no beat reached are added after the last beat.
 * A cut point that does not match a shown line snaps to the nearest one after the previous cut.
 */
export function walkthrough(step: StoryStep, snippets: Map<string, SnippetRow[]>): { beats: WalkBeat[]; snapped: number } {
  const cursor = new Map<string, number>(step.atomIds.map((id) => [id, 0]));
  const started = new Set<string>();
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
    return { atomId, rows: slice, first };
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
    const chunk = take(atomId, keepReplacement(rows, idx, line));
    if (chunk) beats[i].code.push(chunk);
  });

  // Whatever no beat reached goes after the last beat, atom by atom.
  if (!beats.length) beats.push({ text: "", cites: [], code: [] });
  const last = beats[beats.length - 1];
  for (const id of step.atomIds) {
    const rows = snippets.get(id) ?? [];
    if (cursor.get(id)! < rows.length) {
      const chunk = take(id, rows.length - 1);
      if (chunk) last.code.push(chunk);
    }
  }
  return { beats, snapped };
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
