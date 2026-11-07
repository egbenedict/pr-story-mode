import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubToken, loadConfig, readSecret, saveConfig, validateConfig, type Config } from "../src/config";
import { chooseModel } from "../src/model";

const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PRS_TEST_TOKEN"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

const gateway: Config = {
  model: { provider: "anthropic", baseURL: "https://llm-gateway.acme.test", keyHeader: "x-api-key", key: { command: "printf 'banner\\nsapi-123\\n'" }, headers: { "x-team": "reviews" } },
  github: { "github.acme.test": { token: { env: "PRS_TEST_TOKEN" } } },
};

describe("config", () => {
  it("accepts a gateway setup and explains what's wrong with a bad one", () => {
    expect(validateConfig(gateway)).toEqual([]);
    const problems = validateConfig({ model: { provider: "claude", baseURL: "llm.acme", key: "sapi-123", keyHeader: "cookie" }, github: { "bad host!": { token: { password: "x" } } }, open: "yes" });
    expect(problems.join("\n")).toMatch(/provider/);
    expect(problems.join("\n")).toMatch(/baseURL/);
    expect(problems.join("\n")).toMatch(/model.key/); // a key written into the file is refused
    expect(problems.join("\n")).toMatch(/keyHeader/);
    expect(problems.join("\n")).toMatch(/bad host/);
    expect(problems.join("\n")).toMatch(/open/);
  });

  it("is saved readable only by you, and a broken file is reported, not ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "prs-"));
    const path = join(dir, "nested", "config.json");
    saveConfig(path, gateway);
    expect(loadConfig(path)).toEqual(gateway);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, "{ nope");
    expect(() => loadConfig(path)).toThrow(/isn't valid JSON/);
    expect(loadConfig(join(dir, "missing.json"))).toEqual({});
  });

  it("uses the last line a key command prints", async () => {
    expect(await readSecret({ command: "printf 'Signing in...\\nsapi-123\\n'" })).toBe("sapi-123");
    await expect(readSecret({ command: "exit 3" })).rejects.toThrow(/exited with code 3/);
    await expect(readSecret({ env: "PRS_TEST_TOKEN" })).rejects.toThrow(/isn't set/);
  });
});

describe("choosing the model", () => {
  it("sends code to the saved gateway, with its key from the command", async () => {
    process.env.ANTHROPIC_API_KEY = "personal-key"; // never used when a gateway is saved
    const c = chooseModel({}, gateway);
    expect(c.sendsTo).toBe("llm-gateway.acme.test");
    expect(c.keyFrom).toBe("the command `printf 'banner\\nsapi-123\\n'`");
    expect(c.cfg).toMatchObject({ provider: "anthropic", baseURL: "https://llm-gateway.acme.test", keyHeader: "x-api-key", headers: { "x-team": "reviews" } });
    expect("apiKey" in c.cfg && c.cfg.apiKey).toBeFalsy();
    expect(await c.getKey!(false)).toBe("sapi-123");
  });

  it("lets flags override the saved setup for one run", () => {
    expect(chooseModel({ model: "claude-haiku-5-5" }, gateway).cfg).toMatchObject({ model: "claude-haiku-5-5", baseURL: "https://llm-gateway.acme.test" });
    expect(chooseModel({ provider: "none" }, gateway).sendsTo).toBeNull();
    // --no-fallbacks turns off server-side fallback for the run; without it the provider's default (on) holds.
    expect(chooseModel({ "no-fallbacks": true }, gateway).cfg).toMatchObject({ provider: "anthropic", fallbacks: false });
    expect(chooseModel({}, gateway).cfg).not.toHaveProperty("fallbacks");
  });

  it("without a setup, reads the environment the way Claude Code does", () => {
    expect(chooseModel({}, {}).cfg.provider).toBe("none");
    process.env.ANTHROPIC_AUTH_TOKEN = "t";
    expect(chooseModel({}, {}).cfg).toMatchObject({ provider: "anthropic", apiKey: "t", keyHeader: "bearer" });
    process.env.ANTHROPIC_API_KEY = "k";
    const c = chooseModel({}, {});
    expect(c.cfg).toMatchObject({ provider: "anthropic", apiKey: "k" });
    expect("keyHeader" in c.cfg ? c.cfg.keyHeader : undefined).toBeUndefined(); // x-api-key, the default
    expect(c.sendsTo).toBe("api.anthropic.com");
  });
});

describe("GitHub tokens", () => {
  it("prefers the flag, then the saved source, then the environment", async () => {
    process.env.PRS_TEST_TOKEN = "saved";
    process.env.GITHUB_TOKEN = "env";
    process.env.GH_ENTERPRISE_TOKEN = "enterprise";
    expect(await githubToken("github.acme.test", gateway, "flag")).toEqual({ token: "flag", from: "--token" });
    expect(await githubToken("github.acme.test", gateway)).toEqual({ token: "saved", from: "$PRS_TEST_TOKEN" });
    expect(await githubToken("other.acme.test", gateway)).toEqual({ token: "enterprise", from: "$GH_ENTERPRISE_TOKEN" });
    expect(await githubToken("github.com", gateway)).toEqual({ token: "env", from: "$GITHUB_TOKEN" });
    // A host set up with no token uses none, even with GITHUB_TOKEN set.
    expect(await githubToken("github.com", { github: { "github.com": {} } })).toEqual({ from: "no token (as set up)" });
  });
});
