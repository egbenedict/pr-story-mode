import { fetchPullHead, fetchPullRequest, GitHubError, parsePrUrl, READER_CSS, runPipeline, type LLMProvider, type PipelineEvent, type PipelineResult, type PRInput, type StoryStep, type Usage } from "@prstory/core";
import { createProvider, estimateCost } from "@prstory/providers";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { getStory, putStory, storyKey } from "../cache";
import { createBrowserHost } from "../grammars";
import { loadSettings, missingModelReason, providerConfig, type Settings } from "../settings";
import { StoryReader, type StoryView } from "./Story";

const READER_EXTRA_CSS = `
.topbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 8px; align-items: center; padding: 8px 16px; background: var(--bg); border-bottom: 1px solid var(--line); font-size: 13px; }
.topbar .brand { font-weight: 600; margin-right: auto; }
.topbar button, .start button { font: 13px var(--sans); background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.topbar button:hover, .start button:hover { border-color: var(--accent); color: var(--accent); }
.start button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.layout { height: calc(100vh - 41px); }
.rail { top: 0; height: calc(100vh - 41px); }
main { overflow: auto; height: calc(100vh - 41px); }
.layout { display: grid; overflow: hidden; }
.rail li.pending a { color: var(--muted); opacity: .6; }
.writing { margin: 0 0 40px 50px; color: var(--muted); font-size: 14px; }
.writing::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); margin-right: 8px; animation: pulse 1.2s infinite ease-in-out; }
@keyframes pulse { 50% { opacity: .25; } }
.banner { border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); border-radius: 8px; padding: 8px 12px; margin: 0 0 20px; font-size: 13.5px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.banner button { font: 13px var(--sans); background: none; border: 1px solid var(--accent); color: var(--accent); border-radius: 6px; padding: 2px 10px; cursor: pointer; }
.status { max-width: 640px; margin: 80px auto; padding: 0 16px; }
.status h1 { font-size: 20px; margin: 0 0 8px; }
.status .stage { color: var(--muted); }
.status .error { color: var(--del-ink); white-space: pre-wrap; font: 13px/1.5 var(--mono); background: var(--del-bg); padding: 10px 12px; border-radius: 6px; }
.status .detail { margin-top: 16px; font-size: 13px; color: var(--muted); }
.status .detail summary { cursor: pointer; }
.start { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
@media (max-width: 860px) { .layout, .rail, main { height: auto; overflow: visible; } }
`;

type Phase =
  | { kind: "loading"; stage: string }
  | { kind: "ask"; reason: string } // no model configured: offer settings or a model-free story
  | { kind: "error"; message: string; github?: Pick<GitHubError, "kind" | "resetAt">; hasToken?: boolean };

type Live = { view: StoryView; writing: string | null; usage: Required<Usage>; model: string; provider: string; result?: PipelineResult; stale?: string; problem?: string };

/** Why a story made with a model fell back to template text, or null when the model did its part. */
function modelProblem(r: PipelineResult): string | null {
  const providerError = r.metrics.orderErrors.find((e) => e.startsWith("Provider error:"));
  if (providerError) return `The model couldn't be used, so this story shows dependency order and template text. ${providerError.replace(/^Provider error:\s*/, "")}`;
  if (r.metrics.steps > 0 && r.metrics.missingExplanations === r.metrics.steps) return "The model returned no usable explanations, so steps show template text.";
  return null;
}

function errorPhase(err: unknown, settings: Settings | null): Phase {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof GitHubError ? { kind: "error", message, github: { kind: err.kind, resetAt: err.resetAt }, hasToken: !!settings?.githubToken } : { kind: "error", message };
}

