import {
  atomLabel,
  atomSnippet,
  contextCaption,
  expandChunk,
  fileRows,
  lineCounts,
  reindentRuns,
  rowNumber,
  rowPositions,
  rowTarget,
  walkthrough,
  type ChangeAtom,
  type Citation,
  type ContextSnippet,
  type Expansion,
  type PRInput,
  type SnippetRow,
  type StoryStep,
  type WalkChunk,
} from "@prstory/core";
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AskProvider, AskRows, type AskOptions } from "./ask";
import { CommentButton, LineComments, useComments } from "./comments";

/** What the reader shows; `steps[i]` is undefined until step i has been written. */
export type StoryView = {
  pr: PRInput;
  atoms: ChangeAtom[];
  summary: string;
  plan: { label: string; atomIds: string[]; orderOverride?: string }[];
  steps: (StoryStep | undefined)[];
  mechanical: string[];
  headSha: string;
};

/** A highlighted line range, set by clicking a citation. */
type Hl = { step: number; atomId?: string; file?: string; from: number; to: number } | null;

type Ctx = {
  byId: Map<string, ChangeAtom>;
  snippets: Map<string, SnippetRow[]>;
  files: Map<string, PRInput["files"][number]>;
  /** Every line of a changed file in diff order, for expanding chunks (built on first use). */
  fileView: (path: string) => FileView | null;
  link: (file: string, side: "LEFT" | "RIGHT", line: number) => string | null;
  hl: Hl;
  setHl: (h: Hl) => void;
};
const StoryCtx = createContext<Ctx>(null as unknown as Ctx);

type FileView = { all: SnippetRow[]; pos: ReturnType<typeof rowPositions> };

const FOLD_MIN = 4; // re-indented runs at least this long collapse into one row
const EXPAND_STEP = 10; // lines added per click of an expand button
const EXPAND_ALL_MAX = 15; // a stretch this short opens in one click
const CONTEXT_OPEN_MAX = 3; // longer context snippets start collapsed; a citation opens them

/** `code` spans in model text. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/g);
  return <>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>;
}

/** Model text → paragraphs, with "- item" lines as a list. `tail` goes at the end of the last paragraph. */
function Blocks({ text, tail }: { text: string; tail?: ReactNode }) {
  const out: ({ kind: "p"; text: string } | { kind: "ul"; items: string[] })[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push({ kind: "ul", items: list });
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const item = /^[-*•]\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      list.push(item[1]);
    } else if (!line) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  const last = out[out.length - 1];
  return (
    <>
      {out.map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>
            <Inline text={b.text} />
            {i === out.length - 1 && tail ? <> {tail}</> : null}
          </p>
        ) : (
          <ul key={i}>
            {b.items.map((li, j) => (
              <li key={j}>
                <Inline text={li} />
              </li>
            ))}
          </ul>
        ),
      )}
      {tail && (!last || last.kind === "ul") ? <p>{tail}</p> : null}
    </>
  );
}

function inRange(r: SnippetRow, from: number, to: number): boolean {
  if (r.type === "gap") return false;
  const n = rowNumber(r);
  const o = r.type === "reindent" ? r.oldLine : undefined;
  return (n != null && n >= from && n <= to) || (o != null && o >= from && o <= to);
}

