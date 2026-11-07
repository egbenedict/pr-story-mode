import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readBodyFile, readIssuesFile } from "../src/local";
import { makeRepo } from "./helpers";

const main = resolve(__dirname, "../src/main.ts");
const tsx = resolve(__dirname, "../../../node_modules/.bin/tsx");

describe("--body-file and --issues-file", () => {
  const dir = mkdtempSync(join(tmpdir(), "prstory-inputs-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    return join(dir, name);
  };

  it("reads the description as UTF-8 text, unchanged", () => {
    expect(readBodyFile(file("body.md", "Fixes the crash — see ✓ notes.\n\nSecond paragraph.\n"))).toBe("Fixes the crash — see ✓ notes.\n\nSecond paragraph.\n");
  });

  it("reads linked issues and keeps only the known fields", () => {
    const issues = readIssuesFile(file("issues.json", JSON.stringify([{ number: 12, title: "Crash", body: "It crashes.", url: "https://github.com/o/r/issues/12", extra: 1 }, { number: 13, title: "Slow", body: "" }])));
    expect(issues).toEqual([
      { number: 12, title: "Crash", body: "It crashes.", url: "https://github.com/o/r/issues/12" },
      { number: 13, title: "Slow", body: "" },
    ]);
    expect(readIssuesFile(file("none.json", "[]"))).toEqual([]);
  });

  it("refuses issues files with the wrong shape, saying which entry", () => {
    expect(() => readIssuesFile(file("bad.json", "{not json"))).toThrow(/not valid JSON/);
    expect(() => readIssuesFile(file("obj.json", '{"number": 1}'))).toThrow(/JSON array/);
    expect(() => readIssuesFile(file("str.json", JSON.stringify([{ number: 1, title: "a", body: "b" }, { number: "2", title: "a", body: "b" }])))).toThrow(/issue 1 should be/);
    expect(() => readIssuesFile(file("nobody.json", JSON.stringify([{ number: 1, title: "a" }])))).toThrow(/issue 0 should be/);
  });
});

// ---------- end to end: `pr-story story` against a fake Messages API ----------

const seen: { headers: IncomingHttpHeaders; body: { system?: unknown; messages: { content: unknown }[]; fallbacks?: unknown } }[] = [];
let base = "";
const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
// Answers every call as another model, with JSON that fails validation (so the run falls back quickly).
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    seen.push({ headers: req.headers, body: JSON.parse(body) });
    const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      sse([
        ["message_start", { type: "message_start", message }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "{}" } }],
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

/** Runs the CLI from source with a clean environment (no saved setup, a fake key) and waits for it. */
function cli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: "test-key" };
  return new Promise((done, fail) => {
    const p = spawn(tsx, [main, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", fail);
    p.on("close", (code) => done({ code, stderr }));
  });
}

const allText = (b: (typeof seen)[number]["body"]) => JSON.stringify([b.system, b.messages]);

describe("pr-story story with a local diff", () => {
  it("sends the given description and issues to the model, and records the model that answered", async () => {
    const { dir, cleanup } = makeRepo({ "src/a.ts": "export const a = 1;\n" }, { "src/a.ts": "export const a = 2;\n" }, { title: "commit subject" });
    const tmp = mkdtempSync(join(tmpdir(), "prstory-e2e-"));
    try {
      const config = join(tmp, "config.json");
      writeFileSync(config, "{}");
      writeFileSync(join(tmp, "body.md"), "PR-BODY-MARKER: why this change exists.");
      writeFileSync(join(tmp, "issues.json"), JSON.stringify([{ number: 77, title: "ISSUE-TITLE-MARKER", body: "ISSUE-BODY-MARKER", url: "https://github.com/o/r/issues/77" }]));
      const common = ["story", "--repo", dir, "--base", "main", "--head", "feature", "--config", config, "--provider", "anthropic", "--model", "claude-opus-5-5", "--base-url", base, "--title", "TITLE-MARKER", "--no-context"];

      seen.length = 0;
      const out1 = join(tmp, "out1");
      const r1 = await cli([...common, "--out", out1, "--body-file", join(tmp, "body.md"), "--issues-file", join(tmp, "issues.json")]);
      expect(r1.stderr).not.toMatch(/^Error:/m);
      expect(seen.length).toBeGreaterThan(0);
      const first = allText(seen[0]!.body);
      for (const marker of ["TITLE-MARKER", "PR-BODY-MARKER", "ISSUE-TITLE-MARKER", "ISSUE-BODY-MARKER"]) expect(first).toContain(marker);
      expect(first).not.toContain("commit subject");
      expect(seen.every((s) => s.body.fallbacks === "default")).toBe(true);
      const story1 = JSON.parse(readFileSync(join(out1, "story.json"), "utf8"));
      expect(story1.story.meta.model).toBe("claude-opus-5-5");
      expect(story1.metrics.servedModels).toEqual(["claude-sonnet-5-5"]);
      expect(readFileSync(join(out1, "story.html"), "utf8")).toContain("ISSUE-TITLE-MARKER");

      seen.length = 0;
      const out2 = join(tmp, "out2");
      const r2 = await cli([...common, "--out", out2, "--no-fallbacks"]);
      expect(r2.stderr).not.toMatch(/^Error:/m);
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) {
        expect(s.body).not.toHaveProperty("fallbacks");
        expect(String(s.headers["anthropic-beta"] ?? "")).not.toContain("server-side-fallback");
      }
      // Without --body-file the description is the head commit's message body (empty here), and no issues.
      expect(allText(seen[0]!.body)).not.toContain("PR-BODY-MARKER");
      expect(allText(seen[0]!.body)).not.toContain("Linked issue");

      const bad = await cli([...common, "--out", join(tmp, "out3"), "--issues-file", join(tmp, "body.md")]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toMatch(/not valid JSON/);
    } finally {
      cleanup();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
