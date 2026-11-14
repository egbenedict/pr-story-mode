// "Ask about this code": select lines in a step's code and ask the model to walk you through them.
// The answer streams into a panel under the last selected line, with line references that
// highlight code, follow-up questions, a stop button and what it cost. Answers are private (never
// posted to GitHub) and saved in this browser per PR.

import {
  aroundSelection,
  askAboutCode,
  atomSnippet,
  buildAskRequest,
  findDefinitions,
  parseAnswer,
  remapSelection,
  rowNumber,
  type AnswerPart,
  type AskContext,
  type AskSelection,
  type ContextSource,
  type LLMProvider,
  type Usage,
} from "@prstory/core";
import { estimateCost } from "@prstory/providers";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getAsks, putAsks } from "../cache";
import { Icon } from "./icons";
import type { StoryView } from "./Story";

/** Where an answer panel sits: after this row of this step's code. `line` is the row's shown number. */
export type AskAnchor = { step: number; table: "diff" | "ctx"; file: string; mark: "+" | "-" | " "; line: number };

type Turn = { question: string; answer: string; usage?: Usage; model?: string; error?: string; stopped?: boolean };

type Thread = {
  id: string;
  anchor: AskAnchor;
  sel: AskSelection;
  atomId?: string;
  /** For unchanged code: the context snippet the lines came from. */
  snippet?: { start: number; code: string };
  /** What the model was shown, kept for follow-ups and for checking citations. */
  context?: AskContext;
  turns: Turn[];
  open: boolean;
};

/** What the reader page provides: the model, a source for definitions outside the PR, and cost tracking. */
export type AskOptions = {
  /** Why asking is off (no model set up), or null when it's on. */
  unavailable: string | null;
  getProvider(): Promise<LLMProvider | null>;
  getSource(): ContextSource | null;
  onUsage(u: Usage, model: string): void;
  /** Where this PR's answers are saved; null to not save them (demo mode). */
  storeKey: string | null;
};

type Highlight = (h: { step: number; atomId?: string; file?: string; from: number; to: number }) => void;

type Status = "context" | "thinking" | "writing" | null;

type Api = {
  threadsAt(a: AskAnchor): Thread[];
  status(id: string): Status;
  ask(sel: Pending, question: string): void;
  followUp(id: string, question: string): void;
  retry(id: string): void;
  stop(id: string): void;
  remove(id: string): void;
  toggle(id: string): void;
  highlight(t: Thread, side: "new" | "old", from: number, to: number): void;
  unavailable: string | null;
};

const AskCtx = createContext<Api | null>(null);
export const useAsk = () => useContext(AskCtx);

const sameAnchor = (a: AskAnchor, b: AskAnchor) => a.step === b.step && a.table === b.table && a.file === b.file && a.mark === b.mark && a.line === b.line;

/** A selection read from the page, before it's asked about. */
/** `row` is the last selected row on the page, used only to place the bar. */
type Pending = { anchor: AskAnchor; sel: AskSelection; atomId?: string; ctxIndex?: number; row?: HTMLTableRowElement };

/**
 * The selected code rows, read from the page: rows of one table that the text selection touches.
 * Rows carry what's needed in data attributes (set in Story.tsx).
 */
