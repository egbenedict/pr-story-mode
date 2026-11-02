import { dependencyOrder, type Edge } from "./graph";
import { addUsage, completeJson, estimateTokens } from "./llm";
import { atomLabel, atomSnippet, lineCounts, snippetText } from "./snippet";
import type { ChangeAtom, JSONSchema, LLMProvider, Msg, PRInput } from "./types";
import { validatePlan, type Plan } from "./validate";

export const MAX_REPAIR_ROUNDS = 3;

export const ORDER_SYSTEM = `You plan the reading order for a code review. A pull request has been split into change atoms: each atom is one syntactic unit that changed (a function, a method, a class member, a config block, an import list). Arrange the atoms into one flat sequence of steps that a reviewer reads top to bottom, so each step makes sense given the ones before it.

Rules:
- Every atom ID appears exactly once, either in a step or in the \`mechanical\` list.
- Only atoms tagged mechanical (formatting, renames, import reshuffles, lockfiles, generated files) may go in \`mechanical\`, and they normally should. Put a mechanical atom in a step only if the reader needs it to follow the story.
- A step is usually one atom. Put a few atoms in one step only when they read best together, for example the same small edit repeated in several places, or a tiny helper and its single use.
- Respect dependencies. "A → B" means atom A defines something atom B uses, so A's step must come no later than B's. If the story reads clearly better with B first (for example starting from the entry point a user calls), keep that order and set \`orderOverride\` on B's step to a short reason. Otherwise set \`orderOverride\` to an empty string.
- Follow the logic of the change: data shapes and core definitions first, then the code that uses them, then wiring and configuration. Tests go right after the code they test, or at the end.
- \`label\` is a short plain phrase for the outline, such as "Add retry to \`fetchTrail\`". No numbering.
- \`summary\` is two or three plain sentences on what the PR does and why, shown at the top of the story.
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
};

/** Describe the PR and its atoms for the ordering prompt, shrinking snippets to fit the budget. */
export function orderPrompt(pr: PRInput, atoms: ChangeAtom[], edges: Edge[], budgetTokens: number): string {
  const files = new Map(pr.files.map((f) => [f.path, f]));
  const header = `# Pull request #${pr.number}: ${pr.title}\n\n${pr.body.trim() || "(no description)"}\n`;
  const deps = edges.length
    ? edges.map((e) => `${e.from} → ${e.to} (uses \`${e.symbol}\`)`).join("\n")
    : "(no dependencies found between atoms)";

  const render = (maxRows: number) =>
    atoms
      .map((a) => {
        const { add, del } = lineCounts(a);
        const tags = [a.kind, `+${add} −${del}`, a.mechanical ? `mechanical: ${a.mechanical}` : null].filter(Boolean).join(", ");
        const head = `### ${a.id}: ${atomLabel(a)} (${tags})`;
        if (a.mechanical || maxRows === 0) return head;
        return `${head}\n\`\`\`\n${snippetText(atomSnippet(files.get(a.file), a, 1), maxRows)}\n\`\`\``;
      })
      .join("\n\n");

  let body = "";
  for (const maxRows of [60, 30, 15, 6, 0]) {
    body = render(maxRows);
    if (estimateTokens(header + body + deps) <= budgetTokens) break;
  }
  return `${header}\n# Atoms\n\n${body}\n\n# Dependencies\n\n${deps}\n\nReturn the plan as JSON.`;
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
  onEvent?: (e: { type: "order-attempt"; round: number; errors: string[] }) => void,
): Promise<OrderResult> {
  const total = { tokens: 0 };
  if (!provider) return { plan: fallbackPlan(pr, atoms, edges), repairRounds: 0, fallback: true, errors: [], tokens: 0 };

  const budget = Math.floor(provider.capabilities.maxContextTokens * 0.5);
  const messages: Msg[] = [{ role: "user", content: orderPrompt(pr, atoms, edges, budget) }];
  let errors: string[] = [];

  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
    let res: Awaited<ReturnType<typeof completeJson>>;
    try {
      res = await completeJson(provider, { system: ORDER_SYSTEM, messages, schema: ORDER_SCHEMA, maxTokens: 16000 });
    } catch (err) {
      errors = [`Provider error: ${(err as Error).message}`];
      onEvent?.({ type: "order-attempt", round, errors });
      break;
    }
    addUsage(total, res.usage);
    const v = validatePlan(res.json ?? res.text, atoms, edges);
    onEvent?.({ type: "order-attempt", round, errors: v.errors });
    if (v.plan && v.errors.length === 0) {
      return { plan: v.plan, repairRounds: round, fallback: false, errors: [], tokens: total.tokens };
    }
    errors = v.errors;
    messages.push({ role: "assistant", content: res.text || JSON.stringify(res.json) });
    messages.push({
      role: "user",
      content: `The plan has these problems:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nReturn the complete corrected plan as JSON.`,
    });
  }

  return { plan: fallbackPlan(pr, atoms, edges), repairRounds: MAX_REPAIR_ROUNDS, fallback: true, errors, tokens: total.tokens };
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
