import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicProvider, estimateCost, PRICES } from "../src";

/** A fake Messages API that answers as `served` and records each request. */
let served = "claude-sonnet-5-5";
const seen: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let base = "";

const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    seen.push({ headers: req.headers, body: parsed });
    const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const message = { id: "msg_1", type: "message", role: "assistant", model: served, content: [], stop_reason: null, stop_sequence: null, usage };
    if (!parsed.stream) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      sse([
        ["message_start", { type: "message_start", message }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
        ["message_stop", { type: "message_stop" }],
      ]),
    );
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const req = { system: "s", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

describe("served model and fallbacks", () => {
  it("returns the model that answered, and asks for server-side fallback by default", async () => {
    seen.length = 0;
    served = "claude-sonnet-5-5";
    const p = new AnthropicProvider({ baseURL: base, apiKey: "k", model: "claude-opus-5-5" });
    const out = await p.complete(req);
    expect(out.text).toBe("hello");
    expect(out.model).toBe("claude-sonnet-5-5");
    expect(p.model).toBe("claude-opus-5-5");
    expect(seen[0]!.body.fallbacks).toBe("default");
    expect(String(seen[0]!.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
  });

  it("sends no fallback beta or parameter with fallbacks: false, for completions and the ping", async () => {
    seen.length = 0;
    served = "claude-opus-5-5";
    const p = new AnthropicProvider({ baseURL: base, apiKey: "k", model: "claude-opus-5-5", fallbacks: false });
    expect((await p.complete(req)).model).toBe("claude-opus-5-5");
    expect(await p.ping()).toBe("claude-opus-5-5");
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.body).not.toHaveProperty("fallbacks");
      expect(String(s.headers["anthropic-beta"] ?? "")).not.toContain("server-side-fallback");
    }
  });
});

describe("prices", () => {
  it("charges cache reads at a tenth of the input price", () => {
    for (const [model, [input, , cacheRead]] of Object.entries(PRICES)) expect(cacheRead, model).toBeCloseTo(input / 10, 10);
    expect(PRICES["claude-opus-5-5"]![2]).toBe(0.4);
    expect(PRICES["claude-fable-5-1"]![2]).toBe(1);
    expect(estimateCost("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.4, 10);
    expect(estimateCost("claude-fable-5-1", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(1, 10);
  });
});
