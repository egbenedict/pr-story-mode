// Which model a run uses and how it gets its key: command-line flags first, then the saved config,
// then the usual environment variables.

import { DEFAULT_ANTHROPIC_MODEL, type KeySource, type ProviderConfig } from "@prstory/providers";
import { describeSecret, readSecret, type Config, type ModelConfig } from "./config";

type Values = Record<string, string | boolean | undefined>;
const str = (v: Values, k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);

export type ModelChoice = {
  cfg: ProviderConfig;
  /** Where the key comes from, for messages ("the command `sapi-token`"); null without a key. */
  keyFrom: string | null;
  /** The host code is sent to; null without a model. */
  sendsTo: string | null;
  /** Fetches the key once (or again, after a rejection); null when the SDK finds its own. */
  getKey: KeySource | null;
  /** A note for the user when no model was found. */
  note?: string;
};

const PROVIDERS = ["anthropic", "openai", "openai-compatible", "none"] as const;

/** A key source that's read once and read again only when asked to refresh. */
function memoKey(read: () => Promise<string>): KeySource {
  let cached: Promise<string> | null = null;
  return (refresh) => {
    if (refresh || !cached) {
      cached = read();
      cached.catch(() => (cached = null));
    }
    return cached;
  };
}

export function chooseModel(v: Values, config: Config): ModelChoice {
  const flag = str(v, "provider");
  if (flag && !PROVIDERS.includes(flag as never)) throw new Error(`Unknown provider "${flag}". Use ${PROVIDERS.join(", ")}.`);
  const saved: ModelConfig | undefined = config.model;
  let name = (flag ?? saved?.provider) as ModelConfig["provider"] | undefined;
  let note: string | undefined;
  if (!name) {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) name = "anthropic";
    else {
      name = "none";
      note = "No model is set up, so this story uses dependency order and short template descriptions.\nRun `pr-story setup` to choose a model or your company's gateway.";
    }
  }
  // Saved settings apply only to the provider they were saved for.
  const s = saved?.provider === name ? saved : undefined;
  const baseURL = str(v, "base-url") ?? s?.baseURL;
  const model = str(v, "model") ?? s?.model;

  let getKey: KeySource | null = null;
  let apiKey: string | undefined;
  let keyFrom: string | null = null;
  let keyHeader = s?.keyHeader;
  if (s?.key) {
    const secret = s.key;
    getKey = memoKey(() => readSecret(secret));
    keyFrom = describeSecret(secret);
  } else if (name === "anthropic") {
    // As Claude Code does: ANTHROPIC_API_KEY goes in x-api-key, ANTHROPIC_AUTH_TOKEN as a Bearer token.
    if (process.env.ANTHROPIC_API_KEY) [apiKey, keyFrom] = [process.env.ANTHROPIC_API_KEY, "$ANTHROPIC_API_KEY"];
    else if (process.env.ANTHROPIC_AUTH_TOKEN) [apiKey, keyFrom, keyHeader] = [process.env.ANTHROPIC_AUTH_TOKEN, "$ANTHROPIC_AUTH_TOKEN", "bearer"];
  } else if (process.env.OPENAI_API_KEY) [apiKey, keyFrom] = [process.env.OPENAI_API_KEY, "$OPENAI_API_KEY"];
  const auth = { ...(getKey ? { getKey } : apiKey ? { apiKey } : {}), headers: s?.headers };

  let cfg: ProviderConfig;
  let sendsTo: string | null;
  switch (name) {
    case "none":
      cfg = { provider: "none" };
      sendsTo = null;
      break;
    case "anthropic":
      cfg = { provider: "anthropic", model: model ?? DEFAULT_ANTHROPIC_MODEL, baseURL, effort: (str(v, "effort") ?? s?.effort) as "medium" | undefined, keyHeader, ...auth };
      sendsTo = hostOf(baseURL ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com");
      if (!keyFrom) keyFrom = "an `ant auth login` profile, if there is one";
      break;
    case "openai":
      cfg = { provider: "openai", model, baseURL, ...auth };
      sendsTo = hostOf(baseURL ?? "https://api.openai.com");
      break;
    case "openai-compatible":
      if (!model || !baseURL) throw new Error("The openai-compatible provider needs --model and --base-url (or run `pr-story setup`).");
      cfg = { provider: "openai-compatible", model, baseURL, ...auth };
      sendsTo = hostOf(baseURL);
      break;
  }
  return { cfg, keyFrom: name === "none" ? null : keyFrom, sendsTo, getKey, note };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
