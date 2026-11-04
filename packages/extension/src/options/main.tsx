import { DEFAULT_ANTHROPIC_MODEL } from "@prstory/providers";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { APPEARANCE_CSS, AppearanceSettings } from "./appearance";
import { styledCss, type Appearance } from "../appearance";
import { DEFAULT_SETTINGS, hostOrigins, loadSettings, normalizeHost, saveSettings, type ProviderName, type Settings } from "../settings";

const PROVIDERS: { id: ProviderName; label: string; hint: string }[] = [
  { id: "anthropic", label: "Anthropic", hint: `Claude through the Anthropic API. Default model: ${DEFAULT_ANTHROPIC_MODEL}.` },
  { id: "openai", label: "OpenAI", hint: "The OpenAI API. Default model: gpt-5." },
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "A gateway or self-hosted server (vLLM, Ollama, LiteLLM) that speaks the OpenAI chat API. Needs a base URL and a model." },
  { id: "none", label: "No model", hint: "Stories use dependency order and short template descriptions. Nothing is sent anywhere except GitHub." },
];

/** Hosts the extension can reach without asking: the public APIs in the manifest. Others need a grant. */
const BUILT_IN_HOSTS = ["api.anthropic.com", "api.openai.com"];

/** The site a custom base URL needs, or null for the built-in APIs; undefined when it isn't a URL. */
function baseUrlOrigin(baseURL: string): string | null | undefined {
  if (!baseURL.trim()) return null;
  try {
    const u = new URL(baseURL);
    return BUILT_IN_HOSTS.includes(u.hostname) ? null : `${u.protocol}//${u.hostname}/*`;
  } catch {
    return undefined;
  }
}

/**
 * Ask Chrome, in one prompt, for every site these settings need. It's called first thing in the
 * click, since Chrome only prompts during a user gesture; sites already granted don't prompt again.
 */
function ensureOrigins(origins: string[]): Promise<boolean> {
  if (!origins.length || typeof chrome === "undefined" || !chrome.permissions) return Promise.resolve(true);
  return chrome.permissions.request({ origins });
}

const CSS = `
:root { --bg: #fbfaf8; --panel: #fff; --ink: #1d1d1b; --muted: #6b6a66; --line: #e6e3dd; --accent: #c2410c; --on-accent: #fff; --ctx-bg: #f4f2ee; --code: #26251f; --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg: #161614; --panel: #1e1e1b; --ink: #ecebe6; --muted: #9b9a93; --line: #34332e; --accent: #fb923c; --on-accent: #1f1307; --ctx-bg: #22221f; --code: #e3e2dc; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); }
main { max-width: 620px; margin: 0 auto; padding: 40px 16px 80px; }
h1 { font-size: 24px; margin: 0 0 4px; }
.lede { color: var(--muted); margin: 0 0 28px; }
fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px 6px; margin: 0 0 20px; background: var(--panel); }
legend { font-weight: 600; padding: 0 6px; }
label { display: block; margin: 0 0 14px; font-size: 14px; }
label > span { display: block; font-weight: 500; margin-bottom: 4px; }
input[type=text], input[type=password], select { width: 100%; font: 14px var(--sans); padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
.radio { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 10px; }
.radio input { margin-top: 4px; accent-color: var(--accent); }
.hint { color: var(--muted); font-size: 13px; }
.row { display: flex; gap: 10px; align-items: center; }
button { font: 600 14px var(--sans); background: var(--accent); color: var(--on-accent); border: 0; border-radius: 6px; padding: 8px 16px; cursor: pointer; }
.saved { color: var(--muted); font-size: 13px; }
.warn { color: var(--accent); font-size: 13px; }
code { font: 0.9em ui-monospace, Menlo, monospace; }
.ghe { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 4px; }
button.quiet { background: none; color: var(--ink); border: 1px solid var(--line); font-weight: 500; padding: 5px 12px; margin: 0 0 14px; }
button.quiet:hover { border-color: var(--accent); color: var(--accent); }
button.add { display: block; }
`;

