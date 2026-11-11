import { partialStrings, streamedArray, throttle } from "./partial-json";
import { dependencyOrder, type Edge } from "./graph";
import { addUsage, completeJson, estimateTokens, prHeader } from "./llm";
import { atomLabel, atomSnippet, lineCounts, snippetText } from "./snippet";
import { promptCollapses } from "./collapse";
import { explainableLines, sizeHint } from "./length";
import type { ChangeAtom, JSONSchema, LLMProvider, Msg, PRInput } from "./types";
import { validatePlan, type Plan } from "./validate";

export const MAX_REPAIR_ROUNDS = 3;

export const ORDER_SYSTEM = `You plan the reading order for a code review. A pull request has been split into change atoms: each atom is one syntactic unit that changed (a function, a method, a class member, a config block, an import list). Arrange the atoms into one flat sequence of steps that a reviewer reads top to bottom, so each step makes sense given the ones before it.

Rules:
- Every atom ID appears exactly once, either in a step or in the \`mechanical\` list.
- Only atoms tagged mechanical (formatting, renames, import reshuffles, lockfiles, generated files) may go in \`mechanical\`, and they normally should. Put a mechanical atom in a step only if the reader needs it to follow the story.
- Organize the steps the way an experienced reviewer would want to read this change. Each step is one coherent idea that a reviewer can understand and judge on its own, such as a new type with the methods built on it, a helper with the callers that motivate it, the same edit repeated across files, or the cases in one test file.
- Let the structure of the change decide the steps, not the number of atoms or files. Atoms belong in one step when they only make sense together; atoms that do separate things get separate steps, even when they sit in the same file. Two checks: a step shouldn't be a fragment the reviewer can't judge without reading the next one, and it shouldn't bundle unrelated work the reviewer would want to stop halfway through. A focused fix is often a single step; a PR with several independent parts needs a step for each.
- Keep code that sits together in a file together. Neighbouring atoms in one file (consecutive declarations, a small method and the one after it, the cases of one test) go in the same step unless they do unrelated things. Within a step, list atoms from the same file in file order so the reader sees continuous code.
- Respect dependencies. "A → B" means atom A defines something atom B uses, so A's step must come no later than B's. If the story reads clearly better with B first (for example starting from the entry point a user calls), keep that order and set \`orderOverride\` on B's step to a short reason. Otherwise set \`orderOverride\` to an empty string.
- Follow the logic of the change: data shapes and core definitions first, then the code that uses them, then wiring and configuration. Tests go right after the code they test, or at the end.
- \`label\` is a short plain phrase for the outline, such as "Add retry to \`fetchTrail\`". No numbering.
- \`summary\` is one to three plain sentences on what the PR does and why, shown at the top of the story. Keep it to one sentence for a small PR, and don't list every change: the steps do that.
- In \`summary\` and labels, put identifiers, flags, file names and literal values in backticks.`;

export const ORDER_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "steps", "mechanical"],
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["atomIds", "label", "orderOverride"],
        properties: {
          atomIds: { type: "array", items: { type: "string" } },
          label: { type: "string" },
          orderOverride: { type: "string" },
        },
      },
    },
    mechanical: { type: "array", items: { type: "string" } },
  },
};

export type OrderResult = {
  plan: Plan;
  repairRounds: number;
  fallback: boolean; // true when the deterministic dependency order was used
  errors: string[]; // errors from the last failed attempt, if any
  tokens: number;
  /** Set when the PR was too large to order from code, so atoms were summarized first. */
  summarized: { batches: number; missing: number } | null;
};

export type OrderEvent =
  | { type: "order-attempt"; round: number; errors: string[] }
  /** The plan as the model writes it: the summary and step labels so far (not yet validated). */
  | { type: "order-draft"; summary: string; labels: string[] }
  | { type: "summarize"; done: number; total: number };

/** Above this many prompt tokens (or half the context window, if smaller) atoms are summarized first. */
export const SUMMARIZE_ABOVE_TOKENS = 40_000;
const SUMMARY_BATCH_TOKENS = 12_000;
const SUMMARY_BATCH_ATOMS = 30;
const SUMMARY_CONCURRENCY = 4;

export const SUMMARIZE_SYSTEM = `You help plan the reading order for a code review of a large pull request. You get a batch of change atoms: each is one syntactic unit that changed (a function, a method, a class member, a config block), shown as a diff with \`+\` for added lines, \`-\` for removed lines and \`~\` for lines that only changed indentation.

For every atom in the batch, write one or two plain sentences saying what changed in it: what it defines or modifies, and what new behavior or dependency it introduces. These summaries are all a planner will see when deciding which atoms a reviewer should read first, so name the functions, types and fields involved, in backticks. Describe the code in the third person; do not guess at intent the code does not show. Return exactly one summary per atom ID given.`;

export const SUMMARY_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summaries"],
  properties: {
    summaries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["atomId", "summary"],
        properties: { atomId: { type: "string" }, summary: { type: "string" } },
      },
    },
  },
};