function readSelection(): Pending | null {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const range = s.getRangeAt(0);
  const root = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const scope = root?.closest("table") ?? root?.closest("main") ?? document;
  const rows = [...scope.querySelectorAll<HTMLTableRowElement>("tr[data-ask]")].filter((tr) => range.intersectsNode(tr));
  if (!rows.length) return null;
  const table = rows[0]!.closest("table");
  const mine = rows.filter((r) => r.closest("table") === table);
  const first = mine[0]!.dataset;
  const kind = first.ask === "ctx" ? "unchanged" : "diff";
  const lines = mine.map((tr) => {
    const d = tr.dataset;
    const text = tr.querySelector(".tx")?.textContent ?? "";
    return { mark: (d.mark ?? " ") as "+" | "-" | " ", ...(d.old ? { old: +d.old } : {}), ...(d.new ? { new: +d.new } : {}), text: text === " " ? "" : text };
  });
  const last = mine[mine.length - 1]!.dataset;
  const lastLine = lines[lines.length - 1]!;
  return {
    anchor: { step: +(first.step ?? -1), table: first.ask === "ctx" ? "ctx" : "diff", file: first.file ?? "", mark: lastLine.mark, line: +(lastLine.mark === "-" ? last.old! : (last.new ?? last.old!)) },
    sel: { file: first.file ?? "", kind, lines },
    ...(first.atom ? { atomId: first.atom } : {}),
    ...(first.ctx ? { ctxIndex: +first.ctx } : {}),
    row: mine[mine.length - 1],
  };
}

const newId = () => Math.random().toString(36).slice(2, 10);

