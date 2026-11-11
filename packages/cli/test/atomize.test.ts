import { describe, expect, it } from "vitest";
import { atomizePR, buildGraph, checkCoverage, classifyAtoms, dependencyOrder, type ChangeAtom, type PRInput } from "@prstory/core";
import { createHost } from "../src/grammars";
import { makePR } from "./helpers";

const host = createHost();

async function atomsOf(pr: PRInput) {
  return classifyAtoms(pr, await atomizePR(pr, host));
}
const paths = (atoms: ChangeAtom[]) => atoms.map((a) => `${a.file}:${a.symbolPath.join(".")}`);

/** Every changed line must belong to exactly one atom. */
function expectFullCoverage(pr: PRInput, atoms: ChangeAtom[]) {
  const r = checkCoverage(pr, atoms, { steps: [{ atomIds: atoms.map((a) => a.id), label: "", explanation: [] }], mechanical: [] });
  expect(r.missing).toEqual([]);
  expect(r.duplicated).toEqual([]);
  expect(r.extra).toEqual([]);
}

const TS_BASE = `import { a } from "./a";
import { b } from "./b";

export class Scheduler {
  private queue: string[] = [];

  plan(x: number) {
    const y = x + 1;
    return y;
  }

  replan() {
    this.queue = [];
    return this.queue.length;
  }
}

export function helper() {
  return 1;
}

const LIMIT = 10;
`;

