// Formatting for the comment box: each command turns the text and selection into Markdown, the way
// GitHub's own comment toolbar does. Pure functions, so the box can apply them and keep undo.

export type Edit = { text: string; start: number; end: number };
export type Format = "bold" | "italic" | "code" | "link" | "quote" | "bullets" | "numbers" | "codeblock";

/** The replacement for the selected range, and where the selection lands afterwards (absolute). */
export type Change = { from: number; to: number; insert: string; selStart: number; selEnd: number };

const wrapWith = (e: Edit, mark: string, placeholder: string): Change => {
  const sel = e.text.slice(e.start, e.end);
  const before = e.text.slice(Math.max(0, e.start - mark.length), e.start);
  const after = e.text.slice(e.end, e.end + mark.length);
  // Already wrapped: unwrap.
  if (sel && before === mark && after === mark) return { from: e.start - mark.length, to: e.end + mark.length, insert: sel, selStart: e.start - mark.length, selEnd: e.end - mark.length };
  if (sel.length > 2 * mark.length && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(mark.length, -mark.length);
    return { from: e.start, to: e.end, insert: inner, selStart: e.start, selEnd: e.start + inner.length };
  }
  // Keep spaces at the edges of the selection outside the marks (`**word** `, not `**word **`).
  const lead = sel.match(/^\s*/)![0];
  const trail = sel.slice(lead.length).match(/\s*$/)![0];
  const core = sel.slice(lead.length, sel.length - trail.length) || placeholder;
  const insert = `${lead}${mark}${core}${mark}${trail}`;
  const s = e.start + lead.length + mark.length;
  return { from: e.start, to: e.end, insert, selStart: s, selEnd: s + core.length };
};

/** The start of the line holding `i` and the end of the line holding `j`. */
const lineSpan = (text: string, i: number, j: number) => {
  const from = text.lastIndexOf("\n", i - 1) + 1;
  const nl = text.indexOf("\n", Math.max(j - (j > i && text[j - 1] === "\n" ? 1 : 0), i));
  return { from, to: nl === -1 ? text.length : nl };
};

const prefixLines = (e: Edit, prefix: (k: number) => string, strip: RegExp): Change => {
  const { from, to } = lineSpan(e.text, e.start, e.end);
  const lines = e.text.slice(from, to).split("\n");
  const all = lines.every((l) => strip.test(l) || !l.trim());
  const out = lines.map((l, k) => (all ? l.replace(strip, "") : l.trim() ? `${prefix(k)}${l}` : l)).join("\n");
  return { from, to, insert: out, selStart: from, selEnd: from + out.length };
};

/** Make sure inserted blocks start and end on their own lines. */
const asBlock = (e: Edit, block: string, cursorAt: number, selectLen = 0): Change => {
  const pre = e.start > 0 && e.text[e.start - 1] !== "\n" ? "\n" : "";
  const post = e.end < e.text.length && e.text[e.end] !== "\n" ? "\n" : "";
  const insert = `${pre}${block}${post}`;
  const s = e.start + pre.length + cursorAt;
  return { from: e.start, to: e.end, insert, selStart: s, selEnd: s + selectLen };
};

export function format(e: Edit, f: Format): Change {
  const sel = e.text.slice(e.start, e.end);
  switch (f) {
    case "bold":
      return wrapWith(e, "**", "bold text");
    case "italic":
      return wrapWith(e, "_", "italic text");
    case "code":
      if (sel.includes("\n")) return format(e, "codeblock");
      return wrapWith(e, "`", "code");
    case "codeblock": {
      const body = sel || "code";
      return asBlock(e, `\`\`\`\n${body}\n\`\`\``, 4, body.length);
    }
    case "link": {
      const label = sel || "link text";
      const insert = `[${label}](url)`;
      // Select the URL to type over (or the label, when there was no selection).
      return sel
        ? { from: e.start, to: e.end, insert, selStart: e.start + label.length + 3, selEnd: e.start + label.length + 6 }
        : { from: e.start, to: e.end, insert, selStart: e.start + 1, selEnd: e.start + 1 + label.length };
    }
    case "quote":
      return prefixLines(e, () => "> ", /^> ?/);
    case "bullets":
      return prefixLines(e, () => "- ", /^[-*] /);
    case "numbers":
      return prefixLines(e, (k) => `${k + 1}. `, /^\d+\. /);
  }
}

/**
 * A GitHub suggestion block replacing the commented lines with `code` (their current text, to edit).
 * GitHub shows it with a button that applies the change.
 */
export function suggestion(e: Edit, code: string): Change {
  return asBlock(e, `\`\`\`suggestion\n${code}\n\`\`\``, 14, code.length);
}

export function apply(e: Edit, c: Change): Edit {
  return { text: e.text.slice(0, c.from) + c.insert + e.text.slice(c.to), start: c.selStart, end: c.selEnd };
}

/** The format a keyboard shortcut asks for (⌘/Ctrl + B, I, E, K, and ⇧ for lists and quotes). */
export function shortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): Format | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const k = e.key.toLowerCase();
  if (!e.shiftKey) return k === "b" ? "bold" : k === "i" ? "italic" : k === "e" ? "code" : k === "k" ? "link" : null;
  return k === "8" || k === "*" ? "bullets" : k === "7" || k === "&" ? "numbers" : k === "." || k === ">" ? "quote" : null;
}
