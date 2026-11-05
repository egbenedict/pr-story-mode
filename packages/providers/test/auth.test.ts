import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicProvider, Key, OpenAICompatibleProvider, withKeyRetry } from "../src";

/** A fake gateway that accepts one token at a time, like one whose tokens expire hourly. */
let valid = "tok-1";
const seen: IncomingHttpHeaders[] = [];
let base = "";

const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage };

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    seen.push(req.headers);
    const key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (key !== valid) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "token expired" } }));
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "gw-model", choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      return;
    }
    if (JSON.parse(body).stream) {
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
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" }));
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const req = { system: "s", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 };

describe("gateway keys", () => {
  it("fetches a new key once when the gateway rejects it, and sends it as x-api-key", async () => {
    valid = "tok-2";
    seen.length = 0;
    const asked: boolean[] = [];
    const p = new AnthropicProvider({ baseURL: base, getKey: async (refresh) => (asked.push(refresh), refresh ? "tok-2" : "tok-1"), headers: { "x-team": "reviews" } });
    const out = await p.complete(req);
    expect(out.text).toBe("hello");
    expect(asked).toEqual([false, true]);
    expect(seen.map((h) => h["x-api-key"])).toEqual(["tok-1", "tok-2"]);
    expect(seen.every((h) => h.authorization === undefined && h["x-team"] === "reviews")).toBe(true);
    // The fresh key is kept for later calls.
    await p.complete(req);
    expect(asked).toEqual([false, true]);
  });

  it("sends the key as a Bearer token when the gateway wants that", async () => {
    valid = "bearer-1";
    seen.length = 0;
    const p = new AnthropicProvider({ baseURL: base, apiKey: "bearer-1", keyHeader: "bearer" });
    expect(await p.ping()).toBe("claude-opus-5-5");
    expect(seen[0]!.authorization).toBe("Bearer bearer-1");
    expect(seen[0]!["x-api-key"]).toBeUndefined();
  });

  it("doesn't retry a fixed key, and refreshes only once for requests rejected together", async () => {
    valid = "right";
    await expect(new AnthropicProvider({ baseURL: base, apiKey: "wrong" }).complete(req)).rejects.toMatchObject({ status: 401 });
    let n = 0;
    const key = new Key(async () => `k${n++}`, true);
    const rejected = Object.assign(new Error("401"), { status: 401 });
    let calls = 0;
    const call = async () => {
      calls++;
      if ((await key.get()) === "k0") throw rejected;
      return "ok";
    };
    expect(await Promise.all([withKeyRetry(key, call), withKeyRetry(key, call), withKeyRetry(key, call)])).toEqual(["ok", "ok", "ok"]);
    expect(n).toBe(2);
    expect(calls).toBe(6);
  });

  it("works the same for OpenAI-compatible gateways", async () => {
    valid = "oa-2";
    seen.length = 0;
    const p = new OpenAICompatibleProvider({ baseURL: `${base}/v1`, model: "m", getKey: async (refresh) => (refresh ? "oa-2" : "oa-1"), headers: { "x-team": "t" } });
    expect((await p.complete(req)).text).toBe("OK");
    expect(seen.map((h) => h.authorization)).toEqual(["Bearer oa-1", "Bearer oa-2"]);
    expect(seen[1]!["x-team"]).toBe("t");
  });
});
