import { parseUnifiedDiff } from "./diff";
import { isGeneratedPath, isLockfile, packForPath } from "./languages";
import type { PRFile, PRInput } from "./types";

export type PRRef = { host: string; owner: string; repo: string; number: number };

/** Parse https://github.com/owner/repo/pull/123 (also GitHub Enterprise hosts). */
export function parsePrUrl(url: string): PRRef | null {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.trim());
  return m ? { host: m[1], owner: m[2], repo: m[3], number: +m[4] } : null;
}

export function defaultApiBase(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

export type GitHubOptions = {
  token?: string;
  apiBase?: string; // GitHub Enterprise Server: https://ghe.example.com/api/v3
  fetchImpl?: typeof fetch;
  concurrency?: number;
};

/**
 * Ingest a PR: metadata, unified diff, and base/head versions of the files that need parsing.
 * The diff is GitHub's three-dot diff, so base files are read at the merge base.
 */
export async function fetchPullRequest(ref: PRRef, opts: GitHubOptions = {}): Promise<PRInput> {
  const api = opts.apiBase ?? defaultApiBase(ref.host);
  const f = opts.fetchImpl ?? fetch;
  const headers = (accept: string): Record<string, string> => ({
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
  });
  const get = async (path: string, accept = "application/vnd.github+json") => {
    const res = await f(`${api}${path}`, { headers: headers(accept) });
    if (!res.ok) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const hint = remaining === "0" ? " (GitHub rate limit reached; set GITHUB_TOKEN)" : "";
      throw new Error(`GitHub ${res.status} for ${path}${hint}: ${(await res.text()).slice(0, 200)}`);
    }
    return res;
  };

  const repoPath = `/repos/${ref.owner}/${ref.repo}`;
  const meta = (await (await get(`${repoPath}/pulls/${ref.number}`)).json()) as {
    title: string;
    body: string | null;
    html_url: string;
    base: { sha: string };
    head: { sha: string };
  };
  const diffText = await (await get(`${repoPath}/pulls/${ref.number}`, "application/vnd.github.diff")).text();
  const compare = (await (await get(`${repoPath}/compare/${meta.base.sha}...${meta.head.sha}?per_page=1`)).json()) as {
    merge_base_commit: { sha: string };
  };
  const mergeBase = compare.merge_base_commit.sha;

  const files: PRFile[] = parseUnifiedDiff(diffText);
  const needsText = (p: string) => !!packForPath(p) && !isLockfile(p) && !isGeneratedPath(p);
  const raw = async (path: string, sha: string) => {
    const enc = path.split("/").map(encodeURIComponent).join("/");
    return (await get(`${repoPath}/contents/${enc}?ref=${sha}`, "application/vnd.github.raw")).text();
  };

  const jobs: (() => Promise<void>)[] = [];
  for (const file of files) {
    if (file.binary || !file.hunks.length || !needsText(file.path)) continue;
    if (file.status !== "added") jobs.push(async () => void (file.baseText = await raw(file.oldPath, mergeBase)));
    if (file.status !== "removed") jobs.push(async () => void (file.headText = await raw(file.path, meta.head.sha)));
  }
  await runLimited(jobs, opts.concurrency ?? 6);

  return {
    number: ref.number,
    title: meta.title,
    body: meta.body ?? "",
    url: meta.html_url,
    repo: `${ref.owner}/${ref.repo}`,
    baseSha: mergeBase,
    headSha: meta.head.sha,
    files,
  };
}

async function runLimited(jobs: (() => Promise<void>)[], limit: number) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}
