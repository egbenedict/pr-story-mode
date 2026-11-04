import type { ProviderConfig } from "@prstory/providers";
import { DEFAULT_APPEARANCE, withAppearanceDefaults, type Appearance } from "./appearance";

export type ProviderName = "anthropic" | "openai" | "openai-compatible" | "none";

export type Settings = {
  provider: ProviderName;
  model: string; // empty: the provider's default
  apiKey: string;
  baseURL: string; // empty: the provider's public API
  effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  githubToken: string; // for github.com
  /** GitHub Enterprise Server or Cloud (`acme.ghe.com`) hosts, each with its own token. */
  enterprise: EnterpriseHost[];
  /** How the reader looks. */
  appearance: Appearance;
};

export type EnterpriseHost = { host: string; token: string };

export const DEFAULT_SETTINGS: Settings = { provider: "anthropic", model: "", apiKey: "", baseURL: "", effort: "", githubToken: "", enterprise: [], appearance: DEFAULT_APPEARANCE };

/** "https://GitHub.Acme.com/org/repo" or "github.acme.com" → "github.acme.com"; null when it isn't a host name (or is github.com). */
export function normalizeHost(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  let host: string;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host === "github.com" || host.endsWith(".github.com")) return null;
  return host;
}

/** The token for a PR on `host`: the github.com token, or the one saved for that enterprise host. */
export function tokenFor(s: Settings, host: string): string | undefined {
  const t = host.toLowerCase() === "github.com" ? s.githubToken : s.enterprise.find((e) => e.host === host.toLowerCase())?.token;
  return t?.trim() || undefined;
}

/** Sites the extension needs for an enterprise host: its pages (and its API, on Server), plus `api.` on ghe.com. */
export function hostOrigins(host: string): string[] {
  return [`https://${host}/*`, ...(host.endsWith(".ghe.com") ? [`https://api.${host}/*`] : [])];
}

/**
 * Whether pages on these origins may show the reader: only github.com and saved enterprise hosts.
 * The reader is embedded by GitHub's pages, so any other site embedding it is refused.
 */
export function embedAllowed(ancestors: string[], s: Settings): boolean {
  const ok = new Set(["https://github.com", ...s.enterprise.map((e) => `https://${e.host}`)]);
  return ancestors.length > 0 && ancestors.every((o) => ok.has(o.toLowerCase()));
}

const KEY = "settings";

/**
 * Settings live in the extension's local storage, which is never synced. Outside the extension
 * (the dev server used for testing the reader) they fall back to the page's localStorage.
 */
const hasChromeStorage = () => typeof chrome !== "undefined" && !!chrome.storage?.local;

export async function loadSettings(): Promise<Settings> {
  try {
    if (hasChromeStorage()) {
      const got = await chrome.storage.local.get(KEY);
      return withDefaults(got[KEY] as Partial<Settings> | undefined);
    }
    return withDefaults(JSON.parse(localStorage.getItem(`prstory:${KEY}`) ?? "{}"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function withDefaults(saved: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...saved };
  return {
    ...s,
    enterprise: Array.isArray(s.enterprise) ? s.enterprise.filter((e) => e && typeof e.host === "string") : [],
    appearance: withAppearanceDefaults(s.appearance),
  };
}

export async function saveSettings(s: Settings): Promise<void> {
  if (hasChromeStorage()) await chrome.storage.local.set({ [KEY]: s });
  else localStorage.setItem(`prstory:${KEY}`, JSON.stringify(s));
}

/** Calls `cb` with the new settings whenever they're saved, from any tab. */
export function onSettingsChanged(cb: (s: Settings) => void): void {
  if (hasChromeStorage()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[KEY]) cb(withDefaults(changes[KEY].newValue as Partial<Settings> | undefined));
    });
  } else if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === `prstory:${KEY}`) cb(withDefaults(JSON.parse(e.newValue ?? "{}")));
    });
  }
}

/** The provider config for createProvider; "none" when no key is set for a provider that needs one. */
export function providerConfig(s: Settings): ProviderConfig {
  const model = s.model.trim() || undefined;
  const baseURL = s.baseURL.trim() || undefined;
  const apiKey = s.apiKey.trim() || undefined;
  switch (s.provider) {
    case "anthropic":
      return apiKey ? { provider: "anthropic", model, apiKey, baseURL, effort: s.effort || undefined, browser: true } : { provider: "none" };
    case "openai":
      return apiKey ? { provider: "openai", model, apiKey, baseURL } : { provider: "none" };
    case "openai-compatible":
      return model && baseURL ? { provider: "openai-compatible", model, baseURL, apiKey } : { provider: "none" };
    default:
      return { provider: "none" };
  }
}

/** Why the story will run without a model, or null when a model is configured. */
export function missingModelReason(s: Settings): string | null {
  if (s.provider === "none") return "No model is selected in settings.";
  if (s.provider === "openai-compatible" && (!s.model.trim() || !s.baseURL.trim())) return "The OpenAI-compatible provider needs a model and a base URL.";
  if (s.provider !== "openai-compatible" && !s.apiKey.trim()) return "No API key is set.";
  return null;
}
