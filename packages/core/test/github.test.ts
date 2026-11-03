import { describe, expect, it } from "vitest";
import { fetchPullRequest, GitHubError, linkedIssueNumbers, prHeader, type PRInput } from "../src/index";

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
