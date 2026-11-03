// Review comments in the reader: existing threads shown on their lines, new comments posted one at
// a time or collected into a review, all through GitHub's normal review API. Teammates without the
// extension see ordinary review comments.

import {
  atomSnippet,
  commentableLines,
  commentRange,
  createReviewComment,
  diffPlaces,
  inCommentRange,
  fetchReviewComments,
  GitHubError,
  lineKey,
  placeThreads,
  type LineRange,
  replyToReviewComment,
  rowTarget,
  submitReview,
  type NewComment,
  type PRRef,
  type ReviewComment,
  type ReviewEvent,
  type ReviewThread,
  type Side,
} from "@prstory/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { loadSettings } from "../settings";
import type { StoryView } from "./Story";

export const COMMENTS_CSS = `
.diff td.ln { position: relative; }
.cm-add { position: absolute; left: 2px; top: 1px; width: 16px; height: 16px; border-radius: 4px; border: 0; padding: 0; background: var(--accent); color: #fff; font: 600 13px/16px var(--sans); cursor: pointer; opacity: 0; }
.diff tr:hover .cm-add, .cm-add:focus-visible { opacity: 1; }
.diff tr.sel td.code { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.diff tr.sel td.ln { box-shadow: inset 2px 0 0 var(--accent); }
.diff tr.comment-row td { padding: 6px 10px 10px; background: var(--bg); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font: 13.5px/1.5 var(--sans); white-space: normal; color: var(--ink); }
.thread, .cm-form, .cm-draft { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); margin: 6px 0; max-width: 760px; }
.cm { padding: 8px 12px; border-top: 1px solid var(--line); }
.cm:first-child { border-top: 0; }
.cm-meta { font-size: 12px; color: var(--muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cm-meta img { width: 18px; height: 18px; border-radius: 50%; }
.cm-meta b { color: var(--ink); font-weight: 600; }
.cm-meta a { color: var(--muted); }
.cm-body { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
.cm-form { padding: 8px; }
.cm-form textarea { display: block; width: 100%; min-height: 76px; font: 13.5px/1.5 var(--sans); padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); resize: vertical; }
.cm-form textarea:focus { outline: 2px solid color-mix(in srgb, var(--accent) 40%, transparent); border-color: var(--accent); }
.cm-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.cm-actions .hint { margin-right: auto; font-size: 12px; color: var(--muted); }
.cm-btn { font: 13px var(--sans); background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.cm-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.cm-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.cm-btn.primary:hover:not(:disabled) { color: #fff; filter: brightness(1.08); }
.cm-btn:disabled { opacity: .5; cursor: default; }
.cm-btn.link { border: 0; background: none; padding: 0; color: var(--muted); font-size: 12px; }
.cm-reply { padding: 6px 12px 8px; border-top: 1px solid var(--line); }
.cm-reply .cm-form { margin: 0; border: 0; padding: 0; background: none; }
.cm-draft { padding: 8px 12px; border-style: dashed; }
.tag-pending { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; border: 1px solid var(--accent); color: var(--accent); border-radius: 3px; padding: 0 4px; }
.cm-error { color: var(--del-ink); font-size: 12.5px; margin: 6px 0 0; }
.cm-note { font-size: 13px; color: var(--muted); margin: 8px 0 0; }
.cm-note summary { cursor: pointer; }
.cm-note ul { margin: 6px 0 0; padding-left: 18px; }
.cm-note li { margin: 2px 0; }
.review-wrap { position: relative; }
.topbar .review-btn.has { background: var(--accent); border-color: var(--accent); color: #fff; }
.review-panel { position: absolute; right: 0; top: calc(100% + 8px); width: min(440px, calc(100vw - 32px)); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 10px 32px rgba(0,0,0,.2); padding: 12px; z-index: 20; font-size: 13.5px; }
.review-panel h3 { margin: 0 0 6px; font-size: 14px; }
.review-panel textarea { display: block; width: 100%; min-height: 90px; font: 13.5px/1.5 var(--sans); padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); resize: vertical; }
.review-panel fieldset { border: 0; padding: 0; margin: 10px 0 0; display: grid; gap: 6px; }
.review-panel label { display: flex; gap: 8px; align-items: baseline; cursor: pointer; }
.review-panel label small { color: var(--muted); }
.review-panel .done-msg a { font-weight: 600; }
`;

export type Draft = NewComment & { id: string };
/** The open comment box: its range, and the line the selection started on (shift-click extends from there). */
type Composer = LineRange & { path: string; anchor: { side: Side; line: number } };

