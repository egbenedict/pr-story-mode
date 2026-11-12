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
  it("uses Tier 2 atoms for Go, Tier 1 for JSON, and hunk atoms for unknown files", async () => {
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
    expect(atoms.map((a) => a.supportTier)).toEqual([1, 1, 2, 2, 0]);
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

/** `from → to` edges by atom name. */
const edgeNames = (atoms: ChangeAtom[]) => {
  const name = (id: string) => atoms.find((a) => a.id === id)!.symbolPath.join(".");
  return buildGraph(atoms).map((e) => `${name(e.from)} → ${name(e.to)}`);
};

describe("Go atoms", () => {
  const base = `package m

import "example.com/app/api"

// Client sends things.
type Client struct {
	n int
}

type Other struct{}

const (
	Low  = 1
	High = 2
)

// Send sends.
func (c *Client) Send() error {
	return c.flush()
}

func (c *Client) flush() error { return nil }

func (c *Client) String() string { return "client" }

func (o Other) String() string { return "other" }

func (o Other) flush() error { return nil }

func Use() int { return api.Limit }
`;
  const apiBase = "package api\n\nvar Limit = 1\n\nfunc Limit2() int { return 2 }\n";

  it("names methods by their receiver and keeps same-named methods apart", async () => {
    const head = base.replace('return "client"', 'return "Client"').replace('return "other"', 'return "Other"');
    const pr = makePR({ "m.go": base }, { "m.go": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["m.go:Client.String", "m.go:Other.String"]);
    expect(atoms[0].defines).toEqual(["String", "Client.String"]);
    expect(atoms.every((a) => a.supportTier === 2)).toBe(true);
    expectFullCoverage(pr, atoms);
  });

  it("links a receiver's calls to its own type's methods and package references across files", async () => {
    const head = base
      .replace("return c.flush()", "return c.flush() // now checked")
      .replace("{ return nil }\n\nfunc (c *Client) String", "{ return c.check() }\n\nfunc (c *Client) String")
      .replace("func (o Other) flush() error { return nil }", "func (o Other) flush() error { return o.check() }")
      .replace("return api.Limit }", "return api.Limit + 1 }");
    const pr = makePR({ "m.go": base, "api/api.go": apiBase }, { "m.go": head, "api/api.go": apiBase.replace("Limit = 1", "Limit = 10") });
    const atoms = await atomsOf(pr);
    const edges = edgeNames(atoms);
    expect(edges).toContain("Client.flush → Client.Send");
    expect(edges).not.toContain("Other.flush → Client.Send");
    expect(edges).toContain("Limit → Use");
    expect(atoms.find((a) => a.symbolPath.join(".") === "Use")!.references).not.toContain("api");
    expectFullCoverage(pr, atoms);
  });

  it("gives each entry of a grouped declaration its own name", async () => {
    const head = base.replace("High = 2", "High = 3").replace("\tLow  = 1\n", "\tLow  = 1\n\tMid  = 2\n");
    const pr = makePR({ "m.go": base }, { "m.go": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["m.go:Mid, High"]);
    expect(atoms[0].defines).toEqual(expect.arrayContaining(["Mid", "High"]));
    expect(atoms[0].defines).not.toContain("Low");
    expectFullCoverage(pr, atoms);
  });

  it("joins a doc comment change to the declaration it documents, and names package lines", async () => {
    const head = base.replace("// Send sends.", "// Send sends the queued items.").replace("// Client sends things.", "// Client sends queued things.");
    const pr = makePR({ "m.go": base }, { "m.go": head, "n.go": "package m\n\nfunc New() *Client { return &Client{} }\n" });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["m.go:Client", "m.go:Client.Send", "n.go:package m", "n.go:New"]);
    expectFullCoverage(pr, atoms);
  });
});

describe("Rust atoms", () => {
  const base = `use std::io;

/// A thing.
#[derive(Debug)]
pub struct Thing {
    pub n: u32,
}

impl<T: Clone> Sp<T> {
    fn new() -> Self { todo!() }
}

impl Thing {
    /// Makes a thing.
    pub fn new() -> Self { Thing { n: 0 } }

    /// Bumps it.
    pub fn bump(&mut self) {
        self.n += 1;
    }

    fn helper(&self) {}
}

impl Other {
    pub fn new() -> Self { Other }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self { Error::Io }
}

impl From<fmt::Error> for Error {
    fn from(e: fmt::Error) -> Self { Error::Fmt }
}

impl IntoThing<Thing> for Thing {
    fn into_thing(self) -> Thing { self }
}

fn make() -> Thing {
    Thing::new()
}
`;

  it("names the signature line of a documented function by its function", async () => {
    const head = base.replace("pub fn bump(&mut self) {", "pub fn bump(&mut self, by: u32) {").replace("self.n += 1;", "self.n += by;");
    const pr = makePR({ "t.rs": base }, { "t.rs": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["t.rs:Thing.bump"]);
    expect(atoms[0].supportTier).toBe(2);
    expectFullCoverage(pr, atoms);
  });

  it("names impl blocks by their type and keeps each trait impl apart", async () => {
    const head = base
      .replace("fn new() -> Self { todo!() }", "fn new() -> Self { unimplemented!() }")
      .replace("Error::Io }", "Error::Io(e) }")
      .replace("Error::Fmt }", "Error::Fmt(e) }");
    const pr = makePR({ "t.rs": base }, { "t.rs": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["t.rs:Sp.new", "t.rs:From<io::Error> for Error.from", "t.rs:From<fmt::Error> for Error.from"]);
    expect(atoms[1].defines).toEqual(["from", "Error.from", "Error::from"]);
    expectFullCoverage(pr, atoms);
  });

  it("pairs an impl header whose trait changes from the type's name to Self", async () => {
    const head = base.replace("impl IntoThing<Thing> for Thing {", "impl IntoThing<Self> for Thing {");
    const pr = makePR({ "t.rs": base }, { "t.rs": head });
    const atoms = await atomsOf(pr);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].kind).toBe("modified");
    expect(paths(atoms)).toEqual(["t.rs:IntoThing<Thing> for Thing"]);
    expectFullCoverage(pr, atoms);
  });

  it("links Type::f() only to that type's own function, and self calls to the impl's type", async () => {
    const head = base
      .replace("Thing { n: 0 } }", "Thing { n: 1 } }")
      .replace("pub fn new() -> Self { Other }", "pub fn new() -> Self { Other {} }")
      .replace("        self.n += 1;\n", "        self.n += 1;\n        self.helper();\n")
      .replace("fn helper(&self) {}", "fn helper(&self) { println!() }")
      .replace("    Thing::new()\n", "    let t = Thing::new();\n    t\n");
    const pr = makePR({ "t.rs": base }, { "t.rs": head });
    const atoms = await atomsOf(pr);
    const edges = edgeNames(atoms);
    expect(edges).toContain("Thing.new → make");
    expect(edges).not.toContain("Other.new → make");
    expect(edges).toContain("Thing.helper → Thing.bump");
    expectFullCoverage(pr, atoms);
  });

  it("joins an outer doc comment to its item but leaves module docs alone", async () => {
    const withModDoc = `//! The crate.\n\n${base}`;
    const head = withModDoc.replace("//! The crate.", "//! The whole crate.").replace("/// A thing.", "/// A counted thing.");
    const pr = makePR({ "t.rs": withModDoc }, { "t.rs": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["t.rs:", "t.rs:Thing"]);
    expectFullCoverage(pr, atoms);
  });
});

describe("Java atoms", () => {
  const base = `package p;

public class A {
    /** Runs. */
    public void run() {
        helper();
    }

    private void helper() {}

    enum Kind {
        X, Y;

        String label() { return "k"; }

        static Kind parse(String s) { return X; }
    }
}

class B {
    private void helper() {}
}
`;

  it("links unqualified calls to the enclosing class's own method", async () => {
    const head = base.replace("        helper();\n", "        helper();\n        helper();\n").replace("private void helper() {}\n\n    enum", "private void helper() { run(); }\n\n    enum").replace("class B {\n    private void helper() {}", "class B {\n    private void helper() { }");
    const pr = makePR({ "A.java": base }, { "A.java": head });
    const atoms = await atomsOf(pr);
    const edges = edgeNames(atoms);
    expect(edges).toContain("A.helper → A.run");
    expect(edges).not.toContain("B.helper → A.run");
    expect(atoms.every((a) => a.supportTier === 2)).toBe(true);
    expectFullCoverage(pr, atoms);
  });

  it("makes methods after an enum's constants members of the enum", async () => {
    const head = base.replace('return "k";', 'return "kind";').replace("return X;", "return Kind.valueOf(s);");
    const pr = makePR({ "A.java": base }, { "A.java": head });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["A.java:A.Kind.label", "A.java:A.Kind.parse"]);
    expect(atoms[0].defines).toContain("Kind.label");
    expectFullCoverage(pr, atoms);
  });

  it("joins a javadoc change to its method and names package lines", async () => {
    const head = base.replace("/** Runs. */", "/** Runs the job. */");
    const pr = makePR({ "A.java": base }, { "A.java": head, "C.java": "package p;\n\nclass C {}\n" });
    const atoms = await atomsOf(pr);
    expect(paths(atoms)).toEqual(["A.java:A.run", "C.java:package p", "C.java:C"]);
    expectFullCoverage(pr, atoms);
  });
});

/** Atom names as the reader shows them: placeholder segments like `<document>` left out. */
const shown = (atoms: ChangeAtom[]) => atoms.map((a) => `${a.file}:${a.symbolPath.filter((s) => !s.startsWith("<")).join(".")}`);

describe("YAML and TOML atoms", () => {
  const workflow = `name: CI
on:
  push:
    branches: [main]
  pull_request:

# Build and test on every push.
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

  it("splits a workflow by top-level key and by the keys under it, and defines nothing", async () => {
    const head = workflow.replace("branches: [main]", "branches: [main, next]").replace("npm run build", "npm run build:all").replace("npm test", "npm test -- --ci");
    const pr = makePR({ ".github/workflows/ci.yml": workflow, "src/build.ts": "export function build() {}\n" }, { ".github/workflows/ci.yml": head, "src/build.ts": "export function build() { return 1; }\n" });
    const atoms = await atomsOf(pr);
    expect(shown(atoms)).toEqual([".github/workflows/ci.yml:on.push", ".github/workflows/ci.yml:jobs.build", ".github/workflows/ci.yml:jobs.test", "src/build.ts:build"]);
    const yaml = atoms.filter((a) => a.file.endsWith(".yml"));
    expect(yaml.every((a) => a.supportTier === 1 && a.defines.length === 0 && a.references.length === 0)).toBe(true);
    expect(buildGraph(atoms)).toEqual([]); // the `build` job is not the `build` function
    expectFullCoverage(pr, atoms);
  });

  it("joins a comment line to the key below it", async () => {
    const head = workflow.replace("# Build and test on every push.", "# Build and test on every push and pull request.");
    const pr = makePR({ "ci.yaml": workflow }, { "ci.yaml": head });
    const atoms = await atomsOf(pr);
    expect(shown(atoms)).toEqual(["ci.yaml:jobs.build"]); // the first job under it
    expect(atoms[0].headRange?.start).toBe(9);
    expectFullCoverage(pr, atoms);
  });

  it("keeps the same key in two documents apart, named by kind and name", async () => {
    const base = "kind: Deployment\nmetadata:\n  name: web\nspec:\n  replicas: 2\n---\nkind: Service\nmetadata:\n  name: web\nspec:\n  port: 80\n";
    const head = base.replace("replicas: 2", "replicas: 3").replace("port: 80", "port: 8080");
    const pr = makePR({ "k8s/web.yaml": base }, { "k8s/web.yaml": head });
    const atoms = await atomsOf(pr);
    expect(shown(atoms)).toEqual(["k8s/web.yaml:Deployment web.spec.replicas", "k8s/web.yaml:Service web.spec.port"]);
    expectFullCoverage(pr, atoms);
  });

  it("gives TOML one atom per table, joins comments to the table below, and leaves lockfiles mechanical", async () => {
    const base = 'title = "x"\n\n[package]\nname = "app"\nversion = "1.0.0"\n\n# Runtime dependencies.\n[dependencies]\nserde = "1"\ntokio = "1"\n\n[[bin]]\nname = "app"\n';
    const head = base.replace('title = "x"', 'title = "y"').replace('version = "1.0.0"', 'version = "1.1.0"').replace("# Runtime dependencies.", "# Runtime dependencies only.").replace('serde = "1"\ntokio = "1"', 'serde = "1.0"\ntokio = "1.40"').replace('[[bin]]\nname = "app"', '[[bin]]\nname = "app-cli"');
    const pr = makePR({ "Cargo.toml": base, "pnpm-lock.yaml": "lockfileVersion: 9\n" }, { "Cargo.toml": head, "pnpm-lock.yaml": "lockfileVersion: 10\n" });
    const atoms = await atomsOf(pr);
    expect(shown(atoms)).toEqual(["Cargo.toml:title", "Cargo.toml:[package]", "Cargo.toml:[dependencies]", "Cargo.toml:[[bin]]", "pnpm-lock.yaml:"]);
    expect(atoms.find((a) => a.file === "pnpm-lock.yaml")!.mechanical).toBe("lockfile");
    expect(atoms.filter((a) => a.file === "Cargo.toml").every((a) => a.supportTier === 1 && a.defines.length === 0)).toBe(true);
    expectFullCoverage(pr, atoms);
  });
});
