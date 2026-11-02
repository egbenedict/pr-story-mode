import type { ProviderConfig } from "@prstory/providers";

export type ProviderName = "anthropic" | "openai" | "openai-compatible" | "none";

export type Settings = {
  provider: ProviderName;
  model: string; // empty: the provider's default
  apiKey: string;
  baseURL: string; // empty: the provider's public API
  effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  githubToken: string;
};

export const DEFAULT_SETTINGS: Settings = { provider: "anthropic", model: "", apiKey: "", baseURL: "", effort: "", githubToken: "" };

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
      return { ...DEFAULT_SETTINGS, ...(got[KEY] as Partial<Settings> | undefined) };
    }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(`prstory:${KEY}`) ?? "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  if (hasChromeStorage()) await chrome.storage.local.set({ [KEY]: s });
  else localStorage.setItem(`prstory:${KEY}`, JSON.stringify(s));
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
