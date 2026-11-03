import type { CompletionRequest, LLMProvider, Usage } from "@prstory/core";

/** Scripted provider for tests: returns queued responses in order and records each request. */
export class MockProvider implements LLMProvider {
  readonly id = "mock";
  readonly model = "mock";
  readonly capabilities: LLMProvider["capabilities"];
  readonly requests: CompletionRequest[] = [];
  private queue: (string | ((req: CompletionRequest) => string))[];

  private chunk: number;
  private delayMs: number;

  constructor(responses: (string | ((req: CompletionRequest) => string))[], opts: { jsonSchema?: boolean; maxContextTokens?: number; chunk?: number; delayMs?: number } = {}) {
    this.queue = [...responses];
    this.chunk = opts.chunk ?? 40;
    this.delayMs = opts.delayMs ?? 0;
    this.capabilities = { jsonSchema: opts.jsonSchema ?? true, maxContextTokens: opts.maxContextTokens ?? 200_000, promptCaching: false };
  }

  async complete(req: CompletionRequest): Promise<{ text: string; json?: unknown; usage: Usage }> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("MockProvider: no more responses queued");
    const text = typeof next === "function" ? next(req) : next;
    // Stream like a real provider, in a few pieces.
    if (req.onText)
      for (let i = 0; i < text.length; i += this.chunk) {
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        req.onText(text.slice(i, i + this.chunk));
      }
    return { text, usage: { inputTokens: 10, outputTokens: 10 } };
  }
}