/** A plain-language title and explanation for GitHub failures; null for everything else. */
function githubHelp(p: Extract<Phase, { kind: "error" }>): { title: string; text: string } | null {
  if (p.github?.kind === "rate-limit") {
    const at = p.github.resetAt ? ` It resets at ${new Date(p.github.resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "";
    return p.hasToken
      ? { title: "GitHub's hourly limit was reached", text: `Your GitHub token has used up its requests for this hour.${at}` }
      : {
          title: "GitHub's hourly limit was reached",
          text: `Without a token, GitHub allows 60 requests an hour from your network, and other tools on your network may use them too.${at} A free GitHub token raises the limit to 5,000; read-only access to public repositories is enough.`,
        };
  }
  if (p.github?.kind === "not-found")
    return p.hasToken
      ? { title: "GitHub can't find this pull request", text: "Your GitHub token may not have access to this repository. Check that the token includes it." }
      : { title: "GitHub can't find this pull request", text: "If it's in a private repository, add a GitHub token with read access to it in settings." };
  return null;
}

const sendClose = () => window.parent.postMessage({ type: "prstory:close" }, "*");
const openSettings = () => (typeof chrome !== "undefined" && chrome.runtime?.openOptionsPage ? void chrome.runtime.openOptionsPage() : window.open("options.html", "_blank"));

function stageText(e: PipelineEvent, atoms: number): string | null {
  if (e.type === "stage") {
    if (e.stage === "atomize") return "Breaking the diff into changes…";
    if (e.stage === "order") return `Ordering ${atoms || "the"} changes…`;
    if (e.stage === "context") return "Finding unchanged code that helps…";
  }
  if (e.type === "order-attempt" && e.errors.length) return `Fixing the order (round ${e.round + 1})…`;
  if (e.type === "summarize") return `Summarizing changes (${e.done} of ${e.total})…`;
  return null;
}

/** Wrap a provider so the reader can show tokens and cost while the story is written. */
function metered(p: LLMProvider, onUsage: (u: Usage) => void): LLMProvider {
  return {
    id: p.id,
    model: p.model,
    capabilities: p.capabilities,
    async complete(req) {
      const res = await p.complete(req);
      onUsage(res.usage);
      return res;
    },
  };
}

function viewOf(pr: PRInput, result: PipelineResult): StoryView {
  const { story, atoms } = result;
  return { pr, atoms, summary: story.summary, plan: story.steps, steps: story.steps, mechanical: story.mechanical, headSha: story.headSha };
}

function costText(model: string, u: Required<Usage>): string {
  const c = estimateCost(model, u);
  const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return `${tokens.toLocaleString()} tokens${c != null ? ` · ~$${c.toFixed(c < 1 ? 3 : 2)}` : ""}`;
}

function App() {
  const prUrl = new URLSearchParams(location.search).get("pr") ?? "";
  const ref = parsePrUrl(prUrl);
  const [phase, setPhase] = useState<Phase>({ kind: "loading", stage: "Opening the pull request…" });
  const [live, setLive] = useState<Live | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const running = useRef(false);

  /** `withModel` undefined: use the model when one is set up. Settings are re-read each time, since they may have changed in the settings tab. */
  async function generate(withModel?: boolean) {
    if (!ref || running.current) return;
    running.current = true;
    const settings = await loadSettings();
    settingsRef.current = settings;
    withModel ??= missingModelReason(settings) === null;
    try {
      setLive(null);
      setPhase({ kind: "loading", stage: "Reading the pull request from GitHub…" });
      const pr = await fetchPullRequest(ref, { token: settings.githubToken || undefined });
      const base = withModel ? createProvider(providerConfig(settings)) : null;
      const usage: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const model = base?.model ?? "none";
      const providerId = base?.id ?? "none";
      const provider = base
        ? metered(base, (u) => {
            usage.inputTokens += u.inputTokens;
            usage.outputTokens += u.outputTokens;
            usage.cacheReadTokens += u.cacheReadTokens ?? 0;
            usage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
            setLive((l) => (l ? { ...l, usage: { ...usage } } : l));
          })
        : null;
      let atomCount = 0;
      let steps: (StoryStep | undefined)[] = [];
      const result = await runPipeline(pr, {
        host: createBrowserHost(),
        provider,
        contextSource: null, // unchanged files outside the PR are not fetched yet
        onEvent: (e) => {
          const text = stageText(e, atomCount);
          if (text) setPhase({ kind: "loading", stage: text });
          if (e.type === "plan") {
            atomCount = e.atoms.length;
            steps = e.plan.steps.map(() => undefined);
            const view: StoryView = { pr, atoms: e.atoms, summary: e.plan.summary, plan: e.plan.steps, steps, mechanical: e.plan.mechanical, headSha: pr.headSha };
            setLive({ view, writing: `Writing step 1 of ${e.plan.steps.length}…`, usage: { ...usage }, model, provider: providerId });
          }
          if (e.type === "step") {
            steps = steps.slice();
            steps[e.index] = e.step;
            const next = steps.findIndex((s) => !s);
            setLive((l) => (l ? { ...l, view: { ...l.view, steps }, writing: next === -1 ? null : `Writing step ${next + 1} of ${steps.length}…` } : l));
          }
        },
      });
      const problem = base ? modelProblem(result) : null;
      setLive({ view: viewOf(pr, result), writing: null, usage: result.metrics.usage, model, provider: providerId, result, problem: problem ?? undefined });
      // A story the model failed on is not kept, so the next open tries the model again.
      if (!problem) await putStory({ key: storyKey(pr.repo ?? ref.repo, pr.number), headSha: pr.headSha, savedAt: Date.now(), pr, result });
    } catch (err) {
      setLive(null);
      setPhase(errorPhase(err, settings));
    } finally {
      running.current = false;
    }
  }

  useEffect(() => {
    if (!ref) {
      setPhase({ kind: "error", message: `Not a pull request URL: ${prUrl || "(none)"}` });
      return;
    }
    void (async () => {
      const settings = await loadSettings();
      settingsRef.current = settings;
      const cached = await getStory(storyKey(`${ref.owner}/${ref.repo}`, ref.number));
      let head: string | null = null;
      try {
        head = (await fetchPullHead(ref, { token: settings.githubToken || undefined })).headSha;
      } catch (err) {
        if (!cached) {
          setPhase(errorPhase(err, settings));
          return;
        }
      }
      if (cached) {
        const r = cached.result;
        const stale = head && head !== cached.headSha ? `New commits were pushed since this story was written (it covers ${cached.headSha.slice(0, 7)}; the PR is now at ${head.slice(0, 7)}).` : undefined;
        setLive({ view: viewOf(cached.pr, r), writing: null, usage: r.metrics.usage, model: r.story.meta.model, provider: r.story.meta.provider, result: r, stale });
        return;
      }
      const reason = missingModelReason(settings);
      if (reason) setPhase({ kind: "ask", reason });
      else void generate(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const topbar = (
    <div className="topbar">
      <span className="brand">PR Story Mode</span>
      {live && !live.writing ? (
        <button type="button" onClick={() => void generate()}>
          Regenerate
        </button>
      ) : null}
      <button type="button" onClick={openSettings}>
        Settings
      </button>
      {window.parent !== window ? (
        <button type="button" onClick={sendClose} title="Close (Esc)">
          Close
        </button>
      ) : null}
    </div>
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && sendClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (live) {
    const r = live.result;
    const footer: ReactNode = r ? (
      <>
        {r.coverage.ok ? `All ${r.coverage.totalLines} changed lines are shown exactly once.` : `Coverage check failed: ${r.coverage.missing.length} missing, ${r.coverage.duplicated.length} duplicated lines.`}
        <br />
        Generated with {r.story.meta.provider === "none" ? "no model (dependency order and template text)" : `${r.story.meta.provider} · ${r.story.meta.model}`} · {costText(r.story.meta.model, r.metrics.usage)} · {r.story.meta.repairRounds} repair round
        {r.story.meta.repairRounds === 1 ? "" : "s"}
        {r.metrics.fallbackOrder && r.story.meta.provider !== "none" ? " · fell back to dependency order" : ""}
      </>
    ) : (
      <>Writing with {live.provider === "none" ? "no model" : `${live.provider} · ${live.model}`} · {costText(live.model, live.usage)} so far</>
    );
    const banner = live.problem ? (
      <div className="banner">
        <span>{live.problem}</span>
        <button type="button" onClick={openSettings}>
          Settings
        </button>
        <button type="button" onClick={() => void generate(true)}>
          Try again
        </button>
      </div>
    ) : live.stale ? (
      <div className="banner">
        <span>{live.stale}</span>
        <button type="button" onClick={() => void generate()}>
          Regenerate
        </button>
      </div>
    ) : undefined;
    return (
      <>
        {topbar}
        <StoryReader view={live.view} writing={live.writing} footer={footer} banner={banner} />
      </>
    );
  }

  return (
    <>
      {topbar}
      <div className="status">
        {phase.kind === "loading" ? (
          <>
            <h1>Preparing the story</h1>
            <p className="stage">{phase.stage}</p>
          </>
        ) : phase.kind === "ask" ? (
          <>
            <h1>No model is set up yet</h1>
            <p>{phase.reason} Add a provider and key in settings to get a narrated story. Without a model you still get every change, in dependency order, with short template descriptions.</p>
            <div className="start">
              <button type="button" className="primary" onClick={openSettings}>
                Open settings
              </button>
              <button type="button" onClick={() => void generate(false)}>
                Continue without a model
              </button>
            </div>
          </>
        ) : (
          <ErrorScreen phase={phase} retry={() => void generate()} />
        )}
      </div>
    </>
  );
}

function ErrorScreen({ phase, retry }: { phase: Extract<Phase, { kind: "error" }>; retry: () => void }) {
  const help = githubHelp(phase);
  if (!help)
    return (
      <>
        <h1>Something went wrong</h1>
        <p className="error">{phase.message}</p>
        <div className="start">
          <button type="button" onClick={retry}>
            Try again
          </button>
          <button type="button" onClick={openSettings}>
            Settings
          </button>
        </div>
      </>
    );
  return (
    <>
      <h1>{help.title}</h1>
      <p>{help.text}</p>
      <div className="start">
        <button type="button" className="primary" onClick={openSettings}>
          {phase.hasToken ? "Open settings" : "Add a GitHub token"}
        </button>
        <button type="button" onClick={retry}>
          Try again
        </button>
      </div>
      <details className="detail">
        <summary>Details</summary>
        <p className="error">{phase.message}</p>
      </details>
    </>
  );
}

const style = document.createElement("style");
style.textContent = READER_CSS + READER_EXTRA_CSS;
document.head.appendChild(style);
createRoot(document.getElementById("root")!).render(<App />);
