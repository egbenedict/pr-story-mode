import { describe, expect, it } from "vitest";
import { linkPhrases } from "../src/links";
import type { Citation } from "../src/types";

const cite = (phrase?: string): Citation => ({ atomId: "a1", lines: [1, 2], ...(phrase ? { phrase } : {}) });

describe("linkPhrases", () => {
  it("links each citation's phrase where it appears", () => {
    const parts = linkPhrases("Here we count matches with `memchr`, then store each piece.", [cite("count matches with `memchr`"), cite("store each piece")], new Set());
    expect(parts).toEqual([
      { text: "Here we " },
      { text: "count matches with `memchr`", cite: 0 },
      { text: ", then " },
      { text: "store each piece", cite: 1 },
      { text: "." },
    ]);
  });

  it("skips phrases that are missing, cut through a code span, or overlap another link", () => {
    const used = new Set<number>();
    const parts = linkPhrases("We call `split_once` and then `split_once` again.", [cite("nowhere"), cite("split_once"), cite("call `split_once`"), cite("`split_once` and")], used);
    // "split_once" only appears inside code spans; "`split_once` and" overlaps the link before it.
    expect(parts.filter((p) => p.cite !== undefined)).toEqual([{ text: "call `split_once`", cite: 2 }]);
    expect([...used]).toEqual([2]);
  });

  it("links a citation once across paragraphs", () => {
    const used = new Set<number>();
    linkPhrases("First we check `n`.", [cite("check `n`")], used);
    expect(linkPhrases("Then we check `n` again.", [cite("check `n`")], used)).toEqual([{ text: "Then we check `n` again." }]);
  });
});
