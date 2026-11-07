import { describe, expect, it } from "vitest";
import { collapsesFor, promptCollapses, similarRuns, snippetText, type SnippetRow } from "../src";

const added = (lines: string[], from = 1): SnippetRow[] => lines.map((text, i) => ({ type: "add", text, newLine: from + i }));
const ctx = (text: string, n: number): SnippetRow => ({ type: "context", text, oldLine: n, newLine: n });

describe("similar runs", () => {
  it("fold a long table of numbers, keeping its first three lines and its last", () => {
    const rows = [ctx("const TABLE = [", 1), ...added(Array.from({ length: 40 }, (_, i) => `  [${i}, ${i * 0.5}, ${-i}],`), 2), ctx("];", 42)];
    const runs = similarRuns(rows);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 4, end: 39, count: 36, kind: "similar", label: "36 more similar lines of numbers" });
  });

  it("fold repeating patterns: objects over several lines, enum members, calls to one function", () => {
    const objects = Array.from({ length: 8 }, (_, i) => [`  {`, `    id: ${i},`, `    name: "item ${i}",`, `  },`]).flat();
    expect(similarRuns(added(objects))).toHaveLength(1);
    const members = added(Array.from({ length: 20 }, (_, i) => `  COLOR_${String.fromCharCode(65 + i)},`));
    expect(similarRuns(members)[0]?.count).toBe(16);
    const calls = added(Array.from({ length: 15 }, (_, i) => `register("op${i}", handle${i});`));
    expect(similarRuns(calls)).toHaveLength(1);
    expect(similarRuns(added(Array.from({ length: 15 }, (_, i) => `"word${i}",`)))[0]?.label).toMatch(/of strings$/);
  });

  it("leave real code alone, however regular it looks", () => {
    const code = added([
      "const a = load(path);",
      "const b = parse(a);",
      "if (!b.ok) return null;",
      "for (const item of b.items) {",
      "  total += item.price;",
      "}",
      "const c = format(total);",
      "log(c);",
      "x = compute(y);",
      "z = other(w);",
      "save(c, path);",
      "return c;",
      "export default run;",
    ]);
    expect(similarRuns(code)).toEqual([]);
    // Assignments to different names calling different functions aren't one shape, even in bulk.
    expect(similarRuns(added(Array.from({ length: 20 }, (_, i) => `v${i} = fn${i}(arg${i});`)))).toEqual([]);
  });

  it("split around a line that breaks the pattern, so a real change in a table stays in view", () => {
    const lines = [...Array.from({ length: 15 }, (_, i) => `  ${i},`), "  computeExtra(),", ...Array.from({ length: 15 }, (_, i) => `  ${i},`)];
    const runs = similarRuns(added(lines));
    expect(runs.map((r) => [r.start, r.end])).toEqual([
      [3, 13],
      [19, 29],
    ]);
  });

  it("need twelve lines, and don't fold unchanged or removed-and-added mixes", () => {
    expect(similarRuns(added(Array.from({ length: 11 }, (_, i) => `${i},`)))).toEqual([]);
    expect(similarRuns(Array.from({ length: 20 }, (_, i) => ctx(`${i},`, i + 1)))).toEqual([]);
    const mixed: SnippetRow[] = Array.from({ length: 20 }, (_, i) => (i % 2 ? { type: "add", text: `${i},`, newLine: i } : { type: "del", text: `${i},`, oldLine: i }));
    expect(similarRuns(mixed)).toEqual([]);
  });
});

describe("deleted files", () => {
  const rows: SnippetRow[] = Array.from({ length: 60 }, (_, i) => ({ type: "del", text: `line ${i}`, oldLine: i + 1 }));
  const atom = { deletedFile: { names: ["parseLegacy", "LegacyConfig", "migrate"] } };

  it("fold whole under a summary of what they defined", () => {
    expect(collapsesFor(rows, atom)).toEqual([{ start: 0, end: 59, count: 60, kind: "deleted", label: "Deleted file · 60 lines · removed `parseLegacy`, `LegacyConfig`, `migrate`" }]);
  });

  it("go to the model as their first lines and a note, and data runs as their ends", () => {
    const text = snippetText(rows, Infinity, promptCollapses(rows, atom));
    expect(text.split("\n")).toHaveLength(16);
    expect(text).toContain("… 45 more lines of the deleted file, not shown");
    const table = added(Array.from({ length: 200 }, (_, i) => `  ${i},`));
    const short = snippetText(table, Infinity, promptCollapses(table));
    expect(short.split("\n")).toHaveLength(5);
    expect(short).toContain("… 196 more similar lines of numbers, not shown");
  });
});

import { repeatedEdits } from "../src";

describe("repeated edits", () => {
  const hunk = (n: number, lat: string, lng: string): SnippetRow[] => [
    { type: "context", text: `      "phone": "${n}",`, oldLine: n * 10, newLine: n * 10 },
    { type: "del", text: `      "latitude": 34.${n}1,`, oldLine: n * 10 + 1 },
    { type: "del", text: `      "longitude": -84.${n}2`, oldLine: n * 10 + 2 },
    { type: "add", text: `      "latitude": ${lat},`, newLine: n * 10 + 1 },
    { type: "add", text: `      "longitude": ${lng}`, newLine: n * 10 + 2 },
  ];
  const withGaps = (hunks: SnippetRow[][]) => hunks.flatMap((h, i) => (i ? [{ type: "gap" } as SnippetRow, ...h] : h));

  it("fold hunks after the first two when they all make the same kind of edit", () => {
    const rows = withGaps(Array.from({ length: 10 }, (_, i) => hunk(i + 1, `34.${i}`, `-83.${i}`)));
    const f = repeatedEdits(rows);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ start: 11, end: rows.length - 1, label: "8 more edits like these (`latitude`, `longitude`)" });
    expect(rows[f[0]!.start]!.type).toBe("gap");
  });

  it("leave a short series, or a different edit, in view", () => {
    expect(repeatedEdits(withGaps([hunk(1, "1", "2"), hunk(2, "1", "2"), hunk(3, "1", "2")]))).toEqual([]);
    const odd: SnippetRow[] = [{ type: "add", text: `      "notes": "rewritten",`, newLine: 999 }];
    const rows = withGaps([hunk(1, "1", "2"), hunk(2, "1", "2"), odd, hunk(3, "1", "2"), hunk(4, "1", "2")]);
    expect(repeatedEdits(rows)).toEqual([]);
  });
});
