import { lineKey } from "./diff";
import type { ReviewComment } from "./github";
import type { SnippetRow } from "./snippet";
import type { FileDiff, Side } from "./types";

/**
 * The lines GitHub accepts comments on, as `lineKey`s: every line inside one of the file's hunks, removed lines
 * on the LEFT, added lines on the RIGHT, and unchanged hunk lines on either side.
 */
export function commentableLines(file: FileDiff | undefined): Set<string> {
  const out = new Set<string>();
  if (!file) return out;
  for (const h of file.hunks)
    for (const l of h.lines) {
      if (l.type !== "add") out.add(lineKey(file.path, { side: "LEFT", line: l.oldLine }));
      if (l.type !== "del") out.add(lineKey(file.path, { side: "RIGHT", line: l.newLine }));
    }
  return out;
}

/** Where a comment on this reader row goes: removed lines on the base side, everything else on the head side. */
export function rowTarget(r: SnippetRow): { side: Side; line: number } | null {
  if (r.type === "gap") return null;
  if (r.type === "del") return r.oldLine != null ? { side: "LEFT", line: r.oldLine } : null;
  return r.newLine != null ? { side: "RIGHT", line: r.newLine } : null;
}

export type ReviewThread = {
  root: ReviewComment;
  replies: ReviewComment[];
  path: string;
  side: Side;
  /** The line the thread ends on in the story's diff, or null when it can't be placed. */
  line: number | null;
  startLine: number | null;
};

/**
 * Group comments into threads and place each one on a line of the story's diff, keyed by `lineKey`.
 *
 * When the story covers the PR's current head, GitHub's `line` applies directly. When the story
 * is older, a thread is placed by its original line only if it was written on the story's commit;
 * anything else (outdated, or written on a newer commit) is returned in `unplaced`.
 */
export function placeThreads(comments: ReviewComment[], story: { headSha: string; current: boolean }): { placed: Map<string, ReviewThread[]>; unplaced: ReviewThread[] } {
  const roots = new Map<number, ReviewThread>();
  for (const c of comments) if (!c.inReplyTo) roots.set(c.id, { root: c, replies: [], path: c.path, side: c.side, line: null, startLine: null });
  for (const c of comments) if (c.inReplyTo) roots.get(c.inReplyTo)?.replies.push(c);

  const placed = new Map<string, ReviewThread[]>();
  const unplaced: ReviewThread[] = [];
  for (const t of roots.values()) {
    const c = t.root;
    if (story.current && c.line != null) {
      t.line = c.line;
      t.startLine = c.startLine;
    } else if (c.commitId === story.headSha && c.line != null) {
      t.line = c.line;
      t.startLine = c.startLine;
    } else if (c.originalCommitId === story.headSha && c.originalLine != null) {
      t.line = c.originalLine;
      t.startLine = c.originalStartLine;
    }
    if (t.line == null) {
      unplaced.push(t);
      continue;
    }
    const k = lineKey(t.path, { side: t.side, line: t.line });
    placed.set(k, [...(placed.get(k) ?? []), t]);
  }
  return { placed, unplaced };
}
