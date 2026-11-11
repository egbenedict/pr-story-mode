/** Stylesheet shared by the HTML preview (CLI) and the extension reader. */
export const READER_CSS = `:root {
  --bg: #fbfaf8; --panel: #ffffff; --ink: #1d1d1b; --muted: #6b6a66; --line: #e6e3dd; --accent: #c2410c; --on-accent: #ffffff;
  --add-bg: #e9f6ec; --add-ink: #1a6b34; --del-bg: #fbeaea; --del-ink: #a12a2a; --ctx-bg: #f4f2ee; --code: #26251f;
  --mark-bg: #fdf1b8; --mark-ink: #8a6100;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161614; --panel: #1e1e1b; --ink: #ecebe6; --muted: #9b9a93; --line: #34332e; --accent: #fb923c; --on-accent: #1f1307;
    --add-bg: #15301e; --add-ink: #7fd69a; --del-bg: #3a1a1a; --del-ink: #f2a0a0; --ctx-bg: #22221f; --code: #e3e2dc;
    --mark-bg: #3d3412; --mark-ink: #f5cf55; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: var(--text-size, 15px)/1.6 var(--sans); }
a { color: var(--accent); }
code { font: 0.9em var(--mono); background: var(--ctx-bg); padding: 0.05em 0.3em; border-radius: 4px; }
.layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); max-width: 1320px; margin: 0 auto; }
.rail { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 28px 16px 28px 20px; border-right: 1px solid var(--line); }
.rail h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 8px; }
.progress { height: 4px; background: var(--line); border-radius: 2px; margin: 0 0 6px; overflow: hidden; }
.progress > div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }
.progress-text { font-size: 12px; color: var(--muted); margin-bottom: 16px; }
/* Outline rows: a 16px box (checkbox or status) centred on the first 20px line, then the number in
   its own column so wrapped labels hang under the label, not under the number. */
.rail ol { list-style: none; padding: 0; margin: 0 -8px; display: grid; gap: 1px; }
.rail li { display: grid; grid-template-columns: 16px minmax(0, 1fr); column-gap: 8px; align-items: start; padding: 4px 8px; border-radius: 7px; font-size: 13px; line-height: 20px; }
.rail li:hover { background: color-mix(in srgb, var(--ink) 5%, transparent); }
.rail li:has(a.current) { background: color-mix(in srgb, var(--accent) 9%, transparent); }
.rail li > input, .rail li > .rail-state, .rail li > .rail-spacer { width: 16px; height: 16px; margin: 2px 0 0; box-sizing: border-box; }
.rail li > input { appearance: none; -webkit-appearance: none; border: 1.5px solid color-mix(in srgb, var(--muted) 55%, transparent); border-radius: 4px; background: var(--panel); cursor: pointer; transition: background-color .15s, border-color .15s; }
.rail li > input:hover { border-color: var(--accent); }
.rail li > input:checked { background: var(--accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-6.5' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 11px no-repeat; border-color: var(--accent); }
.rail li > input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.rail li a { color: var(--ink); text-decoration: none; display: grid; grid-template-columns: 22px minmax(0, 1fr); min-width: 0; }
.rail li a .n { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; padding-right: 8px; }
.rail li a > span:last-child { overflow-wrap: anywhere; }
.rail li a code { font-size: 0.86em; line-height: 1; padding: 1px 4px; border-radius: 4px; }
.rail li a.current { color: var(--accent); font-weight: 600; }
.rail li a.current .n { color: var(--accent); }
.rail li.done a { color: var(--muted); }
.rail li.done a > span:last-child { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted) 70%, transparent); }
main { padding: 36px 40px 80px; min-width: 0; }
header h1 { font-size: 26px; line-height: 1.25; margin: 0 0 6px; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
.summary { font-size: calc(var(--text-size, 15px) + 2px); max-width: 72ch; margin: 0 0 36px; }
.summary p { margin: 0 0 10px; }
.step { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 14px; margin-bottom: 44px; scroll-margin-top: 16px; }
.step-marker { width: 28px; height: 28px; border-radius: 50%; border: 1.5px solid var(--line); display: grid; place-items: center; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; margin-top: 2px; }
.step.done .step-marker { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
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
/* Code that carries straight on from the chunk above (next lines of the same file) reads as one block. */
.atom.chunk.joined { margin-top: 0; border-top: 1px dashed var(--line); border-top-left-radius: 0; border-top-right-radius: 0; }
.atom.chunk:has(+ .atom.chunk.joined) { border-bottom: 0; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.atom-head.joined-head { border-bottom: 0; padding: 2px 12px 0; font-size: 11.5px; color: var(--muted); }
.atom-head.joined-head .sym { font-weight: 400; }
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
/* Raw diff shows only the code, as GitHub's Files view does: no explanations or unchanged context. */
.step.show-raw .walk, .step.show-raw details.context, .step.show-raw .override { display: none; }
.raw-label { margin: 0 0 8px; font-weight: 600; }
.diff { width: 100%; border-collapse: collapse; font: var(--code-size, 12.5px)/1.5 var(--mono); color: var(--code); tab-size: 4; }
.diff.raw { display: none; }
.rawview .diff.raw, .atom.show-raw .diff.raw { display: table; }
.atom.show-raw .diff.story { display: none; }
.diff td { padding: 0 10px; vertical-align: top; }
.diff .ln { width: 1%; min-width: 3.2em; text-align: right; color: var(--muted); user-select: none; font-size: calc(var(--code-size, 12.5px) - 1px); opacity: .8; }
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
.fold-btn code { font-size: 0.95em; background: none; padding: 0; }
.fold-btn.deleted { padding: 6px 12px; font-size: 12.5px; color: var(--del-ink); background: var(--del-bg); }
.fold-btn.deleted:hover { color: var(--del-ink); text-decoration: underline; }
.diff tbody.expand td { background: var(--ctx-bg); padding: 1px 10px; }
.expand-btn { all: unset; cursor: pointer; padding: 1px 4px; border-radius: 4px; font: 11.5px var(--sans); color: var(--muted); }
.expand-btn:hover, .expand-btn:focus-visible { color: var(--accent); }
.expand-gap { display: inline-flex; gap: 16px; align-items: center; }
.diff tr.other { opacity: 0.55; }
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
/* Unchanged code is highlighted in marker yellow, so it never reads as a deletion. */
.diff.ctx tr.focus td.code { color: var(--ink); background: var(--mark-bg); }
.diff.ctx tr.focus td.ln { color: var(--mark-ink); opacity: 1; }
.diff.ctx tr.hl td { box-shadow: inset 3px 0 0 var(--mark-ink); }
.diff.ctx tr.hl td.code { background: var(--mark-bg); color: var(--ink); }
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
`;
