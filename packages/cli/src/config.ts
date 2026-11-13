// The CLI's saved setup: where code goes to be explained, and how to get keys and GitHub tokens.
// The file never holds a secret. It says where to get each one: a command that prints it (for
// tokens that expire), the macOS Keychain, an environment variable, or the GitHub CLI's login.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { KeyHeader } from "@prstory/providers";

/** Where a secret comes from. */
export type Secret = { command: string } | { keychain: string } | { env: string } | { gh: true };

export type ModelConfig = {
  provider: "anthropic" | "openai" | "openai-compatible" | "none";
  baseURL?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  key?: Secret;
  keyHeader?: KeyHeader;
  /** Extra headers the gateway needs. Not secret: they're stored as written. */
  headers?: Record<string, string>;
};

export type Config = {
  model?: ModelConfig;
  /** Per GitHub host ("github.com", "github.acme.com"): how to get its token. A host listed without one uses no token. */
  github?: Record<string, { token?: Secret }>;
  /** Where stories are written; `~` is your home folder. */
  outDir?: string;
  /** Open each story in the browser when it's written. */
  open?: boolean;
  /** Show unchanged code (definitions, callers) beside steps. Its snippets go to the model too. */
  context?: boolean;
  /** How much of the code the explanations cover: "standard" (the default) or "more". */
  detail?: "standard" | "more";
};

export function configPath(flag?: string): string {
  if (flag) return resolve(flag);
  if (process.env.PR_STORY_CONFIG) return resolve(process.env.PR_STORY_CONFIG);
  const base = process.platform === "win32" ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")) : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "pr-story", "config.json");
}

export const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
export const tildePath = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

/** The saved config, or {} when there is none. A broken file is an error, so it isn't silently ignored. */
export function loadConfig(path: string): Config {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${tildePath(path)} isn't valid JSON (${(err as Error).message}). Fix it, or run \`pr-story setup\` to write a new one.`);
  }
  const problems = validateConfig(raw);
  if (problems.length) throw new Error(`${tildePath(path)} has problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return raw as Config;
}

export function saveConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows
  }
}

const isSecret = (s: unknown): s is Secret => {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 1) return false;
  return (typeof o.command === "string" && !!o.command.trim()) || (typeof o.keychain === "string" && !!o.keychain.trim()) || (typeof o.env === "string" && /^\w+$/.test(o.env)) || o.gh === true;
};

/** What's wrong with a config file, in plain words. Empty when it's fine. */
export function validateConfig(raw: unknown): string[] {
  const out: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["it should be a JSON object"];
  const c = raw as Record<string, unknown>;
  const m = c.model as Record<string, unknown> | undefined;
  if (m !== undefined) {
    if (!m || typeof m !== "object") out.push("model should be an object");
    else {
      if (!["anthropic", "openai", "openai-compatible", "none"].includes(m.provider as string)) out.push('model.provider should be "anthropic", "openai", "openai-compatible" or "none"');
      if (m.baseURL !== undefined && (typeof m.baseURL !== "string" || !/^https?:\/\//.test(m.baseURL))) out.push("model.baseURL should be a URL starting with https://");
      if (m.provider === "openai-compatible" && (!m.baseURL || !m.model)) out.push("an openai-compatible model needs model.baseURL and model.model");
      if ((m.key !== undefined && !isSecret(m.key)) || (m.key as { gh?: unknown } | undefined)?.gh) out.push('model.key should be {"command": "…"}, {"keychain": "…"} or {"env": "…"}');
      if (m.keyHeader !== undefined && m.keyHeader !== "x-api-key" && m.keyHeader !== "bearer") out.push('model.keyHeader should be "x-api-key" or "bearer"');
      if (m.headers !== undefined && (typeof m.headers !== "object" || !m.headers || Object.values(m.headers).some((v) => typeof v !== "string"))) out.push("model.headers should map header names to text");
    }
  }
  if (c.github !== undefined) {
    if (!c.github || typeof c.github !== "object") out.push("github should be an object of hosts");
    else
      for (const [host, h] of Object.entries(c.github as Record<string, { token?: unknown }>)) {
        if (!/^[a-z0-9.-]+$/i.test(host)) out.push(`github."${host}" should be a host name like github.acme.com`);
        if (h?.token !== undefined && !isSecret(h.token)) out.push(`github."${host}".token should be {"gh": true}, {"command": "…"}, {"keychain": "…"} or {"env": "…"}`);
      }
  }
  if (c.outDir !== undefined && typeof c.outDir !== "string") out.push("outDir should be a folder path");
  if (c.open !== undefined && typeof c.open !== "boolean") out.push("open should be true or false");
  if (c.context !== undefined && typeof c.context !== "boolean") out.push("context should be true or false");
  if (c.detail !== undefined && c.detail !== "standard" && c.detail !== "more") out.push('detail should be "standard" or "more"');
  return out;
}

/** "the command `sapi-token`", "Keychain item prstory-model"… for messages. Never includes a secret. */
export function describeSecret(s: Secret): string {
  if ("command" in s) return `the command \`${s.command}\``;
  if ("keychain" in s) return `Keychain item "${s.keychain}"`;
  if ("env" in s) return `$${s.env}`;
  return "your GitHub CLI (gh) login";
}

