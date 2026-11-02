import { describe, expect, it } from "vitest";
import { linkedIssueNumbers, prHeader, type PRInput } from "../src/index";

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
