/** Stylesheet shared by the HTML preview (CLI) and the extension reader. */
export const READER_CSS = `:root {
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
`;
