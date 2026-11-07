import { afterAll, describe, expect, it } from "vitest";
import { atomizePR, classifyAtoms, isTestPath, remoteContextSource, retrieveContext, runPipeline, type CompletionRequest, type ContextSource, type ContextSnippet } from "@prstory/core";
import { execFileSync } from "node:child_process";
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
    // A long table that refers to \`total\` without calling it, like a C function registry.
    "src/registry.ts": `import { total } from "./price";

export const handlers = {
${Array.from({ length: 12 }, (_, k) => `  op${k}: (x: number[]) => x.length + ${k},`).join("\n")}
  sum: total,
${Array.from({ length: 12 }, (_, k) => `  more${k}: (x: number[]) => x.length - ${k},`).join("\n")}
};
`,
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

async function contextFor(sym: string, withSource: boolean | ContextSource, maxSnippetsPerStep = 3) {
  const atoms = classifyAtoms(pr, await atomizePR(pr, host));
  const steps = atoms.filter((a) => !a.mechanical).map((a) => ({ atomIds: [a.id] }));
  const source = typeof withSource === "object" ? withSource : withSource ? localContextSource(repo.dir, pr.headSha) : null;
  const { context, stats } = await retrieveContext(pr, atoms, steps, host, { source, maxSnippetsPerStep });
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

  it("keeps the opening line of a long use, marks the matching line, and says whether it is a call", async () => {
    const { ctx } = await contextFor("total", true, 4);
    const table = ctx.find((c) => c.within === "handlers")!;
    expect(table).toBeDefined();
    expect(table.called).toBe(false);
    expect(table.head).toEqual({ line: 3, text: "export const handlers = {" });
    expect(table.start).toBeGreaterThan(4);
    expect(table.focus).toEqual([16]);
    expect(table.code).toContain("sum: total,");
    const call = ctx.find((c) => c.within === "checkout")!;
    expect(call.called).toBe(true);
    expect(call.head).toBeUndefined(); // short enough to show whole
  });

  it("finds the same context from a repository it can only list and read, as on GitHub without a clone", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo.dir, ...args], { encoding: "utf8" });
    const reads: string[] = [];
    const source = remoteContextSource(
      pr,
      async () =>
        git("ls-tree", "-r", "-l", pr.headSha)
          .trim()
          .split("\n")
          .map((l) => {
            const [meta, path] = l.split("\t");
            return { path, size: +meta.trim().split(/\s+/)[3] };
          }),
      async (path) => (reads.push(path), git("show", `${pr.headSha}:${path}`)),
    );
    const { ctx } = await contextFor("total", source);
    expect(ctx.find((c) => c.symbol === "clampPrice")).toMatchObject({ reason: "definition", file: "src/limits.ts", start: 1, end: 4 });
    expect(ctx.find((c) => c.reason === "caller")).toMatchObject({ symbol: "total", file: "src/checkout.ts", within: "checkout" });
    // limits.ts comes first: price.ts imports it. The README is never read.
    expect(source.fetched()[0]).toBe("src/limits.ts");
    expect(reads).not.toContain("README.md");
  });

  it("doesn't call a header's declaration of the changed function a caller", async () => {
    // Shaped like Luau's lbuffer.h: the declaration hides behind a macro defined elsewhere.
    const c = makeRepo(
      {
        "src/lbuf.h": '#pragma once\n\n#include "lobject.h"\n\nLUAI_FUNC Buffer* newbuf(lua_State* L, size_t s);\nLUAI_FUNC void freebuf(lua_State* L, Buffer* u);\n',
        "src/lbuf.cpp": '#include "lbuf.h"\n\nBuffer* newbuf(lua_State* L, size_t s)\n{\n    return alloc(L, s);\n}\n',
        "src/lapi.cpp": '#include "lbuf.h"\n\nvoid* lua_newbuffer(lua_State* L, size_t sz)\n{\n    Buffer* b = newbuf(L, sz);\n    return b->data;\n}\n',
      },
      { "src/lbuf.cpp": '#include "lbuf.h"\n\nBuffer* newbuf(lua_State* L, size_t s)\n{\n    if (s > MAX)\n        fail(L);\n    return alloc(L, s);\n}\n' },
    );
    try {
      const atoms = classifyAtoms(c.pr, await atomizePR(c.pr, host));
      const steps = atoms.filter((a) => !a.mechanical).map((a) => ({ atomIds: [a.id] }));
      const { context } = await retrieveContext(c.pr, atoms, steps, host, { source: localContextSource(c.dir, c.pr.headSha) });
      const callers = context.flat().filter((x) => x.reason === "caller");
      expect(callers.map((x) => [x.file, x.within])).toEqual([["src/lapi.cpp", "lua_newbuffer"]]);
    } finally {
      c.cleanup();
    }
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
    expect(html).toMatch(/<table class="diff ctx" data-file="[^"]+"><tr data-n="\d+"/);
    expect(html).toContain("is called in <code>checkout</code>");
  });

  it("can be turned off", async () => {
    const r = await runPipeline(pr, { host, provider: null, noContext: true });
    expect(r.metrics.contextSnippets).toBe(0);
    expect(r.story.steps.every((s) => !s.context)).toBe(true);
  });
});