/** `ask`: the row can be selected to ask about (rows of the story's own chunks). */
function Row({ r, hl, path, cls, gap, ask }: { r: SnippetRow; hl: boolean; path?: string; cls?: string; gap?: ReactNode; ask?: { step: number; atomId: string } }) {
  const cm = useComments();
  if (r.type === "gap")
    return (
      <tr className="gap">
        <td colSpan={3}>{gap ?? "⋯"}</td>
      </tr>
    );
  const sign = r.type === "add" ? "+" : r.type === "del" ? "−" : r.type === "reindent" ? "~" : "";
  const old = r.type === "add" ? "" : (r.oldLine ?? "");
  const neu = r.type === "del" ? "" : (r.newLine ?? "");
  // Comments go on the base side for removed lines and the head side for everything else.
  const t = path ? rowTarget(r) : null;
  const button = t && path ? <CommentButton path={path} side={t.side} line={t.line} /> : null;
  const sel = !!(t && path && cm?.selected(path, t.side, t.line));
  const mark = r.type === "add" ? "+" : r.type === "del" ? "-" : " ";
  const shown = rowNumber(r);
  const askable = !!(ask && path && shown != null);
  return (
    <>
      <tr
        className={`${r.type}${cls ? ` ${cls}` : ""}${hl ? " hl" : ""}${sel ? " sel" : ""}`}
        title={cls === "other" ? "Changed in another step" : undefined}
        onMouseEnter={t && path && cm ? () => cm.hover(path, t.side, t.line) : undefined}
        {...(askable
          ? {
              "data-ask": "diff",
              "data-step": ask!.step,
              "data-atom": ask!.atomId,
              "data-file": path,
              "data-mark": mark,
              ...(r.oldLine != null && r.type !== "add" ? { "data-old": r.oldLine } : {}),
              ...(r.newLine != null && r.type !== "del" ? { "data-new": r.newLine } : {}),
            }
          : {})}
      >
        <td className="ln">
          {t?.side === "LEFT" ? button : null}
          {old}
        </td>
        <td className="ln">
          {t?.side === "RIGHT" ? button : null}
          {neu}
        </td>
        <td className="code">
          <span className="sign">{sign}</span>
          <span className="tx">{r.text || " "}</span>
        </td>
      </tr>
      {t && path ? <LineComments path={path} side={t.side} line={t.line} /> : null}
      {askable ? <AskRows anchor={{ step: ask!.step, table: "diff", file: path!, mark, line: shown! }} colSpan={3} /> : null}
    </>
  );
}

/** Whether a row has comment threads, pending comments or the open comment box. */
function useRowHasComments(path: string | undefined) {
  const cm = useComments();
  return (r: SnippetRow) => {
    const t = path && cm ? rowTarget(r) : null;
    if (!t || !cm || !path) return false;
    const c = cm.composer;
    return cm.threadsAt(path, t.side, t.line).length > 0 || cm.draftsAt(path, t.side, t.line).length > 0 || (!!c && c.path === path && c.side === t.side && c.line === t.line);
  };
}

function Fold({ rows, n, isHl, path, clsOf, ask }: { rows: SnippetRow[]; n: number; isHl: (r: SnippetRow) => boolean; path?: string; clsOf: (r: SnippetRow) => string | undefined; ask?: { step: number; atomId: string } }) {
  const hasComments = useRowHasComments(path);
  const hit = rows.some(isHl) || rows.some(hasComments);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hit) setOpen(true);
  }, [hit]);
  return (
    <>
      <tbody className="fold-toggle">
        <tr>
          <td colSpan={3}>
            <button type="button" className="fold-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
              ~ {n} lines re-indented, otherwise unchanged · {open ? "hide" : "show"}
            </button>
          </td>
        </tr>
      </tbody>
      <tbody className={`fold-body${open ? " open" : ""}`}>
        {rows.map((r, i) => (
          <Row key={i} r={r} hl={isHl(r)} path={path} cls={clsOf(r)} ask={ask} />
        ))}
      </tbody>
    </>
  );
}

type ExpandProps = {
  /** Rows added by expanding; changed ones belong to other atoms and are dimmed. */
  extra?: Set<SnippetRow>;
  top?: ReactNode;
  bottom?: ReactNode;
  /** Controls drawn inside a gap row that can be opened. */
  gapControl?: (r: SnippetRow) => ReactNode | undefined;
};

