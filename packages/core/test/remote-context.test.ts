import { describe, expect, it } from "vitest";
import { importedPaths, rankCandidates, remoteContextSource, type PRInput, type RepoFile } from "../src/index";

const repoFiles = [
  "src/app/main.ts",
  "src/app/util.ts",
  "src/app/helpers/index.ts",
  "src/lib/net.ts",
  "src/app/sibling.ts",
  "pkg/core/models.py",
  "pkg/core/__init__.py",
  "pkg/core/views.py",
  "pkg/utils.py",
  "VM/src/lmem.cpp",
  "VM/src/lmem.h",
  "VM/include/lua.h",
  "Common/include/Luau/Common.h",
  "cmd/server/main.go",
  "internal/store/store.go",
  "internal/store/store_test.go",
  "src/main/java/com/acme/Order.java",
  "src/main/java/com/acme/billing/Invoice.java",
  "crates/x/src/lib.rs",
  "crates/x/src/parser.rs",
  "crates/x/src/ast/mod.rs",
  "node_modules/left-pad/index.js",
  "README.md",
];
const files = new Set(repoFiles);
const dirs = new Map<string, string[]>();
for (const f of repoFiles) {
  const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
  dirs.set(d, [...(dirs.get(d) ?? []), f]);
}

describe("importedPaths", () => {
  it("resolves relative imports and includes per language, and ignores outside packages", () => {
    expect(importedPaths("src/app/main.ts", `import { a } from "./util.js";\nimport h from "./helpers";\nimport x from "../lib/net";\nimport React from "react";`, files, dirs)).toEqual([
      "src/app/util.ts",
      "src/app/helpers/index.ts",
      "src/lib/net.ts",
    ]);
    expect(importedPaths("pkg/core/views.py", "from .models import Order\nfrom .. import utils\nimport os\n", files, dirs)).toEqual(["pkg/core/models.py", "pkg/utils.py"]);
    expect(importedPaths("VM/src/lmem.cpp", `#include "lmem.h"\n#include "lua.h"\n#include "Luau/Common.h"\n#include <string.h>\n`, files, dirs)).toEqual([
      "VM/src/lmem.h",
      "VM/include/lua.h",
      "Common/include/Luau/Common.h",
    ]);
    expect(importedPaths("cmd/server/main.go", `import (\n  "fmt"\n  "example.com/app/internal/store"\n)\n`, files, dirs)).toEqual(["internal/store/store.go"]);
    expect(importedPaths("src/main/java/com/acme/Order.java", "import com.acme.billing.Invoice;\nimport java.util.List;\n", files, dirs)).toEqual(["src/main/java/com/acme/billing/Invoice.java"]);
    expect(importedPaths("crates/x/src/lib.rs", "mod parser;\npub mod ast;\nuse std::fmt;\n", files, dirs)).toEqual(["crates/x/src/parser.rs", "crates/x/src/ast/mod.rs"]);
  });
});

const pr = (path: string, headText: string): PRInput => ({
  number: 1,
  title: "t",
  body: "",
  baseSha: "b",
  headSha: "h",
  files: [{ path, oldPath: path, status: "modified", binary: false, hunks: [], headText }],
});

describe("rankCandidates", () => {
  it("puts imports first, then the same directory, then nearby ones, and skips other languages, vendored code and the PR's files", () => {
    const sized: RepoFile[] = repoFiles.map((path) => ({ path, size: 100 }));
    const order = rankCandidates(pr("src/app/main.ts", `import { x } from "../lib/net";`), sized);
    expect(order[0]).toBe("src/lib/net.ts");
    expect(order.slice(1, 3).sort()).toEqual(["src/app/sibling.ts", "src/app/util.ts"]);
    expect(order).toContain("src/app/helpers/index.ts");
    expect(order).not.toContain("src/app/main.ts");
    expect(order).not.toContain("node_modules/left-pad/index.js");
    expect(order.some((p) => p.endsWith(".py") || p.endsWith(".md"))).toBe(false);
  });
});

describe("remoteContextSource", () => {
  it("searches downloaded files for definitions and uses, and fetches files named after a missing symbol", async () => {
    const texts: Record<string, string> = {
      "src/app/util.ts": "export function clamp(x: number) { return x; }\nexport const used = clamp(1);\n",
      "src/app/sibling.ts": "import { run } from './main';\nrun();\n",
      "src/other/scheduler.ts": "export class Scheduler {}\n",
    };
    const tree = Object.keys(texts).map((path) => ({ path, size: texts[path].length }));
    const reads: string[] = [];
    const src = remoteContextSource(pr("src/app/main.ts", "export function run() { clamp(2); new Scheduler(); }\n"), async () => tree, async (p) => (reads.push(p), texts[p]));
    expect(await src.findDefinitions(["clamp", "Scheduler"])).toEqual(["src/app/util.ts", "src/other/scheduler.ts"]);
    expect(await src.findReferences(["run"])).toEqual(["src/app/sibling.ts"]);
    expect(reads.filter((p) => p === "src/other/scheduler.ts")).toHaveLength(1); // downloaded once, only when asked for
    expect(await src.readFile("src/app/util.ts")).toContain("clamp");
  });

  it("gives no context, without throwing, when the repository can't be listed", async () => {
    const src = remoteContextSource(pr("a.ts", ""), async () => {
      throw new Error("403 rate limit");
    }, async () => undefined);
    expect(await src.findDefinitions(["x"])).toEqual([]);
    expect(await src.findReferences(["x"])).toEqual([]);
  });
});

describe("download budget", () => {
  it("stops at the file and byte limits, keeping the best-ranked files", () => {
    const repo: RepoFile[] = Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.ts`, size: 1000 * (i + 1) }));
    const p = pr("src/main.ts", "");
    expect(rankCandidates(p, repo, { maxFiles: 3 })).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts"]);
    expect(rankCandidates(p, repo, { maxTotalBytes: 6000 })).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts"]); // 1+2+3 kB
  });
});
