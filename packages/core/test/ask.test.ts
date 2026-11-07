import { describe, expect, it } from "vitest";
import { aroundSelection, buildAskRequest, findDefinitions, parseAnswer, remapSelection, selectionNames, type AskSelection, type ContextSource, type PRFile, type PRInput } from "../src";

const head = [
  "import { clamp } from './util';", // 1
  "",
  "/**",
  " * Example:",
  " *   const retries = 3;",
  " */",
  "export function retry(fn, opts) {", // 7
  "  const options = { ...opts };",
  "  const limit = clamp(options.retries, 0, MAX_RETRIES);", // 9
  "  for (let i = 0; i < limit; i++) {",
  "    if (shouldRetry(fn())) continue;", // 11
  "  }",
  "}",
  "",
  "function shouldRetry(result) {", // 15
  "  return result === undefined;",
  "}",
].join("\n");
const base = head.replace("  const limit = clamp(options.retries, 0, MAX_RETRIES);", "  const limit = options.retries;");

const file: PRFile = { path: "src/retry.ts", oldPath: "src/retry.ts", status: "modified", binary: false, hunks: [], headText: head, baseText: base };
const pr: PRInput = { number: 7, title: "Clamp retries", body: "Stops runaway retries.", baseSha: "b", headSha: "h", files: [file] };

const sel: AskSelection = {
  file: "src/retry.ts",
  kind: "diff",
  lines: [
    { mark: "-", old: 9, text: "  const limit = options.retries;" },
    { mark: "+", new: 9, text: "  const limit = clamp(options.retries, 0, MAX_RETRIES);" },
    { mark: " ", old: 10, new: 10, text: "  for (let i = 0; i < limit; i++) {" },
    { mark: " ", old: 11, new: 11, text: "    if (shouldRetry(fn())) continue;" },
  ],
};

const source: ContextSource = {
  findDefinitions: async (names) => (names.includes("clamp") || names.includes("MAX_RETRIES") ? ["src/util.ts"] : []),
  findReferences: async () => [],
  readFile: async (p) => (p === "src/util.ts" ? "export const MAX_RETRIES = 5;\n\nexport function clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}\n" : undefined),
};