describe("TypeScript atoms", () => {
  it("splits a hunk spanning two methods into two atoms, and merges hunks in one method", async () => {
    const head = TS_BASE.replace("const y = x + 1;", "const y = x + 2;")
      .replace("    return y;\n  }\n\n  replan() {\n    this.queue = [];", "    return y * 2;\n  }\n\n  replan() {\n    this.queue = ['a'];");
    const pr = makePR({ "src/s.ts": TS_BASE }, { "src/s.ts": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["src/s.ts:Scheduler.plan", "src/s.ts:Scheduler.replan"]);
    expect(atoms.every((a) => a.supportTier === 2 && a.kind === "modified")).toBe(true);
    expectFullCoverage(pr, atoms);
  });

  it("gives imports, fields, top-level consts and new functions their own atoms", async () => {
    const head = TS_BASE.replace('import { b } from "./b";', 'import { b, c } from "./b";')
      .replace("private queue: string[] = [];", "private queue: number[] = [];")
      .replace("const LIMIT = 10;", "const LIMIT = 20;\n\n// Doubles a number.\nexport function twice(n: number) {\n  return helper() * n * 2;\n}");
    const pr = makePR({ "src/s.ts": TS_BASE }, { "src/s.ts": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["src/s.ts:<imports>", "src/s.ts:Scheduler.queue", "src/s.ts:LIMIT", "src/s.ts:twice"]);
    const twice = atoms.find((a) => a.symbolPath.includes("twice"))!;
    expect(twice.kind).toBe("added");
    expect(twice.defines).toEqual(["twice"]);
    expect(twice.references).toContain("helper");
    // The comment above twice() belongs to it.
    expect(twice.hunkLines.length).toBe(4);
    expectFullCoverage(pr, atoms);
  });

  it("joins small declarations that sit next to each other, but not across a function or a long one", async () => {
    const base = "export const a = 1;\nexport const b = {\n  x: 1,\n};\nexport const c = 3;\n\nexport function f() {\n  return a;\n}\nexport const d = 4;\nexport const big = [\n" + Array.from({ length: 10 }, (_, i) => `  ${i},`).join("\n") + "\n];\n";
    const head = base.replace("= 1;", "= 2;").replace("x: 1", "x: 2").replace("= 3;", "= 30;").replace("return a;", "return a + 1;").replace("= 4;", "= 40;").replace("  0,", "  100,");
    const pr = makePR({ "src/k.ts": base }, { "src/k.ts": head });
    const atoms = await atomsOf(pr);
    // a, b and c are one piece; f breaks the run; big is too long to join d.
    expect(paths(atoms)).toEqual(["src/k.ts:a, b, c", "src/k.ts:f", "src/k.ts:d", "src/k.ts:big"]);
    expect(atoms[0].defines).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(atoms[0].headRange).toEqual({ start: 1, end: 5 });
    expectFullCoverage(pr, atoms);
  });

  it("links a definition to its use in another file", async () => {
    const pr = makePR(
      { "src/util.ts": "export const x = 1;\n", "src/main.ts": "export function run() {\n  return 1;\n}\n" },
      {
        "src/util.ts": "export const x = 1;\n\nexport function clamp(v: number) {\n  return Math.min(v, 10);\n}\n",
        "src/main.ts": 'import { clamp } from "./util";\n\nexport function run() {\n  return clamp(1);\n}\n',
      },
    );
    const atoms = await atomsOf(pr);
    const edges = buildGraph(atoms);
    const clamp = atoms.find((a) => a.defines.includes("clamp"))!;
    const run = atoms.find((a) => a.defines.includes("run"))!;
    expect(edges.some((e) => e.from === clamp.id && e.to === run.id)).toBe(true);
    const order = dependencyOrder(atoms, edges);
    expect(order.indexOf(clamp.id)).toBeLessThan(order.indexOf(run.id));
    expectFullCoverage(pr, atoms);
  });
});

const PY_BASE = `import os
import sys


class Trail:
    """A hiking trail."""

    difficulty = 1

    def __init__(self, name):
        self.name = name

    @property
    def label(self):
        return self.name.title()


def load(path):
    with open(path) as f:
        return f.read()


if __name__ == "__main__":
    print(load(sys.argv[1]))
`;

describe("Python atoms", () => {
  it("finds methods, class attributes, decorated methods and functions", async () => {
    const head = PY_BASE.replace("difficulty = 1", "difficulty = 2")
      .replace("@property\n    def label(self):\n        return self.name.title()", "@property\n    def label(self):\n        return self.name.upper()")
      .replace("return f.read()", "return f.read().strip()");
    const pr = makePR({ "trail.py": PY_BASE }, { "trail.py": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["trail.py:Trail.difficulty", "trail.py:Trail.label", "trail.py:load"]);
    expectFullCoverage(pr, atoms);
  });

  it("tags an import reshuffle as mechanical but not new imports", async () => {
    const reshuffled = PY_BASE.replace("import os\nimport sys", "import sys\nimport os");
    let atoms = await atomsOf(makePR({ "t.py": PY_BASE }, { "t.py": reshuffled }));
    expect(atoms.map((a) => a.mechanical)).toEqual(["imports"]);

    const added = PY_BASE.replace("import os\nimport sys", "import os\nimport re\nimport sys");
    atoms = await atomsOf(makePR({ "t.py": PY_BASE }, { "t.py": added }));
    expect(atoms.map((a) => a.mechanical)).toEqual([undefined]);
  });
});

describe("mechanical changes", () => {
  it("tags formatting-only edits", async () => {
    const pr = makePR({ "a.ts": "export function f(a: number, b: number) { return a + b; }\n" }, { "a.ts": "export function f(a: number, b: number) {\n  return a + b;\n}\n" });
    const atoms = await atomsOf(pr);
    expect(atoms.map((a) => a.mechanical)).toEqual(["format"]);
  });

  it("tags a consistent rename but not swapped arguments", async () => {
    const base = "export function total(items: number[]) {\n  return items.length;\n}\n\nexport function avg(xs: number[], n: number) {\n  return sum(xs, n);\n}\n";
    const renamed = base.replace("items: number[]", "values: number[]").replace("items.length", "values.length");
    let atoms = await atomsOf(makePR({ "a.ts": base }, { "a.ts": renamed }));
    expect(atoms.map((a) => a.mechanical)).toEqual(["rename"]);

    const swapped = base.replace("sum(xs, n)", "sum(n, xs)");
    atoms = await atomsOf(makePR({ "a.ts": base }, { "a.ts": swapped }));
    expect(atoms.map((a) => a.mechanical)).toEqual([undefined]);
  });

  it("puts lockfiles and generated files in single mechanical atoms", async () => {
    const pr = makePR(
      { "package-lock.json": '{\n  "a": 1\n}\n', "dist/app.js": "var a=1;\n" },
      { "package-lock.json": '{\n  "a": 2,\n  "b": 3\n}\n', "dist/app.js": "var a=2;\n" },
    );
    const atoms = await atomsOf(pr);
    expect(atoms.map((a) => [a.file, a.mechanical])).toEqual([
      ["dist/app.js", "generated"],
      ["package-lock.json", "lockfile"],
    ]);
    expectFullCoverage(pr, atoms);
  });

  it("detects a function moved between files", async () => {
    const fn = "export function parseTrailName(input: string) {\n  return input.trim().toLowerCase();\n}\n";
    const pr = makePR({ "a.ts": `export const a = 1;\n\n${fn}`, "b.ts": "export const b = 2;\n" }, { "a.ts": "export const a = 1;\n", "b.ts": `export const b = 2;\n\n${fn}` });
    const atoms = await atomsOf(pr);
    expect(atoms.filter((a) => a.kind === "moved")).toHaveLength(2);
    expectFullCoverage(pr, atoms);
  });
});

describe("other tiers", () => {
  it("uses generic Tier 1 atoms for Go and JSON, and hunk atoms for unknown files", async () => {
    const goBase = "package m\n\nfunc Alpha() int {\n\treturn 1\n}\n\nfunc Beta() int {\n\treturn 2\n}\n";
    const pr = makePR(
      { "m.go": goBase, "conf.json": '{\n  "name": "x",\n  "port": 80\n}\n', "notes.md": "# Notes\n\nhello\n" },
      {
        "m.go": goBase.replace("return 1", "return 10").replace("return 2", "return Alpha() + 2"),
        "conf.json": '{\n  "name": "y",\n  "port": 8080\n}\n',
        "notes.md": "# Notes\n\nhello world\n",
      },
    );
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["conf.json:name", "conf.json:port", "m.go:Alpha", "m.go:Beta", "notes.md:"]);
    expect(atoms.map((a) => a.supportTier)).toEqual([1, 1, 1, 1, 0]);
    expect(buildGraph(atoms).some((e) => e.symbol === "Alpha")).toBe(true);
    expectFullCoverage(pr, atoms);
  });

  it("handles renamed, added, removed and binary files", async () => {
    const pr = makePR(
      { "old.ts": "export const keep = 1;\n", "gone.py": "x = 1\n", "img.bin": "\u0000\u0001\u0002" },
      { "old.ts": null, "new.ts": "export const keep = 1;\n", "gone.py": null, "added.py": "def f():\n    return 1\n", "img.bin": "\u0000\u0003\u0004" },
    );
    const atoms = await atomsOf(pr);
    const byFile = Object.fromEntries(atoms.map((a) => [a.file, a]));
    expect(byFile["new.ts"].mechanical).toBe("rename");
    expect(byFile["gone.py"].kind).toBe("removed");
    expect(byFile["added.py"].kind).toBe("added");
    expect(byFile["img.bin"].mechanical).toBe("generated");
    expectFullCoverage(pr, atoms);
  });
});

describe("C and C++", () => {
  it("names functions through declarators, methods, namespaces and flag macros", async () => {
    const base = `#include <string.h>

LUAU_FASTFLAGVARIABLE(LuauFastSplit)

namespace luau {
struct Splitter {
    int count(const char* s) const;
};

int Splitter::count(const char* s) const {
    return (int)strlen(s);
}
}

static int str_split(lua_State* L) {
    return 0;
}
`;
    const head = base
      .replace("LUAU_FASTFLAGVARIABLE(LuauFastSplit)", "LUAU_FASTFLAGVARIABLE(LuauFastSplit)\nLUAU_FASTFLAGVARIABLE(LuauFasterSplit)")
      .replace("return (int)strlen(s);", "return s ? (int)strlen(s) : 0;")
      .replace("    return 0;\n}", "    if (FFlag::LuauFasterSplit)\n        return 1;\n    return 0;\n}");
    const pr = makePR({ "split.cpp": base }, { "split.cpp": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["split.cpp:LuauFasterSplit", "split.cpp:luau.Splitter::count", "split.cpp:str_split"]);
    expect(atoms.every((a) => a.supportTier === 1)).toBe(true);
    const edges = buildGraph(atoms);
    expect(edges.map((e) => e.symbol)).toContain("LuauFasterSplit");
    expectFullCoverage(pr, atoms);
  });
});
