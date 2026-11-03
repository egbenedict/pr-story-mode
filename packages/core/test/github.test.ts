import { describe, expect, it } from "vitest";
import { commentableLines, commentRange, createReviewComment, renderMarkdown, diffPlaces, inCommentRange, fetchPullRequest, fetchReviewComments, GitHubError, lineKey, linkedIssueNumbers, parseUnifiedDiff, placeThreads, prHeader, rowTarget, submitReview, type PRInput, type ReviewComment } from "../src/index";

describe("linked issues", () => {
  it("finds issues the description fixes, closes or resolves in the same repository", () => {
    const body = [
      "Fixes #12 and closes pallets/flask#13.",
      "Resolves: https://github.com/pallets/flask/issues/14",
      "Related to #15, fixes other/repo#16, see #17.",
      "fixed #12 again",
    ].join("\n");
    expect(linkedIssueNumbers(body, "pallets", "flask")).toEqual([12, 13, 14]);
    expect(linkedIssueNumbers("Fix #1, fix #2, fix #3, fix #4", "o", "r")).toEqual([1, 2, 3]);
    expect(linkedIssueNumbers("prefix #9 is not a keyword", "o", "r")).toEqual([]);
  });

  it("puts linked issues after the description in prompts", () => {
    const pr = { number: 7, title: "T", body: "Body.", issues: [{ number: 12, title: "Crash on empty input", body: "Steps…" }] } as PRInput;
    expect(prHeader(pr)).toBe("# Pull request #7: T\n\nBody.\n\n## Linked issue #12: Crash on empty input\n\nSteps…\n");
  });
});

describe("GitHub ingest", () => {
  const ref = { host: "github.com", owner: "o", repo: "r", number: 5 };
  const diff = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-const a = 1;", "+const a = 2;", ""].join("\n");

  /** A fake GitHub: records each URL, and serves the API and raw host unless told to fail. */
  function fakeGitHub(fail: { raw?: boolean; api?: Response } = {}) {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://raw.githubusercontent.com/")) return fail.raw ? new Response("no", { status: 503 }) : new Response(url.includes("/base/") ? "const a = 1;\n" : "const a = 2;\n");
      if (fail.api) return fail.api;
      const accept = new Headers(init?.headers).get("Accept");
      if (url.endsWith("/pulls/5") && accept?.includes("diff")) return new Response(diff);
      if (url.endsWith("/pulls/5")) return Response.json({ title: "T", body: "", html_url: "u", base: { sha: "b0" }, head: { sha: "head" } });
      if (url.includes("/compare/")) return Response.json({ merge_base_commit: { sha: "base" } });
      if (url.includes("/contents/")) return new Response(url.includes("ref=base") ? "const a = 1;\n" : "const a = 2;\n");
      return new Response("?", { status: 500 });
    }) as typeof fetch;
    return { urls, fetchImpl, api: () => urls.filter((u) => u.startsWith("https://api.github.com/")) };
  }

  it("reads file contents from the raw host without a token, so the API is used only for metadata", async () => {
    const gh = fakeGitHub();
    const pr = await fetchPullRequest(ref, { fetchImpl: gh.fetchImpl });
    expect(pr.files[0]).toMatchObject({ baseText: "const a = 1;\n", headText: "const a = 2;\n" });
    expect(gh.api()).toHaveLength(3);
    expect(gh.urls).toContain("https://raw.githubusercontent.com/o/r/head/src/a.ts");
  });

  it("uses the API for contents with a token, and when the raw host fails", async () => {
    const withToken = fakeGitHub();
    await fetchPullRequest(ref, { fetchImpl: withToken.fetchImpl, token: "t" });
    expect(withToken.urls.some((u) => u.includes("raw.githubusercontent"))).toBe(false);
    expect(withToken.api()).toHaveLength(5);

    const rawDown = fakeGitHub({ raw: true });
    const pr = await fetchPullRequest(ref, { fetchImpl: rawDown.fetchImpl });
    expect(pr.files[0].headText).toBe("const a = 2;\n");
    expect(rawDown.api()).toHaveLength(5);
  });

  it("reports rate limits with the reset time", async () => {
    const limited = new Response('{"message":"API rate limit exceeded for 1.2.3.4."}', { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } });
    const err = await fetchPullRequest(ref, { fetchImpl: fakeGitHub({ api: limited }).fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ status: 403, kind: "rate-limit", resetAt: 1_800_000_000_000 });
    expect(err.message).toMatch(/add a GitHub token/);
  });
});

