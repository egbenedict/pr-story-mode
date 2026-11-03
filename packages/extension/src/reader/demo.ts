// A scripted model for working on the reader locally (reader.html?pr=…&demo on a local server).
// It answers the ordering and explanation prompts with plausible JSON, streamed at a realistic
// pace, so the loading and writing screens can be seen without an API key or cost.

import { EXPLAIN_SYSTEM, ORDER_SYSTEM, type CompletionRequest, type LLMProvider, type Usage } from "@prstory/core";

const CHARS = 7; // per chunk
const EVERY_MS = 30; // ~230 characters a second, about a fast model's pace

export class DemoProvider implements LLMProvider {
  readonly id = "demo";
  readonly model = "demo (scripted)";
  readonly capabilities = { jsonSchema: true, maxContextTokens: 200_000, promptCaching: false };

  async complete(req: CompletionRequest): Promise<{ text: string; json?: unknown; usage: Usage }> {
    const prompt = req.messages[req.messages.length - 1].content;
    const text = req.system === ORDER_SYSTEM ? plan(prompt) : req.system === EXPLAIN_SYSTEM ? explain(prompt) : "{}";
    await new Promise((r) => setTimeout(r, req.system === ORDER_SYSTEM ? 1800 : 900)); // "thinking"
    for (let i = 0; i < text.length; i += CHARS) {
      await new Promise((r) => setTimeout(r, EVERY_MS));
      req.onText?.(text.slice(i, i + CHARS));
    }
    return { text, json: JSON.parse(text), usage: { inputTokens: Math.round(prompt.length / 4), outputTokens: Math.round(text.length / 4) } };
  }
}

/** Atoms in dependency order, mechanical ones listed apart. */
function plan(prompt: string): string {
  const atoms = [...prompt.matchAll(/^### (a\w+): (.+) \((.+)\)$/gm)].map((m) => ({ id: m[1], label: m[2], mechanical: m[3].includes("mechanical") }));
  const deps = [...prompt.matchAll(/^(a\w+) → (a\w+)/gm)].map((m) => [m[1], m[2]] as const);
  const order: string[] = [];
  const visit = (id: string, seen = new Set<string>()) => {
    if (order.includes(id) || seen.has(id)) return;
    seen.add(id);
    for (const [from, to] of deps) if (to === id) visit(from, seen);
    order.push(id);
  };
  for (const a of atoms) visit(a.id);
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const steps = order
    .filter((id) => !byId.get(id)?.mechanical)
    .map((id) => {
      const sym = byId.get(id)!.label.split(" › ").pop()!;
      return { atomIds: [id], label: `Change \`${sym}\``, orderOverride: "" };
    });
  const files = new Set(atoms.map((a) => a.label.split(" › ")[0])).size;
  const summary = `This is a scripted demo plan, not a real model. It walks through ${steps.length} change${steps.length === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}, with definitions before the code that uses them.`;
  return JSON.stringify({ summary, steps, mechanical: order.filter((id) => byId.get(id)?.mechanical) });
}

/** Two beats per step: the first ends halfway through the first atom's lines, the second runs to the end. */
function explain(prompt: string): string {
  const steps = prompt
    .split(/^## Step /m)
    .slice(1)
    .map((block) => {
      const step = +block.split(":")[0];
      const label = block.split("\n")[0].replace(/^\d+:\s*/, "");
      const atomId = /Atom (a\w+):/.exec(block)?.[1] ?? "";
      const nums = [...block.matchAll(/^\s+(\d+) [-+ ~] /gm)].map((m) => +m[1]);
      const mid = nums[Math.floor((nums.length - 1) / 2)] ?? 0;
      return {
        step,
        beats: [
          {
            text: `Here the change to ${label.replace(/^Change /, "")} starts. This sentence is placeholder text from the demo model, written to show how a step fills in while it streams. The lines below are the first half of the change.`,
            cites: nums.length ? [{ atomId, start: nums[0], end: mid }] : [],
            throughAtomId: nums.length ? atomId : "",
            throughLine: nums.length ? mid : 0,
          },
          {
            text: "The rest of the change follows. A real model would explain what these lines do and why they matter for the reviewer.",
            cites: [],
            throughAtomId: nums.length ? atomId : "",
            throughLine: nums.length ? nums[nums.length - 1] : 0,
          },
        ],
      };
    });
  return JSON.stringify({ steps });
}
