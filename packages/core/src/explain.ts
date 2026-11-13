import { addUsage, completeJson, estimateTokens, prHeader } from "./llm";
import { fallbackLabel } from "./order";
import { partialStrings, streamedArray, throttle } from "./partial-json";
import { atomLabel, atomSnippet, lineCounts, rowNumber, snippetText, type SnippetRow } from "./snippet";
import { promptCollapses } from "./collapse";
import { countWords, stepWordBudget, type Detail } from "./length";
import type { Beat, ChangeAtom, Citation, ContextSnippet, JSONSchema, LLMProvider, PRInput, StoryStep } from "./types";
import type { Plan } from "./validate";

export const EXPLAIN_SYSTEM = `You have studied this pull request closely, and you are sitting next to a reviewer walking them through the code, one step at a time in a fixed order. You did not write the pull request: someone else did.

Explain each step as a sequence of short beats. A beat is one to three sentences followed by the lines of code they talk about: the reader sees your words, then exactly those lines, then your next beat.

Voice: walk through the code with the reader using "we", as in "Here we check the flag before touching the table, then we presize it to the final count." "We" means you and the reader going through the code together. Never use "I", "my" or "our", and never claim to have written, tested or decided anything.

What to write: say what the code does, in the order it does it, and why. Lead with the action and its purpose: "Here we repoint \`target\` to the new array so the old one can be freed. We then walk every pointer and…". Be direct:
- Use concrete verbs and name the variables, functions and values involved.
- Give the reason in the same sentence when the code or the description makes it clear. When it doesn't, describe what the code does and leave the reason out rather than guessing.
- For changed code, say what it did before and what it does now when that difference is the point.
- Mention an edge case or a risk only when the code shows it concretely. Do not invent problems or add review advice.
- Skip lines that need no explanation (imports, plain assignments, calls whose names say it all) rather than narrating them.
- No filler: don't restate the step's label, don't open with "This step…" or "This change…", don't summarize at the end, and don't use phrases like "Note that", "It's worth noting", "Importantly" or "essentially".
  For example, instead of "This step introduces the optimized path. It sets up \`end\`, \`spanStart\` and \`numMatches\` and keeps the existing comment about \`memchr\`. It's worth noting the path is gated behind a flag.", write "Here we take the new path only when \`LuauOptimizeStringSplit\` is on. For a one-byte separator we first count matches with \`memchr\`, so we can create the table at its final size, then walk the string again and store each piece with \`lua_rawseti\`."

How beats work:
- Go through each step's snippet from top to bottom. If a step has several atoms, take them in the order shown.
- Open each step with what it does and, if it builds on an earlier step, how. Keep that to one sentence.
- End each beat at the last line it covers by setting \`throughAtomId\` and \`throughLine\` (the number at the left of that line). The next beat picks up on the following line. Start a new beat where the code moves on to the next thing it does, such as a separate branch, loop or phase. One beat can cover 40 or more lines of straightforward code, and a step with fewer than about 20 changed lines is usually a single beat. Cut only at the end of a whole statement or block, never partway through one, and never leave a closing bracket or an atom's last line or two for a beat of their own.
- The last beat of a step runs to the end of its snippet. Leave \`throughAtomId\` empty and \`throughLine\` 0 only for a beat that needs no code.
- Each step's heading gives a rough word count for its explanation, scaled to the size of its change. It is a target, not a quota: write less when the code is simple.
- Lines marked \`~\` changed only in indentation. Say so in a short clause instead of explaining them again.
- Write plain sentences: no headings, bullet lists or dramatic framing. Put identifiers, flags, file names and literal values in backticks.
- \`cites\` lists the lines a beat discusses, as the atom ID with the first and last line number. Cite only atoms shown in this request. Set each citation's \`phrase\` to the words in your text that refer to those lines, copied exactly (a few words, such as "count matches with \`memchr\`"); the reader turns that phrase into a link to the lines. Cite the specific lines each phrase is about, so a sentence that walks through several parts of the code links each part.
- Some steps come with unchanged code the PR did not touch, labeled C1, C2 and so on: a definition the step uses, an existing caller of something the step changes, or the class the code sits in. The reader sees it just above the step. Use it where it explains the change, for example what a called helper returns or which existing callers a new behavior reaches, and cite it with its label (\`atomId\` "C2") and its line numbers. In your text, refer to that code by name, never by its label. Don't walk through the context itself, and never end a beat on a context line. In context, \`>\` marks the lines that mention the linking symbol, and a line followed by \`…\` is the opening line of the code the snippet comes from.`;

