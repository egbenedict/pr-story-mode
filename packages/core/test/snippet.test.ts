import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/diff";
import { atomSnippet, expandChunk, fileRows, rowNumber, rowPositions, snippetText, walkthrough, type SnippetRow } from "../src/snippet";
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

  it("doesn't cut between a removed line and the line that replaces it", () => {
    // `int g` is old line 8 and new line 12; a cut "at 8" must not leave the added line for the next beat.
    const g = atom("g", changedLines(file).filter((l) => (l.side === "LEFT" ? l.line === 8 : l.line === 12)));
    const one = new Map([["g", atomSnippet(file, g, 0)]]);
    const types = one.get("g")!.map((r) => r.type);
    expect(types).toEqual(["del", "add"]);
    const w = walkthrough({ atomIds: ["g"], label: "x", explanation: [{ text: "a", cites: [], through: { atomId: "g", line: 8 } }, { text: "b", cites: [] }] }, one);
    expect(w.beats[0].code[0].rows.map((r) => r.type)).toEqual(["del", "add"]);
    expect(w.beats[1].code).toEqual([]);
  });

  it("keeps the unchanged lines after an atom's last change with the beat that shows it", () => {
    const g = atom("g", changedLines(file).filter((l) => (l.side === "LEFT" ? l.line === 8 : l.line === 12)));
    const one = new Map([["g", atomSnippet(file, g)]]);
    expect(one.get("g")!.at(-1)!.type).toBe("context");
    const w = walkthrough({ atomIds: ["g"], label: "x", explanation: [{ text: "a", cites: [], through: { atomId: "g", line: 12 } }, { text: "b", cites: [] }] }, one);
    expect(w.beats[0].code[0].rows).toEqual(one.get("g"));
    expect(w.beats[1].code).toEqual([]);
  });

  it("puts everything after a beat with no cuts", () => {
    const w = walkthrough(step([null]), snippets);
    expect(w.beats[0].code[0].rows).toEqual(rows);
  });
});

describe("walkthrough chunking", () => {
  const add = (n: number, text: string): SnippetRow => ({ type: "add", text, newLine: n });
  const beat = (text: string, atomId?: string, line?: number) => ({ text, cites: [], ...(atomId ? { through: { atomId, line: line! } } : {}) });

  it("keeps an atom's leftover lines in the block a beat already showed", () => {
    const snippets = new Map([["a", [add(23, "x = 1"), add(24, "y = 2"), add(25, "z = 3"), add(26, "w = 4")]]]);
    const w = walkthrough({ atomIds: ["a"], label: "x", explanation: [beat("first three", "a", 25)] }, snippets);
    expect(w.beats[0].code).toHaveLength(1);
    expect(w.beats[0].code[0].rows.map(rowNumber)).toEqual([23, 24, 25, 26]);
  });

  it("moves a cut past the closing bracket after it", () => {
    const snippets = new Map([["a", [add(23, "if (x) {"), add(24, "  run();"), add(25, "  done();"), add(26, "}"), add(27, "next();")]]]);
    const w = walkthrough({ atomIds: ["a"], label: "x", explanation: [beat("the branch", "a", 25), beat("then", "a", 27)] }, snippets);
    expect(w.beats[0].code[0].rows.map(rowNumber)).toEqual([23, 24, 25, 26]);
    expect(w.beats[1].code[0].rows.map(rowNumber)).toEqual([27]);
  });

  it("marks a chunk that carries straight on from the one above in the same file", () => {
    const snippets = new Map([
      ["a", [add(10, "const a = 1;")]],
      ["b", [add(11, "function b() {}")]],
      ["c", [add(30, "function c() {}")]],
      ["d", [add(31, "const d = 1;")]],
    ]);
    const files: Record<string, string> = { a: "x.ts", b: "x.ts", c: "x.ts", d: "y.ts" };
    const w = walkthrough({ atomIds: ["a", "b", "c", "d"], label: "x", explanation: [beat("all")] }, snippets, (id) => files[id]);
    expect(w.beats[0].code.map((c) => !!c.joined)).toEqual([false, true, false, false]);
    expect(walkthrough({ atomIds: ["a", "b"], label: "x", explanation: [beat("all")] }, snippets).beats[0].code.some((c) => c.joined)).toBe(false);
  });
});

