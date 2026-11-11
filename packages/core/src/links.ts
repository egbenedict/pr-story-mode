import type { Citation } from "./types";

/** A piece of model text: plain, or linked to the citation at index `cite`. */
export type TextPart = { text: string; cite?: number };

/**
 * Split one paragraph of model text into plain parts and parts linked to citations, by each
 * citation's `phrase`. A citation links at most once: `used` carries the ones placed in earlier
 * paragraphs and gains the ones placed here. A phrase that would cut through a `code` span, or
 * overlap another link, is skipped; its citation stays unplaced (readers show it as a chip).
 */
export function linkPhrases(text: string, cites: Citation[], used: Set<number>): TextPart[] {
  const spans: { start: number; end: number; cite: number }[] = [];
  const ticks = (s: string) => (s.match(/`/g) ?? []).length;
  cites.forEach((c, i) => {
    const phrase = c.phrase?.trim();
    if (used.has(i) || !phrase) return;
    for (let from = 0; ; ) {
      const at = text.indexOf(phrase, from);
      if (at < 0) return;
      const end = at + phrase.length;
      if (ticks(text.slice(0, at)) % 2 === 0 && ticks(phrase) % 2 === 0 && !spans.some((s) => at < s.end && end > s.start)) {
        spans.push({ start: at, end, cite: i });
        used.add(i);
        return;
      }
      from = at + 1;
    }
  });
  spans.sort((a, b) => a.start - b.start);
  const out: TextPart[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start > pos) out.push({ text: text.slice(pos, s.start) });
    out.push({ text: text.slice(s.start, s.end), cite: s.cite });
    pos = s.end;
  }
  if (pos < text.length || !out.length) out.push({ text: text.slice(pos) });
  return out;
}
