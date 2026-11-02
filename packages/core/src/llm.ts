import { extractJson } from "./validate";
import type { CompletionRequest, JSONSchema, LLMProvider, PRInput, Usage } from "./types";

/** The PR's title, description and linked issues, as the opening of a prompt. */
export function prHeader(pr: PRInput): string {
  const issues = (pr.issues ?? []).map((i) => `## Linked issue #${i.number}: ${i.title}\n\n${i.body.trim().slice(0, 2000) || "(no description)"}`);
  return `# Pull request #${pr.number}: ${pr.title}\n\n${pr.body.trim() || "(no description)"}\n${issues.length ? `\n${issues.join("\n\n")}\n` : ""}`;
}

/** Rough token estimate (≈4 characters per token) for budgeting prompts. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Call the provider and return parsed JSON when possible. When the provider has no native
 * JSON-schema output, the schema is described in the system prompt instead; the validators and
 * repair loop catch anything malformed.
 */
export async function completeJson(
  provider: LLMProvider,
  req: CompletionRequest & { schema: JSONSchema },
): Promise<{ json: unknown; text: string; usage: Usage }> {
  const r: CompletionRequest = provider.capabilities.jsonSchema
    ? req
    : {
        ...req,
        schema: undefined,
        system: `${req.system}\n\nRespond with a single JSON object, and nothing else, that matches this JSON Schema:\n${JSON.stringify(req.schema)}`,
      };
  const res = await provider.complete(r);
  let json = res.json;
  if (json === undefined) {
    try {
      json = JSON.parse(extractJson(res.text));
    } catch {
      json = undefined;
    }
  }
  return { json, text: res.text, usage: res.usage };
}

export function addUsage(total: { tokens: number }, u: Usage) {
  total.tokens += u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}
