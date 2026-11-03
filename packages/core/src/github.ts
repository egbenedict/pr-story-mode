import { parseUnifiedDiff } from "./diff";
import { isGeneratedPath, isLockfile, packForPath } from "./languages";
import { remoteContextSource, type RemoteContextOptions } from "./remote-context";
import type { PRFile, PRInput, Side } from "./types";

export type PRRef = { host: string; owner: string; repo: string; number: number };

/** Parse https://github.com/owner/repo/pull/123 (also GitHub Enterprise hosts). */
export function parsePrUrl(url: string): PRRef | null {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.trim());
  return m ? { host: m[1], owner: m[2], repo: m[3], number: +m[4] } : null;
}

export function defaultApiBase(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

/**
 * Issue numbers the description says the PR fixes, closes or resolves ("Fixes #12",
 * "closes owner/repo#3", "Resolves https://github.com/owner/repo/issues/9"), same repository only.
 */
export function linkedIssueNumbers(body: string, owner: string, repo: string, max = 3): number[] {
  const out: number[] = [];
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:https?:\/\/[^/\s]+\/([\w.-]+)\/([\w.-]+)\/issues\/|(?:([\w.-]+)\/([\w.-]+))?#)(\d+)/gi;
  for (const m of body.matchAll(re)) {
    const o = m[1] ?? m[3];
    const r = m[2] ?? m[4];
    if (o && (o.toLowerCase() !== owner.toLowerCase() || r!.toLowerCase() !== repo.toLowerCase())) continue;
    const n = +m[5];
    if (!out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

export type GitHubOptions = {
  token?: string;
  apiBase?: string; // GitHub Enterprise Server: https://ghe.example.com/api/v3
  fetchImpl?: typeof fetch;
  concurrency?: number;
  /**
   * Where file contents come from without a token. GitHub's REST API allows 60 requests an hour
   * without one, and a story needs two per changed file, so by default github.com files are read
   * from raw.githubusercontent.com, which has its own, much higher limit.
   */
  rawBase?: string | null;
};

export const RAW_BASE = "https://raw.githubusercontent.com";

/** A failed GitHub request. `kind` lets callers explain rate limits, missing repositories and rejected input. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "rate-limit" | "not-found" | "forbidden" | "invalid" | "other",
    /** When the rate limit resets (ms since epoch), if GitHub said. */
    readonly resetAt?: number,
    /** GitHub's own explanation, e.g. "Can not approve your own pull request". */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** GitHub's error body → one readable sentence: its message plus any per-field errors. */
function githubDetail(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { message?: string; errors?: (string | { message?: string; code?: string; field?: string })[] };
    const extra = (j.errors ?? []).map((e) => (typeof e === "string" ? e : (e.message ?? [e.field, e.code].filter(Boolean).join(" ")))).filter(Boolean);
    // GitHub's own message is a generic status ("Validation Failed") when the errors say what went wrong.
    const generic = !!extra.length && /^(Unprocessable Entity|Validation Failed)$/i.test(j.message ?? "");
    return [generic ? undefined : j.message, ...extra].filter(Boolean).join(": ") || undefined;
  } catch {
    return undefined;
  }
}

/** A request against the REST API that throws a GitHubError, mentioning rate limits. */
function githubRequester(ref: PRRef, opts: GitHubOptions) {
  const api = opts.apiBase ?? defaultApiBase(ref.host);
  const f = opts.fetchImpl ?? fetch;
  return async (method: "GET" | "POST", path: string, o: { accept?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {
      Accept: o.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    const res = await f(`${api}${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    if (!res.ok) {
      const text = await res.text();
      const body = text.slice(0, 300);
      const rateLimited = res.headers.get("x-ratelimit-remaining") === "0" || ((res.status === 403 || res.status === 429) && /rate limit/i.test(body));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const kind = rateLimited ? "rate-limit" : res.status === 404 ? "not-found" : res.status === 401 || res.status === 403 ? "forbidden" : res.status === 422 ? "invalid" : "other";
      const hint = kind === "rate-limit" ? " (GitHub rate limit reached; add a GitHub token)" : kind === "not-found" ? " (private repository? add a GitHub token)" : "";
      throw new GitHubError(`GitHub ${res.status} for ${method === "GET" ? "" : `${method} `}${path}${hint}: ${body}`, res.status, kind, reset > 0 ? reset * 1000 : undefined, githubDetail(text));
    }
    return res;
  };
}

/** A GET against the REST API (see githubRequester). */
function githubGetter(ref: PRRef, opts: GitHubOptions) {
  const req = githubRequester(ref, opts);
  return (path: string, accept?: string) => req("GET", path, { accept });
}

/** Just the PR's current head commit and title: one request, for cache checks. */
export async function fetchPullHead(ref: PRRef, opts: GitHubOptions = {}): Promise<{ headSha: string; title: string }> {
  const get = githubGetter(ref, opts);
  const meta = (await (await get(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`)).json()) as { title: string; head: { sha: string } };
  return { headSha: meta.head.sha, title: meta.title };
}

/**
 * Ingest a PR: metadata, unified diff, and base/head versions of the files that need parsing.
 * The diff is GitHub's three-dot diff, so base files are read at the merge base.
 */
export async function fetchPullRequest(ref: PRRef, opts: GitHubOptions = {}): Promise<PRInput> {
  const get = githubGetter(ref, opts);

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
  const raw = fileReader(ref, opts);

  const jobs: (() => Promise<void>)[] = [];
  for (const file of files) {
    if (file.binary || !file.hunks.length || !needsText(file.path)) continue;
    if (file.status !== "added") jobs.push(async () => void (file.baseText = await raw(file.oldPath, mergeBase)));
    if (file.status !== "removed") jobs.push(async () => void (file.headText = await raw(file.path, meta.head.sha)));
  }
  await runLimited(jobs, opts.concurrency ?? 6);

  // Linked issues give the "why"; a failure here never blocks the story.
  const issues: NonNullable<PRInput["issues"]> = [];
  for (const n of linkedIssueNumbers(meta.body ?? "", ref.owner, ref.repo)) {
    try {
      const i = (await (await get(`${repoPath}/issues/${n}`)).json()) as { title: string; body: string | null; html_url: string; pull_request?: unknown };
      if (!i.pull_request) issues.push({ number: n, title: i.title, body: i.body ?? "", url: i.html_url });
    } catch {
      // skip
    }
  }

  return {
    number: ref.number,
    title: meta.title,
    body: meta.body ?? "",
    url: meta.html_url,
    repo: `${ref.owner}/${ref.repo}`,
    baseSha: mergeBase,
    headSha: meta.head.sha,
    files,
    ...(issues.length ? { issues } : {}),
  };
}

/**
 * Reads a file at a commit. Without a token on github.com it uses the raw host, which doesn't count
 * against the API's hourly limit, and falls back to the contents API when that fails.
 */
function fileReader(ref: PRRef, opts: GitHubOptions) {
  const get = githubGetter(ref, opts);
  const rawBase = opts.rawBase === undefined ? (!opts.token && !opts.apiBase && ref.host === "github.com" ? RAW_BASE : null) : opts.rawBase;
  const f = opts.fetchImpl ?? fetch;
  return async (path: string, sha: string) => {
    const enc = path.split("/").map(encodeURIComponent).join("/");
    if (rawBase) {
      // Falls back to the API when the raw host fails (blocked network, odd paths).
      const res = await f(`${rawBase}/${ref.owner}/${ref.repo}/${sha}/${enc}`).catch(() => null);
      if (res?.ok) return res.text();
    }
    return (await get(`/repos/${ref.owner}/${ref.repo}/contents/${enc}?ref=${sha}`, "application/vnd.github.raw")).text();
  };
}

/**
 * Context from unchanged files of the PR's repository at its head commit, without a clone: one API
 * request lists the repository, then likely files are read (see remoteContextSource).
 */
export function githubContextSource(ref: PRRef, opts: GitHubOptions, pr: PRInput, ctx: RemoteContextOptions = {}) {
  const get = githubGetter(ref, opts);
  const raw = fileReader(ref, opts);
  return remoteContextSource(
    pr,
    async () => {
      const res = await get(`/repos/${ref.owner}/${ref.repo}/git/trees/${pr.headSha}?recursive=1`);
      const j = (await res.json()) as { tree?: { path: string; type: string; size?: number }[] };
      return (j.tree ?? []).filter((t) => t.type === "blob").map((t) => ({ path: t.path, size: t.size ?? 0 }));
    },
    (path) => raw(path, pr.headSha),
    ctx,
  );
}

async function runLimited(jobs: (() => Promise<void>)[], limit: number) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

// ---------------------------------------------------------------------------
// Review comments. Lines are GitHub's: `side` LEFT is the base file, RIGHT the head file, and a
// comment can only go on a line inside one of the diff's hunks (see commentableLines).

export type ReviewComment = {
  id: number;
  inReplyTo?: number;
  path: string;
  side: Side;
  line: number | null; // null when the comment is outdated
  startLine: number | null;
  startSide: Side | null;
  originalLine: number | null;
  originalStartLine: number | null;
  commitId: string;
  originalCommitId: string;
  body: string;
  /** The body as GitHub renders it (sanitized by GitHub; sanitize again before showing it). */
  bodyHtml?: string;
  user: string;
  avatarUrl?: string;
  createdAt: string;
  url: string;
};

/** A comment to place: the line it ends on, and optionally the line a multi-line comment starts on. */
export type NewComment = { path: string; side: Side; line: number; startLine?: number; startSide?: Side; body: string };

type RawComment = {
  id: number;
  in_reply_to_id?: number;
  path: string;
  side?: Side;
  line?: number | null;
  start_line?: number | null;
  start_side?: Side | null;
  original_line?: number | null;
  original_start_line?: number | null;
  commit_id: string;
  original_commit_id: string;
  body: string;
  body_html?: string;
  user?: { login: string; avatar_url?: string } | null;
  created_at: string;
  html_url: string;
};

function toComment(c: RawComment): ReviewComment {
  return {
    id: c.id,
    ...(c.in_reply_to_id ? { inReplyTo: c.in_reply_to_id } : {}),
    path: c.path,
    side: c.side ?? "RIGHT",
    line: c.line ?? null,
    startLine: c.start_line ?? null,
    startSide: c.start_side ?? null,
    originalLine: c.original_line ?? null,
    originalStartLine: c.original_start_line ?? null,
    commitId: c.commit_id,
    originalCommitId: c.original_commit_id,
    body: c.body,
    ...(c.body_html ? { bodyHtml: c.body_html } : {}),
    user: c.user?.login ?? "ghost",
    ...(c.user?.avatar_url ? { avatarUrl: c.user.avatar_url } : {}),
    createdAt: c.created_at,
    url: c.html_url,
  };
}

const commentFields = (c: NewComment) => ({
  path: c.path,
  body: c.body,
  line: c.line,
  side: c.side,
  ...(c.startLine != null && c.startLine !== c.line ? { start_line: c.startLine, start_side: c.startSide ?? c.side } : {}),
});

/** Ask for comments with both the Markdown body and GitHub's rendered HTML. */
const FULL = "application/vnd.github.full+json";

/**
 * Markdown rendered the way GitHub renders comments (issue links, mentions and code in this
 * repository resolve). The HTML is GitHub's; sanitize it before showing it.
 */
export async function renderMarkdown(ref: PRRef, opts: GitHubOptions, text: string): Promise<string> {
  const req = githubRequester(ref, opts);
  const res = await req("POST", "/markdown", { accept: "text/html", body: { text, mode: "gfm", context: `${ref.owner}/${ref.repo}` } });
  return res.text();
}

/** Every review comment on the PR (up to 1,000), oldest first. */
export async function fetchReviewComments(ref: PRRef, opts: GitHubOptions = {}): Promise<ReviewComment[]> {
  const get = githubGetter(ref, opts);
  const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const out: RawComment[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = (await (await get(`${base}/comments?per_page=100&page=${page}`, FULL)).json()) as RawComment[];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.map(toComment);
}

/** Post one comment right away (GitHub's "Add single comment"). */
export async function createReviewComment(ref: PRRef, opts: GitHubOptions, commitId: string, c: NewComment): Promise<ReviewComment> {
  const req = githubRequester(ref, opts);
  const res = await req("POST", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`, { accept: FULL, body: { commit_id: commitId, ...commentFields(c) } });
  return toComment((await res.json()) as RawComment);
}

/** Reply in an existing thread; `commentId` is the thread's first comment. */
export async function replyToReviewComment(ref: PRRef, opts: GitHubOptions, commentId: number, body: string): Promise<ReviewComment> {
  const req = githubRequester(ref, opts);
  const res = await req("POST", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${commentId}/replies`, { accept: FULL, body: { body } });
  return toComment((await res.json()) as RawComment);
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** Submit a whole review in one request: a summary, its line comments, and the verdict. */
export async function submitReview(
  ref: PRRef,
  opts: GitHubOptions,
  review: { commitId: string; body: string; event: ReviewEvent; comments: NewComment[] },
): Promise<{ id: number; url: string }> {
  const req = githubRequester(ref, opts);
  const res = await req("POST", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, {
    body: { commit_id: review.commitId, body: review.body, event: review.event, comments: review.comments.map(commentFields) },
  });
  const j = (await res.json()) as { id: number; html_url: string };
  return { id: j.id, url: j.html_url };
}
