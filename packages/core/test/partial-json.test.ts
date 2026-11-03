import { describe, expect, it } from "vitest";
import { partialStrings, streamedArray } from "../src/index";

describe("reading streamed JSON", () => {
  const full = JSON.stringify({ steps: [{ step: 1, beats: [{ text: 'Say "hi" {not a brace}', cites: [] }] }, { step: 2, beats: [{ text: "Line one.\nLine two", cites: [] }, { text: "More" }] }] });

  it("returns the array items that are complete, at every point of the stream", () => {
    const cut = full.indexOf('{"step":2') + 30;
    const { items, partial } = streamedArray(full.slice(0, cut), "steps");
    expect(items).toEqual([{ step: 1, beats: [{ text: 'Say "hi" {not a brace}', cites: [] }] }]);
    expect(partial).toBe(full.slice(full.indexOf('{"step":2'), cut));
    expect(streamedArray(full, "steps")).toEqual({ items: JSON.parse(full).steps, partial: null });
    expect(streamedArray('{"summary":"x","st', "steps")).toEqual({ items: [], partial: null });
    for (let i = 0; i < full.length; i++) expect(() => streamedArray(full.slice(0, i), "steps")).not.toThrow();
  });

  it("decodes the strings written so far, including one cut off mid-escape", () => {
    const part = full.slice(full.indexOf('{"step":2'));
    expect(partialStrings(part, "text")).toEqual(["Line one.\nLine two", "More"]);
    expect(partialStrings('{"text":"Line one.\\nLine t', "text")).toEqual(["Line one.\nLine t"]);
    expect(partialStrings('{"text":"cut \\', "text")).toEqual(["cut "]);
    expect(partialStrings('{"text":"cut \\u00', "text")).toEqual(["cut "]);
    expect(partialStrings('{"summary":"Adds `clamp` and', "summary")).toEqual(["Adds `clamp` and"]);
  });
});