/** Runs a shell command and resolves with its output. Its prompts (a sign-in, say) show in the terminal. */
function runCommand(cmd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, { shell: true, stdio: ["inherit", "pipe", "inherit"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`\`${cmd}\` took longer than ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(new Error(`Couldn't run \`${cmd}\`: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) fail(new Error(`\`${cmd}\` exited with code ${code}.`));
      else done(lastLine(out));
    });
  });
}

/** A key is one line; if a command prints more (a banner first, say), the last line is the key. */
const lastLine = (s: string) => s.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";

/** Reads a secret. Throws with a message that says how to fix it. */
export async function readSecret(s: Secret, host?: string): Promise<string> {
  let value: string;
  if ("command" in s) value = await runCommand(s.command);
  else if ("keychain" in s) {
    if (process.platform !== "darwin") throw new Error("Keychain is only on macOS. Use a command or an environment variable instead.");
    const r = spawnSync("security", ["find-generic-password", "-s", s.keychain, "-w"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`No Keychain item "${s.keychain}". Run \`pr-story setup\` to save it again.`);
    value = r.stdout.trim();
  } else if ("env" in s) {
    value = process.env[s.env]?.trim() ?? "";
    if (!value) throw new Error(`$${s.env} isn't set.`);
  } else {
    const r = spawnSync("gh", ["auth", "token", "--hostname", host ?? "github.com"], { encoding: "utf8" });
    if (r.error) throw new Error("The GitHub CLI (gh) isn't installed.");
    if (r.status !== 0) throw new Error(`gh isn't signed in to ${host ?? "github.com"}. Run \`gh auth login --hostname ${host ?? "github.com"}\`.`);
    value = r.stdout.trim();
  }
  if (!value) throw new Error(`${describeSecret(s)} gave an empty value.`);
  return value;
}

/** Saves a secret in the macOS Keychain. `security` asks for it in the terminal, so it never passes through this program. */
export function saveToKeychain(service: string): boolean {
  const r = spawnSync("security", ["add-generic-password", "-U", "-a", process.env.USER ?? "pr-story", "-s", service, "-w"], { stdio: "inherit" });
  return r.status === 0;
}

/** Whether `gh` is installed and signed in to this host. */
export function ghSignedIn(host: string): boolean {
  const r = spawnSync("gh", ["auth", "token", "--hostname", host], { encoding: "utf8" });
  return !r.error && r.status === 0 && !!r.stdout.trim();
}

export const hasGh = () => !spawnSync("gh", ["--version"], { encoding: "utf8" }).error;

/**
 * The token for a GitHub host, and where it came from: the --token flag, the config, and for hosts
 * not in the config the environment (GH_ENTERPRISE_TOKEN for enterprise hosts, then GITHUB_TOKEN),
 * then gh's login.
 */
export async function githubToken(host: string, config: Config, flag?: string): Promise<{ token?: string; from: string }> {
  if (flag) return { token: flag, from: "--token" };
  const entry = config.github?.[host.toLowerCase()];
  if (entry) {
    // Listed in the config: its token, or none at all (public repositories), never a fallback.
    if (!entry.token) return { from: "no token (as set up)" };
    return { token: await readSecret(entry.token, host), from: describeSecret(entry.token) };
  }
  const enterprise = host !== "github.com" ? (process.env.GH_ENTERPRISE_TOKEN ?? process.env.GITHUB_ENTERPRISE_TOKEN) : undefined;
  if (enterprise) return { token: enterprise, from: process.env.GH_ENTERPRISE_TOKEN ? "$GH_ENTERPRISE_TOKEN" : "$GITHUB_ENTERPRISE_TOKEN" };
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, from: "$GITHUB_TOKEN" };
  if (ghSignedIn(host)) return { token: await readSecret({ gh: true }, host), from: describeSecret({ gh: true }) };
  return { from: "no token" };
}