function DiffTable({ atomId, rows, cls, step, extra, top, bottom, gapControl }: { atomId: string; rows: SnippetRow[]; cls: string; step: number } & ExpandProps) {
  const { hl, byId } = useContext(StoryCtx);
  const path = byId.get(atomId)?.file;
  const isHl = (r: SnippetRow) => !!hl && hl.step === step && hl.atomId === atomId && cls === "story" && inRange(r, hl.from, hl.to);
  const clsOf = (r: SnippetRow) => (extra?.has(r) ? (r.type === "context" ? "extra" : "other") : undefined);
  // The story's chunks can be asked about; raw diffs can't (they're for checking against GitHub).
  const ask = cls === "story" ? { step, atomId } : undefined;
  const runs = useMemo(() => new Map(reindentRuns(rows, FOLD_MIN).map(([a, b, c]) => [a, [b, c] as const])), [rows]);
  const parts: ReactNode[] = [];
  let plain: SnippetRow[] = [];
  const flush = (key: string) => {
    if (plain.length)
      parts.push(
        <tbody key={key}>
          {plain.map((r, i) => (
            <Row key={i} r={r} hl={isHl(r)} path={path} cls={clsOf(r)} gap={gapControl?.(r)} ask={ask} />
          ))}
        </tbody>,
      );
    plain = [];
  };
  for (let i = 0; i < rows.length; i++) {
    const run = runs.get(i);
    if (run) {
      const [end, n] = run;
      flush(`p${i}`);
      parts.push(<Fold key={`f${i}`} rows={rows.slice(i, end + 1)} n={n} isHl={isHl} path={path} clsOf={clsOf} ask={ask} />);
      i = end;
    } else plain.push(rows[i]);
  }
  flush("end");
  return (
    <table className={`diff ${cls}`} data-atom={atomId}>
      {top}
      {parts}
      {bottom}
    </table>
  );
}

function ExpandBar({ dir, n, onMore }: { dir: "up" | "down"; n: number; onMore: (k: number) => void }) {
  const k = n <= EXPAND_ALL_MAX ? n : EXPAND_STEP;
  const where = dir === "up" ? "above" : "below";
  return (
    <tbody className={`expand ${dir}`}>
      <tr>
        <td colSpan={3}>
          <button type="button" className="expand-btn" onClick={() => onMore(k)} title={`${n} unchanged line${n === 1 ? "" : "s"} ${where}`}>
            {dir === "up" ? "↑" : "↓"} Show {k === n ? (n === 1 ? "1 line" : `${n} lines`) : `${k} more lines`} {where}
          </button>
        </td>
      </tr>
    </tbody>
  );
}

/**
 * GitHub-style expanding for a chunk: buttons above and below it, and in its gaps, that show the
 * file's lines around the change. Lines already shown elsewhere in the step (`taken`) are never added.
 */
function useExpand(atom: ChangeAtom | undefined, rows: SnippetRow[], taken: Set<number> | undefined, enabled = true): { rows: SnippetRow[] } & ExpandProps {
  const { fileView } = useContext(StoryCtx);
  const [e, setE] = useState<Expansion>({ above: 0, below: 0, gaps: {} });
  const fv = atom && enabled ? fileView(atom.file) : null;
  const x = useMemo(() => (fv ? expandChunk(rows, fv.all, fv.pos, taken ?? new Set(), e) : null), [fv, rows, taken, e]);
  if (!x) return { rows };
  const openGap = (gap: number, t: number, b: number) =>
    setE((p) => {
      const [t0, b0] = p.gaps[gap] ?? [0, 0];
      return { ...p, gaps: { ...p.gaps, [gap]: [t0 + t, b0 + b] } };
    });
  return {
    rows: x.rows,
    extra: x.extra,
    top: x.moreAbove ? <ExpandBar dir="up" n={x.moreAbove} onMore={(k) => setE((p) => ({ ...p, above: p.above + k }))} /> : null,
    bottom: x.moreBelow ? <ExpandBar dir="down" n={x.moreBelow} onMore={(k) => setE((p) => ({ ...p, below: p.below + k }))} /> : null,
    gapControl: (r) => {
      const g = x.gaps.get(r);
      if (!g?.hidden) return undefined;
      const lines = `${g.hidden} hidden line${g.hidden === 1 ? "" : "s"}`;
      if (g.hidden <= EXPAND_ALL_MAX)
        return (
          <button type="button" className="expand-btn" onClick={() => openGap(g.gap, g.hidden, 0)}>
            ⋯ Show {lines}
          </button>
        );
      return (
        <span className="expand-gap">
          <button type="button" className="expand-btn" onClick={() => openGap(g.gap, EXPAND_STEP, 0)} title="Show more lines below the code above">
            ↓ {EXPAND_STEP} more
          </button>
          <span>⋯ {lines}</span>
          <button type="button" className="expand-btn" onClick={() => openGap(g.gap, 0, EXPAND_STEP)} title="Show more lines above the code below">
            ↑ {EXPAND_STEP} more
          </button>
        </span>
      );
    },
  };
}

