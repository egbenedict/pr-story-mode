import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, LLMProvider, Usage } from "@prstory/core";
import { Key, keyedFetch, withKeyRetry, type KeyHeader, type KeySource } from "./auth";

export type AnthropicOptions = {
  model?: string;
  /** A fixed key. With neither this nor `getKey`, the SDK uses ANTHROPIC_API_KEY or an `ant auth login` profile. */
  apiKey?: string;
  /** Fetches the key, and fetches it again when the server rejects it (gateway tokens that expire). */
  getKey?: KeySource;
  /** How a key is sent. Default `x-api-key`; some gateways want `bearer`. */
  keyHeader?: KeyHeader;
  /** Extra headers on every request, for gateways that need them (a team or project id). */
  headers?: Record<string, string>;
  baseURL?: string; // e.g. an internal gateway
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Calling from a browser extension page with the user's own key (the SDK refuses browsers otherwise). */
  browser?: boolean;
};

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/**
 * Anthropic Messages API adapter: native JSON-schema output, prompt caching on the shared prefix,
 * adaptive thinking, and server-side fallback when a request is declined.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly capabilities = { jsonSchema: true, maxContextTokens: 1_000_000, promptCaching: true };
  private client: Anthropic;
  private effort: AnthropicOptions["effort"];
  private key: Key | null;

  constructor(opts: AnthropicOptions = {}) {
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.effort = opts.effort ?? "medium";
    this.key = opts.getKey ? new Key(opts.getKey, true) : opts.apiKey ? Key.fixed(opts.apiKey) : null;
    this.client = new Anthropic({
      baseURL: opts.baseURL,
      defaultHeaders: opts.headers,
      dangerouslyAllowBrowser: opts.browser,
      // With a key of our own, the SDK gets a stand-in (so it looks for no other credentials) and
      // keyedFetch puts the real key in the right header on each request.
      ...(this.key ? { apiKey: "set-per-request", fetch: keyedFetch(this.key, opts.keyHeader ?? "x-api-key") } : {}),
    });
  }

  /**
   * A tiny request shaped like a story's (same features), to check the key and gateway work.
   * Costs well under a cent. Resolves with the model the server says answered.
   */
  async ping(): Promise<string> {
    return withKeyRetry(this.key, async () => {
      const msg = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 64,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      return msg.model;
    });
  }

  complete(req: CompletionRequest): Promise<{ text: string; json?: unknown; usage: Usage }> {
    return withKeyRetry(this.key, () => this.completeOnce(req));
  }

  private async completeOnce(req: CompletionRequest): Promise<{ text: string; json?: unknown; usage: Usage }> {
    // The shared prefix (PR description, step order) goes first with a cache breakpoint,
    // so explanation windows after the first reuse it.
    const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.map((m, i) => {
      if (i === 0 && m.role === "user" && req.sharedPrefix) {
        return {
          role: "user",
          content: [
            { type: "text", text: req.sharedPrefix, cache_control: { type: "ephemeral" } },
            { type: "text", text: m.content },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        effort: this.effort,
        ...(req.schema ? { format: { type: "json_schema", schema: req.schema } } : {}),
      },
      system: req.system,
      messages,
    });
    if (req.onText) stream.on("text", (delta) => req.onText!(delta));
    const msg = await stream.finalMessage();

    if (msg.stop_reason === "refusal") {
      throw new Error(`The model declined this request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ""}.`);
    }
    if (msg.stop_reason === "max_tokens") {
      throw new Error(`The response hit max_tokens (${req.maxTokens}) before finishing.`);
    }

    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let json: unknown;
    if (req.schema) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined; // the validator reports it and the repair loop asks again
      }
    }
    return {
      text,
      json,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
