import { describe, expect, it } from "vitest";
import { atomizePR, buildGraph, classifyAtoms } from "@prstory/core";
import { createHost } from "../src/grammars";
import { makePR } from "./helpers";

const host = createHost();

/** Edges of a PR that adds `files`, as "from → to" by symbol path. */
async function edgesOf(files: Record<string, string>) {
  const pr = makePR({ "README.md": "x\n" }, files);
  const atoms = classifyAtoms(pr, await atomizePR(pr, host));
  const name = (id: string) => atoms.find((a) => a.id === id)!.symbolPath.join(".");
  return buildGraph(atoms).map((e) => `${name(e.from)} → ${name(e.to)}`);
}

describe("dependency edges", () => {
  it("TypeScript: locals shadow, this.#m stays in its class, property reads and keys link only to members", async () => {
    const edges = await edgesOf({
      "src/a.ts": `export function timeout(ms: number) {
  return ms;
}

export interface Options {
  retries?: number;
}

export class Client {
  #helper() {
    return 1;
  }

  run(options: Options) {
    const timeout = 5;
    return this.#helper() + timeout + (options.retries ?? 0);
  }
}

export class Other {
  #helper() {
    return 2;
  }
}

export const defaults = { retries: 3 };
`,
    });
    expect(edges).toContain("Client.#helper → Client.run");
    expect(edges).not.toContain("Other.#helper → Client.run");
    expect(edges).not.toContain("timeout → Client.run"); // the local `timeout` shadows it
    expect(edges).toContain("Options → Client.run"); // type annotation
    expect(edges).toContain("Options.retries → Client.run"); // options.retries
    expect(edges).toContain("Options.retries → defaults"); // { retries: 3 }
  });

  it("Python: self.m() links to the class's own or inherited m, and keyword names are not uses", async () => {
    const edges = await edgesOf({
      "app.py": `class Base:
    def close(self):
        return 1


class A(Base):
    def pop(self):
        return 1

    def run(self, pop=None):
        self.close()
        return self.pop()


class B:
    def pop(self):
        return 2


def name():
    return "n"


def view():
    return render(name="x")
`,
    });
    expect(edges).toContain("A.pop → A.run");
    expect(edges).not.toContain("B.pop → A.run");
    expect(edges).toContain("Base.close → A.run"); // inherited
    expect(edges).not.toContain("name → view"); // a keyword argument, not the function
  });

  it("C++: parameters shadow, calls link, and members are found through declarators", async () => {
    const edges = await edgesOf({
      "src/box.cpp": `int count(int x) {
    return x;
}

int total(int count) {
    return count * 2;
}

int use() {
    return count(3);
}

struct Box {
    int size;
    int area() { return size * size; }
};
`,
    });
    expect(edges).toContain("count → use");
    expect(edges).not.toContain("count → total");
    expect(edges).toContain("Box.size → Box.area");
  });
});
