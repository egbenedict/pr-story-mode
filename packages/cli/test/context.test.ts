import { afterAll, describe, expect, it } from "vitest";
import { atomizePR, classifyAtoms, isTestPath, retrieveContext, runPipeline, type CompletionRequest, type ContextSnippet } from "@prstory/core";
import { MockProvider } from "@prstory/providers";
import { createHost } from "../src/grammars";
import { localContextSource } from "../src/local";
import { renderStoryHtml } from "../src/render";
import { makeRepo } from "./helpers";

const host = createHost();

// `total` (changed) calls `round2` (unchanged, same file) and `clampPrice` (unchanged, other file,
// not in the PR). `checkout` (unchanged, not in the PR) calls `total`. A test file also defines a
// `round2`, which must never be shown for non-test code.
const repo = makeRepo(
  {
    "src/price.ts": `/** Round to cents. */
export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function total(items: number[]): number {
  return items.reduce((a, b) => a + b, 0);
}
`,
    "src/limits.ts": `// Prices never go below zero or above the cap.
export function clampPrice(x: number): number {
  return Math.min(Math.max(x, 0), 10_000);
}
`,
    "src/checkout.ts": `import { total } from "./price";

export function checkout(cart: number[]) {
  const sum = total(cart);
  return { sum, ok: sum > 0 };
}
`,
    "test/helpers.ts": `export const round2 = (x: number) => x;\n`,
    "README.md": "prices\n",
  },
  {
    "src/price.ts": `import { clampPrice } from "./limits";

/** Round to cents. */
export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function total(items: number[]): number {
  return clampPrice(round2(items.reduce((a, b) => a + b, 0)));
}
`,
  },
  { title: "Clamp and round totals" },
);
afterAll(() => repo.cleanup());
const pr = repo.pr;

async function contextFor(sym: string, withSource: boolean) {
  const atoms = classifyAtoms(pr, await atomizePR(pr, host));
  const steps = atoms.filter((a) => !a.mechanical).map((a) => ({ atomIds: [a.id] }));
  const { context, stats } = await retrieveContext(pr, atoms, steps, host, { source: withSource ? localContextSource(repo.dir, pr.headSha) : null });
  const i = steps.findIndex((s) => atoms.find((a) => a.id === s.atomIds[0])!.symbolPath.includes(sym));
  return { ctx: context[i] as ContextSnippet[], stats };
}

describe("context retrieval", () => {
  it("finds unchanged definitions in the PR's files, with their doc comments", async () => {
    const { ctx } = await contextFor("total", false);
    const def = ctx.find((c) => c.reason === "definition" && c.symbol === "round2")!;
    expect(def).toBeDefined();
    expect(def.file).toBe("src/price.ts");
    expect(def.code.split("\n")[0]).toBe("/** Round to cents. */");
    expect(def.code).toContain("Math.round(x * 100)");
    // Without a source, files outside the PR are not searched.
    expect(ctx.some((c) => c.symbol === "clampPrice")).toBe(false);
  });

  it("finds definitions and callers outside the PR through git grep", async () => {
    const { ctx, stats } = await contextFor("total", true);
    const clamp = ctx.find((c) => c.symbol === "clampPrice")!;
    expect(clamp).toMatchObject({ reason: "definition", file: "src/limits.ts", start: 1, end: 4 });
    const caller = ctx.find((c) => c.reason === "caller")!;
    expect(caller).toMatchObject({ symbol: "total", file: "src/checkout.ts", within: "checkout" });
    expect(caller.code).toContain("const sum = total(cart);");
    expect(ctx.some((c) => c.file.startsWith("test/"))).toBe(false);
    expect(stats.extraFiles).toBeGreaterThan(0);
  });

  it("recognises test paths", () => {
    expect(["test/a.ts", "src/a.test.ts", "pkg/a_test.go", "tests/test_x.py", "src/__tests__/x.js"].every(isTestPath)).toBe(true);
    expect(["src/attest.ts", "src/testing-utils.ts", "contest/a.py"].some(isTestPath)).toBe(false);
  });
});

describe("context in stories", () => {
  /** Cites the first context snippet (good), a context label that does not exist (bad), and runs to the end. */
  const explain = (req: CompletionRequest) => {
    const content = req.messages[0].content;
    const steps = content.split(/^## Step /m).slice(1).map((block) => {
      const step = +block.split(":")[0];
      const ctx = /^(C\d+): .*lines (\d+)–(\d+)/m.exec(block);
      const cites = ctx ? [{ atomId: ctx[1], start: +ctx[2], end: +ctx[2] }, { atomId: "C99", start: 1, end: 1 }] : [];
      return { step, beats: [{ text: `Step ${step}.`, cites, throughAtomId: "", throughLine: 0 }] };
    });
    return JSON.stringify({ steps });
  };

  it("sends context to the model, grounds citations into it, and renders it", async () => {
    const provider = new MockProvider([
      (req) => {
        const ids = [...req.messages[0].content.matchAll(/^### (a\w+):/gm)].map((m) => m[1]);
        return JSON.stringify({ summary: "Clamps totals.", steps: ids.map((id) => ({ atomIds: [id], label: id, orderOverride: "" })), mechanical: [] });
      },
      explain,
    ]);
    const r = await runPipeline(pr, { host, provider, contextSource: localContextSource(repo.dir, pr.headSha) });
    expect(r.coverage.ok).toBe(true);
    expect(r.metrics.contextSnippets).toBeGreaterThan(0);
    const prompt = provider.requests[1].messages[0].content;
    expect(prompt).toContain("Unchanged context for this step:");
    expect(prompt).toMatch(/C1: definition of `\w+`/);

    const cited = r.story.steps.flatMap((s) => s.explanation.flatMap((b) => b.cites)).filter((c) => c.file);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited[0].atomId).toBe("");
    expect(r.metrics.groundingFailures).toBe(cited.length); // each C99 failed

    const html = renderStoryHtml(pr, r);
    expect(html).toContain('<span class="tag-unchanged">Unchanged</span>');
    expect(html).toContain(`class="cite ctx" href="#" data-file="${cited[0].file}"`);
    expect(html).toMatch(/<table class="diff ctx" data-file="[^"]+"><tr data-n="\d+">/);
  });

  it("can be turned off", async () => {
    const r = await runPipeline(pr, { host, provider: null, noContext: true });
    expect(r.metrics.contextSnippets).toBe(0);
    expect(r.story.steps.every((s) => !s.context)).toBe(true);
  });
});