/** The atom's hunks exactly as GitHub shows them, for the raw-diff toggle. */
function rawRows(atom: ChangeAtom, file: PRInput["files"][number] | undefined): SnippetRow[] {
  if (!file) return [];
  const mine = new Set(atom.hunkLines.map((r) => `${r.side}${r.line}`));
  const rows: SnippetRow[] = [];
  for (const h of file.hunks) {
    const hit = h.lines.some((l) => (l.type === "del" ? mine.has(`LEFT${l.oldLine}`) : l.type === "add" ? mine.has(`RIGHT${l.newLine}`) : false));
    if (!hit) continue;
    if (rows.length) rows.push({ type: "gap" });
    for (const l of h.lines) rows.push({ ...l });
  }
  return rows;
}

function AtomHead({ atom, continued, extra }: { atom: ChangeAtom; continued: boolean; extra?: ReactNode }) {
  const { link } = useContext(StoryCtx);
  const sym = atomLabel(atom).slice(atom.file.length).replace(/^ › /, "");
  if (continued)
    return (
      <div className="atom-head cont">
        <span className="path">{atom.file}</span>
        {sym ? <span className="sym">{sym}</span> : null}
        <span className="muted">continued</span>
      </div>
    );
  const { add, del } = lineCounts(atom);
  const first = atom.hunkLines.find((r) => r.side === "RIGHT") ?? atom.hunkLines[0];
  const href = first ? link(atom.file, first.side, first.line) : null;
  return (
    <div className="atom-head">
      <span className="path">{atom.file}</span>
      {sym ? <span className="sym">{sym}</span> : null}
      <span className="counts">
        <span className="plus">+{add}</span> <span className="minus">−{del}</span>
      </span>
      {href ? (
        <a className="gh" href={href} target="_blank" rel="noopener">
          Open in Files view ↗
        </a>
      ) : null}
      {extra}
    </div>
  );
}

const EmptyNote = ({ atom }: { atom: ChangeAtom }) => <p className="empty">{atom.kind === "renamed" ? "File renamed without content changes." : "Binary file changed."}</p>;

/** A whole atom with its own raw-diff toggle (the mechanical list). */
function AtomBlock({ atom }: { atom: ChangeAtom }) {
  const { snippets, files } = useContext(StoryCtx);
  const [raw, setRaw] = useState(false);
  const rows = snippets.get(atom.id) ?? [];
  const ex = useExpand(atom, rows, undefined, !raw);
  const toggle = rows.length ? (
    <button className="raw-toggle" type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
      Raw diff
    </button>
  ) : null;
  return (
    <div className="atom" id={`atom-${atom.id}`}>
      <AtomHead atom={atom} continued={false} extra={toggle} />
      {rows.length ? (
        raw ? (
          <DiffTable atomId={atom.id} rows={rawRows(atom, files.get(atom.file))} cls="raw-shown" step={-1} />
        ) : (
          <DiffTable atomId={atom.id} cls="story" step={-1} {...ex} />
        )
      ) : (
        <EmptyNote atom={atom} />
      )}
    </div>
  );
}

