import { describe, expect, it } from "vitest";
import { changedLines, parseUnifiedDiff } from "../src/diff";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function top() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;

 export { a };
@@ -10,2 +11,2 @@
-old
+new
\\ No newline at end of file
diff --git a/new.py b/new.py
new file mode 100644
index 000..333
--- /dev/null
+++ b/new.py
@@ -0,0 +1,2 @@
+def f():
+    return 1
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 444..000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
diff --git a/img.png b/img.png
index 555..666 100644
Binary files a/img.png and b/img.png differ
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(DIFF);

  it("finds every file with the right status", () => {
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["src/a.ts", "modified", false],
      ["new.py", "added", false],
      ["gone.txt", "removed", false],
      ["new/name.ts", "renamed", false],
      ["img.png", "modified", true],
    ]);
    expect(files[3].oldPath).toBe("old/name.ts");
  });

  it("numbers lines on both sides", () => {
    const a = files[0];
    expect(a.hunks).toHaveLength(2);
    expect(a.hunks[0].header).toBe("function top() {");
    expect(changedLines(a)).toEqual([
      { side: "LEFT", line: 2 },
      { side: "RIGHT", line: 2 },
      { side: "RIGHT", line: 3 },
      { side: "LEFT", line: 10 },
      { side: "RIGHT", line: 11 },
    ]);
  });

  it("keeps empty context lines inside a hunk", () => {
    const ctx = files[0].hunks[0].lines.filter((l) => l.type === "context");
    expect(ctx.map((l) => l.text)).toEqual(["const a = 1;", "", "export { a };"]);
  });

  it("handles added and removed files", () => {
    expect(changedLines(files[1])).toEqual([
      { side: "RIGHT", line: 1 },
      { side: "RIGHT", line: 2 },
    ]);
    expect(changedLines(files[2])).toEqual([{ side: "LEFT", line: 1 }]);
  });
});
