import type { ChangeAtom, PRFile } from "./types";

export type SnippetRow =
  | { type: "context" | "del" | "add"; text: string; oldLine?: number; newLine?: number }
  | { type: "gap" };

/**
 * The diff lines of one atom, with up to `context` unchanged lines around them.
 * Changed lines that belong to other atoms are left out (shown as a gap).
 */
export function atomSnippet(file: PRFile | undefined, atom: ChangeAtom, context = 3): SnippetRow[] {
  if (!file) return [];
  const mine = new Set(atom.hunkLines.map((r) => `${r.side}${r.line}`));
  const rows: SnippetRow[] = [];
  for (const h of file.hunks) {
    const keep: boolean[] = h.lines.map((l) =>
      l.type === "del" ? mine.has(`LEFT${l.oldLine}`) : l.type === "add" ? mine.has(`RIGHT${l.newLine}`) : false,
    );
    if (!keep.some(Boolean)) continue;
    const show = h.lines.map((l, i) => {
      if (keep[i]) return true;
      if (l.type !== "context") return false;
      for (let d = 1; d <= context; d++) if (keep[i - d] || keep[i + d]) return true;
      return false;
    });
    let gap = rows.length > 0;
    h.lines.forEach((l, i) => {
      if (!show[i]) {
        gap = true;
        return;
      }
      if (gap && rows.length) rows.push({ type: "gap" });
      gap = false;
      if (l.type === "context") rows.push({ type: "context", text: l.text, oldLine: l.oldLine, newLine: l.newLine });
      else if (l.type === "del") rows.push({ type: "del", text: l.text, oldLine: l.oldLine });
      else rows.push({ type: "add", text: l.text, newLine: l.newLine });
    });
  }
  return rows;
}

/** Plain-text rendering used in prompts: `  12 + code` / `  10 - code`, with head numbers for context. */
export function snippetText(rows: SnippetRow[], maxRows = Infinity): string {
  const out: string[] = [];
  let n = 0;
  for (const r of rows) {
    if (n >= maxRows) {
      out.push(`  … ${rows.length - n} more lines`);
      break;
    }
    n++;
    if (r.type === "gap") out.push("  …");
    else {
      const num = r.type === "del" ? r.oldLine : r.newLine;
      const mark = r.type === "add" ? "+" : r.type === "del" ? "-" : " ";
      out.push(`${String(num).padStart(5)} ${mark} ${r.text}`);
    }
  }
  return out.join("\n");
}

export function atomLabel(atom: ChangeAtom): string {
  const sym = atom.symbolPath.filter((s) => !s.startsWith("<")).join(".");
  if (atom.symbolPath.includes("<imports>")) return `${atom.file} imports`;
  return sym ? `${atom.file} › ${sym}` : atom.file;
}

export function lineCounts(atom: ChangeAtom): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const r of atom.hunkLines) r.side === "RIGHT" ? add++ : del++;
  return { add, del };
}
