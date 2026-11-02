import {
  atomLabel,
  atomSnippet,
  contextCaption,
  lineCounts,
  reindentRuns,
  walkthrough,
  type ChangeAtom,
  type Citation,
  type ContextSnippet,
  type PRInput,
  type PipelineResult,
  type SnippetRow,
  type WalkChunk,
} from "@prstory/core";

export type RenderOptions = {
  /** Link to a line in GitHub's Files view, when the PR came from GitHub. */
  githubLink?: (file: string, side: "LEFT" | "RIGHT", line: number) => string;
  costUsd?: number | null;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Escape, then turn `code` spans into <code>. */
const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

/** Model text → paragraphs, with "- item" lines rendered as a list. `tail` is appended to the last block. */
function blocks(text: string, tail = ""): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
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
  if (!out.length) return tail ? `<p>${tail}</p>` : "";
  if (tail) {
    const last = out[out.length - 1];
    out[out.length - 1] = last.endsWith("</p>") ? `${last.slice(0, -4)} ${tail}</p>` : `${last}<p>${tail}</p>`;
  }
  return out.join("");
}

const FOLD_MIN = 4; // re-indented runs at least this long collapse into one row

/** Self-contained HTML preview of a story: summary, one continuous scroll of steps, outline rail. */
export function renderStoryHtml(pr: PRInput, result: PipelineResult, opts: RenderOptions = {}): string {
  const { story, atoms, coverage, metrics } = result;
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const files = new Map(pr.files.map((f) => [f.path, f]));
  const snippets = new Map<string, SnippetRow[]>(atoms.map((a) => [a.id, atomSnippet(files.get(a.file), a)]));
  const storageKey = `prstory:${pr.repo ?? "local"}:${story.headSha}`;

  const row = (r: SnippetRow) => {
    if (r.type === "gap") return `<tr class="gap"><td colspan="3">⋯</td></tr>`;
    const shown = r.type === "del" ? r.oldLine : r.newLine;
    const sign = r.type === "add" ? "+" : r.type === "del" ? "−" : r.type === "reindent" ? "~" : "";
    const old = r.type === "add" ? "" : (r.oldLine ?? "");
    const neu = r.type === "del" ? "" : (r.newLine ?? "");
    const o = r.type === "reindent" ? ` data-o="${r.oldLine}"` : "";
    return `<tr class="${r.type}" data-n="${shown}"${o}><td class="ln">${old}</td><td class="ln">${neu}</td><td class="code"><span class="sign">${sign}</span>${esc(r.text) || " "}</td></tr>`;
  };

  const diffTable = (atomId: string, rows: SnippetRow[], cls = "") => {
    const parts: string[] = [];
    let plain: string[] = [];
    const flush = () => {
      if (plain.length) parts.push(`<tbody>${plain.join("")}</tbody>`);
      plain = [];
    };
    const runs = new Map(reindentRuns(rows, FOLD_MIN).map(([a, b, c]) => [a, [b, c]]));
    for (let i = 0; i < rows.length; i++) {
      const run = runs.get(i);
      if (run) {
        const [end, n] = run;
        flush();
        parts.push(
          `<tbody class="fold-toggle"><tr><td colspan="3"><button type="button" class="fold-btn" aria-expanded="false">~ ${n} lines re-indented, otherwise unchanged · show</button></td></tr></tbody>`,
          `<tbody class="fold-body">${rows.slice(i, end + 1).map(row).join("")}</tbody>`,
        );
        i = end;
      } else plain.push(row(rows[i]));
    }
    flush();
    return `<table class="diff ${cls}" data-atom="${atomId}">${parts.join("")}</table>`;
  };

  const rawHunks = (atom: ChangeAtom) => {
    const f = files.get(atom.file);
    if (!f) return "";
    const mine = new Set(atom.hunkLines.map((r) => `${r.side}${r.line}`));
    const rows: SnippetRow[] = [];
    for (const h of f.hunks) {
      const hit = h.lines.some((l) => (l.type === "del" ? mine.has(`LEFT${l.oldLine}`) : l.type === "add" ? mine.has(`RIGHT${l.newLine}`) : false));
      if (!hit) continue;
      if (rows.length) rows.push({ type: "gap" });
      for (const l of h.lines) rows.push({ ...l });
    }
    return diffTable(atom.id, rows, "raw");
  };

  const atomHead = (atom: ChangeAtom, continued: boolean, extra = "") => {
    const sym = atomLabel(atom).slice(atom.file.length).replace(/^ › /, "");
    if (continued) {
      return `<div class="atom-head cont"><span class="path">${esc(atom.file)}</span>${sym ? `<span class="sym">${esc(sym)}</span>` : ""}<span class="muted">continued</span></div>`;
    }
    const { add, del } = lineCounts(atom);
    const first = atom.hunkLines.find((r) => r.side === "RIGHT") ?? atom.hunkLines[0];
    const gh = opts.githubLink && first ? `<a class="gh" href="${esc(opts.githubLink(atom.file, first.side, first.line))}" target="_blank" rel="noopener">Open in Files view ↗</a>` : "";
    return `<div class="atom-head"><span class="path">${esc(atom.file)}</span>${sym ? `<span class="sym">${esc(sym)}</span>` : ""}<span class="counts"><span class="plus">+${add}</span> <span class="minus">−${del}</span></span>${gh}${extra}</div>`;
  };

  const emptyNote = (atom: ChangeAtom) => `<p class="empty">${atom.kind === "renamed" ? "File renamed without content changes." : "Binary file changed."}</p>`;

  /** A whole atom with its own raw-diff toggle (mechanical list and raw view). */
  const atomBlock = (atom: ChangeAtom, withToggle = true) => {
    const rows = snippets.get(atom.id) ?? [];
    const toggle = withToggle && rows.length ? `<button class="raw-toggle" type="button">Raw diff</button>` : "";
    return `<div class="atom" id="atom-${atom.id}">
  ${atomHead(atom, false, toggle)}
  ${rows.length ? diffTable(atom.id, rows, "story") + (withToggle ? rawHunks(atom) : "") : emptyNote(atom)}
</div>`;
  };

  const chunkBlock = (c: WalkChunk) => {
    const atom = byId.get(c.atomId);
    if (!atom) return "";
    return `<div class="atom chunk"${c.first ? ` id="atom-${atom.id}"` : ""}>${atomHead(atom, !c.first)}${diffTable(atom.id, c.rows, "story")}</div>`;
  };

  const citeLinks = (cites: Citation[]) =>
    cites
      .map((c) => {
        const range = c.lines[0] === c.lines[1] ? `L${c.lines[0]}` : `L${c.lines[0]}–${c.lines[1]}`;
        if (c.file) {
          const short = c.file.split("/").pop();
          return `<a class="cite ctx" href="#" data-file="${esc(c.file)}" data-from="${c.lines[0]}" data-to="${c.lines[1]}" title="Unchanged code in ${esc(c.file)}">${esc(short ?? "")} ${range}</a>`;
        }
        return `<a class="cite" href="#atom-${c.atomId}" data-atom="${c.atomId}" data-from="${c.lines[0]}" data-to="${c.lines[1]}">${range}</a>`;
      })
      .join("");

  const CONTEXT_OPEN_MAX = 3; // longer context snippets start collapsed; a citation opens them
  const contextBlock = (c: ContextSnippet) => {
    const focus = new Set(c.focus ?? []);
    const head = c.head
      ? `<tr class="ctx-open" data-n="${c.head.line}"><td class="ln">${c.head.line}</td><td class="code">${esc(c.head.text) || " "}</td></tr><tr class="gap"><td colspan="2">⋯ ${c.start - c.head.line - 1} line${c.start - c.head.line - 1 === 1 ? "" : "s"}</td></tr>`
      : "";
    const rows =
      head +
      c.code
        .split("\n")
        .map((l, i) => `<tr data-n="${c.start + i}"${focus.has(c.start + i) ? ' class="focus"' : ""}><td class="ln">${c.start + i}</td><td class="code">${esc(l) || " "}</td></tr>`)
        .join("");
    const n = c.end - c.start + 1;
    const caption = contextCaption(c).replace(/^./, (ch) => ch.toUpperCase());
    return `<details class="context"${n <= CONTEXT_OPEN_MAX ? " open" : ""}><summary class="context-head"><span class="tag-unchanged">Unchanged</span> ${inline(caption)} <span class="path">${esc(c.file)} · L${c.start}–${c.end}</span></summary><table class="diff ctx" data-file="${esc(c.file)}">${rows}</table></details>`;
  };

  const steps = story.steps
    .map((s, i) => {
      const stepAtoms = s.atomIds.map((id) => byId.get(id)).filter((a): a is ChangeAtom => !!a);
      const { beats } = walkthrough(s, snippets);
      const walk = beats
        .map((b) => {
          const cites = citeLinks(b.cites);
          const text = blocks(b.text, cites ? `<span class="cites">${cites}</span>` : "");
          return `<div class="beat">${text ? `<div class="beat-text">${text}</div>` : ""}${b.code.map(chunkBlock).join("")}</div>`;
        })
        .join("");
      const empties = stepAtoms.filter((a) => !(snippets.get(a.id) ?? []).length).map((a) => `<div class="atom" id="atom-${a.id}">${atomHead(a, false)}${emptyNote(a)}</div>`).join("");
      const hasCode = stepAtoms.some((a) => (snippets.get(a.id) ?? []).length);
      const override = s.orderOverride ? `<p class="override">Placed before code it depends on: ${inline(s.orderOverride)}</p>` : "";
      const context = (s.context ?? []).map(contextBlock).join("");
      return `<section class="step" id="step-${i + 1}" data-step="${i + 1}">
  <div class="step-marker" aria-hidden="true">${i + 1}</div>
  <div class="step-body">
    ${hasCode ? `<div class="step-tools"><button class="step-raw" type="button" aria-pressed="false">Raw diff</button></div>` : ""}
    ${override}
    ${context}
    <div class="walk">${walk}${empties}</div>
    <div class="rawview">${stepAtoms.filter((a) => (snippets.get(a.id) ?? []).length).map((a) => `<div class="atom">${atomHead(a, false)}${rawHunks(a)}</div>`).join("")}</div>
  </div>
</section>`;
    })
    .join("\n");

  const mechAtoms = story.mechanical.map((id) => byId.get(id)).filter((a): a is ChangeAtom => !!a);
  const mechLines = mechAtoms.reduce((n, a) => n + a.hunkLines.length, 0);
  const mechanical = mechAtoms.length
    ? `<details class="mechanical" id="mechanical">
  <summary>Mechanical changes <span class="muted">· ${mechAtoms.length} item${mechAtoms.length === 1 ? "" : "s"}, ${mechLines} line${mechLines === 1 ? "" : "s"}</span></summary>
  <p class="muted">Formatting, renames, import reshuffles, lockfiles and generated files. Every line is here so nothing in the PR goes unseen.</p>
  ${mechAtoms.map((a) => `<div class="mech-item"><span class="tag">${a.mechanical}</span>${atomBlock(a)}</div>`).join("")}
</details>`
    : "";

  const outline = story.steps
    .map((s, i) => `<li><input type="checkbox" data-step="${i + 1}" aria-label="Mark step ${i + 1} reviewed"><a href="#step-${i + 1}" data-step="${i + 1}"><span class="n">${i + 1}</span><span>${inline(s.label)}</span></a></li>`)
    .join("");

  const cost = opts.costUsd != null ? ` · ~$${opts.costUsd.toFixed(opts.costUsd < 1 ? 3 : 2)}` : "";
  const prLink = pr.url ? `<a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.repo ?? "")}#${pr.number}</a>` : esc(pr.repo ?? "local diff");
  const coverageText = coverage.ok
    ? `All ${coverage.totalLines} changed lines are shown exactly once.`
    : `Coverage check failed: ${coverage.missing.length} missing, ${coverage.duplicated.length} duplicated lines.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PR Story · ${esc(pr.title)}</title>
<style>
:root {
  --bg: #fbfaf8; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6a66; --line: #e6e3dd; --accent: #c2410c;
  --add-bg: #e9f6ec; --add-ink: #1a6b34; --del-bg: #fbeaea; --del-ink: #a12a2a; --ctx-bg: #f4f2ee; --code: #26251f;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161614; --panel: #1e1e1b; --ink: #ecebe6; --muted: #9b9a93; --line: #34332e; --accent: #fb923c;
    --add-bg: #15301e; --add-ink: #7fd69a; --del-bg: #3a1a1a; --del-ink: #f2a0a0; --ctx-bg: #22221f; --code: #e3e2dc; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 var(--sans); }
a { color: var(--accent); }
code { font: 0.9em var(--mono); background: var(--ctx-bg); padding: 0.05em 0.3em; border-radius: 4px; }
.layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); max-width: 1320px; margin: 0 auto; }
.rail { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 28px 16px 28px 20px; border-right: 1px solid var(--line); }
.rail h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 8px; }
.progress { height: 4px; background: var(--line); border-radius: 2px; margin: 0 0 6px; overflow: hidden; }
.progress > div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
.progress-text { font-size: 12px; color: var(--muted); margin-bottom: 16px; }
.rail ol { list-style: none; padding: 0; margin: 0; }
.rail li { display: flex; gap: 8px; align-items: flex-start; padding: 3px 0; font-size: 13px; line-height: 1.4; }
.rail li input { margin-top: 2px; accent-color: var(--accent); }
.rail li a { color: var(--ink); text-decoration: none; display: flex; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.rail li a code { font-size: 0.85em; padding: 0 0.2em; }
.rail li a .n { color: var(--muted); min-width: 1.6em; font-variant-numeric: tabular-nums; }
.rail li a.current { color: var(--accent); font-weight: 600; }
.rail li.done a { color: var(--muted); text-decoration: line-through; }
main { padding: 36px 40px 80px; min-width: 0; }
header h1 { font-size: 26px; line-height: 1.25; margin: 0 0 6px; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
.summary { font-size: 17px; max-width: 72ch; margin: 0 0 36px; }
.summary p { margin: 0 0 10px; }
.step { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 14px; margin-bottom: 44px; scroll-margin-top: 16px; }
.step-marker { width: 28px; height: 28px; border-radius: 50%; border: 1.5px solid var(--line); display: grid; place-items: center; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; margin-top: 2px; }
.step.done .step-marker { background: var(--accent); border-color: var(--accent); color: #fff; }
.step-body { min-width: 0; }
.step-tools { float: right; margin: 2px 0 6px 12px; }
.beat + .beat { margin-top: 18px; }
.beat-text { max-width: 72ch; }
.beat-text p { margin: 0 0 8px; }
.beat-text ul { margin: 0 0 8px; padding-left: 1.3em; }
.cites { white-space: nowrap; }
.cite { font: 11px var(--mono); text-decoration: none; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; margin-left: 2px; color: var(--muted); }
.cite:hover { color: var(--accent); border-color: var(--accent); }
.override { font-size: 13px; color: var(--muted); border-left: 2px solid var(--accent); padding-left: 10px; max-width: 72ch; }
.atom { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin: 10px 0 0; overflow: hidden; }
.atom-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; padding: 7px 12px; border-bottom: 1px solid var(--line); font-size: 12.5px; }
.atom-head.cont { padding: 3px 12px; font-size: 11.5px; color: var(--muted); }
.atom-head.cont .sym { font-weight: 400; }
.atom-head .path { font-family: var(--mono); }
.atom-head .sym { font-family: var(--mono); font-weight: 600; }
.atom-head .sym::before { content: "› "; color: var(--muted); font-weight: 400; }
.counts { font-family: var(--mono); font-size: 12px; }
.plus { color: var(--add-ink); } .minus { color: var(--del-ink); }
.gh { margin-left: auto; font-size: 12px; text-decoration: none; }
.raw-toggle, .step-raw { font: 12px var(--sans); background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 4px; padding: 1px 8px; cursor: pointer; }
.atom-head .counts + .raw-toggle { margin-left: auto; }
.raw-toggle[aria-pressed="true"], .step-raw[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
.rawview { display: none; }
.step.show-raw .rawview { display: block; }
.step.show-raw .walk .atom { display: none; }
.diff { width: 100%; border-collapse: collapse; font: 12.5px/1.5 var(--mono); color: var(--code); tab-size: 4; }
.diff.raw { display: none; }
.rawview .diff.raw, .atom.show-raw .diff.raw { display: table; }
.atom.show-raw .diff.story { display: none; }
.diff td { padding: 0 10px; vertical-align: top; }
.diff .ln { width: 1%; min-width: 3.2em; text-align: right; color: var(--muted); user-select: none; font-size: 11.5px; opacity: .8; }
.diff .code { white-space: pre-wrap; word-break: break-word; }
.diff .sign { display: inline-block; width: 1.2em; user-select: none; }
.diff tr.add { background: var(--add-bg); } .diff tr.add .sign { color: var(--add-ink); }
.diff tr.del { background: var(--del-bg); } .diff tr.del .sign { color: var(--del-ink); }
.diff tr.reindent { background: var(--ctx-bg); } .diff tr.reindent .sign { color: var(--muted); }
.diff tr.gap td { color: var(--muted); text-align: center; background: var(--ctx-bg); font-size: 11px; }
.diff tbody.fold-body { display: none; }
.diff tbody.fold-body.open { display: table-row-group; }
.fold-btn { all: unset; cursor: pointer; display: block; width: 100%; padding: 2px 10px; font: 11.5px var(--sans); color: var(--muted); background: var(--ctx-bg); }
.fold-btn:hover { color: var(--accent); }
.diff tr.hl td { box-shadow: inset 3px 0 0 var(--accent); }
.diff tr.hl td.code { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.empty { margin: 0; padding: 10px 12px; color: var(--muted); font-size: 13px; }
.context { margin: 0 0 12px; border: 1px dashed var(--line); border-radius: 8px; overflow: hidden; background: var(--bg); }
.context + .context { margin-top: -4px; }
.context-head { font-size: 12.5px; color: var(--muted); padding: 5px 12px; background: var(--ctx-bg); cursor: pointer; list-style-position: inside; }
.context-head code { font-size: 0.88em; background: none; padding: 0; color: var(--ink); }
.context-head .path { font: 11.5px var(--mono); margin-left: 6px; opacity: .85; }
.tag-unchanged { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; margin-right: 4px; }
.diff.ctx { color: var(--muted); }
.diff.ctx .code { padding-left: 14px; }
.diff.ctx tr.focus td.code { color: var(--ink); background: color-mix(in srgb, var(--accent) 7%, transparent); }
.diff.ctx tr.focus td.ln { color: var(--accent); opacity: 1; }
.diff.ctx tr.ctx-open td.code { color: var(--ink); }
.cite.ctx { border-style: dashed; }
.mechanical { margin: 48px 0 0 50px; border-top: 1px solid var(--line); padding-top: 16px; }
.mechanical summary { cursor: pointer; font-weight: 600; }
.tag { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-top: 14px; }
.muted { color: var(--muted); font-weight: 400; }
footer { margin: 48px 0 0 50px; font-size: 12.5px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 14px; }
@media (max-width: 860px) {
  .layout { display: block; }
  .rail { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 16px; }
  main { padding: 20px 16px 60px; }
  .step { grid-template-columns: 1fr; gap: 6px; }
  .mechanical, footer { margin-left: 0; }
}
</style>
</head>
<body>
<div class="layout">
<nav class="rail" aria-label="Story outline">
  <h2>Outline</h2>
  <div class="progress"><div></div></div>
  <div class="progress-text"></div>
  <ol>${outline}${mechAtoms.length ? `<li><span style="width:13px"></span><a href="#mechanical"><span class="n">·</span>Mechanical changes</a></li>` : ""}</ol>
</nav>
<main>
<header>
  <h1>${inline(pr.title)}</h1>
  <p class="sub">${prLink}${(pr.issues ?? []).map((i) => ` · fixes <a href="${esc(i.url ?? "#")}" target="_blank" rel="noopener">#${i.number}</a> ${inline(i.title)}`).join("")} · head ${esc(story.headSha.slice(0, 7))} · ${story.steps.length} steps · ${metrics.changedLines} changed lines</p>
  <div class="summary">${blocks(story.summary)}</div>
</header>
${steps}
${mechanical}
<footer>
  ${esc(coverageText)}<br>
  Generated with ${esc(story.meta.provider === "none" ? "no LLM (dependency order and template text)" : `${story.meta.provider} · ${story.meta.model}`)} · ${story.meta.tokens.toLocaleString()} tokens${cost} · ${story.meta.repairRounds} repair round${story.meta.repairRounds === 1 ? "" : "s"}${metrics.fallbackOrder && story.meta.provider !== "none" ? " · fell back to dependency order" : ""}
</footer>
</main>
</div>
<script>
(() => {
  const KEY = ${JSON.stringify(storageKey)};
  let done = {};
  try { done = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
  const boxes = [...document.querySelectorAll('.rail input[type=checkbox]')];
  const total = boxes.length;
  const paint = () => {
    let n = 0;
    for (const b of boxes) {
      const s = b.dataset.step, on = !!done[s];
      b.checked = on; if (on) n++;
      b.closest('li').classList.toggle('done', on);
      document.getElementById('step-' + s)?.classList.toggle('done', on);
    }
    document.querySelector('.progress > div').style.width = total ? (100 * n / total) + '%' : '0';
    document.querySelector('.progress-text').textContent = n + ' of ' + total + ' steps reviewed';
  };
  for (const b of boxes) b.addEventListener('change', () => {
    done[b.dataset.step] = b.checked;
    try { localStorage.setItem(KEY, JSON.stringify(done)); } catch {}
    paint();
  });
  paint();

  for (const btn of document.querySelectorAll('.step-raw')) btn.addEventListener('click', () => {
    const on = btn.closest('.step').classList.toggle('show-raw');
    btn.setAttribute('aria-pressed', on);
  });
  for (const btn of document.querySelectorAll('.raw-toggle')) btn.addEventListener('click', () => {
    const on = btn.closest('.atom').classList.toggle('show-raw');
    btn.setAttribute('aria-pressed', on);
  });

  const setFold = (btn, open) => {
    const body = btn.closest('tbody').nextElementSibling;
    body.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open);
    btn.textContent = btn.textContent.replace(/· (show|hide)$/, '· ' + (open ? 'hide' : 'show'));
  };
  for (const btn of document.querySelectorAll('.fold-btn')) btn.addEventListener('click', () => setFold(btn, btn.getAttribute('aria-expanded') !== 'true'));

  for (const c of document.querySelectorAll('.cite')) c.addEventListener('click', (e) => {
    e.preventDefault();
    const step = c.closest('.step');
    step?.classList.remove('show-raw');
    step?.querySelector('.step-raw')?.setAttribute('aria-pressed', 'false');
    const from = +c.dataset.from, to = +c.dataset.to;
    document.querySelectorAll('tr.hl').forEach((r) => r.classList.remove('hl'));
    let first = null;
    const scope = step || document;
    const rows = c.dataset.file
      ? [...scope.querySelectorAll('table.ctx')].filter((t) => t.dataset.file === c.dataset.file).flatMap((t) => [...t.querySelectorAll('tr[data-n]')])
      : scope.querySelectorAll('.walk table.diff[data-atom="' + c.dataset.atom + '"] tr[data-n]');
    for (const r of rows) {
      const n = +r.dataset.n, o = r.dataset.o ? +r.dataset.o : NaN;
      if ((n >= from && n <= to) || (o >= from && o <= to)) {
        r.classList.add('hl');
        first ??= r;
        const det = r.closest('details');
        if (det) det.open = true;
        const fold = r.closest('tbody.fold-body');
        if (fold && !fold.classList.contains('open')) setFold(fold.previousElementSibling.querySelector('.fold-btn'), true);
      }
    }
    (first || document.getElementById('atom-' + c.dataset.atom))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  const links = new Map([...document.querySelectorAll('.rail a[data-step]')].map((a) => [a.dataset.step, a]));
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) {
      links.forEach((a) => a.classList.remove('current'));
      links.get(en.target.dataset.step)?.classList.add('current');
    }
  }, { rootMargin: '-20% 0px -70% 0px' });
  document.querySelectorAll('.step').forEach((s) => io.observe(s));
})();
</script>
</body>
</html>
`;
}