/**
 * Added after EXPLAIN_SYSTEM for More detail. Standard sends EXPLAIN_SYSTEM alone, unchanged.
 * Same kind of walkthrough, with more of the changed lines tied to the words about them.
 */
export const EXPLAIN_MORE_DETAIL = `More detail: the reader asked for a more thorough walkthrough. Keep the same voice, kind of explanation and beat rules, with these changes:
- Cover nearly every changed line. Instead of skipping lines that need no explanation, give them a short clause, grouping the simple ones together: "we import \`Parser\` and \`Node\` for the walker below", "then we copy the three options onto the instance". Lines that changed only in indentation still get just a clause.
- Link more of the code: cite each statement, condition, branch or small group of lines that your text talks about, each with its own phrase, so most changed lines are linked from the words that explain them. Keep each citation to the lines its phrase is about instead of stretching one citation over a whole block.
- Where the code is dense, go one level deeper: the parts of a compound condition, a loop's bounds, or what each argument of a call is for when its name doesn't say.
- Add background only when a reader would likely be stuck without it: what an unfamiliar library call, API or language feature does, an assumption the code relies on that the snippet doesn't show, or which other code a change reaches, as the unchanged context shows. Keep it to a short sentence next to the code it concerns. Most steps need none, and no step needs more than one or two. Don't add history, alternatives, style remarks or review advice.
- The word counts in the step headings are larger to make room for this; they are still targets, not quotas. A beat can run to about five sentences, and you can start a new beat a little sooner, but still only at the end of a whole statement or block.`;

/** The system prompt for writing explanations at a detail level. */
export const explainSystem = (detail: Detail = "standard") => (detail === "more" ? `${EXPLAIN_SYSTEM}\n\n${EXPLAIN_MORE_DETAIL}` : EXPLAIN_SYSTEM);

export const EXPLAIN_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "beats"],
        properties: {
          step: { type: "integer" },
          beats: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "cites", "throughAtomId", "throughLine"],
              properties: {
                text: { type: "string" },
                cites: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["atomId", "start", "end", "phrase"],
                    properties: { atomId: { type: "string" }, start: { type: "integer" }, end: { type: "integer" }, phrase: { type: "string" } },
                  },
                },
                throughAtomId: { type: "string" },
                throughLine: { type: "integer" },
              },
            },
          },
        },
      },
    },
  },
};

export type ExplainStats = {
  citations: number;
  groundingFailures: number;
  beats: number;
  badCuts: number; // beat cut points outside the step's atoms or shown lines (the beat keeps its text)
  missingSteps: number;
  tokens: number;
  windows: number;
  /** Words in the explanations the model wrote (template text for missing steps not counted). */
  words: number;
  /** Steps whose explanation the model wrote, so words / explainedSteps is words per step. */
  explainedSteps: number;
};

/** Split steps into windows of consecutive steps that fit the context budget. */
export function windows(stepTexts: string[], budgetTokens: number, maxSteps = 6): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let used = 0;
  stepTexts.forEach((t, i) => {
    const cost = estimateTokens(t);
    if (cur.length && (used + cost > budgetTokens || cur.length >= maxSteps)) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(i);
    used += cost;
  });
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Write explanations window by window. Only the window's atoms are sent, after a shared prefix
 * (PR description and the full step order) that providers with prompt caching reuse.
 * Citations outside the window's atoms or their shown lines are dropped and counted.
 */