export function AskProvider({ view, options, highlight, children }: { view: StoryView; options: AskOptions | undefined; highlight: Highlight; children: ReactNode }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const aborts = useRef(new Map<string, AbortController>());
  const loaded = useRef(false);
  const latest = useRef(threads);
  latest.current = threads;
  const files = useMemo(() => new Map(view.pr.files.map((f) => [f.path, f])), [view.pr]);
  const byId = useMemo(() => new Map(view.atoms.map((a) => [a.id, a])), [view.atoms]);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Questions can be asked while later steps are still being written; saved answers wait for the
  // whole story, since carrying them over to a new commit needs every step's code.
  const complete = view.steps.length === view.plan.length && view.steps.every(Boolean);

  // Saved answers: as they were for this commit, or carried over from an earlier one when their
  // lines still read the same and the story still shows them. Questions asked before they load are kept.
  useEffect(() => {
    loaded.current = false;
    const key = options?.storeKey;
    if (!key) {
      loaded.current = true;
      return;
    }
    if (!complete) return;
    let cancelled = false;
    void getAsks<Thread>(key).then((saved) => {
      if (cancelled) return;
      const v = viewRef.current;
      const restored = !saved ? [] : saved.headSha === v.headSha ? saved.threads.map((t) => ({ ...t, open: t.open ?? true })) : saved.threads.map((t) => carryOver(t, v, new Map(v.pr.files.map((f) => [f.path, f])))).filter((t): t is Thread => !!t);
      const ids = new Set(restored.map((t) => t.id));
      latest.current = [...restored, ...latest.current.filter((t) => !ids.has(t.id))];
      setThreads(latest.current);
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [options?.storeKey, view.headSha, complete]);

  // Saved whenever they change (not while an answer is still streaming in).
  const busy = Object.values(status).some(Boolean);
  useEffect(() => {
    const key = options?.storeKey;
    if (!key || !loaded.current || busy) return;
    void putAsks({ key, headSha: view.headSha, savedAt: Date.now(), threads });
  }, [threads, busy, options?.storeKey, view.headSha]);

  const update = (id: string, f: (t: Thread) => Thread) => setThreads((ts) => ts.map((t) => (t.id === id ? f(t) : t)));
  const setTurn = (id: string, f: (t: Turn) => Turn) => update(id, (t) => ({ ...t, turns: t.turns.map((u, i) => (i === t.turns.length - 1 ? f(u) : u)) }));

  /** Answers the thread's last turn. */
  const run = useCallback(
    async (id: string) => {
      const t0 = latest.current.find((t) => t.id === id);
      if (!t0 || !options) return;
      const ctrl = new AbortController();
      aborts.current.get(id)?.abort();
      aborts.current.set(id, ctrl);
      const set = (s: Status) => setStatus((m) => ({ ...m, [id]: s }));
      try {
        const provider = await options.getProvider();
        if (!provider) throw new Error(options.unavailable ?? "No model is set up. Choose one in settings.");
        let context = t0.context;
        if (!context) {
          set("context");
          const atom = t0.atomId ? byId.get(t0.atomId) : undefined;
          const around = aroundSelection(t0.sel, files.get(t0.sel.file), atom, t0.snippet);
          // Definitions are a help, not a must: give up on them after a few seconds.
          const definitions = await Promise.race([findDefinitions(t0.sel, view.pr, options.getSource()), new Promise<[]>((r) => setTimeout(() => r([]), 6000))]);
          context = { around, definitions };
          const c = context;
          update(id, (t) => ({ ...t, context: c }));
        }
        if (ctrl.signal.aborted) throw new DOMException("Stopped", "AbortError");
        set("thinking");
        const turns = t0.turns;
        const step = t0.anchor.step >= 0 ? view.steps[t0.anchor.step] : undefined;
        const req = buildAskRequest({
          pr: view.pr,
          summary: view.summary,
          ...(step ? { step: { number: t0.anchor.step + 1, label: step.label, explanation: step.explanation.map((b) => b.text).join("\n\n") } } : {}),
          sel: t0.sel,
          context,
          history: turns.slice(0, -1).map((u) => ({ question: u.question, answer: u.answer })),
          question: turns[turns.length - 1]!.question,
        });
        let text = "";
        let pending = false;
        const flush = () => {
          pending = false;
          const now = text;
          setTurn(id, (u) => ({ ...u, answer: now }));
        };
        const res = await askAboutCode(provider, req, {
          signal: ctrl.signal,
          onText: (d) => {
            if (!text) set("writing");
            text += d;
            if (!pending) {
              pending = true;
              requestAnimationFrame(flush);
            }
          },
        });
        setTurn(id, (u) => ({ ...u, answer: res.text || text, usage: res.usage, model: provider.model, error: undefined }));
        options.onUsage(res.usage, provider.model);
      } catch (err) {
        const stopped = ctrl.signal.aborted || (err as Error)?.name === "AbortError";
        setTurn(id, (u) => (stopped ? { ...u, stopped: true } : { ...u, error: (err as Error)?.message || String(err) }));
      } finally {
        if (aborts.current.get(id) === ctrl) aborts.current.delete(id);
        set(null);
      }
    },
    [options, view, files, byId],
  );

  const api: Api = {
    threadsAt: (a) => threads.filter((t) => sameAnchor(t.anchor, a)),
    status: (id) => status[id] ?? null,
    ask(p, question) {
      const id = newId();
      const ctx = p.ctxIndex != null ? view.steps[p.anchor.step]?.context?.[p.ctxIndex] : undefined;
      const t: Thread = { id, anchor: p.anchor, sel: p.sel, ...(p.atomId ? { atomId: p.atomId } : {}), ...(ctx ? { snippet: { start: ctx.start, code: ctx.code } } : {}), turns: [{ question, answer: "" }], open: true };
      latest.current = [...latest.current, t];
      setThreads(latest.current);
      void run(id);
    },
    followUp(id, question) {
      latest.current = latest.current.map((t) => (t.id === id ? { ...t, open: true, turns: [...t.turns, { question, answer: "" }] } : t));
      setThreads(latest.current);
      void run(id);
    },
    retry(id) {
      latest.current = latest.current.map((t) => (t.id === id ? { ...t, turns: t.turns.map((u, i) => (i === t.turns.length - 1 ? { question: u.question, answer: "" } : u)) } : t));
      setThreads(latest.current);
      void run(id);
    },
    stop: (id) => aborts.current.get(id)?.abort(),
    remove(id) {
      aborts.current.get(id)?.abort();
      setThreads((ts) => ts.filter((t) => t.id !== id));
    },
    toggle: (id) => update(id, (t) => ({ ...t, open: !t.open })),
    highlight(t, _side, from, to) {
      if (t.anchor.table === "ctx") highlight({ step: t.anchor.step, file: t.sel.file, from, to });
      else highlight({ step: t.anchor.step, atomId: t.atomId, from, to });
    },
    unavailable: options ? options.unavailable : "Asking isn't available here.",
  };

  return (
    <AskCtx.Provider value={options ? api : null}>
      {children}
      {options ? <AskBar /> : null}
    </AskCtx.Provider>
  );
}

/**
 * A saved answer moved to a new version of the PR: its lines found again by their text, and placed
 * under the step that now shows them. Null when they can't be found, or the story doesn't show them.
 */
function carryOver(t: Thread, view: StoryView, files: Map<string, StoryView["pr"]["files"][number]>): Thread | null {
  if (t.anchor.table !== "diff") return null;
  const sel = remapSelection(t.sel, files.get(t.sel.file));
  if (!sel) return null;
  const last = sel.lines[sel.lines.length - 1]!;
  const line = last.mark === "-" ? last.old! : last.new!;
  const mark = last.mark;
  for (const [i, step] of view.steps.entries()) {
    for (const id of step?.atomIds ?? []) {
      const atom = view.atoms.find((a) => a.id === id);
      if (!atom || atom.file !== sel.file) continue;
      const shows = atomSnippet(files.get(atom.file), atom).some((r) => r.type !== "gap" && rowNumber(r) === line && (r.type === "add" ? "+" : r.type === "del" ? "-" : " ") === mark);
      if (shows) return { ...t, sel, atomId: id, anchor: { ...t.anchor, step: i, line }, context: undefined };
    }
  }
  return null;
}

// ---- The floating bar shown over a selection ----

function AskBar() {
  const api = useAsk()!;
  const [pending, setPending] = useState<Pending | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [typing, setTyping] = useState(false);
  const [q, setQ] = useState("");
  const typingRef = useRef(false);
  typingRef.current = typing;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (typingRef.current) return;
      const p = readSelection();
      const s = window.getSelection();
      if (!p || !s?.rangeCount) {
        setPending(null);
        setPos(null);
        return;
      }
      // Below the last selected row (so it covers none of the selection), lined up with where the selection starts.
      const rects = s.getRangeAt(0).getClientRects();
      const start = rects[0] ?? s.getRangeAt(0).getBoundingClientRect();
      const bottom = p.row?.getBoundingClientRect().bottom ?? (rects[rects.length - 1] ?? start).bottom;
      setPending(p);
      setPos({ top: Math.min(window.innerHeight - 48, bottom + 6), left: Math.max(8, Math.min(window.innerWidth - 300, start.left)) });
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(check, 120);
    };
    // Scrolling moves the selection; hide the bar rather than leave it behind.
    const onScroll = () => !typingRef.current && setPos(null);
    document.addEventListener("selectionchange", soon);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", soon);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  const close = () => {
    setPending(null);
    setPos(null);
    setTyping(false);
    setQ("");
  };
  const submit = (question: string) => {
    if (!pending) return;
    api.ask(pending, question.trim());
    window.getSelection()?.removeAllRanges();
    close();
  };

  // Esc closes the bar (and not the whole reader).
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      window.getSelection()?.removeAllRanges();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pos]);

  if (!pending || !pos) return null;
  const n = pending.sel.lines.length;
  const off = api.unavailable;
  return (
    <div className="ask-bar" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label="Ask about the selected code" onMouseDown={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}>
      {typing ? (
        <form
          className="ask-bar-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit(q);
          }}
        >
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about these lines…" aria-label="Your question" />
          <button type="submit" className="ask-go" aria-label="Ask">
            <Icon name="send" />
          </button>
        </form>
      ) : (
        <>
          <button type="button" className="ask-main" disabled={!!off} title={off ?? `Walk me through ${n === 1 ? "this line" : `these ${n} lines`}`} onClick={() => submit("")}>
            <Icon name="sparkle" />
            Explain {n === 1 ? "this line" : `${n} lines`}
          </button>
          <button type="button" className="ask-more" disabled={!!off} title={off ?? "Ask your own question about these lines"} onClick={() => setTyping(true)}>
            Ask…
          </button>
        </>
      )}
    </div>
  );
}

