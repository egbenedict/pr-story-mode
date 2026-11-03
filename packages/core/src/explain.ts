import { addUsage, completeJson, estimateTokens, prHeader } from "./llm";
import { fallbackLabel } from "./order";
import { partialStrings, streamedArray, throttle } from "./partial-json";
import { atomLabel, atomSnippet, lineCounts, rowNumber, snippetText, type SnippetRow } from "./snippet";
import type { Beat, ChangeAtom, Citation, ContextSnippet, JSONSchema, LLMProvider, PRInput, StoryStep } from "./types";
import type { Plan } from "./validate";

export const EXPLAIN_SYSTEM = `You have studied this pull request closely, and you are sitting next to a reviewer walking them through the code, one step at a time in a fixed order. You did not write the pull request: someone else did, and the reader knows that.

Explain each step as a sequence of short beats. A beat is one to three sentences followed by the lines of code they talk about: the reader sees your words, then exactly those lines, then your next beat.

Voice: describe the changes in the third person. Make the code or the PR the subject ("This adds…", "The new branch handles…", "The PR moves the old loop into…"), or say "the author" when intent matters. Never use "I", "we", "my" or "our" for the changes, and never claim to have written, tested or decided anything. Where the description gives the reason for a change, attribute it ("the description says…"); otherwise present reasons as what the code suggests, not as a fact.

- Go through each step's snippet from top to bottom. If a step has several atoms, take them in the order shown.
- End each beat at the last line it covers by setting \`throughAtomId\` and \`throughLine\` (the number at the left of that line). The next beat picks up on the following line. Aim for about 5 to 25 lines per beat, splitting long code at natural boundaries such as a new branch, a loop, or a call to a helper. A short step can be a single beat.
- The last beat of a step runs to the end of its snippet. Leave \`throughAtomId\` empty and \`throughLine\` 0 only for a beat that needs no code, such as a sentence linking to the previous step.
- Say what the code does and why, as concretely as someone who knows the change well: name the variables and calls involved, and point out edge cases, behavior changes and anything a reviewer should check. Do not invent problems.
- Lines marked \`~\` changed only in indentation. Say so briefly instead of explaining them again.
- The first beat of a step follows from the step before; where the topic shifts, make that connection in its first sentence.
- Write plain sentences: no headings, bullet lists or dramatic framing. Put identifiers, flags, file names and literal values in backticks.
- \`cites\` lists the lines a beat discusses, as the atom ID with the first and last line number. Cite only atoms shown in this request.
- Some steps come with unchanged code the PR did not touch, labeled C1, C2 and so on: a definition the step uses, an existing caller of something the step changes, or the class the code sits in. The reader sees it just above the step. Use it where it explains the change, for example what a called helper returns or which existing callers a new behavior reaches, and cite it with its label (\`atomId\` "C2") and its line numbers. Don't walk through the context itself, and never end a beat on a context line. In context, \`>\` marks the lines that mention the linking symbol, and a line followed by \`…\` is the opening line of the code the snippet comes from.`;

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
                    required: ["atomId", "start", "end"],
                    properties: { atomId: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } },
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
): Promise<{ steps: StoryStep[]; stats: ExplainStats }> {
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const files = new Map(pr.files.map((f) => [f.path, f]));
  const snippets = new Map<string, SnippetRow[]>(atoms.map((a) => [a.id, atomSnippet(files.get(a.file), a)]));
  const stats: ExplainStats = { citations: 0, groundingFailures: 0, beats: 0, badCuts: 0, missingSteps: 0, tokens: 0, windows: 0 };

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
      return `Atom ${id}: ${atomLabel(a)} (${a.kind}, +${add} −${del})\n\`\`\`\n${snippetText(snippets.get(id)!)}\n\`\`\``;
    });
    const ctx = ctxLabels.filter((c) => c.step === i).map(({ label, snip }) => `${label}: ${contextCaption(snip)}, \`${snip.file}\` lines ${snip.start}–${snip.end} (unchanged)\n\`\`\`\n${numbered(snip)}\n\`\`\``);
    return `## Step ${i + 1}: ${s.label}${s.orderOverride ? `\n(Placed before its dependencies on purpose: ${s.orderOverride})` : ""}\n\n${parts.join("\n\n")}${ctx.length ? `\n\nUnchanged context for this step:\n\n${ctx.join("\n\n")}` : ""}`;
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
        const inStep = new Set(steps[i].atomIds);
        steps[i].explanation = beats.map((p) => {
          const o = p as { text?: unknown; cites?: unknown; throughAtomId?: unknown; throughLine?: unknown };
          stats.beats++;
          let through: Beat["through"];
          if (typeof o.throughAtomId === "string" && o.throughAtomId) {
            const range = inStep.has(o.throughAtomId) ? allowed.get(o.throughAtomId) : undefined;
            const line = o.throughLine;
            if (range && typeof line === "number" && line >= range[0] && line <= range[1]) through = { atomId: o.throughAtomId, line };
            else stats.badCuts++;
          }
          const cites: Citation[] = [];
          for (const c of Array.isArray(o.cites) ? o.cites : []) {
            const { atomId, start, end } = c as { atomId?: unknown; start?: unknown; end?: unknown };
            stats.citations++;
            const range = typeof atomId === "string" ? allowed.get(atomId) : undefined;
            const snip = typeof atomId === "string" ? ctxAllowed.get(atomId) : undefined;
            const ok = (lo: number, hi: number) => typeof start === "number" && typeof end === "number" && start <= end && start >= lo && end <= hi;
            if (range && ok(range[0], range[1])) {
              cites.push({ atomId: atomId as string, lines: [start as number, end as number] });
            } else if (snip && (ok(snip.start, snip.end) || (snip.head && start === snip.head.line && end === snip.head.line))) {
              cites.push({ atomId: "", file: snip.file, lines: [start as number, end as number] });
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
        system: EXPLAIN_SYSTEM,
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