function ChunkBlock({ c, step, taken }: { c: WalkChunk; step: number; taken?: Set<number> }) {
  const { byId } = useContext(StoryCtx);
  const atom = byId.get(c.atomId);
  const ex = useExpand(atom, c.rows, taken);
  if (!atom) return null;
  return (
    <div className="atom chunk" id={c.first ? `atom-${atom.id}` : undefined}>
      <AtomHead atom={atom} continued={!c.first} />
      <DiffTable atomId={atom.id} cls="story" step={step} {...ex} />
    </div>
  );
}

function Cites({ cites, step, onCite }: { cites: Citation[]; step: number; onCite: () => void }) {
  const { setHl } = useContext(StoryCtx);
  if (!cites.length) return null;
  return (
    <span className="cites">
      {cites.map((c, i) => {
        const range = c.lines[0] === c.lines[1] ? `L${c.lines[0]}` : `L${c.lines[0]}–${c.lines[1]}`;
        const click = (e: React.MouseEvent) => {
          e.preventDefault();
          onCite();
          setHl(c.file ? { step, file: c.file, from: c.lines[0], to: c.lines[1] } : { step, atomId: c.atomId, from: c.lines[0], to: c.lines[1] });
        };
        return c.file ? (
          <a key={i} className="cite ctx" href="#" onClick={click} title={`Unchanged code in ${c.file}`}>
            {c.file.split("/").pop()} {range}
          </a>
        ) : (
          <a key={i} className="cite" href={`#atom-${c.atomId}`} onClick={click}>
            {range}
          </a>
        );
      })}
    </span>
  );
}