export async function explainSteps(
  pr: PRInput,
  atoms: ChangeAtom[],
  plan: Plan,
  provider: LLMProvider | null,
  onStep?: (index: number, step: StoryStep) => void,
  context: ContextSnippet[][] = [],
  /** Steps already explained (from a previous story); only the others are sent to the model. */
  reuse: Map<number, StoryStep> = new Map(),
  /** The text written so far for a step that is still streaming. */
  onDraft?: (index: number, text: string) => void,
  opts: { detail?: Detail } = {},
): Promise<{ steps: StoryStep[]; stats: ExplainStats }> {
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const files = new Map(pr.files.map((f) => [f.path, f]));
  const snippets = new Map<string, SnippetRow[]>(atoms.map((a) => [a.id, atomSnippet(files.get(a.file), a)]));
  const stats: ExplainStats = { citations: 0, groundingFailures: 0, beats: 0, badCuts: 0, missingSteps: 0, tokens: 0, windows: 0, words: 0, explainedSteps: 0 };

  const steps: StoryStep[] = plan.steps.map((s, i) => ({
    atomIds: s.atomIds,
    label: s.label,
    ...(s.orderOverride ? { orderOverride: s.orderOverride } : {}),
    ...(context[i]?.length ? { context: context[i] } : {}),
    explanation: [],
  }));

  // Context snippets are labeled C1, C2, … across the whole story.
  const ctxLabels: { label: string; step: number; snip: ContextSnippet }[] = [];
  context.forEach((list, i) => list?.forEach((snip) => ctxLabels.push({ label: `C${ctxLabels.length + 1}`, step: i, snip })));

  if (!provider) {
    steps.forEach((s, i) => {
      s.explanation = [templateExplanation(s.atomIds.map((id) => byId.get(id)!))];
      onStep?.(i, s);
    });
    return { steps, stats };
  }

  const outline = plan.steps.map((s, i) => `${i + 1}. ${s.label} [${s.atomIds.join(", ")}]`).join("\n");
  const sharedPrefix = `${prHeader(pr)}\n# Summary\n\n${plan.summary}\n\n# Full step order\n\n${outline}`;

  const stepTexts = plan.steps.map((s, i) => {
    const parts = s.atomIds.map((id) => {
      const a = byId.get(id)!;
      const { add, del } = lineCounts(a);
      const rows = snippets.get(id)!;
      const names = a.deletedFile?.names ?? [];
      const what = a.deletedFile ? `the whole file is deleted${names.length ? `; it defined ${names.slice(0, 12).join(", ")}` : ""}` : a.kind;
      return `Atom ${id}: ${atomLabel(a)} (${what}, +${add} −${del})\n\`\`\`\n${snippetText(rows, Infinity, promptCollapses(rows, a))}\n\`\`\``;
    });
    const ctx = ctxLabels.filter((c) => c.step === i).map(({ label, snip }) => `${label}: ${contextCaption(snip)}, \`${snip.file}\` lines ${snip.start}–${snip.end} (unchanged)\n\`\`\`\n${numbered(snip)}\n\`\`\``);
    const words = stepWordBudget(s.atomIds.map((id) => byId.get(id)!), opts.detail);
    return `## Step ${i + 1}: ${s.label} (about ${words} words)${s.orderOverride ? `\n(Placed before its dependencies on purpose: ${s.orderOverride})` : ""}\n\n${parts.join("\n\n")}${ctx.length ? `\n\nUnchanged context for this step:\n\n${ctx.join("\n\n")}` : ""}`;
  });

  const budget = Math.max(2000, Math.floor(provider.capabilities.maxContextTokens * 0.3) - estimateTokens(sharedPrefix));
  const total = { tokens: 0 };

  for (const [i, step] of reuse) {
    steps[i] = step;
    onStep?.(i, step);
  }
  const todo = plan.steps.map((_, i) => i).filter((i) => !reuse.has(i));
  const wins = windows(todo.map((i) => stepTexts[i]), Math.min(budget, 30000)).map((w) => w.map((k) => todo[k]));

  for (const win of wins) {
    stats.windows++;
    const prev = win[0] > 0 ? `The reader has just finished step ${win[0]} (${plan.steps[win[0] - 1].label}).\n\n` : "";
    const consecutive = win.every((i, k) => k === 0 || i === win[k - 1] + 1);
    const which = win.length === 1 ? `step ${win[0] + 1}` : consecutive ? `steps ${win[0] + 1} to ${win[win.length - 1] + 1}` : `steps ${win.slice(0, -1).map((i) => i + 1).join(", ")} and ${win[win.length - 1] + 1}`;
    const content = `${prev}Write the explanations for ${which}.\n\n${win.map((i) => stepTexts[i]).join("\n\n")}`;

    const allowed = new Map<string, [number, number]>();
    for (const i of win) for (const id of plan.steps[i].atomIds) allowed.set(id, shownRange(snippets.get(id)!));
    const ctxAllowed = new Map(ctxLabels.filter((c) => win.includes(c.step)).map((c) => [c.label, c.snip]));
    const done = new Set<number>();

    /** Ground one step's beats and hand it to the reader. */
    const finish = (i: number, beats: unknown[] | undefined) => {
      if (done.has(i)) return;
      done.add(i);
      if (!beats?.length) {
        stats.missingSteps++;
        steps[i].explanation = [templateExplanation(steps[i].atomIds.map((id) => byId.get(id)!))];
      } else {
        stats.explainedSteps++;
        const inStep = new Set(steps[i].atomIds);
        steps[i].explanation = beats.map((p) => {
          const o = p as { text?: unknown; cites?: unknown; throughAtomId?: unknown; throughLine?: unknown };
          stats.beats++;
          if (typeof o.text === "string") stats.words += countWords(o.text);
          let through: Beat["through"];
          if (typeof o.throughAtomId === "string" && o.throughAtomId) {
            const range = inStep.has(o.throughAtomId) ? allowed.get(o.throughAtomId) : undefined;
            const line = o.throughLine;
            if (range && typeof line === "number" && line >= range[0] && line <= range[1]) through = { atomId: o.throughAtomId, line };
            else stats.badCuts++;
          }
          const cites: Citation[] = [];
          for (const c of Array.isArray(o.cites) ? o.cites : []) {
            const { atomId, start, end, phrase } = c as { atomId?: unknown; start?: unknown; end?: unknown; phrase?: unknown };
            // The phrase must appear in the beat's text to become a link.
            const words = typeof phrase === "string" && phrase.trim() && typeof o.text === "string" && o.text.includes(phrase.trim()) ? { phrase: phrase.trim() } : {};
            stats.citations++;
            const range = typeof atomId === "string" ? allowed.get(atomId) : undefined;
            const snip = typeof atomId === "string" ? ctxAllowed.get(atomId) : undefined;
            const ok = (lo: number, hi: number) => typeof start === "number" && typeof end === "number" && start <= end && start >= lo && end <= hi;
            if (range && ok(range[0], range[1])) {
              cites.push({ atomId: atomId as string, lines: [start as number, end as number], ...words });
            } else if (snip && (ok(snip.start, snip.end) || (snip.head && start === snip.head.line && end === snip.head.line))) {
              cites.push({ atomId: "", file: snip.file, lines: [start as number, end as number], ...words });
            } else {
              stats.groundingFailures++;
            }
          }
          return { text: typeof o.text === "string" ? o.text : "", cites, ...(through ? { through } : {}) };
        });
      }
      onStep?.(i, steps[i]);
    };
    const stepBeats = (s: unknown): [number, unknown[]] | null => {
      const o = s as { step?: unknown; beats?: unknown };
      return typeof o?.step === "number" && Array.isArray(o.beats) && win.includes(o.step - 1) ? [o.step - 1, o.beats] : null;
    };

    // While the reply streams, each step goes to the reader as soon as its JSON is complete, and the
    // step being written shows its sentences so far.
    let streamed = "";
    let lastDraft = "";
    const progress = throttle(() => {
      const { items, partial } = streamedArray(streamed, "steps");
      for (const it of items) {
        const sb = stepBeats(it);
        if (sb && sb[1].length) finish(sb[0], sb[1]);
      }
      if (partial && onDraft) {
        const n = /"step"\s*:\s*(\d+)/.exec(partial);
        const i = n ? +n[1] - 1 : -1;
        const text = partialStrings(partial, "text").join("\n\n");
        if (win.includes(i) && !done.has(i) && text !== lastDraft) {
          lastDraft = text;
          onDraft(i, text);
        }
      }
    }, 120);

    let json: unknown;
    try {
      const res = await completeJson(provider, {
        system: explainSystem(opts.detail),
        sharedPrefix,
        messages: [{ role: "user", content }],
        schema: EXPLAIN_SCHEMA,
        maxTokens: 16000,
        onText: (d) => {
          streamed += d;
          progress.run();
        },
      });
      addUsage(total, res.usage);
      json = res.json;
    } catch {
      json = undefined;
    }

    // The final reply decides anything the stream didn't settle.
    const arr = (json as { steps?: unknown[] } | undefined)?.steps;
    const got = new Map<number, unknown[]>();
    if (Array.isArray(arr))
      for (const s of arr) {
        const sb = stepBeats(s);
        if (sb) got.set(sb[0], sb[1]);
      }
    for (const i of win) finish(i, got.get(i));
  }
  stats.tokens = total.tokens;
  return { steps, stats };
}

