import { atomizePR } from "./atomize";
import { classifyAtoms } from "./classify";
import { retrieveContext, type ContextSource } from "./context";
import { explainSteps } from "./explain";
import { buildGraph, type Edge } from "./graph";
import { orderAtoms, type OrderEvent, type OrderResult } from "./order";
import type { ParserHost } from "./parse";
import { planFromPrevious, withNewContext, type PreviousStory } from "./reuse";
import type { ChangeAtom, LLMProvider, PRInput, Story, StoryStep, Usage } from "./types";
import { checkCoverage, dependencyViolations, type CoverageReport, type Plan } from "./validate";

export type PipelineEvent =
  | { type: "stage"; stage: "atomize" | "graph" | "order" | "context" | "explain" | "done" }
  | OrderEvent
  /** The diff is split into atoms. */
  | { type: "atoms"; atoms: number; mechanical: number; files: number }
  /** Unchanged code was found for the steps: snippets in all, and files read from outside the PR. */
  | { type: "context"; snippets: number; steps: number; extraFiles: number }
  /** The step order is settled: readers can show the outline and code before explanations arrive. */
  | { type: "plan"; atoms: ChangeAtom[]; plan: Plan; fallback: boolean }
  | { type: "step"; index: number; step: StoryStep }
  /** The explanation of a step still being written, so far. */
  | { type: "draft"; index: number; text: string };

export type PipelineMetrics = {
  files: number;
  changedLines: number;
  atoms: number;
  mechanicalAtoms: number;
  tierCounts: Record<0 | 1 | 2, number>;
  edges: number;
  steps: number;
  repairRounds: number;
  fallbackOrder: boolean;
  orderErrors: string[];
  /** Distinct errors thrown by the model provider (auth, billing, rate limits, network), first 5. */
  providerErrors: string[];
  /** Model calls made and how many of them failed. */
  modelCalls: { total: number; failed: number };
  /** Distinct models that answered, as the provider reported them (empty when it doesn't say). */
  servedModels: string[];
  orderOverrides: number;
  undeclaredViolations: number;
  /** Steps whose explanation was carried over from the previous story (0 without one). */
  reusedSteps: number;
  summarized: { batches: number; missing: number } | null;
  contextSnippets: number;
  stepsWithContext: number;
  contextFiles: number; // unchanged files read from outside the PR for context
  citations: number;
  groundingFailures: number;
  missingExplanations: number;
  beats: number;
  badCuts: number;
  tokens: number;
  usage: Required<Usage>;
  ms: { atomize: number; order: number; context: number; explain: number; firstStep: number | null; total: number };
};

export type PipelineResult = {
  story: Story;
  atoms: ChangeAtom[];
  edges: Edge[];
  coverage: CoverageReport;
  metrics: PipelineMetrics;
};