/**
 * Describe the PR and its atoms for the ordering prompt, shrinking snippets to fit the budget.
 * With `summaries`, each atom is described by its summary instead of its code.
 */
export function orderPrompt(pr: PRInput, atoms: ChangeAtom[], edges: Edge[], budgetTokens: number, summaries?: Map<string, string>): string {
  const files = new Map(pr.files.map((f) => [f.path, f]));
  const header = prHeader(pr);
  const deps = edges.length
    ? edges.map((e) => `${e.from} → ${e.to} (uses \`${e.symbol}\`)`).join("\n")
    : "(no dependencies found between atoms)";

  const render = (maxRows: number) =>
    atoms
      .map((a) => {
        const { add, del } = lineCounts(a);
        const tags = [a.deletedFile ? "whole file deleted" : a.kind, `+${add} −${del}`, a.mechanical ? `mechanical: ${a.mechanical}` : null].filter(Boolean).join(", ");
        const head = `### ${a.id}: ${atomLabel(a)} (${tags})`;
        if (a.mechanical || maxRows === 0) return head;
        if (summaries) return `${head}\n${summaries.get(a.id) ?? fallbackLabel(a)}`;
        const rows = atomSnippet(files.get(a.file), a, 1);
        return `${head}\n\`\`\`\n${snippetText(rows, maxRows, promptCollapses(rows, a))}\n\`\`\``;
      })
      .join("\n\n");

  let body = "";
  for (const maxRows of summaries ? [1, 0] : [60, 30, 15, 6, 0]) {
    body = render(maxRows);
    if (estimateTokens(header + body + deps) <= budgetTokens) break;
  }
  const live = atoms.filter((a) => !a.mechanical);
  const size = sizeHint(explainableLines(live), live.length);
  return `${header}\n# Atoms\n\n${body}\n\n# Dependencies\n\n${deps}\n\n${size ? `${size}\n\n` : ""}Return the plan as JSON.`;
}

/**
 * Ask the model for an order, validate it, and send precise errors back for repair up to
 * MAX_REPAIR_ROUNDS times. Falls back to pure dependency order if it still fails.
 */
export async function orderAtoms(
  pr: PRInput,
  atoms: ChangeAtom[],
  edges: Edge[],
  provider: LLMProvider | null,
  onEvent?: (e: OrderEvent) => void,
  opts: { summarizeAboveTokens?: number } = {},
): Promise<OrderResult> {
  const total = { tokens: 0 };
  if (!provider) return { plan: fallbackPlan(pr, atoms, edges), repairRounds: 0, fallback: true, errors: [], tokens: 0, summarized: null };

  const budget = Math.floor(provider.capabilities.maxContextTokens * 0.5);
  const threshold = Math.min(opts.summarizeAboveTokens ?? SUMMARIZE_ABOVE_TOKENS, budget);
  let prompt = orderPrompt(pr, atoms, edges, Infinity);
  let summarized: OrderResult["summarized"] = null;
  if (estimateTokens(prompt) > threshold) {
    const s = await summarizeAtoms(pr, atoms, provider, onEvent);
    total.tokens += s.tokens;
    summarized = { batches: s.batches, missing: s.missing };
    prompt = orderPrompt(pr, atoms, edges, budget, s.summaries);
  }
  const messages: Msg[] = [{ role: "user", content: prompt }];
  let errors: string[] = [];

  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
    let res: Awaited<ReturnType<typeof completeJson>>;
    let streamed = "";
    const draft = throttle(() => {
      const { items, partial } = streamedArray(streamed, "steps");
      const labels = items.map((it) => (it as { label?: unknown }).label).filter((l): l is string => typeof l === "string");
      const writing = partial ? partialStrings(partial, "label")[0] : undefined;
      onEvent?.({ type: "order-draft", summary: partialStrings(streamed.split(/"steps"\s*:/)[0], "summary")[0] ?? "", labels: writing ? [...labels, writing] : labels });
    }, 150);
    try {
      res = await completeJson(provider, {
        system: ORDER_SYSTEM,
        messages,
        schema: ORDER_SCHEMA,
        maxTokens: 16000,
        onText: (d) => {
          streamed += d;
          draft.run();
        },
      });
      draft.flush();
    } catch (err) {
      errors = [`Provider error: ${(err as Error).message}`];
      onEvent?.({ type: "order-attempt", round, errors });
      break;
    }
    addUsage(total, res.usage);
    const v = validatePlan(res.json ?? res.text, atoms, edges);
    onEvent?.({ type: "order-attempt", round, errors: v.errors });
    if (v.plan && v.errors.length === 0) {
      return { plan: v.plan, repairRounds: round, fallback: false, errors: [], tokens: total.tokens, summarized };
    }
    errors = v.errors;
    messages.push({ role: "assistant", content: res.text || JSON.stringify(res.json) });
    messages.push({
      role: "user",
      content: `The plan has these problems:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nReturn the complete corrected plan as JSON.`,
    });
  }

  return { plan: fallbackPlan(pr, atoms, edges), repairRounds: MAX_REPAIR_ROUNDS, fallback: true, errors, tokens: total.tokens, summarized };
}

