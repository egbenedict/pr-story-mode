import type { LLMProvider } from "@prstory/core";
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai-compatible";

export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic";
export { OpenAICompatibleProvider } from "./openai-compatible";
export { MockProvider } from "./mock";

export type ProviderConfig =
  | { provider: "none" }
  | { provider: "anthropic"; model?: string; apiKey?: string; baseURL?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max"; browser?: boolean }
  | { provider: "openai"; model?: string; apiKey?: string; baseURL?: string }
  | { provider: "openai-compatible"; model: string; baseURL: string; apiKey?: string; jsonSchema?: boolean; maxContextTokens?: number };

export function createProvider(cfg: ProviderConfig): LLMProvider | null {
  switch (cfg.provider) {
    case "none":
      return null;
    case "anthropic":
      return new AnthropicProvider({ ...cfg, model: cfg.model ?? DEFAULT_ANTHROPIC_MODEL });
    case "openai":
      return new OpenAICompatibleProvider({
        id: "openai",
        baseURL: cfg.baseURL ?? "https://api.openai.com/v1",
        model: cfg.model ?? "gpt-5",
        apiKey: cfg.apiKey,
        jsonSchema: true,
        maxContextTokens: 400_000,
      });
    case "openai-compatible":
      return new OpenAICompatibleProvider(cfg);
  }
}

/** USD per million tokens: input, output, cache read, cache write (5-minute TTL). */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
};

/** Estimated cost in USD, or null when the model's price is unknown (e.g. self-hosted). */
export function estimateCost(
  model: string,
  u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (u.inputTokens * p[0] + u.outputTokens * p[1] + (u.cacheReadTokens ?? 0) * p[2] + (u.cacheWriteTokens ?? 0) * p[3]) / 1e6;
}
