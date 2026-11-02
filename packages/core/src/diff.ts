import type { DiffLineRef, FileDiff, FileStatus, Hunk } from "./types";

/**
 * Parse `git diff` / GitHub `.diff` output into per-file hunks.
 * Handles new, deleted, renamed and binary files and "\ No newline at end of file" markers.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split("\n");
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const finish = () => {
    if (file) files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      finish();
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      const a = m ? unquote(m[1]) : "";
      const b = m ? unquote(m[2]) : "";
      file = { path: b, oldPath: a, status: "modified", binary: false, hunks: [] };
      continue;
    }
    if (!file) continue;
    const f: FileDiff = file;

    if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line === "")) {
      // Inside a hunk. An empty line can be a context line whose leading space was stripped,
      // but only while the hunk still expects lines.
      const h: Hunk = hunk;
      const remainingOld = h.oldStart + h.oldLines - oldLine;
      const remainingNew = h.newStart + h.newLines - newLine;
      if (remainingOld <= 0 && remainingNew <= 0) {
        hunk = null;
      } else if (line.startsWith("+")) {
        h.lines.push({ type: "add", text: line.slice(1), newLine: newLine++ });
        continue;
      } else if (line.startsWith("-")) {
        h.lines.push({ type: "del", text: line.slice(1), oldLine: oldLine++ });
        continue;
      } else {
        h.lines.push({ type: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
        continue;
      }
    }

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
      if (!m) continue;
      hunk = {
        oldStart: +m[1],
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3],
        newLines: m[4] === undefined ? 1 : +m[4],
        header: m[5] ?? "",
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      f.hunks.push(hunk);
      continue;
    }

    if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "removed";
    else if (line.startsWith("rename from ")) {
      f.oldPath = line.slice("rename from ".length);
      f.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      f.path = line.slice("rename to ".length);
      f.status = "renamed";
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") f.binary = true;
    else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") f.oldPath = stripPrefix(p, "a/");
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") f.path = stripPrefix(p, "b/");
    }
  }
  finish();

  for (const f of files) {
    if (f.status === "removed") f.path = f.oldPath;
    if (f.status === "added") f.oldPath = f.path;
    if (f.status === "modified" && f.oldPath !== f.path) f.status = "renamed" as FileStatus;
  }
  return files;
}

function stripPrefix(p: string, prefix: string): string {
  p = unquote(p.replace(/\t.*$/, ""));
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
  }
  return s;
}

/** Every changed line in a file, as diff line refs. */
export function changedLines(file: FileDiff): DiffLineRef[] {
  const out: DiffLineRef[] = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type === "del") out.push({ side: "LEFT", line: l.oldLine });
      else if (l.type === "add") out.push({ side: "RIGHT", line: l.newLine });
    }
  }
  return out;
}

export function lineKey(file: string, ref: DiffLineRef): string {
  return `${file}\u0000${ref.side}\u0000${ref.line}`;
}
