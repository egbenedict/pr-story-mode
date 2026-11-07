// `pr-story setup`: a few questions that write the config file. Keys and tokens are never typed
// into this program: they're saved by macOS's `security` tool, or read later from a command, an
// environment variable or the GitHub CLI.

import { DEFAULT_ANTHROPIC_MODEL, type KeyHeader } from "@prstory/providers";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { describeSecret, ghSignedIn, hasGh, loadConfig, readSecret, saveConfig, saveToKeychain, tildePath, type Config, type ModelConfig, type Secret } from "./config";

/** Line-by-line answers. Kept in a queue so answers piped in all at once aren't lost. */
function prompter() {
  // With the terminal as output, readline shows what is typed and lets arrow keys and backspace edit it.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const lines: string[] = [];
  const waiting: ((l: string | null) => void)[] = [];
  let closed = false;
  rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
  rl.on("close", () => {
    closed = true;
    for (const w of waiting.splice(0)) w(null);
  });
  const next = (): Promise<string | null> => (lines.length ? Promise.resolve(lines.shift()!) : closed ? Promise.resolve(null) : new Promise((r) => waiting.push(r)));

  async function ask(question: string, fallback = ""): Promise<string> {
    // The question's last line is readline's prompt, so it's redrawn with the answer as it's edited.
    const text = `${question}${fallback ? ` [${fallback}]` : ""}: `;
    const nl = text.lastIndexOf("\n");
    if (nl >= 0) process.stdout.write(text.slice(0, nl + 1));
    rl.setPrompt(text.slice(nl + 1));
    rl.prompt();
    const a = await next();
    if (a === null) throw new Error("Setup was cancelled.");
    if (!process.stdin.isTTY) process.stdout.write(`${a}\n`);
    return a.trim() || fallback;
  }

  async function choose<T extends string>(question: string, options: [T, string][], fallback?: T): Promise<T> {
    console.log(`\n${question}`);
    options.forEach(([, label], i) => console.log(`  ${i + 1}. ${label}`));
    const def = fallback ? String(options.findIndex(([id]) => id === fallback) + 1) : "1";
    for (;;) {
      const a = await ask("Choose", def);
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]![0];
      console.log(`  Type a number from 1 to ${options.length}.`);
    }
  }

  const yes = async (question: string, fallback: boolean) => /^y/i.test(await ask(`${question} (y/n)`, fallback ? "y" : "n"));

  /** Runs `fn` with the terminal handed over (for `security`, which asks for the secret itself). */
  function handOver<T>(fn: () => T): T {
    rl.pause();
    const raw = process.stdin.isTTY && process.stdin.isRaw;
    if (raw) process.stdin.setRawMode(false);
    try {
      return fn();
    } finally {
      if (raw) process.stdin.setRawMode(true);
      rl.resume();
    }
  }

  return { ask, choose, yes, handOver, close: () => rl.close() };
}

type Prompter = ReturnType<typeof prompter>;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Asks where a secret should come from, saves it to Keychain if chosen, and tries it.
 * `what` is how it's named in questions ("the gateway key").
 */
async function askSecret(p: Prompter, what: string, keychainName: string, opts: { gh?: string; envDefault: string; previous?: Secret }): Promise<Secret | undefined> {
  const options: [string, string][] = [];
  if (opts.gh) options.push(["gh", `Use your GitHub CLI login (gh is signed in to ${opts.gh})`]);
  options.push(["command", `Run a command that prints ${what} (best for tokens that expire, like hourly gateway tokens)`]);
  if (process.platform === "darwin") options.push(["keychain", `Save it in the macOS Keychain (you'll paste it once)`]);
  options.push(["env", "Read it from an environment variable"]);
  if (opts.previous) options.push(["keep", `Keep the current one (${describeSecret(opts.previous)})`]);
  options.push(["none", "None"]);
  const how = await p.choose(`How should pr-story get ${what}?`, options as [string, string][], opts.previous ? "keep" : undefined);

  let secret: Secret | undefined;
  if (how === "keep") return opts.previous;
  if (how === "none") return undefined;
  if (how === "gh") secret = { gh: true };
  if (how === "command") {
    console.log("  The command's last line of output is used as the key. It runs before each story, and again if the key is refused.");
    secret = { command: await p.ask("  Command") };
  }
  if (how === "env") secret = { env: (await p.ask("  Variable name", opts.envDefault)).replace(/^\$/, "") };
  if (how === "keychain") {
    console.log(`  macOS will ask for ${what} twice. It's stored in your login Keychain as "${keychainName}" and never shown.`);
    const saved = p.handOver(() => saveToKeychain(keychainName));
    if (!saved) {
      console.log("  It wasn't saved. You can run setup again, or choose another option.");
      return askSecret(p, what, keychainName, opts);
    }
    secret = { keychain: keychainName };
  }
  if (!secret || ("command" in secret && !secret.command) || ("env" in secret && !secret.env)) return askSecret(p, what, keychainName, opts);
  try {
    const value = await readSecret(secret, opts.gh);
    console.log(`  ✓ Got it (${value.length} characters).`);
  } catch (err) {
    console.log(`  ✗ ${(err as Error).message}`);
    if (!(await p.yes("  Keep this choice anyway?", false))) return askSecret(p, what, keychainName, opts);
  }
  return secret;
}