/** "line 12", "lines 10–12", or "lines −11 to +11" for a range from removed to added lines. */
export function rangeLabel(r: LineRange): string {
  if (r.startLine == null) return `line ${r.line}`;
  const sign = (side: Side) => (side === "LEFT" ? "−" : "+");
  return (r.startSide ?? r.side) === r.side ? `lines ${r.startLine}–${r.line}` : `lines ${sign(r.startSide!)}${r.startLine} to ${sign(r.side)}${r.line}`;
}

type CommentsApi = {
  canComment: (path: string, side: Side, line: number) => boolean;
  threadsAt: (path: string, side: Side, line: number) => ReviewThread[];
  draftsAt: (path: string, side: Side, line: number) => Draft[];
  selected: (path: string, side: Side, line: number) => boolean;
  composer: Composer | null;
  /** Keyboard: open the box on one line, or extend the open one. */
  open: (path: string, side: Side, line: number, extend: boolean) => void;
  /** Mouse down on a line's "+": start a drag selection, or with shift extend the open box. */
  press: (path: string, side: Side, line: number, shift: boolean) => void;
  /** The pointer moved onto a line: extend the selection being dragged. */
  hover: (path: string, side: Side, line: number) => void;
  close: () => void;
  hasToken: boolean;
  postSingle: (body: string) => Promise<void>;
  addDraft: (body: string) => void;
  deleteDraft: (id: string) => void;
  reply: (t: ReviewThread, body: string) => Promise<void>;
  drafts: Draft[];
  submit: (body: string, event: ReviewEvent) => Promise<string>;
  discardDrafts: () => void;
  hidden: ReviewThread[]; // threads not on any line the story shows
  threadCount: number;
  loadError: string | null;
};

const CommentsCtx = createContext<CommentsApi | null>(null);
export const useComments = () => useContext(CommentsCtx);