/**
 * Summarize non-mechanical atoms in batches (a few calls at a time) so the ordering prompt can
 * describe a large PR in a line or two per atom. Atoms the model skips get a template label.
 */
export async function summarizeAtoms(
  pr: PRInput,
  atoms: ChangeAtom[],
  provider: LLMProvider,
  onEvent?: (e: OrderEvent) => void,
): Promise<{ summaries: Map<string, string>; batches: number; missing: number; tokens: number }> {
  const files = new Map(pr.files.map((f) => [f.path, f]));
  const header = prHeader(pr);
  const perBatch = Math.min(SUMMARY_BATCH_TOKENS, Math.floor(provider.capabilities.maxContextTokens * 0.25));

  const batches: { ids: string[]; text: string[]; tokens: number }[] = [];
  for (const a of atoms) {
    if (a.mechanical) continue;
    const { add, del } = lineCounts(a);
    const rows = atomSnippet(files.get(a.file), a, 1);
    let text = `### ${a.id}: ${atomLabel(a)} (${a.deletedFile ? "whole file deleted" : a.kind}, +${add} −${del})\n\`\`\`\n${snippetText(rows, 80, promptCollapses(rows, a))}\n\`\`\``;
    if (estimateTokens(text) > perBatch) text = text.slice(0, perBatch * 4) + "\n…\n\`\`\`";
    const cost = estimateTokens(text);
    let b = batches[batches.length - 1];
    if (!b || b.ids.length >= SUMMARY_BATCH_ATOMS || b.tokens + cost > perBatch) batches.push((b = { ids: [], text: [], tokens: 0 }));
    b.ids.push(a.id);
    b.text.push(text);
    b.tokens += cost;
  }

  const summaries = new Map<string, string>();
  const total = { tokens: 0 };
  let done = 0;
  const run = async (b: (typeof batches)[number]) => {
    try {
      const res = await completeJson(provider, {
        system: SUMMARIZE_SYSTEM,
        sharedPrefix: header,
        messages: [{ role: "user", content: `Summarize each of these ${b.ids.length} atoms.\n\n${b.text.join("\n\n")}` }],
        schema: SUMMARY_SCHEMA,
        maxTokens: 8000,
      });
      addUsage(total, res.usage);
      const wanted = new Set(b.ids);
      const list = (res.json as { summaries?: unknown } | undefined)?.summaries;
      for (const item of Array.isArray(list) ? list : []) {
        const { atomId, summary } = item as { atomId?: unknown; summary?: unknown };
        if (typeof atomId === "string" && wanted.has(atomId) && typeof summary === "string" && summary.trim()) summaries.set(atomId, summary.trim());
      }
    } catch {
      // The batch keeps template labels.
    }
    onEvent?.({ type: "summarize", done: ++done, total: batches.length });
  };

  for (let i = 0; i < batches.length; i += SUMMARY_CONCURRENCY) await Promise.all(batches.slice(i, i + SUMMARY_CONCURRENCY).map(run));

  let missing = 0;
  for (const a of atoms)
    if (!a.mechanical && !summaries.has(a.id)) {
      missing++;
      summaries.set(a.id, fallbackLabel(a) + ".");
    }
  return { summaries, batches: batches.length, missing, tokens: total.tokens };
}

/** Pure dependency order, one atom per step, mechanical atoms at the end. */
export function fallbackPlan(pr: PRInput, atoms: ChangeAtom[], edges: Edge[]): Plan {
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const order = dependencyOrder(atoms, edges);
  const steps = order.filter((id) => !byId.get(id)!.mechanical).map((id) => ({ atomIds: [id], label: fallbackLabel(byId.get(id)!) }));
  const mechanical = order.filter((id) => byId.get(id)!.mechanical);
  const files = new Set(atoms.map((a) => a.file)).size;
  return {
    summary: `${pr.title}. This change touches ${files} file${files === 1 ? "" : "s"} in ${steps.length} step${steps.length === 1 ? "" : "s"}, ordered so definitions come before the code that uses them.`,
    steps,
    mechanical,
  };
}

export function fallbackLabel(a: ChangeAtom): string {
  const verb = { added: "Add", removed: "Remove", modified: "Change", moved: "Move", renamed: "Rename" }[a.kind];
  const sym = a.symbolPath.filter((s) => !s.startsWith("<")).join(".");
  const short = a.file.split("/").pop();
  if (a.symbolPath.includes("<imports>")) return `${verb === "Change" ? "Update" : verb} imports in ${short}`;
  return sym ? `${verb} ${sym}` : `${verb} ${short}`;
}