async function askModel(p: Prompter, prev?: ModelConfig): Promise<ModelConfig> {
  const where = await p.choose(
    "Where should code go to be explained?",
    [
      ["gateway", "My company's LLM gateway for Claude"],
      ["anthropic", "The Anthropic API, with my own key"],
      ["openai-compatible", "An OpenAI-compatible gateway or server"],
      ["none", "Nowhere: no model (stories use dependency order and short templates)"],
    ],
    prev ? (prev.provider === "anthropic" && prev.baseURL ? "gateway" : (prev.provider as "anthropic")) : undefined,
  );
  if (where === "none") return { provider: "none" };

  const m: ModelConfig = { provider: where === "openai-compatible" ? "openai-compatible" : "anthropic" };
  if (where !== "anthropic") {
    for (;;) {
      const url = await p.ask(where === "gateway" ? "\nGateway base URL (what you'd set as ANTHROPIC_BASE_URL)" : "\nBase URL (usually ends in /v1)", prev?.baseURL ?? "");
      if (/^https?:\/\/[^\s/]+/.test(url)) {
        m.baseURL = url.replace(/\/+$/, "");
        break;
      }
      console.log("  That should be a URL like https://llm-gateway.acme.com.");
    }
  }
  if (where === "gateway") {
    m.keyHeader = await p.choose<KeyHeader>(
      "Which header does the gateway expect the key in?",
      [
        ["x-api-key", "x-api-key (most Claude gateways; what ANTHROPIC_API_KEY sends)"],
        ["bearer", "Authorization: Bearer (what ANTHROPIC_AUTH_TOKEN sends)"],
      ],
      prev?.keyHeader,
    );
  }
  const key = await askSecret(p, where === "gateway" ? "the gateway key" : "the API key", where === "anthropic" ? "pr-story-anthropic" : `pr-story-${slug(new URL(m.baseURL!).host)}`, {
    envDefault: where === "openai-compatible" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
    previous: prev?.key,
  });
  if (key) m.key = key;

  const model = await p.ask(where === "openai-compatible" ? "\nModel name" : "\nModel name (gateways sometimes use their own names)", prev?.model ?? (where === "openai-compatible" ? "" : DEFAULT_ANTHROPIC_MODEL));
  if (model && model !== DEFAULT_ANTHROPIC_MODEL) m.model = model;
  if (m.provider === "openai-compatible" && !model) m.model = await p.ask("A model name is needed");

  if (where !== "anthropic") {
    const headers: Record<string, string> = { ...prev?.headers };
    if (Object.keys(headers).length) console.log(`\nExtra headers now: ${Object.keys(headers).join(", ")}`);
    if (await p.yes("\nDoes the gateway need extra headers (a team or project id, say)?", false)) {
      console.log('  One per line as "Name: value", empty line to finish. They are saved as written, so don\'t put secrets here.');
      for (;;) {
        const line = await p.ask("  Header");
        if (!line) break;
        const at = line.indexOf(":");
        if (at < 1) console.log('  Use "Name: value".');
        else headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
    }
    if (Object.keys(headers).length) m.headers = headers;
  }
  return m;
}

async function askGitHub(p: Prompter, prev: Config["github"] = {}): Promise<Config["github"]> {
  const hosts = (await p.ask("\nWhich GitHub hosts are your pull requests on? Separate with commas", Object.keys(prev).join(", ") || "github.com"))
    .split(/[,\s]+/)
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  const out: NonNullable<Config["github"]> = {};
  const gh = hasGh();
  for (const host of hosts) {
    console.log(`\n${host}: a token lets pr-story read private repositories. Read access is enough (Contents and Pull requests).`);
    const token = await askSecret(p, `a token for ${host}`, `pr-story-github-${slug(host)}`, {
      gh: gh && ghSignedIn(host) ? host : undefined,
      envDefault: host === "github.com" ? "GITHUB_TOKEN" : "GH_ENTERPRISE_TOKEN",
      previous: prev[host]?.token,
    });
    out[host] = token ? { token } : {};
  }
  return out;
}

export async function setupCmd(path: string): Promise<void> {
  let prev: Config = {};
  if (existsSync(path)) {
    try {
      prev = loadConfig(path);
    } catch (err) {
      console.log(`${(err as Error).message}\nStarting over.\n`);
    }
  }
  const p = prompter();
  try {
    console.log("PR Story Mode setup. Press Enter to take the answer in [brackets].");
    console.log("Keys and tokens aren't written to the config file: you choose where each one is read from.");
    const config: Config = { ...prev };
    config.model = await askModel(p, prev.model);
    config.github = await askGitHub(p, prev.github);
    config.context = await p.yes("\nShow unchanged code (definitions and callers) beside each step? Those snippets are sent to the model too", prev.context ?? true);
    config.outDir = await p.ask("Folder for stories", prev.outDir ?? "~/pr-stories");
    config.open = await p.yes("Open each story in the browser when it's ready?", prev.open ?? true);
    saveConfig(path, config);
    console.log(`\nSaved ${tildePath(path)}. Next: \`pr-story check\` to try it, then \`pr-story <PR URL>\`.`);
  } finally {
    p.close();
  }
}
