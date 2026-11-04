import { fetchPullHead, fetchPullRequest, GitHubError, githubContextSource, modelFailure, parsePrUrl, READER_CSS, runPipeline, type LLMProvider, type PipelineEvent, type PipelineResult, type PRInput, type StoryStep, type Usage } from "@prstory/core";
import { createProvider, estimateCost } from "@prstory/providers";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { getStory, putStory, repoKey, storyKey } from "../cache";
import { createBrowserHost } from "../grammars";
import { embedAllowed, loadSettings, missingModelReason, providerConfig, tokenFor, type Settings } from "../settings";
import { COMMENTS_CSS, CommentsNote, CommentsProvider, ReviewButton } from "./comments";
import { DemoProvider } from "./demo";
import { BrandMark, Icon } from "./icons";
import { Inline, StoryReader, type StoryView, type Writing } from "./Story";

const READER_EXTRA_CSS = `
/* Top bar: 41px tall (the layout below is sized to it). */
.topbar { position: sticky; top: 0; z-index: 5; display: flex; gap: 2px; align-items: center; height: 41px; box-sizing: border-box; padding: 0 10px 0 14px; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: saturate(1.4) blur(10px); -webkit-backdrop-filter: saturate(1.4) blur(10px); border-bottom: 1px solid var(--line); font-size: 13px; }
.topbar .brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: -0.005em; white-space: nowrap; }
.topbar .brand-mark { flex: none; display: block; }
/* The PR name (or the writing status) fills the space, so the buttons sit at the right. */
.topbar .pr-ref { flex: 1 1 auto; display: flex; align-items: center; margin: 0 8px 0 10px; padding-left: 10px; border-left: 1px solid var(--line); color: var(--muted); white-space: nowrap; min-width: 0; }
.topbar .pr-ref .ref-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.topbar .pr-ref .spent { flex: none; }
.topbar .spacer { flex: 1 1 auto; }
.tb { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: color-mix(in srgb, var(--ink) 78%, var(--muted)); font: 500 13px var(--sans); cursor: pointer; white-space: nowrap; transition: background-color .15s, color .15s, border-color .15s; }
.tb .icon { flex: none; opacity: .85; }
.tb:hover { background: color-mix(in srgb, var(--ink) 7%, transparent); color: var(--ink); }
.tb:active { background: color-mix(in srgb, var(--ink) 11%, transparent); }
.tb:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tb[aria-expanded="true"] { background: color-mix(in srgb, var(--ink) 9%, transparent); color: var(--ink); }
.tb.icon-only { width: 28px; padding: 0; justify-content: center; }
.tb.attn { color: var(--accent); }
.tb.attn::after { content: ""; position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg); }
.tb.primary { background: var(--accent); color: #fff; }
.tb.primary:hover { background: color-mix(in srgb, var(--accent) 88%, #000); color: #fff; }
.tb.primary .icon { opacity: 1; }
.tb-badge { min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; background: rgba(255,255,255,.25); font: 600 11.5px/18px var(--sans); text-align: center; font-variant-numeric: tabular-nums; }
/* The dark theme's accent is light, so dark text reads better on it. */
@media (prefers-color-scheme: dark) { .tb.primary, .tb.primary:hover { color: #1f1307; } .tb.primary .tb-badge { background: rgba(0,0,0,.16); } }
.tb-sep { width: 1px; height: 18px; margin: 0 6px; background: var(--line); flex: none; }
.topbar .pr-ref .spent { font-variant-numeric: tabular-nums; }
.topbar .pr-ref .ref-name + .spent::before { content: "·"; margin: 0 7px; }
@media (max-width: 640px) { .topbar .pr-ref .ref-name { display: none; } .topbar .pr-ref .spent::before { content: none; } }
@media (max-width: 560px) { .tb .tb-label { display: none; } .tb { padding: 0 7px; } }
.start button { font: 13px var(--sans); background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.start button:hover { border-color: var(--accent); color: var(--accent); }
.start button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.layout { height: calc(100vh - 41px); }
.rail { top: 0; height: calc(100vh - 41px); }
main { overflow: auto; height: calc(100vh - 41px); }
.layout { display: grid; overflow: hidden; }
.rail li.pending a { color: var(--muted); opacity: .7; }
@keyframes pulse { 50% { opacity: .25; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 50% { opacity: 0; } }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@keyframes slide { from { background-position: -40% 0; } to { background-position: 140% 0; } }
@keyframes fade-up { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes ring { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); } 100% { box-shadow: 0 0 0 9px transparent; } }

/* Top bar while writing */

.writing-status { flex: 1 1 auto; margin: 0 8px 0 10px; padding-left: 10px; border-left: 1px solid var(--line); min-width: 0; color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s infinite ease-in-out; flex: none; }
.write-progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: transparent; }
.write-progress > span { display: block; height: 100%; background: var(--accent); transition: width .6s ease; border-radius: 0 2px 2px 0; }

/* Loading screen */
.prep { position: relative; overflow: hidden; max-width: 600px; margin: 56px auto; padding: 26px 28px 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.06); }
.prep-bar { position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--accent), transparent) no-repeat; background-size: 40% 100%; animation: slide 1.6s ease-in-out infinite; }
.prep-kicker { margin: 0 0 6px; font-size: 11.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
.prep h1 { font-size: 19px; line-height: 1.35; margin: 0; }
.prep-ref { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.stages { list-style: none; padding: 0; margin: 22px 0 6px; }
.stages > li { position: relative; display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 12px; padding-bottom: 16px; }
.stages > li:not(:last-child)::before { content: ""; position: absolute; left: 9.5px; top: 22px; bottom: 2px; width: 1px; background: var(--line); }
.stages > li.done:not(:last-child)::before { background: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.stages .dot { width: 20px; height: 20px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid var(--line); background: var(--panel); display: grid; place-items: center; color: #fff; }
.stages li.active .dot { border: 2px solid color-mix(in srgb, var(--accent) 22%, transparent); border-top-color: var(--accent); animation: spin .9s linear infinite; }
.stages li.done .dot { background: var(--accent); border-color: var(--accent); }
.stage-name { font-size: 14px; line-height: 20px; }
.stages li.todo .stage-name { color: var(--muted); }
.stages li.active .stage-name { font-weight: 600; }
.stage-detail { display: block; font-size: 12.5px; color: var(--muted); margin-top: 1px; animation: fade-up .3s ease; }
.prep.finished .prep-bar { animation: none; background: var(--accent); background-size: 100% 100%; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.layout { animation: fade-in .35s ease; }
.prep-foot { margin: 4px 0 0; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.caret { display: inline-block; width: 7px; height: 1.05em; margin-left: 3px; vertical-align: text-bottom; background: var(--accent); border-radius: 1px; animation: blink 1s steps(1) infinite; }

/* Steps not written yet */
.pending-step .pending-label { margin: 2px 0 12px; font-weight: 600; font-size: 15.5px; }
.pending-meta { display: block; margin-top: 2px; font-weight: 400; font-size: 12.5px; color: var(--muted); }
.pending-step:not(.active) { opacity: .62; }
.pending-step:not(.active) .pending-label { margin-bottom: 8px; }
.pending-step.active .step-marker { animation: ring 1.6s ease-out infinite; }
.draft { margin: 0 0 14px; }
.draft p { margin: 0 0 10px; animation: fade-up .3s ease; }
.draft-code { opacity: .88; }
.skeleton { display: grid; gap: 8px; margin: 4px 0 16px; max-width: 640px; }
.skeleton span { display: block; height: 10px; border-radius: 5px; background: linear-gradient(90deg, var(--ctx-bg) 30%, var(--line) 50%, var(--ctx-bg) 70%); background-size: 200% 100%; animation: shimmer 1.6s linear infinite; }
.skeleton span:nth-child(1) { width: 94%; } .skeleton span:nth-child(2) { width: 80%; } .skeleton span:nth-child(3) { width: 58%; }
.skeleton.quiet span { height: 8px; animation-duration: 2.4s; }
.skeleton.quiet span:nth-child(2) { width: 46%; }

/* Outline while writing */
.rail-state { border-radius: 50%; border: 1.5px dashed color-mix(in srgb, var(--muted) 45%, transparent); }
.rail li.writing .rail-state { border: 1.5px solid var(--accent); background: radial-gradient(circle, var(--accent) 0 3px, transparent 3.5px); animation: pulse 1.2s infinite ease-in-out; }
.rail li.writing a { color: var(--ink); opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  .layout, .prep-bar, .stages .dot, .caret, .skeleton span, .pulse, .rail-state, .pending-step .step-marker, .draft p, .stage-detail { animation: none !important; }
  .write-progress > span { transition: none; }
}
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

/** What the loading screen knows so far, until the first step is written. */
type Prep = {
  started: number;
  /** Reading the PR, splitting it, planning the order, finding context, starting the walkthrough; 5 when all are done. */
  stage: 0 | 1 | 2 | 3 | 4 | 5;
  pr?: { title: string; ref: string; files: number; add: number; del: number };
  atoms?: { n: number; mechanical: number };
  planned?: number; // steps the model has planned so far
  note?: string; // "Fixing the order (round 2)", "Summarizing changes (3 of 8)"
  steps?: number; // once the order is settled
  context?: { snippets: number; steps: number; extraFiles: number };
  written?: number; // steps written by the time the card finishes
  model: string | null; // null: no model
  usage: Required<Usage>;
};

type Phase =
  | { kind: "loading"; prep: Prep }
  | { kind: "ask"; reason: string } // no model configured: offer settings or a model-free story
  | { kind: "error"; message: string; github?: Pick<GitHubError, "kind" | "resetAt">; hasToken?: boolean };

type Live = {
  view: StoryView;
  /** Set while steps are still being written. */
  writing: (Writing & { note: string; started: number }) | null;
  usage: Required<Usage>;
  model: string;
  provider: string;
  result?: PipelineResult;
  stale?: string;
  problem?: string;
};

const zeroUsage = (): Required<Usage> => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function errorPhase(err: unknown, settings: Settings | null, host: string): Phase {
  let message = err instanceof Error ? err.message : String(err);
  // The browser says only "Failed to fetch" when a host can't be reached at all.
  if (!(err instanceof GitHubError) && /failed to fetch|networkerror|load failed/i.test(message)) {
    message =
      host.toLowerCase() === "github.com"
        ? "Couldn't reach GitHub. Check your internet connection and try again."
        : `Couldn't reach ${host}. If it's on your company's network, check that you're connected (for example to the VPN), and that ${host} is saved under GitHub Enterprise in settings.`;
  }
  return err instanceof GitHubError ? { kind: "error", message, github: { kind: err.kind, resetAt: err.resetAt }, hasToken: !!(settings && tokenFor(settings, host)) } : { kind: "error", message };
}

/**
 * In the extension, the reader runs only inside a page on github.com or a GitHub Enterprise host
 * saved in settings. Any other site that embeds it, or links to it directly, gets nothing: no
 * settings are used, nothing is fetched and no cached story is shown. (The local dev server is exempt.)
 */
function embeddedSafely(s: Settings): boolean {
  if (location.protocol === "http:" || location.protocol === "https:") return true;
  const ancestors = location.ancestorOrigins ? Array.from(location.ancestorOrigins) : [];
  return embedAllowed(ancestors, s);
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

/** "0:42", "3:05" */
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The time since `started`, ticking once a second while `on`. */
function useElapsed(started: number | null, on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return started ? now - started : 0;
}

/** Wrap a provider so the reader can show tokens and cost while the story is written. */
/**
 * Wrap a provider so the reader can show tokens and cost while the story is written: `onUsage` gets
 * each call's real usage when it ends, and `onStream` the output characters streamed so far in calls
 * still running (about four characters a token), so the count moves during long calls.
 */
function metered(p: LLMProvider, onUsage: (u: Usage) => void, onStream: (chars: number) => void): LLMProvider {
  let streaming = 0;
  return {
    id: p.id,
    model: p.model,
    capabilities: p.capabilities,
    async complete(req) {
      let mine = 0;
      try {
        const res = await p.complete({
          ...req,
          onText: (d) => {
            mine += d.length;
            streaming += d.length;
            onStream(streaming);
            req.onText?.(d);
          },
        });
        streaming -= mine;
        mine = 0;
        onUsage(res.usage);
        return res;
      } finally {
        streaming -= mine;
      }
    },
  };
}

const withStreamed = (u: Required<Usage>, chars: number): Required<Usage> => ({ ...u, outputTokens: u.outputTokens + Math.round(chars / 4) });

function viewOf(pr: PRInput, result: PipelineResult): StoryView {
  const { story, atoms } = result;
  return { pr, atoms, summary: story.summary, plan: story.steps, steps: story.steps, mechanical: story.mechanical, headSha: story.headSha };
}

function costText(model: string, u: Required<Usage>): string {
  const c = estimateCost(model, u);
  const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return `${tokens.toLocaleString()} tokens${c != null ? ` · ~$${c.toFixed(c < 1 ? 3 : 2)}` : ""}`;
}

/** "5.2K tokens · ~$0.08", for the top bar; "" before anything has been used. */
function costShort(model: string, u: Required<Usage>): string {
  const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  if (!tokens) return "";
  const c = estimateCost(model, u);
  const n = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(tokens);
  return `${n} tokens${c != null ? ` · ~$${c.toFixed(c < 0.1 ? 3 : 2)}` : ""}`;
}

/** Cost text, or "" before anything has been used. */
const costSoFar = (model: string, u: Required<Usage>) => (u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens ? costText(model, u) : "");


/** `?demo` on a local preview server: a scripted model, for working on the reader without a key. Never in the extension. */
const DEMO = location.protocol.startsWith("http") && new URLSearchParams(location.search).has("demo");

function App() {
  const prUrl = new URLSearchParams(location.search).get("pr") ?? "";
  const ref = parsePrUrl(prUrl);
  const [phase, setPhase] = useState<Phase>({ kind: "loading", prep: { started: Date.now(), stage: 0, model: null, usage: zeroUsage() } });
  const [live, setLive] = useState<Live | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const running = useRef(false);

  /** `withModel` undefined: use the model when one is set up. Settings are re-read each time, since they may have changed in the settings tab. */
  async function generate(withModel?: boolean) {
    if (!ref || running.current) return;
    const settings = await loadSettings();
    if (!embeddedSafely(settings)) return;
    running.current = true;
    settingsRef.current = settings;
    withModel ??= missingModelReason(settings) === null;
    const started = Date.now();
    let prep: Prep = { started, stage: 0, model: null, usage: zeroUsage() };
    const setPrep = (f: (p: Prep) => Prep) => {
      prep = f(prep);
      setPhase({ kind: "loading", prep });
    };
    try {
      setLive(null);
      const base = DEMO ? new DemoProvider() : withModel ? createProvider(providerConfig(settings)) : null;
      setPrep((p) => ({ ...p, model: base?.model ?? null }));
      const gh = { token: tokenFor(settings, ref.host) };
      const pr = await fetchPullRequest(ref, gh);
      let add = 0;
      let del = 0;
      for (const f of pr.files) for (const h of f.hunks) for (const l of h.lines) l.type === "add" ? add++ : l.type === "del" ? del++ : 0;
      setPrep((p) => ({ ...p, stage: 1, pr: { title: pr.title, ref: `${pr.repo ?? `${ref.owner}/${ref.repo}`}#${pr.number}`, files: pr.files.length, add, del } }));
      // Starts downloading likely context files now, while the model orders the steps.
      const contextSource = githubContextSource(ref, gh, pr);
      // A story for an earlier commit lets unchanged steps keep their explanations.
      const cached = await getStory(storyKey(repoKey(ref), pr.number));
      const previous = cached && cached.headSha !== pr.headSha ? { pr: cached.pr, atoms: cached.result.atoms, story: cached.result.story } : null;
      const usage = zeroUsage();
      const model = base?.model ?? "none";
      const providerId = base?.id ?? "none";
      const provider = base
        ? metered(
            base,
            (u) => {
              usage.inputTokens += u.inputTokens;
              usage.outputTokens += u.outputTokens;
              usage.cacheReadTokens += u.cacheReadTokens ?? 0;
              usage.cacheWriteTokens += u.cacheWriteTokens ?? 0;
              setLive((l) => (l ? { ...l, usage: { ...usage } } : l));
              if (!revealed) setPrep((p) => ({ ...p, usage: { ...usage } }));
            },
            (chars) => {
              const now = Date.now();
              if (now - lastShown < 250) return;
              lastShown = now;
              const shown = withStreamed(usage, chars);
              setLive((l) => (l ? { ...l, usage: shown } : l));
              if (!revealed) setPrep((p) => ({ ...p, usage: shown }));
            },
          )
        : null;
      let lastShown = 0;
      let steps: (StoryStep | undefined)[] = [];
      let drafts: Record<number, string> = {};
      // The loading card stays up until the first step is written; then, after a moment with every
      // stage ticked off, the story takes over with whatever has arrived by then.
      let view: StoryView | null = null;
      let revealed = false;
      let reveal: Promise<void> | null = null;
      const finishCard = () => {
        if (reveal) return reveal;
        setPrep((p) => ({ ...p, stage: 5 }));
        reveal = new Promise<void>((done) =>
          setTimeout(() => {
            revealed = true;
            if (view) setLive({ view: { ...view, steps }, writing: { drafts, note: note(), started }, usage: { ...usage }, model, provider: providerId });
            done();
          }, 700),
        );
        return reveal;
      };
      const note = () => {
        const n = steps.filter(Boolean).length;
        return `Writing step ${Math.min(n + 1, steps.length)} of ${steps.length}`;
      };
      const result = await runPipeline(pr, {
        host: createBrowserHost(),
        provider,
        contextSource,
        previous,
        onEvent: (e) => {
          if (e.type === "atoms") setPrep((p) => ({ ...p, stage: 2, atoms: { n: e.atoms, mechanical: e.mechanical } }));
          if (e.type === "order-draft") setPrep((p) => (p.planned === e.labels.length ? p : { ...p, planned: e.labels.length }));
          if (e.type === "order-attempt" && e.errors.length) setPrep((p) => ({ ...p, note: `Fixing the order (round ${e.round + 2})`, planned: undefined }));
          if (e.type === "summarize") setPrep((p) => ({ ...p, note: `Summarizing ${e.total} batches of changes first (${e.done} done)` }));
          if (e.type === "plan") {
            steps = e.plan.steps.map(() => undefined);
            view = { pr, atoms: e.atoms, summary: e.plan.summary, plan: e.plan.steps, steps, mechanical: e.plan.mechanical, headSha: pr.headSha };
            setPrep((p) => ({ ...p, stage: 3, note: undefined, steps: e.plan.steps.length }));
          }
          if (e.type === "context") setPrep((p) => ({ ...p, stage: 4, context: { snippets: e.snippets, steps: e.steps, extraFiles: e.extraFiles } }));
          if (e.type === "draft") {
            drafts = { ...drafts, [e.index]: e.text };
            setLive((l) => (l?.writing ? { ...l, writing: { ...l.writing, drafts } } : l));
          }
          if (e.type === "step") {
            steps = steps.slice();
            steps[e.index] = e.step;
            const { [e.index]: _done, ...rest } = drafts;
            drafts = rest;
            if (!revealed) {
              const n = steps.filter(Boolean).length;
              setPrep((p) => ({ ...p, written: n }));
              void finishCard();
            }
            setLive((l) => (l?.writing ? { ...l, view: { ...l.view, steps }, writing: { ...l.writing, drafts, note: note() } } : l));
          }
        },
      });
      await finishCard(); // a story with no steps, or one so quick the card is still up
      const failure = base ? modelFailure(result) : null;
      const problem = failure ? `${failure} The story shows template text where the model didn't answer.` : null;
      setLive({ view: viewOf(pr, result), writing: null, usage: result.metrics.usage, model, provider: providerId, result, problem: problem ?? undefined });
      // A story the model failed on is not kept, so the next open tries the model again.
      if (!problem && !DEMO) await putStory({ key: storyKey(repoKey(ref), pr.number), headSha: pr.headSha, savedAt: Date.now(), pr, result });
    } catch (err) {
      setLive(null);
      setPhase(errorPhase(err, settings, ref.host));
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
      if (!embeddedSafely(settings)) {
        setPhase({ kind: "error", message: "PR Story Mode only opens inside github.com or a GitHub Enterprise host saved in its settings." });
        return;
      }
      settingsRef.current = settings;
      if (DEMO) return void generate(true);
      const cached = await getStory(storyKey(repoKey(ref), ref.number));
      let head: string | null = null;
      try {
        head = (await fetchPullHead(ref, { token: tokenFor(settings, ref.host) })).headSha;
      } catch (err) {
        if (!cached) {
          setPhase(errorPhase(err, settings, ref.host));
          return;
        }
      }
      if (cached) {
        const r = cached.result;
        const stale =
          head && head !== cached.headSha
            ? `New commits were pushed since this story was written (it covers ${cached.headSha.slice(0, 7)}; the PR is now at ${head.slice(0, 7)}). Regenerating keeps the steps whose code didn't change and explains only the rest.`
            : undefined;
        setLive({ view: viewOf(cached.pr, r), writing: null, usage: r.metrics.usage, model: r.story.meta.model, provider: r.story.meta.provider, result: r, stale });
        return;
      }
      const reason = missingModelReason(settings);
      if (reason) setPhase({ kind: "ask", reason });
      else void generate(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prRef = ref ? `${ref.owner}/${ref.repo}#${ref.number}` : null;
  // Once written, what the story cost stays in view (for a cached story, what it cost when written).
  const spent = live && !live.writing && live.provider !== "none" ? costShort(live.model, live.usage) : "";
  const topbar = (
    <div className="topbar">
      <span className="brand">
        <BrandMark />
        PR Story Mode
      </span>
      {live?.writing ? (
        <WritingStatus live={live} />
      ) : prRef ? (
        <span className="pr-ref">
          <span className="ref-name">{prRef}</span>
          {spent ? (
            <span className="spent" title={`${costSoFar(live!.model, live!.usage)}: what writing this story with ${live!.model} used`}>
              {spent}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="spacer" />
      )}
      {live && !live.writing ? (
        <button
          type="button"
          className={`tb${live.stale ? " attn" : ""}`}
          onClick={() => void generate()}
          title={live.stale ? "New commits were pushed: update the story" : "Write the story again"}
          aria-label="Regenerate"
        >
          <Icon name="regenerate" />
          <span className="tb-label">Regenerate</span>
        </button>
      ) : null}
      <ReviewButton />
      <button type="button" className="tb" onClick={openSettings} title="Model, keys and GitHub token" aria-label="Settings">
        <Icon name="settings" />
        <span className="tb-label">Settings</span>
      </button>
      {window.parent !== window ? (
        <>
          <span className="tb-sep" aria-hidden="true" />
          <button type="button" className="tb icon-only" onClick={sendClose} title="Close (Esc)" aria-label="Close">
            <Icon name="close" />
          </button>
        </>
      ) : null}
    </div>
  );

  useEffect(() => {
    // Esc closes the overlay, except while typing (a comment box handles its own Esc).
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) && sendClose();
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
        {r.story.meta.reused ? (
          <>
            <br />
            Updated from the story for {r.story.meta.reused.from.slice(0, 7)}: {r.story.meta.reused.steps} of {r.story.steps.length} steps kept, {r.story.steps.length - r.story.meta.reused.steps} explained again.
          </>
        ) : null}
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
    const story = (
      <>
        {topbar}
        <StoryReader view={live.view} writing={live.writing} footer={footer} banner={banner} headerExtra={<CommentsNote prUrl={live.view.pr.url} />} />
      </>
    );
    // Comments need a GitHub PR; a story without one (local preview) just reads.
    return ref ? (
      <CommentsProvider prRef={ref} view={live.view} current={!live.stale}>
        {story}
      </CommentsProvider>
    ) : (
      story
    );
  }

  return (
    <>
      {topbar}
      <div className="status">
        {phase.kind === "loading" ? (
          <Preparing prep={phase.prep} />
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

const STAGES = ["Read the pull request", "Split it into changes", "Plan the reading order", "Find unchanged code that helps", "Start the walkthrough"];

/** The loading screen: each stage with what it found, and the plan appearing as the model writes it. */
function Preparing({ prep }: { prep: Prep }) {
  const elapsed = useElapsed(prep.started, true);
  const detail = (i: number): ReactNode => {
    if (i === 0 && prep.pr) return `${prep.pr.files} file${prep.pr.files === 1 ? "" : "s"} · +${prep.pr.add} −${prep.pr.del}`;
    if (i === 1 && prep.atoms) return `${prep.atoms.n} change${prep.atoms.n === 1 ? "" : "s"}${prep.atoms.mechanical ? `, ${prep.atoms.mechanical} of them mechanical` : ""}`;
    if (i === 2 && prep.stage === 2) {
      if (!prep.model) return "In dependency order, since no model is set up";
      if (prep.note) return prep.note;
      return prep.planned ? `${prep.planned} step${prep.planned === 1 ? "" : "s"} planned so far` : "The model is reading the changes…";
    }
    if (i === 2 && prep.stage > 2 && prep.steps != null) return `${prep.steps} step${prep.steps === 1 ? "" : "s"}`;
    if (i === 3 && prep.stage === 3) return "Looking through the repository…";
    if (i === 3 && prep.context) {
      const c = prep.context;
      if (!c.snippets) return "Nothing outside the changes was needed";
      return `${c.snippets} snippet${c.snippets === 1 ? "" : "s"} for ${c.steps} step${c.steps === 1 ? "" : "s"}${c.extraFiles ? `, from ${c.extraFiles} file${c.extraFiles === 1 ? "" : "s"} outside the PR` : ""}`;
    }
    if (i === 4 && prep.stage === 4) return !prep.model ? "Template text, since no model is set up" : "Writing the first step…";
    if (i === 4 && prep.stage === 5) {
      const n = prep.steps ?? 0;
      const w = prep.written ?? 0;
      if (n <= 1 || w >= n) return n > 1 ? `All ${n} steps are ready` : "Ready";
      return w > 1 ? `${w} steps are ready; the rest are written as you read` : "Step 1 is ready; the rest are written as you read";
    }
    return null;
  };
  return (
    <div className={`prep${prep.stage === 5 ? " finished" : ""}`}>
      <div className="prep-bar" aria-hidden="true" />
      <p className="prep-kicker">Preparing the story</p>
      <h1>{prep.pr ? <Inline text={prep.pr.title} /> : "Opening the pull request…"}</h1>
      {prep.pr ? <p className="prep-ref">{prep.pr.ref}</p> : null}
      <ol className="stages">
        {STAGES.map((name, i) => {
          const state = i < prep.stage ? "done" : i === prep.stage ? "active" : "todo";
          const d = detail(i);
          return (
            <li key={name} className={state}>
              <span className="dot" aria-hidden="true">
                {state === "done" ? (
                  <svg viewBox="0 0 16 16" width="10" height="10">
                    <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </span>
              <div>
                <span className="stage-name">{name}</span>
                {d ? <span className="stage-detail">{d}</span> : null}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="prep-foot">
        {clock(elapsed)}
        {prep.model ? ` · ${prep.model}` : ""}
        {prep.model && costSoFar(prep.model, prep.usage) ? ` · ${costSoFar(prep.model, prep.usage)}` : ""}
      </p>
    </div>
  );
}

/** In the top bar while steps are written: what's happening, time, cost, and a progress line. */
function WritingStatus({ live }: { live: Live }) {
  const w = live.writing!;
  const elapsed = useElapsed(w.started, true);
  const total = live.view.plan.length;
  const written = live.view.steps.filter(Boolean).length;
  return (
    <>
      <span className="writing-status" role="status">
        <span className="pulse" aria-hidden="true" />
        {w.note} · {clock(elapsed)}
        {live.provider !== "none" && costSoFar(live.model, live.usage) ? ` · ${costSoFar(live.model, live.usage)}` : ""}
      </span>
      <span className="write-progress" aria-hidden="true">
        <span style={{ width: `${total ? (100 * written) / total : 0}%` }} />
      </span>
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
style.textContent = READER_CSS + READER_EXTRA_CSS + COMMENTS_CSS;
document.head.appendChild(style);
createRoot(document.getElementById("root")!).render(<App />);
