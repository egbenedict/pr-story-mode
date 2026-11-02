import { changedLines, lineKey } from "./diff";
import { components, type Edge } from "./graph";
import type { ChangeAtom, PRInput, Story } from "./types";

export type PlanStep = { atomIds: string[]; label: string; orderOverride?: string };
export type Plan = { summary: string; steps: PlanStep[]; mechanical: string[] };

export type DependencyViolation = { step: number; atomId: string; dependsOn: string; dependsOnStep: number; symbol: string };

/**
 * Deterministic checks on an ordering plan from the model:
 * - shape is right;
 * - no unknown or repeated atom IDs;
 * - every non-mechanical atom appears exactly once in the steps; mechanical atoms appear exactly once
 *   (in the steps or the mechanical list);
 * - no step comes before a step it depends on, unless it carries an orderOverride.
 * Dependencies inside a cycle are ignored, since no order can satisfy them.
 */
export function validatePlan(
  raw: unknown,
  atoms: ChangeAtom[],
  edges: Edge[],
): { plan: Plan | null; errors: string[]; violations: DependencyViolation[] } {
  const errors: string[] = [];
  const plan = coercePlan(raw, errors);
  if (!plan) return { plan: null, errors, violations: [] };

  const byId = new Map(atoms.map((a) => [a.id, a]));
  const where = new Map<string, number>(); // atom id -> step index (or -1 for mechanical list)

  plan.steps.forEach((s, i) => {
    if (!s.atomIds.length) errors.push(`Step ${i + 1} has no atomIds.`);
    if (!s.label.trim()) errors.push(`Step ${i + 1} has an empty label.`);
    for (const id of s.atomIds) {
      if (!byId.has(id)) errors.push(`Step ${i + 1} lists unknown atom ID "${id}".`);
      else if (where.has(id)) errors.push(`Atom ${id} appears more than once (step ${i + 1} and ${placeName(where.get(id)!)}).`);
      else where.set(id, i);
    }
  });
  for (const id of plan.mechanical) {
    const a = byId.get(id);
    if (!a) errors.push(`The mechanical list has unknown atom ID "${id}".`);
    else if (where.has(id)) errors.push(`Atom ${id} appears more than once (mechanical list and ${placeName(where.get(id)!)}).`);
    else if (!a.mechanical) errors.push(`Atom ${id} is not mechanical, so it must be a story step, not in the mechanical list.`);
    else where.set(id, -1);
  }
  for (const a of atoms) {
    if (!where.has(a.id)) {
      errors.push(
        a.mechanical
          ? `Mechanical atom ${a.id} is missing; put it in the mechanical list.`
          : `Atom ${a.id} (${a.file} ${a.symbolPath.join(".")}) is missing from the steps.`,
      );
    }
  }

  const violations = dependencyViolations(plan, atoms, edges);
  for (const v of violations) {
    errors.push(
      `Step ${v.step + 1} (atom ${v.atomId}) uses \`${v.symbol}\` defined by atom ${v.dependsOn}, which comes later at step ${v.dependsOnStep + 1}. ` +
        `Move the definition earlier, or give step ${v.step + 1} an orderOverride explaining why.`,
    );
  }
  return { plan, errors, violations };
}

export function dependencyViolations(plan: Plan, atoms: ChangeAtom[], edges: Edge[]): DependencyViolation[] {
  const stepOf = new Map<string, number>();
  plan.steps.forEach((s, i) => s.atomIds.forEach((id) => stepOf.has(id) || stepOf.set(id, i)));
  const comp = components(
    atoms.map((a) => a.id),
    edges,
  );
  const out: DependencyViolation[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const from = stepOf.get(e.from);
    const to = stepOf.get(e.to);
    if (from === undefined || to === undefined) continue; // in the mechanical list or missing
    if (comp.get(e.from) === comp.get(e.to)) continue;
    if (from <= to) continue;
    if (plan.steps[to].orderOverride?.trim()) continue;
    const k = `${to}:${from}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ step: to, atomId: e.to, dependsOn: e.from, dependsOnStep: from, symbol: e.symbol });
  }
  return out;
}

function placeName(i: number): string {
  return i === -1 ? "the mechanical list" : `step ${i + 1}`;
}

function coercePlan(raw: unknown, errors: string[]): Plan | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(extractJson(raw));
    } catch {
      errors.push("The response was not valid JSON.");
      return null;
    }
  }
  if (!raw || typeof raw !== "object") {
    errors.push("The response must be a JSON object with summary, steps and mechanical.");
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.steps)) {
    errors.push("`steps` must be an array.");
    return null;
  }
  const steps: PlanStep[] = [];
  r.steps.forEach((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(o.atomIds) ? o.atomIds.filter((x): x is string => typeof x === "string") : [];
    if (!Array.isArray(o.atomIds)) errors.push(`Step ${i + 1}: atomIds must be an array of strings.`);
    const override = typeof o.orderOverride === "string" && o.orderOverride.trim() ? o.orderOverride.trim() : undefined;
    steps.push({ atomIds: ids, label: typeof o.label === "string" ? o.label : "", orderOverride: override });
  });
  const mechanical = Array.isArray(r.mechanical) ? r.mechanical.filter((x): x is string => typeof x === "string") : [];
  return { summary: typeof r.summary === "string" ? r.summary : "", steps, mechanical };
}

/** Pull the first JSON object out of a model reply that may include prose or code fences. */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

// ---------- coverage guarantee ----------

export type CoverageReport = {
  ok: boolean;
  totalLines: number;
  missing: string[]; // "file:SIDE:line"
  duplicated: string[];
  extra: string[]; // lines claimed by atoms that are not in the diff
  repeatedAtoms: string[];
  unknownAtoms: string[];
};

/**
 * The invariant: the union of hunkLines over all atoms in `steps` and `mechanical` equals the set of
 * changed lines in the diff, with no line and no atom repeated.
 */
export function checkCoverage(pr: PRInput, atoms: ChangeAtom[], story: Pick<Story, "steps" | "mechanical">): CoverageReport {
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const expected = new Set<string>();
  for (const f of pr.files) for (const r of changedLines(f)) expected.add(lineKey(f.path, r));

  const seenAtoms = new Set<string>();
  const repeatedAtoms: string[] = [];
  const unknownAtoms: string[] = [];
  const seenLines = new Set<string>();
  const duplicated: string[] = [];
  const extra: string[] = [];

  const ids = [...story.steps.flatMap((s) => s.atomIds), ...story.mechanical];
  for (const id of ids) {
    if (seenAtoms.has(id)) {
      repeatedAtoms.push(id);
      continue;
    }
    seenAtoms.add(id);
    const a = byId.get(id);
    if (!a) {
      unknownAtoms.push(id);
      continue;
    }
    for (const r of a.hunkLines) {
      const k = lineKey(a.file, r);
      if (seenLines.has(k)) duplicated.push(pretty(k));
      seenLines.add(k);
      if (!expected.has(k)) extra.push(pretty(k));
    }
  }
  const missing = [...expected].filter((k) => !seenLines.has(k)).map(pretty);
  // Atoms with no lines (binary files, pure renames) must still be shown.
  for (const a of atoms) if (!a.hunkLines.length && !seenAtoms.has(a.id)) missing.push(`${a.file} (${a.kind})`);

  return {
    ok: !missing.length && !duplicated.length && !extra.length && !repeatedAtoms.length && !unknownAtoms.length,
    totalLines: expected.size,
    missing,
    duplicated,
    extra,
    repeatedAtoms,
    unknownAtoms,
  };
}

function pretty(k: string): string {
  return k.split("\u0000").join(":");
}
