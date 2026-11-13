import { lineCounts } from "./snippet";
import type { ChangeAtom } from "./types";

/**
 * How much of the code the explanations cover. More links nearly every changed line to the words
 * about it (see EXPLAIN_MORE_DETAIL), so it gets a larger word budget than Standard.
 */
export type Detail = "standard" | "more";
export const DETAIL_SCALE: Record<Detail, number> = { standard: 1, more: 1.5 };

/** Word budget for one step: a base plus a little per changed line, capped. */
export const BUDGET = { base: 30, perLine: 2, max: 200, deletedFile: 40, min: 15 };

/** Changed lines that need explaining: mechanical atoms count for nothing, deleted files for little. */
export function explainableLines(atoms: ChangeAtom[]): number {
  let n = 0;
  for (const a of atoms) {
    if (a.mechanical) continue;
    const { add, del } = lineCounts(a);
    n += a.deletedFile ? Math.min(add + del, 10) : add + del;
  }
  return n;
}

/** About how many words a step's explanation should take. A soft target sent with the step. */
export function stepWordBudget(atoms: ChangeAtom[], detail: Detail = "standard"): number {
  const scale = DETAIL_SCALE[detail] ?? 1;
  const live = atoms.filter((a) => !a.mechanical);
  if (live.length && live.every((a) => a.deletedFile)) return round(Math.max(BUDGET.min, BUDGET.deletedFile * scale));
  const words = Math.min(BUDGET.max, BUDGET.base + BUDGET.perLine * explainableLines(atoms));
  return round(Math.max(BUDGET.min, words * scale));
}

/** Rounded to 5 so the prompt doesn't suggest false precision. */
const round = (n: number) => Math.max(5, Math.round(n / 5) * 5);

/** At most this many changed lines (or a single atom) makes a PR small enough for a one-sentence summary. */
export const SMALL_PR_LINES = 40;

/**
 * A note for the ordering prompt on small PRs, about the summary only: how many steps a PR gets is
 * left to its structure.
 */
export function sizeHint(lines: number, atoms: number): string {
  if (atoms > 1 && lines > SMALL_PR_LINES) return "";
  return `This is a small PR (${lines} changed line${lines === 1 ? "" : "s"} to explain), so keep the summary to one sentence.`;
}

/** Words in a piece of prose, counting identifiers in backticks as one word each. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
