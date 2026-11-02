import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/diff";
import { atomSnippet, rowNumber, snippetText, walkthrough } from "../src/snippet";
import type { ChangeAtom, PRFile, StoryStep } from "../src/types";
import { changedLines } from "../src/diff";

// A function whose old body moves into an else branch (re-indented), plus a real one-line change.
const DIFF = `diff --git a/s.c b/s.c
--- a/s.c
+++ b/s.c
@@ -1,8 +1,13 @@
 int f(int x) {
-  int a = x + 1;
-  int b = a * 2;
-  int c = b - 3;
-  return c;
+  if (fast) {
+    return x * 2 - 1;
+  } else {
+    int a = x + 1;
+    int b = a * 2;
+    int c = b - 3;
+    return c;
+  }
 }
 
-int g(void) { return 1; }
+int g(void) { return 2; }
 
`;

const file: PRFile = parseUnifiedDiff(DIFF)[0];
const atom = (id: string, lines = changedLines(file)): ChangeAtom => ({
  id, file: "s.c", language: "c", symbolPath: ["f"], kind: "modified", hunkLines: lines, defines: [], references: [], supportTier: 1,
});

describe("re-indent folding", () => {
  const rows = atomSnippet(file, atom("a1"));
  const kinds = rows.map((r) => r.type).join(",");

  it("pairs whitespace-only changes into reindent rows and keeps real changes", () => {
    expect(rows.filter((r) => r.type === "reindent")).toHaveLength(4);
    expect(rows.filter((r) => r.type === "del").map((r) => (r as { text: string }).text)).toEqual(["int g(void) { return 1; }"]);
    expect(kinds).not.toContain("gap");
    const re = rows.find((r) => r.type === "reindent") as { oldLine?: number; newLine?: number; text: string };
    expect([re.oldLine, re.newLine, re.text]).toEqual([2, 5, "    int a = x + 1;"]);
  });

  it("accounts for every changed line exactly once", () => {
    const shown: string[] = [];
    for (const r of rows) {
      if (r.type === "del") shown.push(`L${r.oldLine}`);
      if (r.type === "add") shown.push(`R${r.newLine}`);
      if (r.type === "reindent") shown.push(`L${r.oldLine}`, `R${r.newLine}`);
    }
    const expected = changedLines(file).map((l) => `${l.side[0]}${l.line}`);
    expect(shown.sort()).toEqual(expected.sort());
  });

  it("can be turned off, and leaves moved identical lines alone", () => {
    expect(atomSnippet(file, atom("a1"), 3, { foldReindent: false }).some((r) => r.type === "reindent")).toBe(false);
  });

  it("marks re-indented lines with ~ in prompts", () => {
    expect(snippetText(rows)).toContain("    5 ~     int a = x + 1;");
  });
});

describe("walkthrough", () => {
  const snippets = new Map([["a1", atomSnippet(file, atom("a1"))]]);
  const rows = snippets.get("a1")!;
  const nums = rows.map(rowNumber);
  const step = (cuts: (number | null)[]): StoryStep => ({
    atomIds: ["a1"],
    label: "x",
    explanation: cuts.map((c, i) => ({ text: `beat ${i}`, cites: [], ...(c === null ? {} : { through: { atomId: "a1", line: c } }) })),
  });
  const flat = (w: ReturnType<typeof walkthrough>) => w.beats.flatMap((b) => b.code.flatMap((c) => c.rows));

  it("cuts the snippet at each beat and shows every row once", () => {
    const w = walkthrough(step([null, 4, 9, 13]), snippets);
    expect(w.snapped).toBe(0);
    expect(w.beats[0].code).toEqual([]);
    expect(rowNumber(w.beats[1].code[0].rows.at(-1)!)).toBe(4);
    expect(w.beats[1].code[0].first).toBe(true);
    expect(w.beats[2].code[0].first).toBe(false);
    expect(flat(w).map(rowNumber)).toEqual(nums.filter((n) => n !== undefined));
  });

  it("snaps bad cuts and puts unreached rows after the last beat", () => {
    const w = walkthrough(step([6, 2, 999]), snippets); // 2 is behind the cursor; 999 is past the end
    expect(w.snapped).toBe(2);
    expect(flat(w).map(rowNumber)).toEqual(nums.filter((n) => n !== undefined));
  });

  it("puts everything after a beat with no cuts", () => {
    const w = walkthrough(step([null]), snippets);
    expect(w.beats[0].code[0].rows).toEqual(rows);
  });
});
