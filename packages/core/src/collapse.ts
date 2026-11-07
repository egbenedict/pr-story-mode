// Folding low-information changes: long runs of lines that all have the same shape (rows of a data
// table, a list of strings, a block of near-identical registrations) and whole deleted files. Every
// line stays in the story; folded ones are hidden behind a summary until opened, and prompts get a
// shortened version so the model's attention (and the cost) goes to the code that changed.

import type { SnippetRow } from "./snippet";

/** A stretch of rows to hide: `start`..`end` (inclusive indexes into the rows), with a summary. */
export type Collapse = { start: number; end: number; count: number; kind: "similar" | "deleted"; label: string };

export const COLLAPSE_MIN = 12; // a run this long or longer folds
export const COLLAPSE_KEEP_TOP = 3; // lines left showing at the start of a run
export const COLLAPSE_KEEP_BOTTOM = 1; // and at its end
const MAX_PERIOD = 6; // repeating patterns up to this many lines long (an object spread over lines)

const KEYWORD = /\b(if|else|for|while|do|switch|case|return|const|let|var|function|def|class|struct|import|export|from|try|catch|throw|new|await|async|yield|fn|func|pub|impl|match|elif|lambda|with|goto)\b/;

const STRING = /(["'`])(?:\\.|(?!\1).)*\1/g;
const NUMBER = /(?<![\w$])-?(?:0x[0-9a-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)(?![\w$])/gi;

/** A line with its literals blanked out: `[1.5, "a"],` and `[2, "bb"],` both become `[N, S],`. */
export function lineShape(text: string): string {
  return text.trim().replace(STRING, "S").replace(NUMBER, "N").replace(/\s+/g, " ");
}

/**
 * Looser shapes, for lists whose entries differ by name too. `names` replaces every identifier
 * (enum members, `FOO_BAR,`); `calls` keeps the first one (`register(S, handlerA)` and
 * `register(S, handlerB)` match, `x = f(a)` and `y = g(b)` don't). Neither applies to lines with
 * keywords, which are code rather than data.
 */
function looseShapes(text: string): { names: string | null; calls: string | null } {
  const s = lineShape(text);
  if (KEYWORD.test(s)) return { names: null, calls: null };
  let first = true;
  const calls = s.replace(/[A-Za-z_$][\w$]*/g, (w) => {
    if (first) {
      first = false;
      return w;
    }
    return w === "S" || w === "N" ? w : "I";
  });
  const names = /[(]/.test(s) ? null : s.replace(/[A-Za-z_$][\w$]*/g, (w) => (w === "S" || w === "N" ? w : "I"));
  return { names, calls };
}

type Keyed = { type: string; keys: (string | null)[] };

/** The longest stretch from `i` where each row's key equals the key `p` rows earlier (and rows share a type). */
function stretch(rows: Keyed[], i: number, p: number, k: number): number {
  const first = rows[i]?.keys[k];
  if (first == null) return i;
  let end = i + p - 1;
  for (let j = i; j < i + p; j++) if (j >= rows.length || rows[j]!.keys[k] == null || rows[j]!.type !== rows[i]!.type) return i;
  for (let j = i + p; j < rows.length; j++) {
    const a = rows[j]!;
    const b = rows[j - p]!;
    if (a.type !== b.type || a.keys[k] == null || a.keys[k] !== b.keys[k]) break;
    end = j;
  }
  return end;
}

/** Text describing what a run holds, from its rows' shapes. */
function describe(shapes: string[]): string {
  const all = shapes.join(" ");
  const words = all.replace(/\b[SN]\b/g, "").match(/[A-Za-z_$][\w$]*/g) ?? [];
  const nums = (all.match(/\bN\b/g) ?? []).length;
  const strs = (all.match(/\bS\b/g) ?? []).length;
  if (!words.length && nums >= strs && nums > 0) return "numbers";
  if (!words.length && strs > 0) return "strings";
  return "";
}

/**
 * Runs of changed lines (all added, or all removed) that repeat one shape, or a pattern of up to six
 * shapes, for at least `min` lines. Each run keeps its first `COLLAPSE_KEEP_TOP` and last
 * `COLLAPSE_KEEP_BOTTOM` lines showing; what's returned is the part to hide.
 */
export function similarRuns(rows: SnippetRow[], min = COLLAPSE_MIN): Collapse[] {
  const keyed: Keyed[] = rows.map((r) => {
    if (r.type !== "add" && r.type !== "del") return { type: r.type, keys: [null, null, null] };
    if (!r.text.trim()) return { type: r.type, keys: ["", null, null] };
    const loose = looseShapes(r.text);
    return { type: r.type, keys: [`${r.type}:${lineShape(r.text)}`, loose.names && `${r.type}:${loose.names}`, loose.calls && `${r.type}:${loose.calls}`] };
  });
  const out: Collapse[] = [];
  for (let i = 0; i < rows.length; ) {
    let best = i;
    for (let k = 0; k < 3; k++)
      for (let p = 1; p <= MAX_PERIOD; p++) {
        const end = stretch(keyed, i, p, k);
        // A pattern must repeat at least three times to count, and blank lines alone don't make a run.
        if (end - i + 1 >= Math.max(min, 3 * p) && end > best && keyed[i]!.keys[0] !== "") best = end;
      }
    if (best > i) {
      const start = i + COLLAPSE_KEEP_TOP;
      const end = best - COLLAPSE_KEEP_BOTTOM;
      const shapes = rows.slice(i, best + 1).map((r) => (r.type === "gap" ? "" : lineShape(r.text)));
      const what = describe(shapes);
      const count = end - start + 1;
      out.push({ start, end, count, kind: "similar", label: `${count} more similar line${count === 1 ? "" : "s"}${what ? ` of ${what}` : ""}` });
      i = best + 1;
    } else i++;
  }
  return out;
}

export const REPEAT_MIN = 4; // hunks in a row making the same kind of edit
const REPEAT_KEEP = 2; // shown as examples before the fold

/** The names a data edit touches: JSON keys and `name:` / `name =` before a value. */
function editedKeys(rows: SnippetRow[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.type !== "add" && r.type !== "del") continue;
    const m = /^\s*["']?([A-Za-z_$][\w$-]*)["']?\s*[:=]/.exec(r.text);
    if (m) keys.add(m[1]!);
  }
  return [...keys].slice(0, 4);
}

/**
 * Hunks in a row that make the same kind of edit, like a data file where 90 entries each get new
 * coordinates: the changed lines of each hunk have the same shapes. The first two hunks stay as
 * examples; the rest fold into one row.
 */
export function repeatedEdits(rows: SnippetRow[], min = REPEAT_MIN): Collapse[] {
  // Hunks are the stretches between gap rows.
  const hunks: { start: number; end: number; sig: string }[] = [];
  let start = 0;
  for (let i = 0; i <= rows.length; i++) {
    if (i === rows.length || rows[i]!.type === "gap") {
      if (i > start) {
        const changed = rows.slice(start, i).filter((r) => r.type === "add" || r.type === "del");
        const sig = changed.map((r) => (r.type === "gap" ? "" : `${r.type}:${lineShape(r.text)}`)).join("\n");
        hunks.push({ start, end: i - 1, sig: changed.length ? sig : "" });
      }
      start = i + 1;
    }
  }
  const out: Collapse[] = [];
  for (let h = 0; h < hunks.length; ) {
    let e = h;
    while (e + 1 < hunks.length && hunks[h]!.sig && hunks[e + 1]!.sig === hunks[h]!.sig) e++;
    const n = e - h + 1;
    if (n >= min) {
      const first = hunks[h + REPEAT_KEEP]!.start;
      // The gap row before the folded hunks goes in the fold too.
      const from = first > 0 && rows[first - 1]!.type === "gap" ? first - 1 : first;
      const to = hunks[e]!.end;
      const keys = editedKeys(rows.slice(hunks[h]!.start, hunks[h]!.end + 1));
      const more = n - REPEAT_KEEP;
      const lines = rows.slice(from, to + 1).filter((r) => r.type !== "gap").length;
      out.push({
        start: from,
        end: to,
        count: lines,
        kind: "similar",
        label: `${more} more edit${more === 1 ? "" : "s"} like these${keys.length ? ` (${keys.map((k) => `\`${k}\``).join(", ")})` : ""}`,
      });
    }
    h = e + 1;
  }
  return out;
}

/** Repeated edits first, then long runs of similar lines that aren't inside one. */
function dataFolds(rows: SnippetRow[]): Collapse[] {
  const edits = repeatedEdits(rows);
  const inside = (f: Collapse) => edits.some((e) => f.start <= e.end && e.start <= f.end);
  return [...edits, ...similarRuns(rows).filter((f) => !inside(f))].sort((a, b) => a.start - b.start);
}

/** The fold for a whole deleted file: every row, under a summary naming what it defined. */
export function deletedRun(rows: SnippetRow[], names: string[]): Collapse | null {
  const lines = rows.filter((r) => r.type === "del").length;
  if (!rows.length) return null;
  const shown = names.slice(0, 6).map((n) => `\`${n}\``);
  const more = names.length > 6 ? ` and ${names.length - 6} more` : "";
  return {
    start: 0,
    end: rows.length - 1,
    count: rows.length,
    kind: "deleted",
    label: `Deleted file · ${lines} line${lines === 1 ? "" : "s"}${shown.length ? ` · removed ${shown.join(", ")}${more}` : ""}`,
  };
}

/** The folds for a chunk of an atom's rows: the whole thing for a deleted file, else its similar runs. */
export function collapsesFor(rows: SnippetRow[], atom?: { deletedFile?: { names: string[] } }): Collapse[] {
  if (atom?.deletedFile) {
    const d = deletedRun(rows, atom.deletedFile.names);
    return d ? [d] : [];
  }
  return dataFolds(rows);
}

const PROMPT_DELETED_LINES = 15;

/**
 * Folds for prompts: similar runs as in the reader, and for a deleted file all but its first lines
 * (the model sees what the file was and what it defined, not every removed line).
 */
export function promptCollapses(rows: SnippetRow[], atom?: { deletedFile?: { names: string[] } }): Collapse[] {
  if (!atom?.deletedFile) return dataFolds(rows);
  if (rows.length <= PROMPT_DELETED_LINES + 5) return [];
  const count = rows.length - PROMPT_DELETED_LINES;
  return [{ start: PROMPT_DELETED_LINES, end: rows.length - 1, count, kind: "deleted", label: `${count} more lines of the deleted file` }];
}