describe("code follows the text", () => {
  // Like sherlock#3211's step 3: the plan lists 32-49, 1-6, 16-31, the text explains 16-31 then 32-49,
  // and nothing mentions the docstring at 1-6.
  const add = (n: number): SnippetRow => ({ type: "add", text: `l${n}`, newLine: n });
  const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => add(a + k));
  const snippets = new Map([
    ["rejects", span(32, 49)],
    ["doc", span(1, 6)],
    ["reduces", span(16, 31)],
  ]);
  const cite = (atomId: string, a: number, b: number) => ({ atomId, lines: [a, b] as [number, number] });
  const order = (w: ReturnType<typeof walkthrough>) => w.beats.map((b) => b.code.map((c) => c.atomId));

  it("puts an atom no beat cut into under the first beat that cites it, and an uncited one beside its neighbour", () => {
    const step: StoryStep = {
      atomIds: ["rejects", "doc", "reduces"],
      label: "x",
      explanation: [
        { text: "First we reduce names.", cites: [cite("reduces", 16, 20)] },
        { text: "Then we reject bad ones.", cites: [cite("rejects", 32, 40)] },
      ],
    };
    expect(order(walkthrough(step, snippets))).toEqual([["doc", "reduces"], ["rejects"]]);
  });

  it("does the same when the beats cut into the atoms in their own order", () => {
    const step: StoryStep = {
      atomIds: ["rejects", "doc", "reduces"],
      label: "x",
      explanation: [
        { text: "First we reduce names.", cites: [], through: { atomId: "reduces", line: 31 } },
        { text: "Then we reject bad ones.", cites: [], through: { atomId: "rejects", line: 49 } },
      ],
    };
    expect(order(walkthrough(step, snippets))).toEqual([["doc", "reduces"], ["rejects"]]);
  });

  it("orders atoms within a beat by the order its citations name them", () => {
    const step: StoryStep = {
      atomIds: ["rejects", "reduces"],
      label: "x",
      explanation: [{ text: "We reduce, then reject.", cites: [cite("reduces", 16, 20), cite("rejects", 32, 40)] }],
    };
    expect(order(walkthrough(step, snippets))).toEqual([["reduces", "rejects"]]);
  });
});

describe("expanding a chunk", () => {
  // 30 lines; lines 15 and 25 change.
  const head = Array.from({ length: 30 }, (_, i) => (i + 1 === 15 || i + 1 === 25 ? `X${i + 1}` : `l${i + 1}`)).join("\n") + "\n";
  const base = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const ctx = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => ` l${a + i}`).join("\n");
  const diff = `diff --git a/t.c b/t.c\n--- a/t.c\n+++ b/t.c\n@@ -12,7 +12,7 @@\n${ctx(12, 14)}\n-l15\n+X15\n${ctx(16, 18)}\n@@ -22,7 +22,7 @@\n${ctx(22, 24)}\n-l25\n+X25\n${ctx(26, 28)}\n`;
  const f: PRFile = { ...parseUnifiedDiff(diff)[0], baseText: base, headText: head };
  const a: ChangeAtom = { id: "t", file: "t.c", language: "c", symbolPath: ["t"], kind: "modified", hunkLines: changedLines(f), defines: [], references: [], supportTier: 1 };
  const rows = atomSnippet(f, a);
  const all = fileRows(f);
  const pos = rowPositions(all);
  const gapAt = rows.findIndex((r) => r.type === "gap");
  const nums = (rs: SnippetRow[]) => rs.map((r) => (r.type === "gap" ? "…" : r.type === "del" ? `-${r.oldLine}` : `${r.newLine}`));

  it("lists every line of the file in diff order", () => {
    expect(all).toHaveLength(32);
    expect(all.every((r) => r.type !== "gap")).toBe(true);
    expect(nums(all.slice(10, 13))).toEqual(["11", "12", "13"]);
    expect(all[all.length - 1]).toMatchObject({ type: "context", text: "l30", oldLine: 30, newLine: 30 });
  });

  it("adds lines above, below and inside gaps, and says how many are left", () => {
    expect(nums(rows)).toEqual(["12", "13", "14", "-15", "15", "16", "17", "18", "…", "22", "23", "24", "-25", "25", "26", "27", "28"]);
    const closed = expandChunk(rows, all, pos, new Set(), { above: 0, below: 0, gaps: {} });
    expect(closed).toMatchObject({ moreAbove: 11, moreBelow: 2 });
    expect(closed.gaps.get(rows[gapAt])).toEqual({ gap: gapAt, hidden: 3 });

    const open = expandChunk(rows, all, pos, new Set(), { above: 5, below: 10, gaps: { [gapAt]: [1, 0] } });
    expect(nums(open.rows).slice(0, 6)).toEqual(["7", "8", "9", "10", "11", "12"]);
    expect(nums(open.rows).slice(-3)).toEqual(["28", "29", "30"]);
    expect(nums(open.rows).slice(12, 15)).toEqual(["18", "19", "…"]);
    expect(open).toMatchObject({ moreAbove: 6, moreBelow: 0 });
    expect(open.extra.size).toBe(5 + 2 + 1);

    const gapGone = expandChunk(rows, all, pos, new Set(), { above: 0, below: 0, gaps: { [gapAt]: [2, 1] } });
    expect(nums(gapGone.rows).slice(7, 11)).toEqual(["18", "19", "20", "21"]);
    expect([...gapGone.gaps.values()]).toEqual([]);
  });

  it("stops at lines shown elsewhere in the step", () => {
    const line10 = all.findIndex((r) => r.type === "context" && r.newLine === 10);
    expect(expandChunk(rows, all, pos, new Set([line10]), { above: 0, below: 0, gaps: {} }).moreAbove).toBe(1);
  });

  it("can't expand between hunks without the file's text", () => {
    const bare: PRFile = { ...f, baseText: undefined, headText: undefined };
    const r = fileRows(bare);
    expect(r.filter((x) => x.type === "gap")).toHaveLength(2); // before the first hunk and between the two
    const e = expandChunk(rows, r, rowPositions(r), new Set(), { above: 0, below: 0, gaps: {} });
    expect(e).toMatchObject({ moreAbove: 0, moreBelow: 0 });
    expect(e.gaps.get(rows[gapAt])).toEqual({ gap: gapAt, hidden: 0 });
  });
});
