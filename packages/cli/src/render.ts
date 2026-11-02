import {
  atomLabel,
  atomSnippet,
  contextCaption,
  lineCounts,
  READER_CSS,
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
${READER_CSS}
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
