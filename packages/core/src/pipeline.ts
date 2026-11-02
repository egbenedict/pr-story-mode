import { atomizePR } from "./atomize";
import { classifyAtoms } from "./classify";
import { explainSteps } from "./explain";
import { buildGraph, type Edge } from "./graph";
import { orderAtoms } from "./order";
import type { ParserHost } from "./parse";
import type { ChangeAtom, LLMProvider, PRInput, Story, StoryStep, Usage } from "./types";
import { checkCoverage, dependencyViolations, type CoverageReport } from "./validate";

export type PipelineEvent =
  | { type: "stage"; stage: "atomize" | "graph" | "order" | "explain" | "done" }
  | { type: "order-attempt"; round: number; errors: string[] }
  | { type: "step"; index: number; step: StoryStep };

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
  orderOverrides: number;
  undeclaredViolations: number;
  citations: number;
  groundingFailures: number;
  missingExplanations: number;
  beats: number;
  badCuts: number;
  tokens: number;
  usage: Required<Usage>;
  ms: { atomize: number; order: number; explain: number; firstStep: number | null; total: number };
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
  opts: { host: ParserHost; provider: LLMProvider | null; onEvent?: (e: PipelineEvent) => void },
): Promise<PipelineResult> {
  const t0 = Date.now();
  const emit = opts.onEvent ?? (() => {});
  const usage: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const provider = opts.provider ? meter(opts.provider, usage) : null;

  emit({ type: "stage", stage: "atomize" });
  const atoms = classifyAtoms(pr, await atomizePR(pr, opts.host));
  const tAtoms = Date.now();

  emit({ type: "stage", stage: "graph" });
  const edges = buildGraph(atoms);

  emit({ type: "stage", stage: "order" });
  const order = await orderAtoms(pr, atoms, edges, provider, (e) => emit(e));
  const tOrder = Date.now();

  emit({ type: "stage", stage: "explain" });
  let firstStep: number | null = null;
  const { steps, stats } = await explainSteps(pr, atoms, order.plan, provider, (index, step) => {
    firstStep ??= Date.now() - t0;
    emit({ type: "step", index, step });
  });
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
      orderOverrides: steps.filter((s) => s.orderOverride).length,
      undeclaredViolations: dependencyViolations(order.plan, atoms, edges).length,
      citations: stats.citations,
      groundingFailures: stats.groundingFailures,
      missingExplanations: stats.missingSteps,
      beats: stats.beats,
      badCuts: stats.badCuts,
      tokens: story.meta.tokens,
      usage,
      ms: { atomize: tAtoms - t0, order: tOrder - tAtoms, explain: tExplain - tOrder, firstStep, total: Date.now() - t0 },
    },
  };
}

/** Wrap a provider so every call's usage is added to `total`. */
function meter(p: LLMProvider, total: Required<Usage>): LLMProvider {
  return {
    id: p.id,
    model: p.model,
    capabilities: p.capabilities,
    async complete(req) {
      const res = await p.complete(req);
      total.inputTokens += res.usage.inputTokens;
      total.outputTokens += res.usage.outputTokens;
      total.cacheReadTokens += res.usage.cacheReadTokens ?? 0;
      total.cacheWriteTokens += res.usage.cacheWriteTokens ?? 0;
      return res;
    },
  };
}