/** PR → atoms → graph → order (LLM, validated and repaired) → explanation (LLM) → Story. */
export async function runPipeline(
  pr: PRInput,
  opts: {
    host: ParserHost;
    provider: LLMProvider | null;
    onEvent?: (e: PipelineEvent) => void;
    /** Where to look for unchanged code outside the PR's files (null: only the PR's files). */
    contextSource?: ContextSource | null;
    /** Turn off context retrieval entirely. */
    noContext?: boolean;
    summarizeAboveTokens?: number;
    /**
     * The story for an earlier commit of this PR. When it was made with the same model and most of
     * its code is unchanged, its order is kept and only steps with changed code are explained again.
     */
    previous?: PreviousStory | null;
  },
): Promise<PipelineResult> {
  const t0 = Date.now();
  const emit = opts.onEvent ?? (() => {});
  const usage: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const calls = { total: 0, failed: 0, errors: [] as string[], served: new Set<string>() };
  const provider = opts.provider ? meter(opts.provider, usage, calls) : null;

  emit({ type: "stage", stage: "atomize" });
  const atoms = classifyAtoms(pr, await atomizePR(pr, opts.host));
  const tAtoms = Date.now();
  emit({ type: "atoms", atoms: atoms.length, mechanical: atoms.filter((a) => a.mechanical).length, files: pr.files.length });

  emit({ type: "stage", stage: "graph" });
  const edges = buildGraph(atoms);

  emit({ type: "stage", stage: "order" });
  const prev = opts.previous;
  const sameModel = !!prev && !!opts.provider && prev.story.meta.provider === opts.provider.id && prev.story.meta.model === opts.provider.model;
  const reuse = sameModel ? planFromPrevious(prev!, pr, atoms, edges) : null;
  const order: OrderResult = reuse
    ? { plan: reuse.plan, repairRounds: 0, fallback: false, errors: [], tokens: 0, summarized: null }
    : await orderAtoms(pr, atoms, edges, provider, (e) => emit(e), { summarizeAboveTokens: opts.summarizeAboveTokens });
  const tOrder = Date.now();
  emit({ type: "plan", atoms, plan: order.plan, fallback: order.fallback });

  emit({ type: "stage", stage: "context" });
  const ctx = opts.noContext
    ? { context: [], stats: { snippets: 0, stepsWithContext: 0, extraFiles: 0 } }
    : await retrieveContext(pr, atoms, order.plan.steps, opts.host, { source: opts.contextSource });
  const tContext = Date.now();
  emit({ type: "context", snippets: ctx.stats.snippets, steps: ctx.stats.stepsWithContext, extraFiles: ctx.stats.extraFiles });

  // A carried-over step is kept only if its unchanged context is the same too.
  const reused = new Map<number, StoryStep>();
  if (reuse)
    for (const [i, step] of reuse.reused) {
      const kept = withNewContext(step, ctx.context[i]);
      if (kept) reused.set(i, kept);
    }

  emit({ type: "stage", stage: "explain" });
  let firstStep: number | null = null;
  const { steps, stats } = await explainSteps(
    pr,
    atoms,
    order.plan,
    provider,
    (index, step) => {
      firstStep ??= Date.now() - t0;
      emit({ type: "step", index, step });
    },
    ctx.context,
    reused,
    (index, text) => emit({ type: "draft", index, text }),
  );
  const tExplain = Date.now();

  const story: Story = {
    prNumber: pr.number,
    headSha: pr.headSha,
    summary: order.plan.summary,
    steps,
    mechanical: order.plan.mechanical,
    meta: {
      model: opts.provider?.model ?? "none",
      provider: opts.provider?.id ?? "none",
      repairRounds: order.repairRounds,
      tokens: order.tokens + stats.tokens,
      ...(reuse && prev ? { reused: { steps: reused.size, from: prev.story.headSha } } : {}),
    },
  };

  const coverage = checkCoverage(pr, atoms, story);
  emit({ type: "stage", stage: "done" });

  const tierCounts: Record<0 | 1 | 2, number> = { 0: 0, 1: 0, 2: 0 };
  for (const a of atoms) tierCounts[a.supportTier]++;

  return {
    story,
    atoms,
    edges,
    coverage,
    metrics: {
      files: pr.files.length,
      changedLines: coverage.totalLines,
      atoms: atoms.length,
      mechanicalAtoms: atoms.filter((a) => a.mechanical).length,
      tierCounts,
      edges: edges.length,
      steps: steps.length,
      repairRounds: order.repairRounds,
      fallbackOrder: order.fallback,
      orderErrors: order.errors,
      providerErrors: calls.errors,
      modelCalls: { total: calls.total, failed: calls.failed },
      servedModels: [...calls.served],
      orderOverrides: steps.filter((s) => s.orderOverride).length,
      reusedSteps: reused.size,
      undeclaredViolations: dependencyViolations(order.plan, atoms, edges).length,
      summarized: order.summarized,
      contextSnippets: ctx.stats.snippets,
      stepsWithContext: ctx.stats.stepsWithContext,
      contextFiles: ctx.stats.extraFiles,
      citations: stats.citations,
      groundingFailures: stats.groundingFailures,
      missingExplanations: stats.missingSteps,
      beats: stats.beats,
      badCuts: stats.badCuts,
      tokens: story.meta.tokens,
      usage,
      ms: { atomize: tAtoms - t0, order: tOrder - tAtoms, context: tContext - tOrder, explain: tExplain - tContext, firstStep, total: Date.now() - t0 },
    },
  };
}

/**
 * Why a story made with a model fell back to template text or dependency order, or null when the
 * model did its part. Callers use it to warn, stop a benchmark, or skip caching.
 */
export function modelFailure(r: PipelineResult): string | null {
  if (r.story.meta.provider === "none") return null;
  const m = r.metrics;
  if (m.modelCalls.total > 0 && m.modelCalls.failed === m.modelCalls.total) return `Every model call failed: ${m.providerErrors[0] ?? "unknown error"}`;
  if (m.steps > 0 && m.missingExplanations === m.steps) return m.providerErrors.length ? `No step was explained: ${m.providerErrors[0]}` : "The model returned no usable explanations.";
  if (m.fallbackOrder && m.providerErrors.length) return `The order fell back to dependency order: ${m.providerErrors[0]}`;
  return null;
}

/**
 * Wrap a provider so every call's usage is added to `total`, failures are recorded in `calls`, and
 * the model that answered each call is collected in `calls.served`.
 */
function meter(p: LLMProvider, total: Required<Usage>, calls: { total: number; failed: number; errors: string[]; served: Set<string> }): LLMProvider {
  return {
    id: p.id,
    model: p.model,
    capabilities: p.capabilities,
    async complete(req) {
      calls.total++;
      let res: Awaited<ReturnType<LLMProvider["complete"]>>;
      try {
        res = await p.complete(req);
      } catch (err) {
        calls.failed++;
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        if (calls.errors.length < 5 && !calls.errors.includes(msg)) calls.errors.push(msg);
        throw err;
      }
      total.inputTokens += res.usage.inputTokens;
      total.outputTokens += res.usage.outputTokens;
      total.cacheReadTokens += res.usage.cacheReadTokens ?? 0;
      total.cacheWriteTokens += res.usage.cacheWriteTokens ?? 0;
      if (res.model) calls.served.add(res.model);
      return res;
    },
  };
}
