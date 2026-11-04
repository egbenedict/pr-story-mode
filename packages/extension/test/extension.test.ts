import { describe, expect, it } from "vitest";
import { prUrlOf } from "../src/content";
import { DEFAULT_SETTINGS, embedAllowed, hostOrigins, missingModelReason, normalizeHost, providerConfig, tokenFor } from "../src/settings";
import { repoKey } from "../src/cache";

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

describe("GitHub Enterprise settings", () => {
  const s = { ...DEFAULT_SETTINGS, githubToken: "public-token", enterprise: [{ host: "github.acme.com", token: " acme-token " }, { host: "acme.ghe.com", token: "" }] };

  it("reads host names from what people paste, and rejects github.com and non-hosts", () => {
    expect(normalizeHost("https://GitHub.Acme.com/team/api/pull/7")).toBe("github.acme.com");
    expect(normalizeHost(" acme.ghe.com ")).toBe("acme.ghe.com");
    expect(["github.com", "api.github.com", "localhost", "not a host", ""].map(normalizeHost)).toEqual([null, null, null, null, null]);
  });

  it("uses each host's own token", () => {
    expect(tokenFor(s, "github.com")).toBe("public-token");
    expect(tokenFor(s, "GitHub.Acme.com")).toBe("acme-token");
    expect(tokenFor(s, "acme.ghe.com")).toBeUndefined();
    expect(tokenFor(s, "other.example.com")).toBeUndefined();
  });

  it("asks for the host, and for ghe.com also its api. host", () => {
    expect(hostOrigins("github.acme.com")).toEqual(["https://github.acme.com/*"]);
    expect(hostOrigins("acme.ghe.com")).toEqual(["https://acme.ghe.com/*", "https://api.acme.ghe.com/*"]);
  });

  it("lets only github.com and saved hosts show the reader", () => {
    expect(embedAllowed(["https://github.com"], s)).toBe(true);
    expect(embedAllowed(["https://github.acme.com"], s)).toBe(true);
    expect(embedAllowed(["https://evil.example"], s)).toBe(false);
    expect(embedAllowed(["https://github.com", "https://evil.example"], s)).toBe(false); // every ancestor must be allowed
    expect(embedAllowed([], s)).toBe(false); // opened directly, not inside GitHub
    expect(embedAllowed(["https://github.acme.com"], DEFAULT_SETTINGS)).toBe(false);
  });

  it("keeps stories from different hosts apart", () => {
    expect(repoKey({ host: "github.com", owner: "o", repo: "r" })).toBe("o/r");
    expect(repoKey({ host: "GitHub.Acme.com", owner: "o", repo: "r" })).toBe("github.acme.com/o/r");
  });
});
