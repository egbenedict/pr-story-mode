import { describe, expect, it } from "vitest";
import { atomizePR, buildGraph, classifyAtoms, runPipeline, validatePlan, type CompletionRequest, type PRInput } from "@prstory/core";
import { MockProvider } from "@prstory/providers";
import { createHost } from "../src/grammars";
import { renderStoryHtml } from "../src/render";
import { makePR } from "./helpers";

const host = createHost();

// clamp is defined in util.ts and used by run() in main.ts; formatting-only change in fmt.ts.
const pr: PRInput = makePR(
  {
    "src/util.ts": "export const x = 1;\n",
    "src/main.ts": "export function run() {\n  return 1;\n}\n",
    "src/fmt.ts": "export function f(a: number) { return a; }\n",
  },
  {
    "src/util.ts": "export const x = 1;\n\nexport function clamp(v: number) {\n  return Math.min(v, 10);\n}\n",
    "src/main.ts": "export function run() {\n  return clamp(1);\n}\n",
    "src/fmt.ts": "export function f(a: number) {\n  return a;\n}\n",
  },
  { title: "Clamp run() output", body: "Adds a clamp helper and uses it in run()." },
);

async function setup() {
  const atoms = classifyAtoms(pr, await atomizePR(pr, host));
  const edges = buildGraph(atoms);
  const id = (sym: string) => atoms.find((a) => a.symbolPath.includes(sym))!.id;
  return { atoms, edges, clamp: id("clamp"), run: id("run"), fmt: id("f") };
}

const plan = (steps: { atomIds: string[]; label: string; orderOverride?: string }[], mechanical: string[]) =>
  JSON.stringify({ summary: "Adds clamp and uses it.", steps: steps.map((s) => ({ orderOverride: "", ...s })), mechanical });

/** Explanation response that cites the first shown line of each requested step's atoms. */
const explainAll = (req: CompletionRequest) => {
  const content = req.messages[0].content;
  const steps = [...content.matchAll(/## Step (\d+):[\s\S]*?Atom (a\w+):[\s\S]*?```\n\s*(\d+)/g)].map((m) => ({
    step: +m[1],
    paragraphs: [{ text: `Step ${m[1]} explained.`, cites: [{ atomId: m[2], start: +m[3], end: +m[3] }, { atomId: "a_bogus", start: 1, end: 2 }] }],
  }));
  return JSON.stringify({ steps });
};

describe("validatePlan", () => {
  it("accepts a plan that covers every atom in dependency order", async () => {
    const { atoms, edges, clamp, run, fmt } = await setup();
    const v = validatePlan(plan([{ atomIds: [clamp], label: "Add clamp" }, { atomIds: [run], label: "Use clamp in run" }], [fmt]), atoms, edges);
    expect(v.errors).toEqual([]);
  });

  it("reports missing, unknown, repeated and misplaced atoms", async () => {
    const { atoms, edges, clamp, run } = await setup();
    const v = validatePlan(plan([{ atomIds: [clamp, "nope"], label: "A" }, { atomIds: [clamp], label: "B" }], [run]), atoms, edges);
    const text = v.errors.join("\n");
    expect(text).toContain('unknown atom ID "nope"');
    expect(text).toContain(`Atom ${clamp} appears more than once`);
    expect(text).toContain(`Atom ${run} is not mechanical`);
    expect(text).toMatch(/Mechanical atom \w+ is missing/);
  });

  it("flags dependency violations unless the step declares an override", async () => {
    const { atoms, edges, clamp, run, fmt } = await setup();
    const bad = validatePlan(plan([{ atomIds: [run], label: "Use clamp" }, { atomIds: [clamp], label: "Add clamp" }], [fmt]), atoms, edges);
    expect(bad.errors.join("\n")).toContain("uses `clamp`");
    const ok = validatePlan(plan([{ atomIds: [run], label: "Use clamp", orderOverride: "Start from the entry point" }, { atomIds: [clamp], label: "Add clamp" }], [fmt]), atoms, edges);
    expect(ok.errors).toEqual([]);
  });
});

describe("runPipeline", () => {
  it("repairs a bad plan, then explains and drops ungrounded citations", async () => {
    const { clamp, run, fmt } = await setup();
    const provider = new MockProvider([
      plan([{ atomIds: [run], label: "Use clamp" }], [fmt]), // missing clamp
      plan([{ atomIds: [clamp], label: "Add clamp" }, { atomIds: [run], label: "Use clamp in run" }], [fmt]),
      explainAll,
    ]);
    const r = await runPipeline(pr, { host, provider });
    expect(r.metrics.repairRounds).toBe(1);
    expect(r.metrics.fallbackOrder).toBe(false);
    expect(r.story.steps.map((s) => s.label)).toEqual(["Add clamp", "Use clamp in run"]);
    expect(r.coverage.ok).toBe(true);
    expect(r.metrics.citations).toBe(4);
    expect(r.metrics.groundingFailures).toBe(2);
    expect(r.story.steps[0].explanation[0].cites).toHaveLength(1);
    // The repair request carried the precise error back to the model.
    expect(provider.requests[1].messages.at(-1)!.content).toContain(`Atom ${clamp}`);
    // Explanation windows send the shared prefix separately so it can be cached.
    expect(provider.requests[2].sharedPrefix).toContain("# Full step order");
  });

  it("falls back to dependency order after three failed repairs", async () => {
    const bad = plan([{ atomIds: ["nope"], label: "?" }], []);
    const provider = new MockProvider([bad, bad, bad, bad, explainAll]);
    const r = await runPipeline(pr, { host, provider });
    expect(r.metrics.fallbackOrder).toBe(true);
    expect(r.metrics.repairRounds).toBe(3);
    expect(r.coverage.ok).toBe(true);
    expect(r.metrics.undeclaredViolations).toBe(0);
  });

  it("asks for JSON in the prompt when the provider has no schema support", async () => {
    const { clamp, run, fmt } = await setup();
    const provider = new MockProvider(
      ["Here you go:\n```json\n" + plan([{ atomIds: [clamp, run], label: "Add and use clamp" }], [fmt]) + "\n```", explainAll],
      { jsonSchema: false },
    );
    const r = await runPipeline(pr, { host, provider });
    expect(provider.requests[0].system).toContain("JSON Schema");
    expect(r.metrics.fallbackOrder).toBe(false);
    expect(r.story.steps).toHaveLength(1);
  });

  it("runs without a model and still covers every line, then renders HTML", async () => {
    const r = await runPipeline(pr, { host, provider: null });
    expect(r.coverage.ok).toBe(true);
    expect(r.story.mechanical).toHaveLength(1);
    const html = renderStoryHtml(pr, r);
    expect(html).toContain("Clamp run() output");
    expect(html).toContain("Mechanical changes");
    expect(html).toContain(`All ${r.coverage.totalLines} changed lines are shown exactly once.`);
  });
});
