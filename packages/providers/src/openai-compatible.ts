import type { Completion, CompletionRequest, LLMProvider } from "@prstory/core";
import { Key, withKeyRetry, type KeySource } from "./auth";

export type OpenAICompatibleOptions = {
  baseURL: string; // e.g. https://api.openai.com/v1, http://localhost:11434/v1 (Ollama), a vLLM server
  model: string;
  apiKey?: string;
  /** Fetches the key, and fetches it again when the server rejects it. Sent as a Bearer token. */
  getKey?: KeySource;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
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
  private key: Key | null;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.key = opts.getKey ? new Key(opts.getKey, true) : opts.apiKey ? Key.fixed(opts.apiKey) : null;
    this.id = opts.id ?? "openai-compatible";
    this.model = opts.model;
    this.capabilities = {
      jsonSchema: opts.jsonSchema ?? false,
      maxContextTokens: opts.maxContextTokens ?? 32_000,
      promptCaching: false,
    };
  }

  /** A one-message request to check the key and server work. Resolves with the model that answered. */
  async ping(): Promise<string> {
    const data = await withKeyRetry(this.key, () => this.post({ model: this.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 8 }));
    return (data as { model?: string }).model ?? this.model;
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.opts.headers,
        ...(this.key ? { Authorization: `Bearer ${await this.key.get()}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw Object.assign(new Error(`${this.id} ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });
    return res.json();
  }

  async complete(req: CompletionRequest): Promise<Completion> {
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
    const data = (await withKeyRetry(this.key, () => this.post(body, req.signal))) as {
      model?: string;
      choices: { message: { content: string | null }; finish_reason: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices[0]?.message.content ?? "";
    return {
      text,
      model: data.model,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
    };
  }
}
