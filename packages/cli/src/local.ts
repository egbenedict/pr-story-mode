import { execFileSync } from "node:child_process";
import { definedOnLine, isGeneratedPath, isLockfile, packForPath, parseUnifiedDiff, type ContextSource, type PRFile, type PRInput } from "@prstory/core";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Build a PR from a local repository: the diff between merge-base(base, head) and head,
 * like GitHub's PR diff, plus base/head versions of the files that need parsing.
 */
export function loadLocalPR(
  repo: string,
  base: string,
  head: string,
  meta: { number?: number; title?: string; body?: string; url?: string; repo?: string } = {},
): PRInput {
  const headSha = git(repo, "rev-parse", head).trim();
  const baseSha = git(repo, "merge-base", base, headSha).trim();
  const diff = git(repo, "diff", "--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/", baseSha, headSha);
  const files: PRFile[] = parseUnifiedDiff(diff);

  const show = (sha: string, path: string): string | undefined => {
    try {
      return git(repo, "show", `${sha}:${path}`);
    } catch {
      return undefined;
    }
  };
  for (const f of files) {
    if (f.binary || !f.hunks.length || !packForPath(f.path) || isLockfile(f.path) || isGeneratedPath(f.path)) continue;
    if (f.status !== "added") f.baseText = show(baseSha, f.oldPath);
    if (f.status !== "removed") f.headText = show(headSha, f.path);
  }

  const subject = git(repo, "log", "-1", "--format=%s", headSha).trim();
  const body = git(repo, "log", "-1", "--format=%b", headSha).trim();
  return {
    number: meta.number ?? 0,
    title: meta.title ?? subject,
    body: meta.body ?? body,
    url: meta.url,
    repo: meta.repo,
    baseSha,
    headSha,
    files,
  };
}

export function listMerges(repo: string, n: number): { sha: string; subject: string; body: string }[] {
  const out = git(repo, "log", "--merges", "--first-parent", `-n${n}`, "--format=%H%x1f%s%x1f%b%x1e");
  return parseLog(out);
}

export function listCommits(repo: string, n: number): { sha: string; subject: string; body: string }[] {
  const out = git(repo, "log", "--no-merges", "--first-parent", `-n${n}`, "--format=%H%x1f%s%x1f%b%x1e");
  return parseLog(out);
}

function parseLog(out: string) {
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body] = r.split("\x1f");
      return { sha, subject, body: body ?? "" };
    });
}

// ---------- context lookups outside the PR ----------

/**
 * Context lookups in a local clone at `sha`, with `git grep`: definitions are found by grepping
 * for the names and keeping lines that look like they define one; references by whole-word match.
 */
export function localContextSource(repo: string, sha: string): ContextSource {
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", ["-C", repo, "-c", "core.quotepath=off", "grep", "-I", ...args, sha, "--"], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return ""; // exit code 1 means no matches
    }
  };
  const grep = (args: string[], symbols: string[]) => (symbols.length ? run(["-w", "-F", ...args, ...symbols.flatMap((s) => ["-e", s])]) : "");
  const stripRev = (line: string) => line.slice(sha.length + 1); // "<sha>:path..." → "path..."
  return {
    async findDefinitions(symbols) {
      const names = symbols.filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
      const wanted = new Set(names);
      const files = new Map<string, number>();
      // Let git keep only lines shaped like a definition of one of the names (much less output than
      // a plain word search for common names), then check each line properly.
      let out = "";
      for (let i = 0; i < names.length; i += 40) {
        const alt = names.slice(i, i + 40).map((n) => n.replace(/\$/g, "\\$")).join("|");
        const end = "([^[:alnum:]_$]|$)";
        out += run([
          "-n", "-E",
          "-e", `(def|class|function|interface|type|enum|struct|union|trait|fn|func|const|let|var|val|namespace|typedef|module|object|record|define)[[:space:]]+(\\([^)]*\\)[[:space:]]*)?([[:alnum:]_$]+(::|\\.))*(${alt})${end}`,
          "-e", `^[A-Za-z_][^=;(]*[^[:alnum:]_$](${alt})[[:space:]]*\\(`,
          "-e", `^[[:space:]]+(public|private|protected|static|final|abstract|override|virtual|inline)[^=;(]*[^[:alnum:]_$](${alt})[[:space:]]*\\(`,
        ]);
      }
      for (const raw of out.split("\n")) {
        if (!raw) continue;
        const m = /^(.*?):(\d+):(.*)$/.exec(stripRev(raw));
        if (!m || m[3].length > 400) continue;
        if (definedOnLine(m[3]).some((n) => wanted.has(n))) files.set(m[1], (files.get(m[1]) ?? 0) + 1);
      }
      return [...files.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
    },
    async findReferences(symbols) {
      return grep(["-l"], symbols).split("\n").filter(Boolean).map(stripRev).slice(0, 200);
    },
    async readFile(path) {
      try {
        return git(repo, "show", `${sha}:${path}`);
      } catch {
        return undefined;
      }
    },
  };
}

/** True when the clone has this commit (so it can serve context for a GitHub PR). */
export function hasCommit(repo: string, sha: string): boolean {
  try {
    git(repo, "cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}
