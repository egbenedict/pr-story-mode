import { execFileSync } from "node:child_process";
import { isGeneratedPath, isLockfile, packForPath, parseUnifiedDiff, type PRFile, type PRInput } from "@prstory/core";

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
