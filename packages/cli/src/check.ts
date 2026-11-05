// `pr-story check`: tries each part of the setup (the key, the model or gateway, each GitHub token)
// and says in plain words what works, what doesn't and how to fix it, and where code will be sent.

import { defaultApiBase, parsePrUrl } from "@prstory/core";
import { createProvider, isKeyRejection } from "@prstory/providers";
import { existsSync } from "node:fs";
import { githubToken, tildePath, type Config } from "./config";
import { chooseModel } from "./model";

type Values = Record<string, string | boolean | undefined>;

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const info = (s: string) => console.log(`    ${s}`);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);

export async function checkCmd(target: string | undefined, v: Values, config: Config, path: string): Promise<void> {
  let failed = false;
  console.log(existsSync(path) ? `Config: ${tildePath(path)}` : `Config: none yet (run \`pr-story setup\`). Using flags and environment variables.`);

  // The model.
  console.log("\nModel");
  const choice = chooseModel(v, config);
  if (choice.cfg.provider === "none") {
    info("No model: stories use dependency order and short template descriptions. Run `pr-story setup` to add one.");
  } else {
    const model = "model" in choice.cfg ? choice.cfg.model : undefined;
    info(`${choice.cfg.provider === "anthropic" ? "Claude" : choice.cfg.provider} at ${choice.sendsTo}${model ? `, model ${model}` : ""}`);
    let keyOk = true;
    if (choice.getKey) {
      try {
        const key = await choice.getKey(false);
        ok(`Key from ${choice.keyFrom} (${key.length} characters)`);
      } catch (err) {
        bad(`Couldn't get the key from ${choice.keyFrom}: ${message(err)}`);
        failed = true;
        keyOk = false;
      }
    } else info(`Key: ${choice.keyFrom ?? "none"}`);
    if (keyOk) {
      const provider = createProvider(choice.cfg) as { ping?: () => Promise<string> } | null;
      try {
        const answered = await provider!.ping!();
        ok(`${choice.sendsTo} answered a test request${answered && answered !== model ? ` (model ${answered})` : ""}`);
      } catch (err) {
        failed = true;
        bad(`The test request failed: ${message(err)}`);
        if (isKeyRejection(err)) info(choice.getKey ? "The key was refused, even after getting a fresh one. Check that the key command gives a key for this gateway." : "The key was refused. Check it, or the header the gateway expects (keyHeader in the config).");
        else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|Connection error/i.test(String(err))) info(`Couldn't reach ${choice.sendsTo}. If it's an internal address, check the VPN.`);
        else if ((err as { status?: number }).status === 404) info("The address answered, but not as this kind of API. Check the base URL (often it ends without /v1 for Claude gateways).");
      }
    }
  }

  // GitHub.
  console.log("\nGitHub");
  const ref = target ? parsePrUrl(target) : null;
  if (target && !ref) {
    bad(`Not a pull request URL: ${target}`);
    failed = true;
  }
  const hosts = [...new Set([...Object.keys(config.github ?? {}), ...(ref ? [ref.host.toLowerCase()] : [])])];
  if (!hosts.length) hosts.push("github.com");
  for (const host of hosts) {
    const api = process.env.GITHUB_API_URL && host === ref?.host ? process.env.GITHUB_API_URL : defaultApiBase(host);
    let token: string | undefined;
    let from: string;
    try {
      ({ token, from } = await githubToken(host, config, typeof v.token === "string" ? v.token : undefined));
    } catch (err) {
      bad(`${host}: couldn't get the token: ${message(err)}`);
      failed = true;
      continue;
    }
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "pr-story", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    try {
      const res = await fetch(`${api}${token ? "/user" : "/rate_limit"}`, { headers });
      if (res.status === 401) {
        bad(`${host}: the token from ${from} was refused. It may have expired.`);
        failed = true;
        continue;
      }
      if (!res.ok) {
        bad(`${host}: GitHub answered ${res.status}.`);
        failed = true;
        continue;
      }
      if (token) ok(`${host}: signed in as ${((await res.json()) as { login?: string }).login ?? "?"} (token from ${from})`);
      else ok(`${host}: reachable, no token (public repositories only, 60 requests an hour)`);
    } catch (err) {
      bad(`${host}: couldn't reach ${api}: ${message(err)}${host !== "github.com" ? ". If it's an internal address, check the VPN." : ""}`);
      failed = true;
      continue;
    }
    if (ref && ref.host.toLowerCase() === host) {
      const res = await fetch(`${api}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, { headers }).catch(() => null);
      if (res?.ok) ok(`Can read ${ref.owner}/${ref.repo}#${ref.number}: ${((await res.json()) as { title?: string }).title ?? ""}`);
      else {
        failed = true;
        bad(`Can't read ${ref.owner}/${ref.repo}#${ref.number}${res ? ` (${res.status})` : ""}. ${res?.status === 404 ? "Either it doesn't exist or the token can't see the repository: give it Contents and Pull requests read access." : ""}`);
      }
    }
  }

  console.log("\nWhere code goes");
  info(`Pull requests are read from ${hosts.join(", ")}.`);
  if (choice.sendsTo) info(`Changed code${config.context === false ? "" : " and nearby unchanged code"} is sent to ${choice.sendsTo} to be explained.`);
  info("Nothing else leaves this computer: there is no PR Story Mode server and no telemetry. Stories are saved as local files.");

  if (failed) process.exitCode = 1;
  else console.log(`\nAll set.${target ? "" : " Run `pr-story <PR URL>`."}`);
}