// Context is about what changed: `run` uses `unrelated` on a line that didn't change and `fmt` on
// one that did; `describeRun` changes only its comment; the test calls `delay`, a helper outside the PR.
describe("context stays on what changed", () => {
  const r2 = makeRepo(
    {
      "src/util.ts": `export function fmt(x: number): string {\n  return x.toFixed(2);\n}\n\nexport function unrelated(): void {\n  console.log("hi");\n}\n`,
      "src/delay.ts": `export function delay(ms: number) {\n  return new Promise((r) => setTimeout(r, ms));\n}\n`,
      "src/app.ts": `import { fmt, unrelated } from "./util";\n\nexport function run(a: number) {\n  unrelated();\n  const b = a + 1;\n  return b;\n}\n\nexport function describeRun() {\n  // Runs once.\n  return "run";\n}\n`,
      "test/app.test.ts": `import { delay } from "../src/delay";\nimport { run } from "../src/app";\n\ntest("run", async () => {\n  expect(run(1)).toBe(2);\n});\n`,
    },
    {
      "src/app.ts": `import { fmt, unrelated } from "./util";\n\nexport function run(a: number) {\n  unrelated();\n  const b = fmt(a + 1);\n  return b;\n}\n\nexport function describeRun() {\n  // Runs once, then stops.\n  return "run";\n}\n`,
      "test/app.test.ts": `import { delay } from "../src/delay";\nimport { run } from "../src/app";\n\ntest("run", async () => {\n  await delay(5);\n  expect(run(1)).toBe("2.00");\n});\n`,
    },
    { title: "Format run's result" },
  );
  afterAll(() => r2.cleanup());

  it("shows definitions only for names on changed lines, nothing for comment-only changes, and no outside helpers for tests", async () => {
    const atoms = classifyAtoms(r2.pr, await atomizePR(r2.pr, host));
    const steps = atoms.filter((a) => !a.mechanical && !a.symbolPath.includes("<imports>")).map((a) => ({ atomIds: [a.id] }));
    const { context } = await retrieveContext(r2.pr, atoms, steps, host, { source: localContextSource(r2.dir, r2.pr.headSha) });
    const ctxOf = (sym: string) => context[steps.findIndex((s) => atoms.find((a) => a.id === s.atomIds[0])!.symbolPath.join(".").includes(sym))] ?? [];
    expect(ctxOf("run").map((c) => c.symbol)).toContain("fmt");
    expect(ctxOf("run").map((c) => c.symbol)).not.toContain("unrelated");
    expect(ctxOf("describeRun")).toEqual([]);
    const testStep = context[steps.findIndex((s) => isTestPath(atoms.find((a) => a.id === s.atomIds[0])!.file))] ?? [];
    expect(testStep.map((c) => c.symbol)).not.toContain("delay");
  });
});
