import { addUsage, completeJson, estimateTokens } from "./llm";
import { fallbackLabel } from "./order";
import { atomLabel, atomSnippet, lineCounts, snippetText, type SnippetRow } from "./snippet";
import type { ChangeAtom, Citation, JSONSchema, LLMProvider, PRInput, StoryStep } from "./types";
import type { Plan } from "./validate";

export const EXPLAIN_SYSTEM = `You walk a colleague through a pull request, one step at a time, in a fixed order. For each step you are given, write a short, plain explanation of what changed and why: usually one or two short paragraphs, never more than three.

- Write each step so it follows from the one before. Where the topic shifts, make the first sentence connect it to what came earlier.
- No headings, titles, bullet lists or dramatic framing. Sound like a knowledgeable colleague: specific, calm and brief.
- Point out what a reviewer should check closely, such as edge cases, behavior changes or risky assumptions, but do not invent problems.
- Every paragraph cites the lines it talks about. A citation gives the atom ID and the first and last line numbers as shown at the left of that atom's snippet. Cite only atoms shown in this request.`;

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
        required: ["step", "paragraphs"],
        properties: {
          step: { type: "integer" },
          paragraphs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "cites"],
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
              },
            },
          },
        },
      },
    },
  },
};

export type ExplainStats = { citations: number; groundingFailures: number; missingSteps: number; tokens: number; windows: number };

/** Split steps into windows of consecutive steps that fit the context budget. */
export function windows(stepTexts: string[], budgetTokens: number, maxSteps = 8): number[][] {
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
): Promise<{ steps: StoryStep[]; stats: ExplainStats }> {
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const files = new Map(pr.files.map((f) => [f.path, f]));
  const snippets = new Map<string, SnippetRow[]>(atoms.map((a) => [a.id, atomSnippet(files.get(a.file), a)]));
  const stats: ExplainStats = { citations: 0, groundingFailures: 0, missingSteps: 0, tokens: 0, windows: 0 };

  const steps: StoryStep[] = plan.steps.map((s) => ({
    atomIds: s.atomIds,
    label: s.label,
    ...(s.orderOverride ? { orderOverride: s.orderOverride } : {}),
    explanation: [],
  }));

  if (!provider) {
    steps.forEach((s, i) => {
      s.explanation = [templateExplanation(s.atomIds.map((id) => byId.get(id)!))];
      onStep?.(i, s);
    });
    return { steps, stats };
  }

  const outline = plan.steps.map((s, i) => `${i + 1}. ${s.label} [${s.atomIds.join(", ")}]`).join("\n");
  const sharedPrefix = `# Pull request #${pr.number}: ${pr.title}\n\n${pr.body.trim() || "(no description)"}\n\n# Summary\n\n${plan.summary}\n\n# Full step order\n\n${outline}`;

  const stepTexts = plan.steps.map((s, i) => {
    const parts = s.atomIds.map((id) => {
      const a = byId.get(id)!;
      const { add, del } = lineCounts(a);
      return `Atom ${id}: ${atomLabel(a)} (${a.kind}, +${add} −${del})\n\`\`\`\n${snippetText(snippets.get(id)!)}\n\`\`\``;
    });
    return `## Step ${i + 1}: ${s.label}${s.orderOverride ? `\n(Placed before its dependencies on purpose: ${s.orderOverride})` : ""}\n\n${parts.join("\n\n")}`;
  });

  const budget = Math.max(2000, Math.floor(provider.capabilities.maxContextTokens * 0.3) - estimateTokens(sharedPrefix));
  const total = { tokens: 0 };

  for (const win of windows(stepTexts, Math.min(budget, 30000))) {
    stats.windows++;
    const prev = win[0] > 0 ? `The reader has just finished step ${win[0]} (${plan.steps[win[0] - 1].label}).\n\n` : "";
    const content = `${prev}Write the explanations for steps ${win[0] + 1} to ${win[win.length - 1] + 1}.\n\n${win.map((i) => stepTexts[i]).join("\n\n")}`;
    let json: unknown;
    try {
      const res = await completeJson(provider, {
        system: EXPLAIN_SYSTEM,
        sharedPrefix,
        messages: [{ role: "user", content }],
        schema: EXPLAIN_SCHEMA,
        maxTokens: 16000,
      });
      addUsage(total, res.usage);
      json = res.json;
    } catch {
      json = undefined;
    }

    const got = new Map<number, unknown[]>();
    const arr = (json as { steps?: unknown[] } | undefined)?.steps;
    if (Array.isArray(arr))
      for (const s of arr) {
        const o = s as { step?: unknown; paragraphs?: unknown };
        if (typeof o.step === "number" && Array.isArray(o.paragraphs)) got.set(o.step - 1, o.paragraphs);
      }

    const allowed = new Map<string, [number, number]>();
    for (const i of win) for (const id of plan.steps[i].atomIds) allowed.set(id, shownRange(snippets.get(id)!));

    for (const i of win) {
      const paragraphs = got.get(i);
      if (!paragraphs?.length) {
        stats.missingSteps++;
        steps[i].explanation = [templateExplanation(steps[i].atomIds.map((id) => byId.get(id)!))];
      } else {
        steps[i].explanation = paragraphs.map((p) => {
          const o = p as { text?: unknown; cites?: unknown };
          const cites: Citation[] = [];
          for (const c of Array.isArray(o.cites) ? o.cites : []) {
            const { atomId, start, end } = c as { atomId?: unknown; start?: unknown; end?: unknown };
            stats.citations++;
            const range = typeof atomId === "string" ? allowed.get(atomId) : undefined;
            if (range && typeof start === "number" && typeof end === "number" && start <= end && start >= range[0] && end <= range[1]) {
              cites.push({ atomId: atomId as string, lines: [start, end] });
            } else {
              stats.groundingFailures++;
            }
          }
          return { text: typeof o.text === "string" ? o.text : "", cites };
        });
      }
      onStep?.(i, steps[i]);
    }
  }
  stats.tokens = total.tokens;
  return { steps, stats };
}

function shownRange(rows: SnippetRow[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    if (r.type === "gap") continue;
    for (const n of [r.oldLine, r.newLine]) {
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
