import { describe, expect, it } from "vitest";
import { atomizePR, buildGraph, classifyAtoms, EXPLAIN_SYSTEM, modelFailure, ORDER_SYSTEM, planFromPrevious, runPipeline, validatePlan, type CompletionRequest, type PRInput } from "@prstory/core";
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

/**
 * Explanation response: for each requested step, two beats. The first cites the first shown line and
 * ends there; the second cites a bogus atom and runs to the end. Also returns a cut outside the step.
 */
const explainAll = (req: CompletionRequest) => {
  const content = req.messages[0].content;
  const steps = content.split(/^## Step /m).slice(1).map((block) => {
    const step = +block.split(":")[0];
    const atomId = /Atom (a\w+):/.exec(block)![1];
    const nums = [...block.matchAll(/^\s+(\d+) [-+ ~] /gm)].map((m) => +m[1]);
    return {
      step,
      beats: [
        { text: `Step ${step} starts here.`, cites: [{ atomId, start: nums[0], end: nums[0] }], throughAtomId: atomId, throughLine: nums[0] },
        { text: `Step ${step} continues.`, cites: [{ atomId: "a_bogus", start: 1, end: 2 }], throughAtomId: atomId, throughLine: nums[nums.length - 1] },
        { text: "A cut that points nowhere.", cites: [], throughAtomId: "a_elsewhere", throughLine: 3 },
      ],
    };
  });
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
    expect(r.metrics.beats).toBe(6);
    expect(r.metrics.badCuts).toBe(2);
    expect(r.story.steps[0].explanation[0].cites).toHaveLength(1);
    expect(r.story.steps[0].explanation[0].through).toBeDefined();
    expect(r.story.steps[0].explanation[2].through).toBeUndefined();
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

  it("reports a model that refuses every call, and doesn't count bad plans as model failures", async () => {
    const refuse = () => {
      throw new Error("400 Your credit balance is too low to access the Anthropic API.");
    };
    const broke = await runPipeline(pr, { host, provider: new MockProvider([refuse, refuse, refuse]) });
    expect(broke.coverage.ok).toBe(true);
    expect(broke.metrics.modelCalls).toEqual({ total: 2, failed: 2 }); // one order call, one explain window
    expect(broke.metrics.providerErrors).toEqual(["400 Your credit balance is too low to access the Anthropic API."]);
    expect(modelFailure(broke)).toMatch(/^Every model call failed: 400 Your credit balance/);

    const { clamp, run, fmt } = await setup();
    const explainDown = await runPipeline(pr, { host, provider: new MockProvider([plan([{ atomIds: [clamp, run], label: "Add and use clamp" }], [fmt]), refuse]) });
    expect(modelFailure(explainDown)).toMatch(/^No step was explained: 400/);

    const bad = plan([{ atomIds: ["nope"], label: "?" }], []);
    const badPlans = await runPipeline(pr, { host, provider: new MockProvider([bad, bad, bad, bad, explainAll]) });
    expect(badPlans.metrics.fallbackOrder).toBe(true);
    expect(modelFailure(badPlans)).toBeNull();
    expect(modelFailure(await runPipeline(pr, { host, provider: null }))).toBeNull();
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

  it("renders beats with their code, lists and code spans", async () => {
    const { clamp, run, fmt } = await setup();
    const provider = new MockProvider([
      JSON.stringify({ summary: "Adds `clamp` and uses it in `run`.", steps: [{ atomIds: [clamp], label: "Add `clamp`", orderOverride: "" }, { atomIds: [run], label: "Use it", orderOverride: "" }], mechanical: [fmt] }),
      (req: CompletionRequest) => explainAll(req).replace("Step 1 starts here.", "Two cases:\\n- low values\\n- high values"),
    ]);
    const r = await runPipeline(pr, { host, provider });
    const html = renderStoryHtml(pr, r);
    expect(html).toContain('<div class="summary"><p>Adds <code>clamp</code> and uses it in <code>run</code>.</p></div>');
    expect(html).toContain("<ul><li>low values</li><li>high values</li></ul>");
    expect(html).toContain('<span>Add <code>clamp</code></span>');
    // Step 1's first beat is followed by the start of clamp's code, and the rest comes after beat 2.
    const step1 = html.slice(html.indexOf('id="step-1"'), html.indexOf('id="step-2"'));
    expect(step1.indexOf("high values")).toBeLessThan(step1.indexOf('class="atom chunk"'));
    expect(step1.match(/class="atom chunk"/g)).toHaveLength(2);
    expect(step1).toContain("continued");
  });

  it("collects the distinct models that answered, as the provider reports them", async () => {
    const { clamp, run, fmt } = await setup();
    const mock = new MockProvider([plan([{ atomIds: [clamp], label: "Add clamp" }, { atomIds: [run], label: "Use clamp in run" }], [fmt]), explainAll]);
    const served = ["claude-sonnet-5-5", "claude-opus-5-5"];
    let n = 0;
    const provider = { id: "anthropic", model: "claude-opus-5-5", capabilities: mock.capabilities, complete: async (req: CompletionRequest) => ({ ...(await mock.complete(req)), model: served[n++ % 2] }) };
    const r = await runPipeline(pr, { host, provider });
    expect(r.metrics.modelCalls.total).toBe(2);
    expect(r.metrics.servedModels).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(r.story.meta.model).toBe("claude-opus-5-5"); // still the requested model
    // A provider that doesn't say which model answered leaves the list empty.
    const quiet = await runPipeline(pr, { host, provider: new MockProvider([plan([{ atomIds: [clamp, run], label: "All" }], [fmt]), explainAll]) });
    expect(quiet.metrics.servedModels).toEqual([]);
  });
});