describe("ask about code", () => {
  it("looks up names the selection calls or that look like types and constants, not locals", () => {
    const names = selectionNames(sel);
    expect(names.slice(0, 2).sort()).toEqual(["clamp", "shouldRetry"]); // calls first
    expect(names).toContain("MAX_RETRIES");
    expect(names).not.toContain("options"); // a plain local
    expect(names).not.toContain("limit"); // defined in the selection
    expect(names).not.toContain("const");
  });

  it("finds definitions in the PR's files and through the context source, skipping doc examples", async () => {
    const defs = await findDefinitions(sel, pr, source);
    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(byName.shouldRetry).toMatchObject({ file: "src/retry.ts", start: 15, end: 17 });
    expect(byName.clamp).toMatchObject({ file: "src/util.ts", start: 3, end: 5 });
    expect(byName.MAX_RETRIES).toMatchObject({ file: "src/util.ts", start: 1, end: 1 });
    expect(defs.map((d) => d.label)).toEqual(defs.map((_, i) => `D${i + 1}`));
    // `retries` appears only in a comment's example, so it's never shown as a definition.
    const onlyInComment = await findDefinitions({ ...sel, lines: [{ mark: "+", new: 9, text: "use(Retries_X)" }] }, { ...pr, files: [{ ...file, headText: head.replace("const retries = 3", "const Retries_X = 3") }] });
    expect(onlyInComment).toEqual([]);
  });

  it("shows the enclosing function around the selection, new and old versions", () => {
    const around = aroundSelection(sel, file, { headRange: { start: 7, end: 13 }, baseRange: { start: 7, end: 13 } } as never);
    expect(around.map((e) => [e.side, e.start, e.end])).toEqual([
      ["new", 7, 13],
      ["old", 7, 13],
    ]);
    // Without a short enclosing symbol: a window of lines, clamped to the file.
    expect(aroundSelection(sel, file)[0]).toMatchObject({ start: 1, end: 17 });
  });

  it("builds a request with the step, the code, the definitions and the question, and keeps follow-ups as a conversation", async () => {
    const context = { around: aroundSelection(sel, file), definitions: await findDefinitions(sel, pr, source) };
    const first = buildAskRequest({ pr, summary: "Retries are capped.", step: { number: 2, label: "Cap retries", explanation: "Uses clamp." }, sel, context, history: [], question: "" });
    expect(first.sharedPrefix).toContain("Clamp retries");
    expect(first.messages).toHaveLength(1);
    const msg = first.messages[0]!.content;
    expect(msg).toContain('step 2 of the walkthrough, "Cap retries"');
    expect(msg).toContain("> Uses clamp.");
    expect(msg).toContain("−    9 |   const limit = options.retries;");
    expect(msg).toContain("+    9 |   const limit = clamp(");
    expect(msg).toMatch(/D\d: `clamp` in `src\/util.ts`, lines 3–5/);
    expect(msg).toMatch(/Walk me through this code/);
    const next = buildAskRequest({ pr, summary: "", sel, context, history: [{ question: "", answer: "It clamps." }], question: "Why 0?" });
    expect(next.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(next.messages[2]!.content).toBe("Why 0?");
  });

  it("keeps citations of lines the model was shown and flags the rest", async () => {
    const context = { around: aroundSelection(sel, file, { headRange: { start: 7, end: 13 }, baseRange: { start: 7, end: 13 } } as never), definitions: await findDefinitions(sel, pr, source) };
    const clampLabel = context.definitions.find((d) => d.name === "clamp")!.label;
    const parts = parseAnswer(`It caps it [L9] using [${clampLabel} L3-5], unlike before [old L9]. Not [L40] or [D9 L1].`, sel, context);
    const refs = parts.filter((p) => "ref" in p).map((p) => ("ref" in p ? [p.ref.label, p.ref.side, p.ref.start, p.ref.end, p.text] : null));
    expect(refs).toEqual([
      ["", "new", 9, 9, "L9"],
      [clampLabel, "new", 3, 5, `${clampLabel} L3–5`],
      ["", "old", 9, 9, "old L9"],
    ]);
    expect(parts.filter((p) => "bad" in p).map((p) => p.text)).toEqual(["L40", "D9 L1"]);
    expect(parts.map((p) => p.text).join("")).toBe(`It caps it L9 using ${clampLabel} L3–5, unlike before old L9. Not L40 or D9 L1.`);
  });

  it("carries a selection to a new version of the file only when its lines still read the same", () => {
    const shifted = { ...file, headText: `// new header\n// more\n${head}`, baseText: `// new header\n// more\n${base}` };
    const moved = remapSelection(sel, shifted)!;
    expect(moved.lines.map((l) => (l.mark === "-" ? l.old : l.new))).toEqual([11, 11, 12, 13]);
    expect(remapSelection(sel, { ...file, headText: head.replace("shouldRetry(fn())", "shouldRetry(fn(), 1)") })).toBeNull();
    expect(remapSelection(sel, { ...file, headText: `${head}\n${head}` })).toBeNull(); // found twice
  });
});

describe("definition excerpts", () => {
  it("run to the end of an expression that continues after a closing brace", async () => {
    const text = ["export const getState = (value) =>", "  isMarked(value)", "    ? {", "        replace: true,", "      }", "    : {", "        replace: false,", "      };", "", "const other = 1;"].join("\n");
    const f: PRFile = { path: "m.ts", oldPath: "m.ts", status: "modified", binary: false, hunks: [], headText: text };
    const defs = await findDefinitions({ file: "x.ts", kind: "diff", lines: [{ mark: "+", new: 1, text: "const s = getState(v);" }] }, { ...pr, files: [f] });
    expect(defs[0]).toMatchObject({ name: "getState", start: 1, end: 8 });
  });
});
