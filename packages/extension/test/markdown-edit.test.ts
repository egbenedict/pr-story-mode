import { describe, expect, it } from "vitest";
import { apply, format, shortcut, suggestion, type Edit, type Format } from "../src/reader/markdown-edit";

/** `[` and `]` mark the selection in these strings. */
const at = (s: string): Edit => {
  const start = s.indexOf("[");
  const end = s.indexOf("]") - 1;
  return { text: s.replace("[", "").replace("]", ""), start, end };
};
const show = (e: Edit) => e.text.slice(0, e.start) + "[" + e.text.slice(e.start, e.end) + "]" + e.text.slice(e.end);
const run = (s: string, f: Format) => show(apply(at(s), format(at(s), f)));

describe("comment formatting", () => {
  it("wraps the selection, keeps edge spaces outside, and unwraps again", () => {
    expect(run("make [this ]bold", "bold")).toBe("make **[this]** bold");
    expect(run("make **[this]** bold", "bold")).toBe("make [this] bold");
    expect(run("make [**this**] bold", "bold")).toBe("make [this] bold");
    expect(run("an [aside]", "italic")).toBe("an _[aside]_");
    expect(run("call [fn()]", "code")).toBe("call `[fn()]`");
    expect(run("x []", "bold")).toBe("x **[bold text]**");
  });

  it("turns a multi-line selection into a code block on its own lines", () => {
    expect(run("see [a\nb] here", "code")).toBe("see \n```\n[a\nb]\n```\n here");
  });

  it("makes links, selecting what to type next", () => {
    expect(run("read [the docs]", "link")).toBe("read [the docs]([url])");
    expect(run("read []", "link")).toBe("read [[link text]](url)");
  });

  it("prefixes whole lines for quotes and lists, and toggles them off", () => {
    expect(run("one\nt[wo\nthr]ee", "quote")).toBe("one\n[> two\n> three]");
    expect(run("[> two\n> three]", "quote")).toBe("[two\nthree]");
    expect(run("[a\n\nb]", "bullets")).toBe("[- a\n\n- b]");
    expect(run("[a\nb\nc]", "numbers")).toBe("[1. a\n2. b\n3. c]");
  });

  it("writes a suggestion block with the lines' current code selected", () => {
    const e = at("Use the cap here:[]");
    expect(show(apply(e, suggestion(e, "  return min(v, 10);")))).toBe("Use the cap here:\n```suggestion\n[  return min(v, 10);]\n```");
  });

  it("maps the keyboard shortcuts", () => {
    const k = (key: string, shiftKey = false) => shortcut({ key, metaKey: true, ctrlKey: false, shiftKey });
    expect([k("b"), k("i"), k("e"), k("k"), k("8", true), k("7", true), k(".", true)]).toEqual(["bold", "italic", "code", "link", "bullets", "numbers", "quote"]);
    expect(shortcut({ key: "b", metaKey: false, ctrlKey: false, shiftKey: false })).toBeNull();
  });
});
