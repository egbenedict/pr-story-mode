import { describe, expect, it } from "vitest";
import { prUrlOf } from "../src/content";
import { DEFAULT_SETTINGS, missingModelReason, providerConfig } from "../src/settings";

describe("prUrlOf", () => {
  it("finds the PR from any of its tabs and ignores other pages", () => {
    expect(prUrlOf("https://github.com/sindresorhus/ky/pull/880")).toBe("https://github.com/sindresorhus/ky/pull/880");
    expect(prUrlOf("https://github.com/sindresorhus/ky/pull/880/files?w=1#diff-abc")).toBe("https://github.com/sindresorhus/ky/pull/880");
    expect(prUrlOf("https://github.com/sindresorhus/ky/pulls")).toBeNull();
    expect(prUrlOf("https://github.com/sindresorhus/ky/pull/880x")).toBeNull();
    expect(prUrlOf("https://github.com/sindresorhus/ky/issues/879")).toBeNull();
  });
});

describe("settings", () => {
  it("runs without a model until a key (or a self-hosted endpoint) is set", () => {
    expect(providerConfig(DEFAULT_SETTINGS)).toEqual({ provider: "none" });
    expect(missingModelReason(DEFAULT_SETTINGS)).toBe("No API key is set.");
    const anthropic = { ...DEFAULT_SETTINGS, apiKey: " test-key " };
    expect(providerConfig(anthropic)).toMatchObject({ provider: "anthropic", apiKey: "test-key", browser: true });
    expect(missingModelReason(anthropic)).toBeNull();
    const selfHosted = { ...DEFAULT_SETTINGS, provider: "openai-compatible" as const, model: "qwen3-coder", baseURL: "http://localhost:8000/v1" };
    expect(providerConfig(selfHosted)).toMatchObject({ provider: "openai-compatible", model: "qwen3-coder", apiKey: undefined });
    expect(missingModelReason({ ...selfHosted, baseURL: "" })).toMatch(/base URL/);
  });
});
