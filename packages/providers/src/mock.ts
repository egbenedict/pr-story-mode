import type { CompletionRequest, LLMProvider, Usage } from "@prstory/core";

/** Scripted provider for tests: returns queued responses in order and records each request. */
export class MockProvider implements LLMProvider {
  readonly id = "mock";
  readonly model = "mock";
  readonly capabilities: LLMProvider["capabilities"];
  readonly requests: CompletionRequest[] = [];
  private queue: (string | ((req: CompletionRequest) => string))[];

  constructor(responses: (string | ((req: CompletionRequest) => string))[], opts: { jsonSchema?: boolean; maxContextTokens?: number } = {}) {
    this.queue = [...responses];
    this.capabilities = { jsonSchema: opts.jsonSchema ?? true, maxContextTokens: opts.maxContextTokens ?? 200_000, promptCaching: false };
  }

  async complete(req: CompletionRequest): Promise<{ text: string; json?: unknown; usage: Usage }> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("MockProvider: no more responses queued");
    const text = typeof next === "function" ? next(req) : next;
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}