describe("review comments", () => {
  const ref = { host: "github.com", owner: "o", repo: "r", number: 5 };
  const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -10,3 +10,3 @@", " keep();", "-old();", "+neu();", " tail();", ""].join("\n");
  const file = parseUnifiedDiff(diff)[0];

  it("allows comments only on lines inside the diff's hunks, on the side each line exists", () => {
    const ok = commentableLines(file);
    expect([...ok].map((k) => k.split("\u0000").slice(1).join(":")).sort()).toEqual(["LEFT:10", "LEFT:11", "LEFT:12", "RIGHT:10", "RIGHT:11", "RIGHT:12"]);
    expect(ok.has(lineKey("a.ts", { side: "RIGHT", line: 13 }))).toBe(false);
    expect(rowTarget({ type: "del", text: "", oldLine: 11 })).toEqual({ side: "LEFT", line: 11 });
    expect(rowTarget({ type: "reindent", text: "", oldLine: 4, newLine: 5 })).toEqual({ side: "RIGHT", line: 5 });
    expect(rowTarget({ type: "gap" })).toBeNull();
  });

  it("builds ranges in diff order that can cross from removed to added lines, within one hunk", () => {
    const two = parseUnifiedDiff(diff + ["@@ -40,2 +40,2 @@", "-a();", "+b();", " c();", ""].join("\n"))[0];
    const places = diffPlaces(two);
    const L = (line: number) => ({ side: "LEFT" as const, line });
    const R = (line: number) => ({ side: "RIGHT" as const, line });
    const both = { side: "RIGHT", line: 11, startSide: "LEFT", startLine: 11 };
    expect(commentRange(places, "a.ts", L(11), R(11))).toEqual(both);
    expect(commentRange(places, "a.ts", R(11), L(11))).toEqual(both); // dragged upward
    expect(commentRange(places, "a.ts", R(10), L(11))).toEqual({ side: "LEFT", line: 11, startSide: "LEFT", startLine: 10 });
    expect(commentRange(places, "a.ts", R(12), R(12))).toEqual({ side: "RIGHT", line: 12 });
    expect(commentRange(places, "a.ts", R(10), R(41))).toBeNull(); // another hunk
    expect(commentRange(places, "a.ts", R(10), R(13))).toBeNull(); // outside the diff
    const r = commentRange(places, "a.ts", L(11), R(11))!;
    expect([L(11), R(11), R(10), R(12)].map((at) => inCommentRange(places, "a.ts", r, at))).toEqual([true, true, false, false]);
  });

  const comment = (o: Partial<ReviewComment> & { id: number }): ReviewComment => ({
    path: "a.ts", side: "RIGHT", line: 11, startLine: null, startSide: null, originalLine: 11, originalStartLine: null,
    commitId: "head", originalCommitId: "head", body: "b", user: "u", createdAt: "2026-01-01T00:00:00Z", url: "u", ...o,
  });

  it("groups replies under their thread and places threads for current and older stories", () => {
    const cs = [
      comment({ id: 1 }),
      comment({ id: 2, inReplyTo: 1 }),
      comment({ id: 3, line: null, originalLine: 4, commitId: "old", originalCommitId: "old" }), // outdated
      comment({ id: 4, line: 20, originalLine: 18, commitId: "head", originalCommitId: "old" }), // written on old, moved since
    ];
    const now = placeThreads(cs, { headSha: "head", current: true });
    expect(now.placed.get(lineKey("a.ts", { side: "RIGHT", line: 11 }))![0].replies.map((c) => c.id)).toEqual([2]);
    expect(now.placed.has(lineKey("a.ts", { side: "RIGHT", line: 20 }))).toBe(true);
    expect(now.unplaced.map((t) => t.root.id)).toEqual([3]);

    // A story still at "old": thread 3 and 4 go where they were written; thread 1 (written on head) can't be placed.
    const old = placeThreads(cs, { headSha: "old", current: false });
    expect(old.placed.has(lineKey("a.ts", { side: "RIGHT", line: 4 }))).toBe(true);
    expect(old.placed.has(lineKey("a.ts", { side: "RIGHT", line: 18 }))).toBe(true);
    expect(old.unplaced.map((t) => t.root.id)).toEqual([1]);
  });

  function recorder(response: Response | (() => Response)) {
    const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get("Authorization") });
      return typeof response === "function" ? response() : response;
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const raw = { id: 9, path: "a.ts", side: "RIGHT", line: 12, start_line: 10, start_side: "RIGHT", original_line: 12, original_start_line: 10, commit_id: "head", original_commit_id: "head", body: "Hi", user: { login: "me" }, created_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/o/r/pull/5#discussion_r9" };

  it("posts a multi-line comment and a review with GitHub's field names", async () => {
    const one = recorder(() => Response.json(raw, { status: 201 }));
    const c = await createReviewComment(ref, { token: "t", fetchImpl: one.fetchImpl }, "head", { path: "a.ts", side: "RIGHT", line: 12, startLine: 10, startSide: "RIGHT", body: "Hi" });
    expect(one.calls[0]).toMatchObject({ url: "https://api.github.com/repos/o/r/pulls/5/comments", method: "POST", auth: "Bearer t" });
    expect(one.calls[0].body).toEqual({ commit_id: "head", path: "a.ts", body: "Hi", line: 12, side: "RIGHT", start_line: 10, start_side: "RIGHT" });
    expect(c).toMatchObject({ id: 9, user: "me", line: 12, startLine: 10 });

    const rev = recorder(() => Response.json({ id: 3, html_url: "https://github.com/o/r/pull/5#pullrequestreview-3" }));
    const res = await submitReview(ref, { token: "t", fetchImpl: rev.fetchImpl }, { commitId: "head", body: "Looks good", event: "APPROVE", comments: [{ path: "a.ts", side: "LEFT", line: 11, body: "Why?" }] });
    expect(rev.calls[0].url).toBe("https://api.github.com/repos/o/r/pulls/5/reviews");
    expect(rev.calls[0].body).toEqual({ commit_id: "head", body: "Looks good", event: "APPROVE", comments: [{ path: "a.ts", body: "Why?", line: 11, side: "LEFT" }] });
    expect(res.url).toContain("pullrequestreview-3");
  });

  it("asks for rendered HTML with comments, and renders Markdown in the repository's context", async () => {
    const accepts: string[] = [];
    const list = (async (_: string | URL | Request, init?: RequestInit) => {
      accepts.push(new Headers(init?.headers).get("accept") ?? "");
      return Response.json([{ ...raw, body: "**hi**", body_html: "<p><strong>hi</strong></p>" }]);
    }) as typeof fetch;
    const [c] = await fetchReviewComments(ref, { fetchImpl: list });
    expect(c).toMatchObject({ body: "**hi**", bodyHtml: "<p><strong>hi</strong></p>" });
    expect(accepts).toEqual(["application/vnd.github.full+json"]);

    const md = recorder(() => new Response("<p><em>x</em> <a href=\"https://github.com/o/r/issues/3\">#3</a></p>"));
    expect(await renderMarkdown(ref, { token: "t", fetchImpl: md.fetchImpl }, "_x_ #3")).toContain("<em>x</em>");
    expect(md.calls[0]).toMatchObject({ url: "https://api.github.com/markdown", method: "POST", body: { text: "_x_ #3", mode: "gfm", context: "o/r" } });
  });

  it("pages through comments and explains rejected input", async () => {
    let n = 0;
    const pages = recorder(() => Response.json(n++ === 0 ? Array.from({ length: 100 }, (_, i) => ({ ...raw, id: i + 1 })) : [{ ...raw, id: 101, in_reply_to_id: 1 }]));
    const all = await fetchReviewComments(ref, { fetchImpl: pages.fetchImpl });
    expect(all).toHaveLength(101);
    expect(all[100].inReplyTo).toBe(1);
    expect(pages.calls.map((c) => c.url.split("?")[1])).toEqual(["per_page=100&page=1", "per_page=100&page=2"]);

    const bad = recorder(() => Response.json({ message: "Unprocessable Entity", errors: ["Can not approve your own pull request"] }, { status: 422 }));
    const err = await submitReview(ref, { token: "t", fetchImpl: bad.fetchImpl }, { commitId: "head", body: "", event: "APPROVE", comments: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ kind: "invalid", detail: "Can not approve your own pull request" });
  });
});