/** A short, actionable sentence for a failed comment request. */
export function commentError(err: unknown): string {
  if (err instanceof GitHubError) {
    if (err.kind === "rate-limit") return "GitHub's hourly request limit was reached. Try again later, or add a GitHub token in settings.";
    if (err.kind === "forbidden" || err.kind === "not-found")
      return "Your GitHub token can't comment on this pull request. It needs Pull requests: Read and write access to this repository.";
    if (err.kind === "invalid") {
      const d = err.detail ?? err.message;
      return /pending review/i.test(d) ? `${d}. Submit or delete your pending review on GitHub first.` : d;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function useDrafts(key: string): [Draft[], (d: Draft[]) => void] {
  const [drafts, setDrafts] = useState<Draft[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      return [];
    }
  });
  const save = (d: Draft[]) => {
    setDrafts(d);
    try {
      if (d.length) localStorage.setItem(key, JSON.stringify(d));
      else localStorage.removeItem(key);
    } catch {
      // drafts then last only while the reader is open
    }
  };
  return [drafts, save];
}

/** Loads the PR's review comments and holds drafts and the open comment box. `current`: the story covers the PR's head. */
export function CommentsProvider({ prRef, view, current, children }: { prRef: PRRef; view: StoryView; current: boolean; children: React.ReactNode }) {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [drag, setDrag] = useState<Composer | null>(null);
  const [drafts, setDrafts] = useDrafts(`prstory:drafts:${prRef.owner}/${prRef.repo}#${prRef.number}@${view.headSha}`);
  const gh = async () => ({ token: (await loadSettings()).githubToken || undefined });

  const reload = useCallback(async () => {
    try {
      setComments(await fetchReviewComments(prRef, await gh()));
      setLoadError(null);
    } catch (err) {
      setLoadError(commentError(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prRef.owner, prRef.repo, prRef.number]);

  useEffect(() => {
    void reload();
  }, [reload, view.headSha]);

  // The token may be added in the settings tab while the reader is open.
  useEffect(() => {
    const check = () => void loadSettings().then((s) => setHasToken(!!s.githubToken));
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  const commentable = useMemo(() => {
    const s = new Set<string>();
    for (const f of view.pr.files) for (const k of commentableLines(f)) s.add(k);
    return s;
  }, [view.pr]);

  // Lines the story actually shows, to list threads it can't show.
  const visible = useMemo(() => {
    const files = new Map(view.pr.files.map((f) => [f.path, f]));
    const s = new Set<string>();
    for (const a of view.atoms)
      for (const r of atomSnippet(files.get(a.file), a)) {
        const t = rowTarget(r);
        if (t) s.add(lineKey(a.file, t));
      }
    return s;
  }, [view.pr, view.atoms]);

  const { placed, unplaced } = useMemo(() => placeThreads(comments, { headSha: view.headSha, current }), [comments, view.headSha, current]);
  const hidden = useMemo(() => [...unplaced, ...[...placed].filter(([k]) => !visible.has(k)).flatMap(([, ts]) => ts)], [placed, unplaced, visible]);

  const places = useMemo(() => new Map(view.pr.files.map((f) => [f.path, diffPlaces(f)])), [view.pr]);
  const rangeTo = (path: string, anchor: { side: Side; line: number }, to: { side: Side; line: number }): Composer | null => {
    const r = commentRange(places.get(path) ?? new Map(), path, anchor, to);
    return r ? { ...r, path, anchor } : null;
  };

  // A drag ends wherever the mouse is released; the box opens on the selected range.
  useEffect(() => {
    if (!drag) return;
    const up = () => {
      setComposer(drag);
      setDrag(null);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [drag]);

  const target = (c: Composer): Omit<NewComment, "body"> => ({ path: c.path, side: c.side, line: c.line, ...(c.startLine != null ? { startLine: c.startLine, startSide: c.startSide ?? c.side } : {}) });
  const single = (path: string, side: Side, line: number): Composer => ({ path, side, line, anchor: { side, line } });

  const api: CommentsApi = {
    canComment: (path, side, line) => commentable.has(lineKey(path, { side, line })),
    threadsAt: (path, side, line) => placed.get(lineKey(path, { side, line })) ?? [],
    draftsAt: (path, side, line) => drafts.filter((d) => d.path === path && d.side === side && d.line === line),
    selected: (path, side, line) => {
      const c = drag ?? composer;
      return !!c && c.path === path && inCommentRange(places.get(path) ?? new Map(), path, c, { side, line });
    },
    composer,
    open: (path, side, line, extend) => {
      const r = extend && composer?.path === path ? rangeTo(path, composer.anchor, { side, line }) : null;
      setComposer(r ?? single(path, side, line));
    },
    press: (path, side, line, shift) => {
      const r = shift && composer?.path === path ? rangeTo(path, composer.anchor, { side, line }) : null;
      if (r) setComposer(r);
      else setDrag(single(path, side, line));
    },
    hover: (path, side, line) => {
      if (!drag || drag.path !== path) return;
      const r = rangeTo(path, drag.anchor, { side, line });
      if (r && (r.line !== drag.line || r.side !== drag.side || r.startLine !== drag.startLine || r.startSide !== drag.startSide)) setDrag(r);
    },
    close: () => setComposer(null),
    hasToken,
    postSingle: async (body) => {
      if (!composer) return;
      const c = await createReviewComment(prRef, await gh(), view.headSha, { ...target(composer), body });
      setComments((cs) => [...cs, c]);
      setComposer(null);
    },
    addDraft: (body) => {
      if (!composer) return;
      setDrafts([...drafts, { ...target(composer), body, id: `${Date.now()}-${drafts.length}` }]);
      setComposer(null);
    },
    deleteDraft: (id) => setDrafts(drafts.filter((d) => d.id !== id)),
    reply: async (t, body) => {
      const c = await replyToReviewComment(prRef, await gh(), t.root.id, body);
      setComments((cs) => [...cs, c]);
    },
    drafts,
    submit: async (body, event) => {
      const res = await submitReview(prRef, await gh(), { commitId: view.headSha, body, event, comments: drafts.map(({ id: _id, ...c }) => c) });
      setDrafts([]);
      void reload();
      return res.url;
    },
    discardDrafts: () => setDrafts([]),
    hidden,
    threadCount: [...placed.values()].reduce((n, ts) => n + ts.length, unplaced.length),
    loadError,
  };
  return <CommentsCtx.Provider value={api}>{children}</CommentsCtx.Provider>;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [2592000, "month"],
    [31536000, "year"],
  ];
  let [div, name] = units[0];
  for (const u of units) if (s >= u[0]) [div, name] = u;
  const n = Math.floor(s / div);
  return `${n} ${name}${n === 1 ? "" : "s"} ago`;
}

function CommentView({ c }: { c: ReviewComment }) {
  return (
    <div className="cm">
      <div className="cm-meta">
        {c.avatarUrl ? <img src={`${c.avatarUrl}${c.avatarUrl.includes("?") ? "&" : "?"}s=36`} alt="" /> : null}
        <b>{c.user}</b>
        <a href={c.url} target="_blank" rel="noopener">
          {ago(c.createdAt)}
        </a>
      </div>
      <div className="cm-body">{c.body}</div>
    </div>
  );
}

/** A text box with its own busy and error state. `actions` get the text and return when done. */
function Form({
  placeholder,
  actions,
  onCancel,
  hint,
  autoFocus,
}: {
  placeholder: string;
  actions: { label: string; primary?: boolean; run: (text: string) => Promise<void> | void; disabled?: boolean }[];
  onCancel: () => void;
  hint?: React.ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (run: (t: string) => Promise<void> | void) => {
    setBusy(true);
    setError(null);
    try {
      await run(text.trim());
      setText("");
    } catch (err) {
      setError(commentError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cm-form">
      <textarea
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          const primary = actions.find((a) => a.primary);
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && primary && text.trim() && !primary.disabled) {
            e.preventDefault();
            void go(primary.run);
          }
        }}
      />
      {error ? <p className="cm-error">{error}</p> : null}
      <div className="cm-actions">
        {hint ? <span className="hint">{hint}</span> : null}
        <button type="button" className="cm-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {actions.map((a) => (
          <button key={a.label} type="button" className={`cm-btn${a.primary ? " primary" : ""}`} disabled={busy || !text.trim() || a.disabled} onClick={() => void go(a.run)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const openSettings = () => (typeof chrome !== "undefined" && chrome.runtime?.openOptionsPage ? void chrome.runtime.openOptionsPage() : window.open("options.html", "_blank"));

function TokenHint() {
  return (
    <>
      Posting needs a GitHub token with write access.{" "}
      <button type="button" className="cm-btn link" onClick={openSettings}>
        Settings
      </button>
    </>
  );
}

function ThreadView({ t }: { t: ReviewThread }) {
  const cm = useComments()!;
  const [replying, setReplying] = useState(false);
  return (
    <div className="thread">
      <CommentView c={t.root} />
      {t.replies.map((c) => (
        <CommentView key={c.id} c={c} />
      ))}
      <div className="cm-reply">
        {replying ? (
          <Form
            placeholder="Reply…"
            autoFocus
            onCancel={() => setReplying(false)}
            hint={cm.hasToken ? undefined : <TokenHint />}
            actions={[
              {
                label: "Reply",
                primary: true,
                disabled: !cm.hasToken,
                run: async (text) => {
                  await cm.reply(t, text);
                  setReplying(false);
                },
              },
            ]}
          />
        ) : (
          <button type="button" className="cm-btn link" onClick={() => setReplying(true)}>
            Reply…
          </button>
        )}
      </div>
    </div>
  );
}

/** The "+" in a diff row's line-number cell. Shift-click extends the open comment to a range. */
export function CommentButton({ path, side, line }: { path: string; side: Side; line: number }) {
  const cm = useComments();
  if (!cm?.canComment(path, side, line)) return null;
  return (
    <button
      type="button"
      className="cm-add"
      title="Comment on this line. Drag down or up, or shift-click another line, to comment on a range."
      aria-label={`Comment on line ${line}`}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection while dragging
        cm.press(path, side, line, e.shiftKey);
      }}
      // Mouse clicks are handled on mouse down; this is for the keyboard (Enter or Space).
      onClick={(e) => e.detail === 0 && cm.open(path, side, line, e.shiftKey)}
    >
      +
    </button>
  );
}

/** Threads, pending drafts and the comment box for one diff line, as an extra table row. */
export function LineComments({ path, side, line }: { path: string; side: Side; line: number }) {
  const cm = useComments();
  if (!cm) return null;
  const threads = cm.threadsAt(path, side, line);
  const drafts = cm.draftsAt(path, side, line);
  const c = cm.composer;
  const composing = !!c && c.path === path && c.side === side && c.line === line;
  if (!threads.length && !drafts.length && !composing) return null;
  const range = c ? rangeLabel(c) : `line ${line}`;
  return (
    <tr className="comment-row">
      <td colSpan={3}>
        {threads.map((t) => (
          <ThreadView key={t.root.id} t={t} />
        ))}
        {drafts.map((d) => (
          <div className="cm-draft" key={d.id}>
            <div className="cm-meta">
              <span className="tag-pending">Pending</span>
              {d.startLine != null ? <span>{rangeLabel(d)}</span> : null}
              <button type="button" className="cm-btn link" onClick={() => cm.deleteDraft(d.id)}>
                Delete
              </button>
            </div>
            <div className="cm-body">{d.body}</div>
          </div>
        ))}
        {composing ? (
          <Form
            key={`${c.startSide ?? ""}${c.startLine ?? ""}-${c.line}`}
            placeholder={`Comment on ${range}${side === "LEFT" && c.startLine == null ? " (removed)" : ""}…`}
            autoFocus
            onCancel={cm.close}
            hint={cm.hasToken ? undefined : <TokenHint />}
            actions={[
              { label: "Add single comment", disabled: !cm.hasToken, run: cm.postSingle },
              { label: cm.drafts.length ? "Add review comment" : "Start a review", primary: true, run: cm.addDraft },
            ]}
          />
        ) : null}
      </td>
    </tr>
  );
}

/** Topbar button and panel for submitting the pending review. */
export function ReviewButton() {
  const cm = useComments();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneUrl, setDoneUrl] = useState<string | null>(null);
  if (!cm) return null;
  const n = cm.drafts.length;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setDoneUrl(await cm.submit(body.trim(), event));
      setBody("");
    } catch (err) {
      setError(commentError(err));
    } finally {
      setBusy(false);
    }
  };
  const needsBody = event === "REQUEST_CHANGES" || (event === "COMMENT" && n === 0);
  return (
    <span className="review-wrap">
      <button type="button" className={`review-btn${n ? " has" : ""}`} aria-expanded={open} onClick={() => (setOpen(!open), setDoneUrl(null))}>
        {n ? `Finish review (${n})` : "Review"}
      </button>
      {open ? (
        <div className="review-panel" role="dialog" aria-label="Finish your review">
          {doneUrl ? (
            <p className="done-msg">
              Review submitted.{" "}
              <a href={doneUrl} target="_blank" rel="noopener">
                See it on GitHub ↗
              </a>
            </p>
          ) : (
            <>
              <h3>Finish your review</h3>
              <p className="cm-note" style={{ marginTop: 0, marginBottom: 8 }}>
                {n ? `${n} pending comment${n === 1 ? "" : "s"} will be posted with this review.` : "No pending comments. Use + beside a line to add some."}
              </p>
              <textarea value={body} placeholder="Leave a summary (optional for comments and approvals)" onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))} />
              <fieldset>
                {(
                  [
                    ["COMMENT", "Comment", "General feedback without approving"],
                    ["APPROVE", "Approve", "Approve merging these changes"],
                    ["REQUEST_CHANGES", "Request changes", "Feedback that must be addressed before merging"],
                  ] as const
                ).map(([v, label, help]) => (
                  <label key={v}>
                    <input type="radio" name="event" checked={event === v} onChange={() => setEvent(v)} />
                    <span>
                      {label} <small>{help}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              {error ? <p className="cm-error">{error}</p> : null}
              <div className="cm-actions">
                {!cm.hasToken ? (
                  <span className="hint">
                    <TokenHint />
                  </span>
                ) : n ? (
                  <button type="button" className="cm-btn link hint" onClick={() => confirm(`Delete ${n} pending comment${n === 1 ? "" : "s"}?`) && cm.discardDrafts()}>
                    Discard pending
                  </button>
                ) : null}
                <button type="button" className="cm-btn" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="cm-btn primary" disabled={busy || !cm.hasToken || (needsBody && !body.trim())} onClick={() => void submit()}>
                  Submit review
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </span>
  );
}

/** Under the title: how many threads there are, and the ones the story has no line for. */
export function CommentsNote({ prUrl }: { prUrl?: string }) {
  const cm = useComments();
  if (!cm) return null;
  if (cm.loadError) return <p className="cm-note">Couldn't load review comments: {cm.loadError}</p>;
  if (!cm.threadCount) return null;
  const shown = cm.threadCount - cm.hidden.length;
  const label = `${cm.threadCount} review thread${cm.threadCount === 1 ? "" : "s"}${shown && cm.hidden.length ? `, ${shown} shown beside their lines` : shown ? ", shown beside their lines" : ""}`;
  if (!cm.hidden.length) return <p className="cm-note">{label}.</p>;
  return (
    <details className="cm-note">
      <summary>
        {label}; {cm.hidden.length} not in the story (outdated, or on lines it doesn't show)
      </summary>
      <ul>
        {cm.hidden.map((t) => (
          <li key={t.root.id}>
            <a href={t.root.url} target="_blank" rel="noopener">
              {t.path}
              {t.line != null ? `:${t.line}` : ""}
            </a>{" "}
            · {t.root.user}: {t.root.body.length > 90 ? `${t.root.body.slice(0, 90)}…` : t.root.body}
            {t.replies.length ? ` (${t.replies.length} repl${t.replies.length === 1 ? "y" : "ies"})` : ""}
          </li>
        ))}
      </ul>
      {prUrl ? (
        <a href={`${prUrl}/files`} target="_blank" rel="noopener">
          Open the Files view ↗
        </a>
      ) : null}
    </details>
  );
}