describe("staged ordering for large PRs", () => {
  it("summarizes atoms first and orders from the summaries", async () => {
    const { clamp, run, fmt } = await setup();
    const provider = new MockProvider([
      // One batch; the model skips `run`, which then gets a template line.
      JSON.stringify({ summaries: [{ atomId: clamp, summary: "Adds `clamp`, which caps a value at 10." }, { atomId: "a_unknown", summary: "ignored" }] }),
      plan([{ atomIds: [clamp], label: "Add clamp" }, { atomIds: [run], label: "Use clamp in run" }], [fmt]),
      explainAll,
    ]);
    const events: string[] = [];
    const r = await runPipeline(pr, { host, provider, summarizeAboveTokens: 1, onEvent: (e) => e.type === "summarize" && events.push(`${e.done}/${e.total}`) });
    expect(r.metrics.summarized).toEqual({ batches: 1, missing: 1 });
    expect(events).toEqual(["1/1"]);
    expect(provider.requests[0].system).toContain("one or two plain sentences");
    expect(provider.requests[0].messages[0].content).toContain("Math.min(v, 10)"); // the batch sees code
    const orderPrompt = provider.requests[1].messages[0].content;
    expect(orderPrompt).toContain("Adds `clamp`, which caps a value at 10.");
    expect(orderPrompt).toContain("Change run.");
    expect(orderPrompt).not.toContain("Math.min(v, 10)"); // the planner sees only summaries
    expect(r.metrics.fallbackOrder).toBe(false);
    expect(r.coverage.ok).toBe(true);
  });

  it("orders from code when the prompt is small enough", async () => {
    const provider = new MockProvider([plan([], []), plan([], []), plan([], []), plan([], []), explainAll]);
    const r = await runPipeline(pr, { host, provider });
    expect(r.metrics.summarized).toBeNull();
    expect(provider.requests[0].system).not.toContain("one or two plain sentences");
  });
});

describe("explanation voice", () => {
  it("walks through with \"we\", never as the author, and without filler", () => {
    expect(EXPLAIN_SYSTEM).not.toMatch(/You wrote this pull request/);
    expect(EXPLAIN_SYSTEM).toContain("You did not write the pull request");
    expect(EXPLAIN_SYSTEM).toContain('using "we"');
    expect(EXPLAIN_SYSTEM).toMatch(/Never use "I", "my" or "our"/);
    expect(EXPLAIN_SYSTEM).toContain("No filler");
    expect(EXPLAIN_SYSTEM).toContain("refer to that code by name, never by its label");
  });
});

