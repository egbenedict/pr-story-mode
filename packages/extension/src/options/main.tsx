import { DEFAULT_ANTHROPIC_MODEL } from "@prstory/providers";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type ProviderName, type Settings } from "../settings";

const PROVIDERS: { id: ProviderName; label: string; hint: string }[] = [
  { id: "anthropic", label: "Anthropic", hint: `Claude through the Anthropic API. Default model: ${DEFAULT_ANTHROPIC_MODEL}.` },
  { id: "openai", label: "OpenAI", hint: "The OpenAI API. Default model: gpt-5." },
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "A gateway or self-hosted server (vLLM, Ollama, LiteLLM) that speaks the OpenAI chat API. Needs a base URL and a model." },
  { id: "none", label: "No model", hint: "Stories use dependency order and short template descriptions. Nothing is sent anywhere except GitHub." },
];

/** Hosts the extension can reach without asking: the public APIs in the manifest. Others need a grant. */
const BUILT_IN_HOSTS = ["api.anthropic.com", "api.openai.com"];

async function ensureHostPermission(baseURL: string): Promise<boolean> {
  if (!baseURL.trim() || typeof chrome === "undefined" || !chrome.permissions) return true;
  let origin: string;
  try {
    const u = new URL(baseURL);
    if (BUILT_IN_HOSTS.includes(u.hostname)) return true;
    origin = `${u.protocol}//${u.hostname}/*`;
  } catch {
    return false;
  }
  return chrome.permissions.request({ origins: [origin] });
}

const CSS = `
:root { --bg: #fbfaf8; --panel: #fff; --ink: #1d1d1b; --muted: #6b6a66; --line: #e6e3dd; --accent: #c2410c; --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg: #161614; --panel: #1e1e1b; --ink: #ecebe6; --muted: #9b9a93; --line: #34332e; --accent: #fb923c; } }
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
button { font: 600 14px var(--sans); background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 8px 16px; cursor: pointer; }
.saved { color: var(--muted); font-size: 13px; }
.warn { color: var(--accent); font-size: 13px; }
`;

function Options() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState("");
  useEffect(() => {
    void loadSettings().then(setS);
  }, []);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS({ ...s, [k]: v });
    setStatus("");
  };

  const save = async () => {
    if (!(await ensureHostPermission(s.baseURL))) {
      setStatus("Not saved: the extension needs permission to reach that base URL.");
      return;
    }
    await saveSettings(s);
    setStatus("Saved. Open a pull request and press Story mode.");
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
          <span className="hint">Needed for private repositories, and raises GitHub's limit of 60 requests an hour. A fine-grained token with read access to pull requests and contents is enough.</span>
        </label>
      </fieldset>

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
style.textContent = CSS;
document.head.appendChild(style);
createRoot(document.getElementById("root")!).render(<Options />);