// ---- A reminder at the top of the story ----

const TIP_KEY = "prstory:askTipHidden";

/** A one-line reminder that any code in the story can be selected and asked about, until it's dismissed. */
export function AskTip() {
  const api = useAsk();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(TIP_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (!api || api.unavailable || hidden) return null;
  return (
    <p className="ask-tip">
      <Icon name="sparkle" />
      <span>Highlight any lines of code in the story to have them explained, or to ask your own question about them.</span>
      <button
        type="button"
        className="ask-tip-close"
        aria-label="Hide this tip"
        title="Hide this tip"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(TIP_KEY, "1");
          } catch {
            // only this page forgets it
          }
        }}
      >
        <Icon name="close" />
      </button>
    </p>
  );
}

// ---- Answer panels, drawn after their anchor row ----

export function AskRows({ anchor, colSpan }: { anchor: AskAnchor; colSpan: number }) {
  const api = useAsk();
  if (!api) return null;
  const ts = api.threadsAt(anchor);
  if (!ts.length) return null;
  return (
    <>
      {ts.map((t) => (
        <tr className="ask-row" key={t.id}>
          <td colSpan={colSpan}>
            <AskThread t={t} />
          </td>
        </tr>
      ))}
    </>
  );
}

const lineRange = (sel: AskSelection) => {
  const nums = sel.lines.map((l) => (l.mark === "-" ? l.old : (l.new ?? l.old))).filter((n): n is number => n != null);
  if (!nums.length) return "";
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? `L${lo}` : `L${lo}–${hi}`;
};