describe("explanation length", () => {
  it("sends a word target with each step, a size note to the planner, and counts the words written", async () => {
    const { clamp, run, fmt } = await setup();
    const provider = new MockProvider([plan([{ atomIds: [clamp], label: "Add clamp" }, { atomIds: [run], label: "Use clamp in run" }], [fmt]), explainAll]);
    const r = await runPipeline(pr, { host, provider });
    // A PR of a few lines gets a one-sentence summary; the number of steps is left to its structure.
    expect(provider.requests[0].messages[0].content).toMatch(/This is a small PR \(\d+ changed lines? to explain\), so keep the summary to one sentence\./);
    expect(provider.requests[0].messages[0].content).not.toMatch(/at most \d+ steps/);
    expect(provider.requests[1].messages[0].content).toMatch(/## Step 1: Add clamp \(about \d+ words\)/);
    // Each explained step gets "Step N starts here." (4), "Step N continues." (3), "A cut that points nowhere." (5).
    expect(r.metrics.explainedSteps).toBe(2);
    expect(r.metrics.words).toBe(24);
  });

  it("scales the word target with the detail level", async () => {
    const { clamp, run, fmt } = await setup();
    const target = async (detail?: "brief" | "thorough") => {
      const provider = new MockProvider([plan([{ atomIds: [clamp], label: "Add clamp" }, { atomIds: [run], label: "Use clamp in run" }], [fmt]), explainAll]);
      await runPipeline(pr, { host, provider, detail });
      return +/## Step 1: Add clamp \(about (\d+) words\)/.exec(provider.requests[1].messages[0].content)![1];
    };
    const [brief, standard, thorough] = [await target("brief"), await target(), await target("thorough")];
    expect(brief).toBeLessThan(standard);
    expect(thorough).toBeGreaterThan(standard);
  });

  it("tells the planner to organize by the change's structure, not a step count", () => {
    expect(ORDER_SYSTEM).toContain("Let the structure of the change decide the steps");
    expect(ORDER_SYSTEM).not.toMatch(/A step is usually one atom|how many steps suit/);
  });

  it("tells the planner to keep neighbouring code together and the explainer to cut only between whole statements", () => {
    expect(ORDER_SYSTEM).toContain("Keep code that sits together in a file together");
    expect(EXPLAIN_SYSTEM).toContain("Cut only at the end of a whole statement or block");
  });

  it("tells the model not to restate the code and not to split beats by a line count", () => {
    expect(EXPLAIN_SYSTEM).toContain("Skip lines that need no explanation");
    expect(EXPLAIN_SYSTEM).not.toMatch(/5 to 25 lines per beat/);
  });
});

describe("reusing the previous story after a push", () => {
  const header = "// header\n// more\n// lines\n\n";
  const util1 = `${header}export const x = 1;\n`;
  const utilHead = `${header}export const x = 1;\n\nexport function clamp(v: number) {\n  return Math.min(v, 10);\n}\n`;
  const v1 = makePR(
    { "src/util.ts": util1, "src/main.ts": "export function run() {\n  return 1;\n}\n" },
    { "src/util.ts": utilHead, "src/main.ts": "export function run() {\n  return clamp(1);\n}\n" },
    { title: "Clamp run() output" },
  );
  // The base gained a line above clamp (a rebase), run() changed again, and twice() is new.
  const v2 = makePR(
    { "src/util.ts": `// new first line\n${util1}`, "src/main.ts": "export function run() {\n  return 1;\n}\n" },
    {
      "src/util.ts": `// new first line\n${utilHead}`,
      "src/main.ts": "export function run() {\n  return clamp(2);\n}\n",
      "src/extra.ts": "export function twice(v: number) {\n  return clamp(v) * 2;\n}\n",
    },
    { title: "Clamp run() output" },
  );

  async function first() {
    const atoms = classifyAtoms(v1, await atomizePR(v1, host));
    const id = (s: string) => atoms.find((a) => a.symbolPath.includes(s))!.id;
    const provider = new MockProvider([plan([{ atomIds: [id("clamp")], label: "Add clamp" }, { atomIds: [id("run")], label: "Use clamp in run" }], []), explainAll]);
    const r = await runPipeline(v1, { host, provider });
    return { pr: v1, atoms: r.atoms, story: r.story };
  }

  it("keeps unchanged steps with moved line numbers, and explains only changed and new code, without ordering again", async () => {
    const prev = await first();
    const provider = new MockProvider([explainAll]);
    const r = await runPipeline(v2, { host, provider, previous: prev });

    expect(provider.requests).toHaveLength(1); // one explain call, no order call
    expect(provider.requests[0].system).toBe(EXPLAIN_SYSTEM);
    expect(r.coverage.ok).toBe(true);
    expect(r.story.summary).toBe(prev.story.summary);
    expect(r.story.meta.reused).toEqual({ steps: 1, from: v1.headSha });
    expect(r.metrics.reusedSteps).toBe(1);

    const labels = r.story.steps.map((s) => s.label);
    expect(labels).toEqual(["Add clamp", "Add twice", "Use clamp in run"]); // twice right after what it uses
    const asked = [...provider.requests[0].messages[0].content.matchAll(/^## Step (\d+):/gm)].map((m) => +m[1]);
    expect(asked).toEqual([2, 3]);

    // The clamp step is the old explanation, on the new atom ID and one line lower.
    const oldStep = prev.story.steps[0];
    const newStep = r.story.steps[0];
    expect(newStep.explanation.map((b) => b.text)).toEqual(oldStep.explanation.map((b) => b.text));
    const clampId = r.atoms.find((a) => a.symbolPath.includes("clamp"))!.id;
    expect(newStep.atomIds).toEqual([clampId]);
    expect(newStep.explanation[0].cites[0]).toEqual({ atomId: clampId, lines: [oldStep.explanation[0].cites[0].lines[0] + 1, oldStep.explanation[0].cites[0].lines[1] + 1] });
    expect(newStep.explanation[0].through).toEqual({ atomId: clampId, line: oldStep.explanation[0].through!.line + 1 });
  });

  it("orders from scratch when the previous story came from another model, or most of the code changed", async () => {
    const prev = await first();
    const other = { ...prev, story: { ...prev.story, meta: { ...prev.story.meta, model: "another-model" } } };
    const atoms = classifyAtoms(v2, await atomizePR(v2, host));
    const id = (s: string) => atoms.find((a) => a.symbolPath.includes(s))!.id;
    const fresh = () => new MockProvider([plan([{ atomIds: [id("clamp")], label: "Add clamp" }, { atomIds: [id("twice")], label: "Add twice" }, { atomIds: [id("run")], label: "Use it" }], []), explainAll]);
    const p1 = fresh();
    const r1 = await runPipeline(v2, { host, provider: p1, previous: other });
    expect(p1.requests).toHaveLength(2);
    expect(r1.story.meta.reused).toBeUndefined();

    const edges = buildGraph(atoms);
    expect(planFromPrevious(prev, v2, atoms, edges, { maxChangedShare: 0.3 })).toBeNull(); // 2 of 3 steps changed
    expect(planFromPrevious(prev, v2, atoms, edges)?.changed).toEqual([1, 2]);
  });
});

describe("streaming", () => {
  it("hands each step to the reader as soon as it is written, with drafts of the one in progress, and the plan as it is planned", async () => {
    const { clamp, run, fmt } = await setup();
    const provider = new MockProvider([plan([{ atomIds: [clamp], label: "Add clamp" }, { atomIds: [run], label: "Use clamp in run" }], [fmt]), explainAll], { chunk: 12, delayMs: 15 });
    const events: { type: string; at: number; index?: number; text?: string; labels?: string[]; summary?: string }[] = [];
    let explainDone = 0;
    const r = await runPipeline(pr, {
      host,
      provider,
      noContext: true,
      onEvent: (e) => {
        if (e.type === "stage" && e.stage === "done") explainDone = Date.now();
        events.push({ type: e.type, at: Date.now(), ...("index" in e ? { index: e.index } : {}), ...("text" in e ? { text: e.text } : {}), ...(e.type === "order-draft" ? { labels: e.labels, summary: e.summary } : {}) });
      },
    });
    expect(r.coverage.ok).toBe(true);

    const drafts = events.filter((e) => e.type === "order-draft");
    expect(drafts.length).toBeGreaterThan(1);
    expect(drafts.at(-1)).toMatchObject({ summary: "Adds clamp and uses it.", labels: ["Add clamp", "Use clamp in run"] });
    expect(drafts.some((d) => d.labels!.length === 1)).toBe(true); // labels arrive one by one

    const steps = events.filter((e) => e.type === "step");
    expect(steps.map((s) => s.index)).toEqual([0, 1]);
    // Step 1 arrived while step 2 was still being written.
    const step2Drafts = events.filter((e) => e.type === "draft" && e.index === 1);
    expect(step2Drafts.length).toBeGreaterThan(0);
    expect(steps[0].at).toBeLessThanOrEqual(step2Drafts[0].at);
    expect(steps[0].at).toBeLessThan(explainDone);
    expect(step2Drafts.at(-1)!.text).toContain("Step 2 starts here.");
  });
});

describe("folding low-information changes", () => {
  const legacy = [
    "export interface LegacyConfig {",
    "  path: string;",
    "}",
    "",
    "export function parseLegacy(text: string): LegacyConfig {",
    "  return { path: text.trim() };",
    "}",
    "",
    "export function migrate(c: LegacyConfig): string {",
    "  return c.path.toUpperCase();",
    "}",
    "",
  ].join("\n");
  const table = `export const WEIGHTS = [\n${Array.from({ length: 60 }, (_, i) => `  [${i}, ${(i * 0.37).toFixed(2)}, ${i % 7}],`).join("\n")}\n];\n`;
  const pr = makePR(
    { "src/legacy.ts": legacy, "src/app.ts": "export const run = () => 1;\n" },
    { "src/legacy.ts": null, "src/weights.ts": table, "src/app.ts": "import { WEIGHTS } from './weights';\nexport const run = () => WEIGHTS.length;\n" },
    { title: "Drop the legacy parser, add weights" },
  );

  it("makes a deleted file one change, folds data, and still shows every line exactly once", async () => {
    const r = await runPipeline(pr, { host: createHost(), provider: null });
    const deleted = r.atoms.filter((a) => a.file === "src/legacy.ts");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ deletedFile: { names: ["LegacyConfig", "parseLegacy", "migrate"] }, kind: "removed" });
    expect(r.coverage.ok).toBe(true);
    const html = renderStoryHtml(pr, r);
    expect(html).toContain('class="fold-btn deleted"');
    expect(html).toContain("Deleted file · 11 lines · removed <code>LegacyConfig</code>, <code>parseLegacy</code>, <code>migrate</code> · ");
    expect(html).toMatch(/56 more similar lines of numbers · <span class="fold-state">show/);
  });
});