function ContextBlock({ c, step, index }: { c: ContextSnippet; step: number; index: number }) {
  const { hl } = useContext(StoryCtx);
  const n = c.end - c.start + 1;
  const [open, setOpen] = useState(n <= CONTEXT_OPEN_MAX);
  const hit = !!hl && hl.step === step && hl.file === c.file && hl.from <= c.end && hl.to >= c.start;
  useEffect(() => {
    if (hit) setOpen(true);
  }, [hit]);
  const focus = new Set(c.focus ?? []);
  const caption = contextCaption(c).replace(/^./, (ch) => ch.toUpperCase());
  const lineHl = (ln: number) => hit && ln >= hl!.from && ln <= hl!.to;
  return (
    <details className="context" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="context-head">
        <span className="tag-unchanged">Unchanged</span> <Inline text={caption} />{" "}
        <span className="path">
          {c.file} · L{c.start}–{c.end}
        </span>
      </summary>
      <table className="diff ctx">
        <tbody>
          {c.head ? (
            <>
              <tr className={`ctx-open${lineHl(c.head.line) ? " hl" : ""}`}>
                <td className="ln">{c.head.line}</td>
                <td className="code">{c.head.text || " "}</td>
              </tr>
              <tr className="gap">
                <td colSpan={2}>
                  ⋯ {c.start - c.head.line - 1} line{c.start - c.head.line - 1 === 1 ? "" : "s"}
                </td>
              </tr>
            </>
          ) : null}
          {c.code.split("\n").map((l, i) => {
            const ln = c.start + i;
            const cls = [focus.has(ln) ? "focus" : "", lineHl(ln) ? "hl" : ""].filter(Boolean).join(" ");
            return (
              <Fragment key={i}>
                <tr className={cls || undefined} data-ask="ctx" data-step={step} data-ctx={index} data-file={c.file} data-mark=" " data-new={ln}>
                  <td className="ln">{ln}</td>
                  <td className="code">
                    <span className="tx">{l || " "}</span>
                  </td>
                </tr>
                <AskRows anchor={{ step, table: "ctx", file: c.file, mark: " ", line: ln }} colSpan={2} />
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

function Step({ i, step, done }: { i: number; step: StoryStep; done: boolean }) {
  const { byId, snippets, files, fileView } = useContext(StoryCtx);
  const [raw, setRaw] = useState(false);
  const stepAtoms = step.atomIds.map((id) => byId.get(id)).filter((a): a is ChangeAtom => !!a);
  const { beats } = useMemo(() => walkthrough(step, snippets), [step, snippets]);
  // Per file, the lines this step's chunks already show, so expanding one chunk stops at the next.
  const taken = useMemo(() => {
    const m = new Map<string, Set<number>>();
    for (const a of stepAtoms) {
      const fv = fileView(a.file);
      if (!fv) continue;
      const set = m.get(a.file) ?? new Set<number>();
      for (const r of snippets.get(a.id) ?? []) {
        const p = fv.pos(r);
        if (p) set.add(p[0]).add(p[1]);
      }
      m.set(a.file, set);
    }
    return m;
  }, [step, snippets, fileView, byId]);
  const withCode = stepAtoms.filter((a) => (snippets.get(a.id) ?? []).length);
  return (
    <section className={`step${done ? " done" : ""}${raw ? " show-raw" : ""}`} id={`step-${i + 1}`} data-step={i + 1}>
      <div className="step-marker" aria-hidden="true">
        {i + 1}
      </div>
      <div className="step-body">
        {withCode.length ? (
          <div className="step-tools">
            <button className="step-raw" type="button" aria-pressed={raw} onClick={() => setRaw(!raw)}>
              Raw diff
            </button>
          </div>
        ) : null}
        {step.orderOverride ? (
          <p className="override">
            Placed before code it depends on: <Inline text={step.orderOverride} />
          </p>
        ) : null}
        {(step.context ?? []).map((c, k) => (
          <ContextBlock key={k} c={c} step={i} index={k} />
        ))}
        <div className="walk">
          {beats.map((b, k) => (
            <div className="beat" key={k}>
              {b.text || b.cites.length ? (
                <div className="beat-text">
                  <Blocks text={b.text} tail={<Cites cites={b.cites} step={i} onCite={() => setRaw(false)} />} />
                </div>
              ) : null}
              {b.code.map((c, j) => (
                <ChunkBlock key={j} c={c} step={i} taken={taken.get(byId.get(c.atomId)?.file ?? "")} />
              ))}
            </div>
          ))}
          {stepAtoms
            .filter((a) => !(snippets.get(a.id) ?? []).length)
            .map((a) => (
              <div className="atom" id={`atom-${a.id}`} key={a.id}>
                <AtomHead atom={a} continued={false} />
                <EmptyNote atom={a} />
              </div>
            ))}
        </div>
        {/* Rendered only while shown, so comment threads and boxes never exist twice on the page. */}
        {raw ? (
          <div className="rawview">
            <p className="raw-label">
              <Inline text={step.label} />
            </p>
            {withCode.map((a) => (
              <div className="atom" key={a.id}>
                <AtomHead atom={a} continued={false} />
                <DiffTable atomId={a.id} rows={rawRows(a, files.get(a.file))} cls="raw-shown" step={i} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Hex SHA-256 of each changed file's path, for links into GitHub's Files view. */
function usePathHashes(paths: string[]): Map<string, string> {
  const [hashes, setHashes] = useState(new Map<string, string>());
  const joined = paths.join("\n");
  useEffect(() => {
    let alive = true;
    void Promise.all(
      paths.map(async (p) => {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p));
        return [p, [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")] as const;
      }),
    ).then((pairs) => alive && setHashes(new Map(pairs)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  return hashes;
}

function useReviewed(key: string): [Record<number, boolean>, (step: number, on: boolean) => void] {
  const [done, setDone] = useState<Record<number, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      return {};
    }
  });
  const set = (step: number, on: boolean) => {
    const next = { ...done, [step]: on };
    setDone(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // per-viewer convenience only
    }
  };
  return [done, set];
}

/** Summary, the continuous scroll of steps, mechanical changes, and the outline rail. */
/**
 * A step that isn't written yet. The one being written shows its code and its words as they stream
 * in; the rest wait as a placeholder.
 */
function PendingStep({ i, label, atomIds, active, draft }: { i: number; label: string; atomIds: string[]; active: boolean; draft?: string }) {
  const { byId, snippets } = useContext(StoryCtx);
  const atoms = atomIds.map((id) => byId.get(id)).filter((a): a is ChangeAtom => !!a);
  const lines = atoms.reduce((n, a) => n + a.hunkLines.length, 0);
  return (
    <section className={`step pending-step${active ? " active" : ""}`} id={`step-${i + 1}`} data-step={i + 1} aria-busy="true">
      <div className="step-marker" aria-hidden="true">
        {i + 1}
      </div>
      <div className="step-body">
        <p className="pending-label">
          <Inline text={label} />
          <span className="pending-meta">
            {active ? "Writing now" : "Up next"} · {lines} changed line{lines === 1 ? "" : "s"} in {[...new Set(atoms.map((a) => a.file.split("/").pop()))].join(", ")}
          </span>
        </p>
        {active ? (
          <>
            <div className="draft" aria-live="polite">
              {draft ? (
                <Blocks text={draft.split("`").length % 2 === 0 ? `${draft}\`` : draft} tail={<span className="caret" aria-hidden="true" />} />
              ) : (
                <div className="skeleton" aria-label="Reading the code">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
            {atoms
              .filter((a) => (snippets.get(a.id) ?? []).length)
              .map((a) => (
                <div className="atom chunk draft-code" key={a.id}>
                  <AtomHead atom={a} continued={false} />
                  <DiffTable atomId={a.id} rows={snippets.get(a.id)!} cls="story" step={i} />
                </div>
              ))}
          </>
        ) : (
          <div className="skeleton quiet" aria-hidden="true">
            <span />
            <span />
          </div>
        )}
      </div>
    </section>
  );
}

/** While a story is being written: the text so far of steps still streaming, by step index. */
export type Writing = { drafts: Record<number, string> };

export function StoryReader({ view, writing, footer, banner, headerExtra, ask }: { view: StoryView; writing: Writing | null; footer: ReactNode; banner?: ReactNode; headerExtra?: ReactNode; ask?: AskOptions }) {
  const { pr, atoms } = view;
  const byId = useMemo(() => new Map(atoms.map((a) => [a.id, a])), [atoms]);
  const files = useMemo(() => new Map(pr.files.map((f) => [f.path, f])), [pr]);
  const snippets = useMemo(() => new Map(atoms.map((a) => [a.id, atomSnippet(files.get(a.file), a)])), [atoms, files]);
  const fileView = useMemo(() => {
    const cache = new Map<string, FileView | null>();
    return (path: string) => {
      if (!cache.has(path)) {
        const f = files.get(path);
        const all = f && !f.binary ? fileRows(f) : null;
        cache.set(path, all ? { all, pos: rowPositions(all) } : null);
      }
      return cache.get(path)!;
    };
  }, [files]);
  const hashes = usePathHashes(pr.files.map((f) => f.path));
  const link = (file: string, side: "LEFT" | "RIGHT", line: number) => {
    const h = hashes.get(file);
    return pr.url && h ? `${pr.url}/files#diff-${h}${side === "LEFT" ? "L" : "R"}${line}` : null;
  };
  const [hl, setHl] = useState<Hl>(null);
  const [done, setDone] = useReviewed(`prstory:reviewed:${pr.repo ?? "local"}:${view.headSha}`);
  const [current, setCurrent] = useState(0);
  const mainRef = useRef<HTMLElement>(null);

  // The step being written: the first with a draft, else the first not written yet.
  const firstMissing = view.steps.findIndex((s) => !s);
  const drafted = writing ? Object.keys(writing.drafts).map(Number).filter((i) => !view.steps[i]) : [];
  const active = writing ? (drafted.length ? Math.min(...drafted) : firstMissing) : -1;

  useEffect(() => {
    if (!hl) return;
    const step = document.getElementById(`step-${hl.step + 1}`);
    const target = step?.querySelector("tr.hl") ?? (hl.atomId ? document.getElementById(`atom-${hl.atomId}`) : null);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hl]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) if (en.isIntersecting) setCurrent(+(en.target as HTMLElement).dataset.step! - 1);
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    document.querySelectorAll(".step").forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [view.plan.length]);

  const mechAtoms = view.mechanical.map((id) => byId.get(id)).filter((a): a is ChangeAtom => !!a);
  const mechLines = mechAtoms.reduce((n, a) => n + a.hunkLines.length, 0);
  const total = view.plan.length;
  const reviewed = view.plan.filter((_, i) => done[i + 1]).length;
  const changedLines = atoms.reduce((n, a) => n + a.hunkLines.length, 0);

  return (
    <StoryCtx.Provider value={{ byId, snippets, files, fileView, link, hl, setHl }}>
      <AskProvider view={view} options={writing ? undefined : ask} highlight={setHl}>
      <div className="layout">
        <nav className="rail" aria-label="Story outline">
          <h2>Outline</h2>
          <div className="progress">
            <div style={{ width: total ? `${(100 * reviewed) / total}%` : "0" }} />
          </div>
          <div className="progress-text">
            {reviewed} of {total} steps reviewed
          </div>
          <ol>
            {view.plan.map((s, i) => {
              const ready = !!view.steps[i];
              const state = ready ? "" : i === active ? " writing" : " pending";
              return (
                <li key={i} className={`${done[i + 1] ? "done" : ""}${state}`}>
                  {ready ? (
                    <input type="checkbox" checked={!!done[i + 1]} onChange={(e) => setDone(i + 1, e.target.checked)} aria-label={`Mark step ${i + 1} reviewed`} />
                  ) : (
                    <span className="rail-state" aria-label={i === active ? "Being written" : "Waiting to be written"} />
                  )}
                  <a href={`#step-${i + 1}`} className={i === current ? "current" : ""}>
                    <span className="n">{i + 1}</span>
                    <span>
                      <Inline text={s.label} />
                    </span>
                  </a>
                </li>
              );
            })}
            {mechAtoms.length ? (
              <li>
                <span className="rail-spacer" />
                <a href="#mechanical">
                  <span className="n">·</span>Mechanical changes
                </a>
              </li>
            ) : null}
          </ol>
        </nav>
        <main ref={mainRef}>
          {banner}
          <header>
            <h1>
              <Inline text={pr.title} />
            </h1>
            <p className="sub">
              {pr.url ? (
                <a href={pr.url} target="_blank" rel="noopener">
                  {pr.repo}#{pr.number}
                </a>
              ) : (
                (pr.repo ?? "local diff")
              )}
              {(pr.issues ?? []).map((iss) => (
                <span key={iss.number}>
                  {" "}
                  · fixes{" "}
                  <a href={iss.url ?? "#"} target="_blank" rel="noopener">
                    #{iss.number}
                  </a>{" "}
                  <Inline text={iss.title} />
                </span>
              ))}{" "}
              · head {view.headSha.slice(0, 7)} · {total} steps · {changedLines} changed lines
            </p>
            {headerExtra}
            <div className="summary">
              <Blocks text={view.summary} />
            </div>
          </header>
          {view.plan.map((p, i) => {
            const s = view.steps[i];
            return s ? <Step key={i} i={i} step={s} done={!!done[i + 1]} /> : <PendingStep key={i} i={i} label={p.label} atomIds={p.atomIds} active={i === active} draft={writing?.drafts[i]} />;
          })}
          {!writing && mechAtoms.length ? (
            <details className="mechanical" id="mechanical">
              <summary>
                Mechanical changes{" "}
                <span className="muted">
                  · {mechAtoms.length} item{mechAtoms.length === 1 ? "" : "s"}, {mechLines} line{mechLines === 1 ? "" : "s"}
                </span>
              </summary>
              <p className="muted">Formatting, renames, import reshuffles, lockfiles and generated files. Every line is here so nothing in the PR goes unseen.</p>
              {mechAtoms.map((a) => (
                <div className="mech-item" key={a.id}>
                  <span className="tag">{a.mechanical}</span>
                  <AtomBlock atom={a} />
                </div>
              ))}
            </details>
          ) : null}
          <footer>{footer}</footer>
        </main>
      </div>
      </AskProvider>
    </StoryCtx.Provider>
  );
}