/** "definition of `clamp`", "a caller of `run` (in `main`)", "the class `Scheduler`". */
export function contextCaption(c: ContextSnippet): string {
  if (c.reason === "definition") return `definition of \`${c.symbol}\``;
  if (c.reason === "caller") return `\`${c.symbol}\` is ${c.called ? "called" : "referenced"}${c.within ? ` in \`${c.within}\`` : " here"}`;
  return `enclosing \`${c.symbol}\``;
}

function numbered(c: ContextSnippet): string {
  const head = c.head ? [`${String(c.head.line).padStart(5)}   ${c.head.text}`, "  …"] : [];
  return [
    ...head,
    ...c.code.split("\n").map((l, k) => `${String(c.start + k).padStart(5)} ${c.focus?.includes(c.start + k) ? ">" : " "} ${l}`),
  ].join("\n");
}

function shownRange(rows: SnippetRow[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    if (r.type === "gap") continue;
    for (const n of [rowNumber(r), r.type === "reindent" ? r.oldLine : undefined]) {
      if (n === undefined) continue;
      lo = Math.min(lo, n);
      hi = Math.max(hi, n);
    }
  }
  return lo === Infinity ? [0, 0] : [lo, hi];
}

/** Deterministic explanation used without a model, or when the model skipped a step. */
export function templateExplanation(atoms: ChangeAtom[]): { text: string; cites: Citation[] } {
  const parts = atoms.map((a) => {
    const { add, del } = lineCounts(a);
    const what = fallbackLabel(a);
    const counts = [add ? `${add} added` : "", del ? `${del} removed` : ""].filter(Boolean).join(", ");
    return `${what} in \`${a.file}\`${counts ? ` (${counts} line${add + del === 1 ? "" : "s"})` : ""}.`;
  });
  const cites: Citation[] = atoms.flatMap((a) => {
    const r = a.headRange ?? a.baseRange;
    return r ? [{ atomId: a.id, lines: [r.start, r.end] as [number, number] }] : [];
  });
  return { text: parts.join(" "), cites };
}