function Options() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState("");
  useEffect(() => {
    void loadSettings().then((got) => {
      setS(got);
      restyle(got.appearance);
    });
  }, []);
  // Appearance saves as it changes (merged into the saved settings, so unsaved fields above stay unsaved).
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setAppearance = (appearance: Appearance) => {
    setS((cur) => ({ ...cur, appearance }));
    restyle(appearance);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void loadSettings().then((saved) => saveSettings({ ...saved, appearance })), 150);
  };
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS({ ...s, [k]: v });
    setStatus("");
  };

  const save = async () => {
    const base = baseUrlOrigin(s.baseURL);
    if (base === undefined) {
      setStatus("Not saved: the base URL isn't a valid URL.");
      return;
    }
    // Enterprise hosts: drop empty rows, and refuse ones that aren't host names or repeat.
    const enterprise: Settings["enterprise"] = [];
    for (const e of s.enterprise) {
      if (!e.host.trim() && !e.token.trim()) continue;
      const host = normalizeHost(e.host);
      if (!host) {
        setStatus(`Not saved: "${e.host.trim() || "(empty)"}" isn't a GitHub Enterprise host name, like github.acme.com or acme.ghe.com.`);
        return;
      }
      if (enterprise.some((x) => x.host === host)) {
        setStatus(`Not saved: ${host} is listed twice.`);
        return;
      }
      enterprise.push({ host, token: e.token.trim() });
    }
    const wanted = [...(base ? [base] : []), ...enterprise.flatMap((e) => hostOrigins(e.host))];
    if (!(await ensureOrigins(wanted))) {
      setStatus("Not saved: the extension needs permission to reach those sites.");
      return;
    }
    // Give back access to enterprise hosts that were removed.
    const before = await loadSettings();
    const gone = before.enterprise.filter((e) => !enterprise.some((x) => x.host === e.host)).flatMap((e) => hostOrigins(e.host));
    if (gone.length && typeof chrome !== "undefined" && chrome.permissions) await chrome.permissions.remove({ origins: gone }).catch(() => false);
    const next = { ...s, enterprise };
    await saveSettings(next);
    setS(next);
    setStatus(enterprise.length ? "Saved. Reload any open GitHub Enterprise pages to see the Story mode button." : "Saved. Open a pull request and press Story mode.");
  };
  const setHost = (i: number, patch: Partial<Settings["enterprise"][number]>) => {
    setS({ ...s, enterprise: s.enterprise.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
    setStatus("");
  };

  const needsKey = s.provider === "anthropic" || s.provider === "openai";
  return (
    <main>
      <h1>PR Story Mode</h1>
      <p className="lede">Code goes only from GitHub to this browser, and from here to the model you choose. There is no PR Story Mode server.</p>

      <fieldset>
        <legend>Model</legend>
        {PROVIDERS.map((p) => (
          <label className="radio" key={p.id}>
            <input type="radio" name="provider" checked={s.provider === p.id} onChange={() => set("provider", p.id)} />
            <span>
              {p.label}
              <br />
              <span className="hint">{p.hint}</span>
            </span>
          </label>
        ))}
        {s.provider !== "none" ? (
          <>
            {needsKey || s.provider === "openai-compatible" ? (
              <label>
                <span>API key{s.provider === "openai-compatible" ? " (optional)" : ""}</span>
                <input type="password" autoComplete="off" value={s.apiKey} onChange={(e) => set("apiKey", e.target.value)} placeholder={s.provider === "anthropic" ? "sk-ant-…" : "sk-…"} />
                <span className="hint">Stored in this browser's extension storage only. It is never synced.</span>
              </label>
            ) : null}
            <label>
              <span>Model{s.provider === "openai-compatible" ? "" : " (optional)"}</span>
              <input type="text" value={s.model} onChange={(e) => set("model", e.target.value)} placeholder={s.provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : s.provider === "openai" ? "gpt-5" : "e.g. qwen3-coder"} />
            </label>
            <label>
              <span>Base URL{s.provider === "openai-compatible" ? "" : " (optional)"}</span>
              <input type="text" value={s.baseURL} onChange={(e) => set("baseURL", e.target.value)} placeholder={s.provider === "openai-compatible" ? "https://gateway.example.com/v1" : "Leave empty for the public API"} />
              <span className="hint">For a company gateway or a self-hosted server. Saving asks Chrome for permission to reach it.</span>
            </label>
            {s.provider === "anthropic" ? (
              <label>
                <span>Effort</span>
                <select value={s.effort} onChange={(e) => set("effort", e.target.value as Settings["effort"])}>
                  <option value="">Default (medium)</option>
                  <option value="low">Low: faster and cheaper</option>
                  <option value="medium">Medium</option>
                  <option value="high">High: slower, more careful</option>
                </select>
              </label>
            ) : null}
          </>
        ) : null}
      </fieldset>

      <fieldset>
        <legend>GitHub</legend>
        <label>
          <span>Personal access token (optional)</span>
          <input type="password" autoComplete="off" value={s.githubToken} onChange={(e) => set("githubToken", e.target.value)} placeholder="github_pat_…" />
          <span className="hint">
            Needed to post review comments and for private repositories, and raises GitHub's limit of 60 requests an hour. Create a{" "}
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">
              fine-grained token
            </a>{" "}
            with <b>Pull requests: Read and write</b> and <b>Contents: Read</b> for the repositories you review. Read-only is enough if you only read stories.
          </span>
        </label>
      </fieldset>

      <fieldset>
        <legend>GitHub Enterprise</legend>
        <p className="hint" style={{ marginTop: 0 }}>
          For pull requests on GitHub Enterprise Server (your company's own address, like <code>github.acme.com</code>) or GitHub Enterprise Cloud with its own address (<code>acme.ghe.com</code>). Each host needs a token from that host: one from github.com won't work there. Saving asks Chrome for access to just these hosts.
        </p>
        {s.enterprise.map((e, i) => {
          const host = normalizeHost(e.host);
          return (
            <div className="ghe" key={i}>
              <label>
                <span>Host</span>
                <input type="text" value={e.host} onChange={(ev) => setHost(i, { host: ev.target.value })} placeholder="github.acme.com" spellCheck={false} />
              </label>
              <label>
                <span>Token</span>
                <input type="password" autoComplete="off" value={e.token} onChange={(ev) => setHost(i, { token: ev.target.value })} placeholder="github_pat_… or ghp_…" />
                <span className="hint">
                  {host ? (
                    <>
                      Create one at{" "}
                      <a href={`https://${host}/settings/personal-access-tokens/new`} target="_blank" rel="noopener">
                        {host}
                      </a>{" "}
                      with the same access as above. If your server has no fine-grained tokens, use a classic one with the <b>repo</b> scope.
                    </>
                  ) : (
                    "A personal access token from that host."
                  )}
                </span>
              </label>
              <button type="button" className="quiet" onClick={() => (setS({ ...s, enterprise: s.enterprise.filter((_, k) => k !== i) }), setStatus(""))}>
                Remove
              </button>
            </div>
          );
        })}
        <button type="button" className="quiet add" onClick={() => (setS({ ...s, enterprise: [...s.enterprise, { host: "", token: "" }] }), setStatus(""))}>
          Add an enterprise host
        </button>
      </fieldset>

      <AppearanceSettings value={s.appearance} onChange={setAppearance} />

      <div className="row">
        <button type="button" onClick={() => void save()}>
          Save
        </button>
        <span className={status.startsWith("Not") ? "warn" : "saved"}>{status}</span>
      </div>
    </main>
  );
}

const style = document.createElement("style");
document.head.appendChild(style);
/** The settings page follows the chosen appearance too, so the choices can be seen as they're made. */
function restyle(a: Appearance) {
  style.textContent = styledCss(CSS + APPEARANCE_CSS, a);
}
restyle(DEFAULT_SETTINGS.appearance);
createRoot(document.getElementById("root")!).render(<Options />);
