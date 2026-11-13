import { describe, expect, it } from "vitest";
import { countWords, explainableLines, sizeHint, stepWordBudget } from "../src/length";
import type { ChangeAtom, DiffLineRef } from "../src/types";

/** An atom with `add` added and `del` removed lines. */
function atom(add: number, del = 0, extra: Partial<ChangeAtom> = {}): ChangeAtom {
  const hunkLines = [
    ...Array.from({ length: add }, (_, i) => ({ side: "RIGHT", line: i + 1 })),
    ...Array.from({ length: del }, (_, i) => ({ side: "LEFT", line: i + 1 })),
  ] as DiffLineRef[];
  return { id: `a${add}_${del}`, file: "x.ts", language: "typescript", symbolPath: ["f"], kind: "modified", hunkLines, defines: [], references: [], supportTier: 2, ...extra };
}

describe("step word budget", () => {
  it("grows with the changed lines and stops at the cap", () => {
    expect(stepWordBudget([atom(5)])).toBe(40); // 30 + 2 × 5
    expect(stepWordBudget([atom(20, 10)])).toBe(90);
    expect(stepWordBudget([atom(500)])).toBe(200);
    expect(stepWordBudget([atom(10), atom(10)])).toBe(70);
  });

  it("ignores mechanical atoms and keeps deleted files short", () => {
    expect(explainableLines([atom(10), atom(300, 0, { mechanical: "format" })])).toBe(10);
    expect(stepWordBudget([atom(0, 400, { deletedFile: { names: ["a", "b"] }, kind: "removed" })])).toBe(40);
  });

  it("scales with the detail level and rounds to fives", () => {
    expect(stepWordBudget([atom(20)], "standard")).toBe(70);
    expect(stepWordBudget([atom(20)], "more")).toBe(105); // 70 × 1.5
    expect(stepWordBudget([atom(21)], "more")).toBe(110); // 72 × 1.5 = 108
    expect(stepWordBudget([atom(500)], "more")).toBe(300);
    expect(stepWordBudget([atom(0, 400, { deletedFile: { names: ["a"] }, kind: "removed" })], "more")).toBe(60);
  });
});

describe("planning note", () => {
  it("asks for a one-sentence summary on small PRs and never names a step count", () => {
    expect(sizeHint(28, 4)).toContain("keep the summary to one sentence");
    expect(sizeHint(500, 1)).toContain("one sentence");
    expect(sizeHint(900, 40)).toBe("");
    expect(sizeHint(28, 4)).not.toMatch(/step/);
  });
});

describe("countWords", () => {
  it("counts words and backticked identifiers, not punctuation", () => {
    expect(countWords("The new `clamp` call — caps `v` at 10.")).toBe(8);
    expect(countWords("  ")).toBe(0);
  });
});
