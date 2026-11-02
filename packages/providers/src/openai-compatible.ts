import type { CompletionRequest, LLMProvider, Usage } from "@prstory/core";

export type OpenAICompatibleOptions = {
  baseURL: string; // e.g. https://api.openai.com/v1, http://localhost:11434/v1 (Ollama), a vLLM server
  model: string;
  apiKey?: string;
  jsonSchema?: boolean; // whether the server supports response_format json_schema
  maxContextTokens?: number;
  id?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Chat Completions adapter for OpenAI and OpenAI-compatible servers (Ollama, vLLM, LM Studio).
 * When the server lacks JSON-schema output, core asks for JSON in the prompt instead.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: LLMProvider["capabilities"];
  private opts: OpenAICompatibleOptions;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.id = opts.id ?? "openai-compatible";
    this.model = opts.model;
    this.capabilities = {
      jsonSchema: opts.jsonSchema ?? false,
      maxContextTokens: opts.maxContextTokens ?? 32_000,
      promptCaching: false,
    };
  }

  async complete(req: CompletionRequest): Promise<{ text: string; json?: unknown; usage: Usage }> {
    const messages = [
      { role: "system", content: req.system },
      ...req.messages.map((m, i) =>
        i === 0 && req.sharedPrefix ? { role: m.role, content: `${req.sharedPrefix}\n\n${m.content}` } : m,
      ),
    ];
    const body: Record<string, unknown> = { model: this.model, messages, max_tokens: req.maxTokens };
    if (req.schema && this.capabilities.jsonSchema) {
      body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema: req.schema } };
    }
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${this.id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices: { message: { content: string | null }; finish_reason: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices[0]?.message.content ?? "";
    return {
      text,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
    };
  }
}