function costOf(turns: Turn[]): string {
  let tokens = 0;
  let cost: number | null = 0;
  for (const t of turns) {
    if (!t.usage) continue;
    tokens += t.usage.inputTokens + t.usage.outputTokens + (t.usage.cacheReadTokens ?? 0) + (t.usage.cacheWriteTokens ?? 0);
    const c = t.model ? estimateCost(t.model, t.usage) : null;
    cost = c == null || cost == null ? null : cost + c;
  }
  if (!tokens) return "";
  const n = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(tokens);
  return `${n} tokens${cost != null ? ` · ~$${cost.toFixed(cost < 0.1 ? 3 : 2)}` : ""}`;
}

function AskThread({ t }: { t: Thread }) {
  const api = useAsk()!;
  const st = api.status(t.id);
  const [q, setQ] = useState("");
  const [peek, setPeek] = useState<PeekAt | null>(null);
  const last = t.turns[t.turns.length - 1]!;
  const cost = costOf(t.turns);
  const send = () => {
    if (!q.trim() || st) return;
    api.followUp(t.id, q.trim());
    setQ("");
  };
  return (
    <div className={`ask-thread${t.open ? "" : " closed"}`}>
      <div className="ask-head">
        <button type="button" className="ask-toggle" aria-expanded={t.open} onClick={() => api.toggle(t.id)}>
          <Icon name="sparkle" />
          <span className="ask-title">
            {t.turns[0]!.question ? <>“{t.turns[0]!.question}”</> : "Walkthrough"} <span className="muted">· {lineRange(t.sel)}</span>
          </span>
        </button>
        <span className="ask-private" title="Only you can see this. It isn't posted to GitHub.">
          Private
        </span>
        {cost ? <span className="ask-cost">{cost}</span> : null}
        {st ? (
          <button type="button" className="ask-btn" onClick={() => api.stop(t.id)}>
            Stop
          </button>
        ) : null}
        <button type="button" className="ask-btn icon" title="Delete this answer" aria-label="Delete this answer" onClick={() => api.remove(t.id)}>
          <Icon name="close" />
        </button>
      </div>
      {t.open ? (
        <div className="ask-body">
          {t.turns.map((u, i) => {
            const isLast = i === t.turns.length - 1;
            return (
              <div className="ask-turn" key={i}>
                {i > 0 ? <p className="ask-q">{u.question}</p> : null}
                {u.answer ? (
                  <div className="ask-answer md">
                    <AnswerText text={u.answer} t={t} turn={i} peek={peek} setPeek={setPeek} />
                    {isLast && st === "writing" ? <span className="ask-caret" aria-hidden="true" /> : null}
                  </div>
                ) : null}
                {isLast && !u.answer && st ? <p className="ask-status">{st === "context" ? "Gathering the code around it…" : "Thinking…"}</p> : null}
                {u.stopped ? <p className="ask-status">Stopped.</p> : null}
                {u.error ? (
                  <p className="ask-error">
                    {u.error}{" "}
                    {isLast ? (
                      <button type="button" className="ask-btn" onClick={() => api.retry(t.id)}>
                        Try again
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </div>
            );
          })}
          {!st && !last.error ? (
            <form
              className="ask-follow"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a follow-up…" aria-label="Follow-up question" />
              <button type="submit" className="ask-btn" disabled={!q.trim()}>
                Ask
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** An open definition: which one, the lines cited, and where (the answer block that cited it). */
type PeekAt = { turn: number; block: number; label: string; from: number; to: number };
const samePeek = (a: PeekAt | null, b: PeekAt) => !!a && a.turn === b.turn && a.block === b.block && a.label === b.label && a.from === b.from && a.to === b.to;

/** A definition the answer cited, shown right under the paragraph that cites it, cited lines marked. */
function Peek({ t, peek, onClose }: { t: Thread; peek: PeekAt; onClose: () => void }) {
  const d = t.context?.definitions.find((x) => x.label === peek.label);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [peek]);
  if (!d) return null;
  return (
    <div className="ask-peek" ref={box}>
      <div className="ask-peek-head">
        <span>
          Definition of <code>{d.name}</code> in <span className="path">{d.file}</span>
        </span>
        <button type="button" className="ask-btn icon" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <table className="diff ctx">
        <tbody>
          {d.lines.map((l, i) => {
            const n = d.start + i;
            return (
              <tr key={i} className={n >= peek.from && n <= peek.to ? "hl" : undefined}>
                <td className="ln">{n}</td>
                <td className="code">{l || " "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Answer text: paragraphs, lists, code blocks, inline marks and line references ----

type Block = { kind: "p"; text: string } | { kind: "ul" | "ol"; items: string[] } | { kind: "code"; text: string };

/** Splits an answer into blocks. A code fence still open (mid-stream) runs to the end. */
export function answerBlocks(text: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  let code: string[] | null = null;
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
    if (list) out.push(list);
    list = null;
  };
  for (const raw of text.split("\n")) {
    if (code) {
      if (/^\s*```/.test(raw)) {
        out.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else code.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flush();
      code = [];
      continue;
    }
    const line = raw.trim();
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (para.length) {
        out.push({ kind: "p", text: para.join(" ") });
        para = [];
      }
      if (list && list.kind !== kind) {
        out.push(list);
        list = null;
      }
      list ??= { kind, items: [] };
      list.items.push((ul ?? ol)![1]!);
    } else if (!line) flush();
    else if (list && /^\s{2,}/.test(raw)) list.items[list.items.length - 1] += ` ${line}`;
    else {
      if (list) {
        out.push(list);
        list = null;
      }
      para.push(line);
    }
  }
  flush();
  if (code) out.push({ kind: "code", text: (code as string[]).join("\n") });
  return out;
}

/** Inline marks: `code`, **bold**, *italic* / _italic_. */
function Marks({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    if ((m.index ?? 0) > last) parts.push(text.slice(last, m.index));
    if (m[1] != null) parts.push(<code key={k++}>{m[1]}</code>);
    else if (m[2] != null) parts.push(<strong key={k++}>{m[2]}</strong>);
    else parts.push(<em key={k++}>{m[3] ?? m[4]}</em>);
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

type PeekProps = { turn: number; peek: PeekAt | null; setPeek: (p: PeekAt | null) => void };

function Line({ text, t, block, turn, peek, setPeek }: { text: string; t: Thread; block: number } & PeekProps) {
  const api = useAsk()!;
  const parts: AnswerPart[] = t.context ? parseAnswer(text, t.sel, t.context) : [{ text }];
  return (
    <>
      {parts.map((p, i) => {
        if ("ref" in p) {
          const r = p.ref;
          // Definitions are labelled D1, D2… for the model; the reader sees the name instead.
          const def = r.label ? t.context?.definitions.find((d) => d.label === r.label) : undefined;
          const at: PeekAt = { turn, block, label: r.label, from: r.start, to: r.end };
          const open = !!def && samePeek(peek, at);
          const click = (e: React.MouseEvent) => {
            e.preventDefault();
            if (r.label) setPeek(open ? null : at);
            else api.highlight(t, r.side, r.start, r.end);
          };
          return (
            <a
              key={i}
              href="#"
              className={`cite${r.label ? " ctx" : ""}${open ? " on" : ""}`}
              onClick={click}
              aria-expanded={r.label ? open : undefined}
              title={def ? `${open ? "Hide" : "Show"} the definition of ${def.name} (${def.file})` : "Highlight these lines in the code"}
            >
              {def ? p.text.replace(/^D\d+ /, `${def.name} `) : p.text}
            </a>
          );
        }
        if ("bad" in p)
          return (
            <span key={i} className="cite bad" title="The model cited lines it wasn't shown, so this reference may be wrong.">
              {p.text}
            </span>
          );
        return <Marks key={i} text={p.text} />;
      })}
    </>
  );
}

function AnswerText({ text, t, turn, peek, setPeek }: { text: string; t: Thread } & PeekProps) {
  const lineProps = { t, turn, peek, setPeek };
  return (
    <>
      {answerBlocks(text).map((b, i) => (
        <Fragment key={i}>
          {b.kind === "code" ? (
            <pre>
              <code>{b.text}</code>
            </pre>
          ) : b.kind === "p" ? (
            <p>
              <Line text={b.text} block={i} {...lineProps} />
            </p>
          ) : b.kind === "ul" ? (
            <ul>
              {b.items.map((it, j) => (
                <li key={j}>
                  <Line text={it} block={i} {...lineProps} />
                </li>
              ))}
            </ul>
          ) : (
            <ol>
              {b.items.map((it, j) => (
                <li key={j}>
                  <Line text={it} block={i} {...lineProps} />
                </li>
              ))}
            </ol>
          )}
          {peek && peek.turn === turn && peek.block === i ? <Peek t={t} peek={peek} onClose={() => setPeek(null)} /> : null}
        </Fragment>
      ))}
    </>
  );
}

export const ASK_CSS = `
/* Ask about this code */
.ask-tip { display: flex; align-items: center; gap: 8px; width: fit-content; max-width: 72ch; margin: 12px 0 18px; padding: 6px 6px 6px 10px; border-radius: 8px; font-size: 13px; color: var(--muted); background: color-mix(in srgb, var(--accent) 7%, transparent); }
.ask-tip > .icon { flex: none; color: var(--accent); }
.ask-tip-close { all: unset; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 5px; cursor: pointer; color: var(--muted); }
.ask-tip-close:hover, .ask-tip-close:focus-visible { background: color-mix(in srgb, var(--ink) 8%, transparent); color: var(--ink); }
.ask-tip-close .icon { width: 12px; height: 12px; }
.ask-bar { position: fixed; z-index: 50; display: flex; gap: 2px; align-items: center; padding: 3px; border-radius: 9px; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 6px 22px rgba(0,0,0,.16), 0 1px 3px rgba(0,0,0,.08); animation: fade-up .14s ease-out; }
.ask-bar button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 6px; font: 500 13px var(--sans); color: var(--ink); cursor: pointer; white-space: nowrap; }
.ask-bar button:hover:not(:disabled), .ask-bar button:focus-visible { background: color-mix(in srgb, var(--ink) 7%, transparent); }
.ask-bar button:disabled { opacity: .5; cursor: not-allowed; }
.ask-bar .ask-main { background: var(--accent); color: var(--on-accent); }
.ask-bar .ask-main:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 88%, #000); }
.ask-bar .ask-more { color: var(--muted); }
.ask-bar-form { display: flex; gap: 4px; align-items: center; }
.ask-bar-form input { width: 260px; font: 13.5px var(--sans); padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); outline: none; }
.ask-bar-form input:focus { border-color: var(--accent); }
.ask-bar .ask-go { width: 28px; padding: 0; justify-content: center; background: var(--accent); color: var(--on-accent); }
tr.ask-row > td { padding: 8px 10px 10px; background: var(--bg); font: var(--text-size, 15px)/1.6 var(--sans); color: var(--ink); white-space: normal; }
.ask-thread { border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-left: 3px solid var(--accent); border-radius: 8px; background: var(--panel); max-width: 80ch; animation: fade-up .16s ease-out; }
.ask-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 10px; font-size: 13px; }
.ask-thread:not(.closed) .ask-head { border-bottom: 1px solid var(--line); }
.ask-toggle { all: unset; display: inline-flex; gap: 7px; align-items: center; cursor: pointer; flex: 1; min-width: 0; color: var(--accent); }
.ask-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.ask-title { color: var(--ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ask-private { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; flex: none; }
.ask-cost { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
.ask-btn { font: 500 12.5px var(--sans); background: none; border: 1px solid var(--line); color: var(--ink); border-radius: 6px; padding: 2px 9px; cursor: pointer; flex: none; }
.ask-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ask-btn:disabled { opacity: .5; cursor: default; }
.ask-btn.icon { border-color: transparent; padding: 3px; display: inline-grid; place-items: center; color: var(--muted); }
.ask-body { padding: 4px 14px 12px; }
.ask-turn + .ask-turn { border-top: 1px dashed var(--line); margin-top: 8px; padding-top: 4px; }
.ask-q { font-weight: 600; margin: 8px 0 4px; }
.ask-q::before { content: "You: "; color: var(--muted); font-weight: 400; }
.ask-answer p { margin: 8px 0; }
.ask-answer ul, .ask-answer ol { margin: 6px 0; padding-left: 1.4em; }
.ask-answer li { margin: 2px 0; }
.ask-answer pre { background: var(--ctx-bg); padding: 8px 10px; border-radius: 6px; font: var(--code-size, 12.5px)/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
.ask-answer pre code { background: none; padding: 0; font: inherit; }
.ask-answer .cite { font-size: 11px; vertical-align: 1px; }
.cite.bad { border-style: dotted; text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted) 60%, transparent); cursor: help; }
.ask-caret { display: inline-block; width: 7px; height: 1.05em; margin-left: 2px; vertical-align: -2px; background: var(--accent); animation: blink 1s steps(1) infinite; }
.ask-status { color: var(--muted); font-size: 13px; margin: 10px 0 4px; }
.ask-status::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 8px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent); border-top-color: var(--accent); vertical-align: -1px; animation: spin .8s linear infinite; }
.ask-error { color: var(--del-ink); background: var(--del-bg); border-radius: 6px; padding: 6px 10px; font-size: 13px; margin: 8px 0; }
.ask-follow { display: flex; gap: 6px; margin-top: 10px; }
.ask-follow input { flex: 1; min-width: 0; font: 13.5px var(--sans); padding: 5px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); outline: none; }
.ask-follow input:focus { border-color: var(--accent); }
.ask-peek { margin: 10px 0 2px; border: 1px dashed var(--line); border-radius: 8px; overflow: hidden; background: var(--bg); }
.ask-peek-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 3px 6px 3px 12px; background: var(--ctx-bg); font-size: 12.5px; color: var(--muted); }
.ask-peek-head .path { font: 11.5px var(--mono); }
.ask-peek .diff tr.hl td.code { background: var(--mark-bg); color: var(--ink); }
.ask-answer .cite.on { background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: var(--accent); color: var(--accent); }
.step.show-raw tr.ask-row { display: none; }
`;
