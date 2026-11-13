#!/usr/bin/env -S npx tsx
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  atomLabel,
  atomizePR,
  classifyAtoms,
  buildGraph,
  countWords,
  fetchPullRequest,
  githubContextSource,
  lineCounts,
  modelFailure,
  parsePrUrl,
  runPipeline,
  type Detail,
  type PipelineResult,
  type PRInput,
} from "@prstory/core";
import { createProvider, estimateCost } from "@prstory/providers";
import { checkCmd } from "./check";
import { configPath, expandHome, githubToken, loadConfig, type Config } from "./config";
import { createHost } from "./grammars";
import { hasCommit, listCommits, listMerges, listShas, loadLocalPR, localContextSource, readBodyFile, readIssuesFile } from "./local";
import { chooseModel } from "./model";
import { renderStoryHtml } from "./render";
import { setupCmd } from "./setup";

const USAGE = `pr-story: turn a pull request into a narrated, ordered story.

Getting started:
  pr-story setup                     Choose a model or your company's gateway, and GitHub tokens
  pr-story check [<PR URL>]          Try the setup: key, gateway, GitHub access, and where code goes
  pr-story <PR URL>                  Write a story for a pull request (and open it)

More:
  pr-story story --repo <dir> --base <ref> --head <ref>  Story for a local branch diff
      [--title <text>] [--body-file <file>] [--issues-file <file>]
                                     The PR's title, description (UTF-8 text file) and linked issues
                                     (JSON array of {number, title, body, url?}). Without them the
                                     title and description come from the head commit's message.
                                     With a PR URL, they replace what GitHub has.
  pr-story bench --repo <dir> [--count 20] [--mode merges|commits] [--min-lines 1] [--max-lines 100000]
                 [--shas <sha,sha,…>]
                                     Run the pipeline over recent merged PRs and check coverage.
                                     With --shas, run exactly those commits (merges diff parent 1
                                     to parent 2). Each story is saved in <out>/stories/.
  pr-story atoms <PR URL> | --repo <dir> --base <ref> --head <ref>
                                     Print the change atoms and dependency edges

Options (each overrides the saved setup for one run):
  --provider anthropic|openai|openai-compatible|none
  --model <id>          Model (default claude-opus-5-5 for anthropic)
  --base-url <url>      A gateway, or an OpenAI-compatible server
  --effort <level>      Anthropic effort: low|medium|high|xhigh|max (default medium)
  --no-fallbacks        Anthropic: don't let another model answer when the requested one declines
  --out <dir>           Output folder (default: the saved folder, else ./stories/<name>)
  --token <token>       GitHub token
  --repo <dir>          With a PR URL: a local clone to read unchanged context from (else it's read from GitHub)
  --no-context          Don't show unchanged definitions and callers beside steps
  --detail <level>      standard, or more: link nearly every changed line to the words about it
  --open / --no-open    Open the story in the browser, or don't
  --config <file>       Use this config file

Setup is saved in ~/.config/pr-story/config.json (or $PR_STORY_CONFIG). It never holds keys or
tokens, only where to read them: a command (for tokens that expire), the macOS Keychain, an
environment variable, or the GitHub CLI's login. Without a saved setup, pr-story reads
ANTHROPIC_API_KEY (sent as x-api-key), ANTHROPIC_AUTH_TOKEN (sent as a Bearer token),
ANTHROPIC_BASE_URL, OPENAI_API_KEY, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN and GITHUB_API_URL.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
      "issues-file": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      effort: { type: "string" },
      out: { type: "string" },
      token: { type: "string" },
      count: { type: "string" },
      mode: { type: "string" },
      "min-lines": { type: "string" },
      "max-lines": { type: "string" },
      shas: { type: "string" },
      "no-context": { type: "boolean" },
      detail: { type: "string" },
      "no-fallbacks": { type: "boolean" },
      config: { type: "string" },
      open: { type: "boolean" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }

  const path = configPath(values.config);
  if (cmd === "setup") return setupCmd(path);
  const config = loadConfig(path);
  // `pr-story <PR URL>` is short for `pr-story story <PR URL>`.
  if (/^https?:\/\//.test(cmd)) return storyCmd(cmd, values, config);
  if (cmd === "story") return storyCmd(rest[0], values, config);
  if (cmd === "check") return checkCmd(rest[0], values, config, path);
  if (cmd === "bench") return benchCmd(values, config);
  if (cmd === "atoms") return atomsCmd(rest[0], values, config);
  console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
  process.exitCode = 1;
}

type Values = Record<string, string | boolean | undefined>;
const str = (v: Values, k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);

/** The detail level: --detail, else the saved setup, else standard. */
function detailFrom(v: Values, config: Config): Detail {
  const d = str(v, "detail") ?? config.detail ?? "standard";
  if (d !== "standard" && d !== "more") throw new Error(`--detail should be "standard" or "more", not "${d}".`);
  return d;
}

function providerFrom(v: Values, config: Config) {
  const choice = chooseModel(v, config);
  if (choice.note) console.error(`${choice.note}\n`);
  return createProvider(choice.cfg);
}

/** The GitHub token for a PR's host, saying where it came from when it isn't the obvious place. */
const tokens = new Map<string, Promise<string | undefined>>();
function tokenFor(host: string, v: Values, config: Config): Promise<string | undefined> {
  let t = tokens.get(host);
  if (!t) {
    t = githubToken(host, config, str(v, "token")).then(({ token, from }) => {
      if (token && from !== "--token") process.stderr.write(`  (GitHub token for ${host} from ${from})\n`);
      return token;
    });
    tokens.set(host, t);
  }
  return t;
}

async function loadInput(target: string | undefined, v: Values, config: Config): Promise<PRInput> {
  // Read these first, so a bad file fails before anything is fetched.
  const bodyFile = str(v, "body-file");
  const issuesFile = str(v, "issues-file");
  const meta = {
    title: str(v, "title"),
    body: bodyFile ? readBodyFile(resolve(bodyFile)) : undefined,
    issues: issuesFile ? readIssuesFile(resolve(issuesFile)) : undefined,
  };
  let pr: PRInput;
  if (target) {
    const ref = parsePrUrl(target);
    if (!ref) throw new Error(`Not a pull request URL: ${target}`);
    pr = await fetchPullRequest(ref, { token: await tokenFor(ref.host, v, config), apiBase: process.env.GITHUB_API_URL });
  } else {
    const repo = str(v, "repo");
    const base = str(v, "base");
    const head = str(v, "head");
    if (!repo || !base || !head) throw new Error("Give a PR URL, or --repo, --base and --head.");
    pr = loadLocalPR(resolve(repo), base, head);
  }
  if (meta.title !== undefined) pr.title = meta.title;
  if (meta.body !== undefined) pr.body = meta.body;
  if (meta.issues !== undefined) pr.issues = meta.issues;
  return pr;
}

/**
 * Where unchanged context comes from: a local clone given with --repo (when it has the head
 * commit), or else the repository on GitHub, read through its API, so no clone is needed.
 */
async function contextSourceFor(pr: PRInput, v: Values, config: Config, target: string | undefined) {
  const repo = str(v, "repo");
  if (repo) {
    const dir = resolve(repo);
    if (hasCommit(dir, pr.headSha)) return localContextSource(dir, pr.headSha);
    process.stderr.write(`  (${repo} does not have ${pr.headSha.slice(0, 7)}; reading context from GitHub instead. Run \`git fetch\` there to use the clone.)\n`);
  }
  const ref = target ? parsePrUrl(target) : null;
  if (!ref) return null;
  return githubContextSource(ref, { token: await tokenFor(ref.host, v, config).catch(() => undefined), apiBase: process.env.GITHUB_API_URL }, pr);
}

/** Opens a file in the default browser. */
function openInBrowser(file: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function githubLinker(pr: PRInput) {
  if (!pr.url) return undefined;
  return (file: string, side: "LEFT" | "RIGHT", line: number) =>
    `${pr.url}/files#diff-${createHash("sha256").update(file).digest("hex")}${side === "LEFT" ? "L" : "R"}${line}`;
}

async function storyCmd(target: string | undefined, v: Values, config: Config) {
  const detail = detailFrom(v, config);
  const provider = providerFrom(v, config);
  process.stderr.write("Reading the pull request…\n");
  const pr = await loadInput(target, v, config);
  process.stderr.write(`  ${pr.files.length} files.\n`);
  const noContext = v["no-context"] === true || config.context === false;

  const result = await runPipeline(pr, {
    host: createHost(),
    provider,
    contextSource: noContext ? null : await contextSourceFor(pr, v, config, target),
    noContext,
    detail,
    onEvent: (e) => {
      if (e.type === "stage" && e.stage !== "done") process.stderr.write(`  ${e.stage}…\n`);
      if (e.type === "summarize") process.stderr.write(`    summarized batch ${e.done} of ${e.total}\n`);
      if (e.type === "order-attempt" && e.errors.length) process.stderr.write(`    plan round ${e.round + 1}: ${e.errors.length} problem(s), repairing\n`);
      if (e.type === "step") process.stderr.write(`    step ${e.index + 1}: ${e.step.label}\n`);
    },
  });

  const name = pr.repo ? `${pr.repo.replace("/", "-")}-${pr.number}` : `local-${pr.headSha.slice(0, 7)}`;
  const out = resolve(str(v, "out") ?? join(config.outDir ? expandHome(config.outDir) : "stories", name));
  mkdirSync(out, { recursive: true });
  const cost = provider ? estimateCost(provider.model, result.metrics.usage) : null;
  writeFileSync(join(out, "story.json"), JSON.stringify({ story: result.story, atoms: result.atoms, edges: result.edges, metrics: result.metrics, coverage: result.coverage }, null, 2));
  writeFileSync(join(out, "story.html"), renderStoryHtml(pr, result, { githubLink: githubLinker(pr), costUsd: cost }));

  printSummary(result, cost);
  console.log(`\nWrote ${join(out, "story.html")}`);
  const failure = modelFailure(result);
  if (failure) {
    process.stderr.write(`\nWarning: ${failure}\n`);
    if (/\b40[13]\b|key|auth/i.test(failure)) process.stderr.write("Run `pr-story check` to test the key and gateway.\n");
  }
  if (v.open === true || (config.open === true && v["no-open"] !== true)) openInBrowser(join(out, "story.html"));
  if (!result.coverage.ok) process.exitCode = 2;
  else if (failure) process.exitCode = 3;
}

function printSummary(r: PipelineResult, cost: number | null) {
  const m = r.metrics;
  const c = r.coverage;
  console.log(`\n${r.story.steps.length} steps, ${r.story.mechanical.length} mechanical, ${m.atoms} atoms (tier 2/1/0: ${m.tierCounts[2]}/${m.tierCounts[1]}/${m.tierCounts[0]}), ${m.edges} dependency edges`);
  console.log(c.ok ? `Coverage: OK, all ${c.totalLines} changed lines shown exactly once` : `Coverage: FAILED (${c.missing.length} missing, ${c.duplicated.length} duplicated, ${c.extra.length} extra)`);
  console.log(`Order: ${m.fallbackOrder ? "dependency fallback" : "model plan"}${m.summarized ? ` from summaries (${m.summarized.batches} batches)` : ""}, ${m.repairRounds} repair round(s), ${m.orderOverrides} declared override(s), ${m.undeclaredViolations} undeclared violation(s)`);
  console.log(`Context: ${m.contextSnippets} unchanged snippet(s) on ${m.stepsWithContext} step(s)${m.contextFiles ? `, ${m.contextFiles} file(s) read from outside the PR` : ""}`);
  if (r.story.meta.provider !== "none") {
    const failPct = m.citations ? ((100 * m.groundingFailures) / m.citations).toFixed(1) : "0";
    console.log(`Citations: ${m.citations}, ${m.groundingFailures} failed grounding (${failPct}%)`);
    console.log(`Tokens: ${m.tokens.toLocaleString()}${cost != null ? ` (~$${cost.toFixed(3)})` : ""}`);
    if (m.servedModels.some((x) => x !== r.story.meta.model)) console.log(`Served by: ${m.servedModels.join(", ")} (requested ${r.story.meta.model})`);
  }
  console.log(`Time: ${(m.ms.total / 1000).toFixed(1)}s total, first step at ${m.ms.firstStep != null ? (m.ms.firstStep / 1000).toFixed(1) + "s" : "n/a"}`);
}

async function benchCmd(v: Values, config: Config) {
  const repo = str(v, "repo");
  if (!repo) throw new Error("bench needs --repo <dir>");
  const dir = resolve(repo);
  const count = +(str(v, "count") ?? 20);
  const mode = str(v, "mode") ?? "merges";
  const minLines = +(str(v, "min-lines") ?? 1);
  const maxLines = +(str(v, "max-lines") ?? 100000);
  const detail = detailFrom(v, config);
  const provider = providerFrom({ provider: "none", ...v }, config);
  const host = createHost();

  // Scan more history than needed, since size filters skip some.
  const shaList = str(v, "shas")?.split(/[\s,]+/).filter(Boolean) ?? [];
  const candidates = shaList.length
    ? listShas(dir, shaList)
    : (mode === "commits" ? listCommits(dir, count * 5) : listMerges(dir, count * 5)).map((c) => ({ ...c, merge: mode !== "commits" }));
  const out = resolve(str(v, "out") ?? join("bench", dir.split("/").pop()!));
  mkdirSync(join(out, "stories"), { recursive: true });
  const rows: Record<string, unknown>[] = [];
  let ran = 0;
  let passed = 0;
  let modelStop: string | null = null;
  for (const c of candidates) {
    if (!shaList.length && ran >= count) break;
    let pr: PRInput;
    try {
      pr = c.merge ? loadLocalPR(dir, `${c.sha}^1`, `${c.sha}^2`, { title: c.subject, body: c.body }) : loadLocalPR(dir, `${c.sha}^`, c.sha, { title: c.subject, body: c.body });
    } catch {
      continue;
    }
    const changed = pr.files.reduce((n, f) => n + f.hunks.reduce((k, h) => k + h.lines.filter((l) => l.type !== "context").length, 0), 0);
    if (!shaList.length && (changed < minLines || changed > maxLines)) continue;
    ran++;
    const r = await runPipeline(pr, { host, provider, contextSource: v["no-context"] === true ? null : localContextSource(dir, pr.headSha), noContext: v["no-context"] === true, detail });
    if (r.coverage.ok) passed++;
    const m = r.metrics;
    const failure = modelFailure(r);
    const row = {
      sha: c.sha.slice(0, 10),
      title: c.subject.slice(0, 60),
      files: m.files,
      lines: m.changedLines,
      atoms: m.atoms,
      mechanical: m.mechanicalAtoms,
      tier2: m.tierCounts[2],
      tier1: m.tierCounts[1],
      tier0: m.tierCounts[0],
      edges: m.edges,
      steps: m.steps,
      context: m.contextSnippets,
      contextFiles: m.contextFiles,
      summarized: m.summarized ? m.summarized.batches : 0,
      coverage: r.coverage.ok ? "ok" : `FAIL(${r.coverage.missing.length}m/${r.coverage.duplicated.length}d/${r.coverage.extra.length}x)`,
      repairRounds: m.repairRounds,
      fallbackOrder: m.fallbackOrder,
      undeclaredViolations: m.undeclaredViolations,
      groundingFailPct: m.citations ? +((100 * m.groundingFailures) / m.citations).toFixed(1) : 0,
      missingExplanations: m.missingExplanations,
      badCuts: m.badCuts,
      words: m.words,
      wordsPerStep: m.explainedSteps ? Math.round(m.words / m.explainedSteps) : 0,
      wordsPerLine: m.changedLines && m.explainedSteps ? +(m.words / m.changedLines).toFixed(2) : 0,
      beatsPerStep: m.explainedSteps ? +(m.beats / m.steps).toFixed(1) : 0,
      summaryWords: countWords(r.story.summary),
      tokens: m.tokens,
      inputTokens: m.usage.inputTokens,
      outputTokens: m.usage.outputTokens,
      cacheReadTokens: m.usage.cacheReadTokens,
      cacheWriteTokens: m.usage.cacheWriteTokens,
      firstStepMs: m.ms.firstStep ?? "",
      ms: m.ms.total,
      modelCalls: m.modelCalls.total,
      failedModelCalls: m.modelCalls.failed,
      servedModels: m.servedModels.join(" "),
      modelError: m.providerErrors[0] ?? "",
    };
    rows.push(row);
    writeFileSync(join(out, "stories", `${row.sha}.json`), JSON.stringify({ title: c.subject, story: r.story, metrics: m }, null, 2));
    console.log(`${row.coverage === "ok" ? "✓" : "✗"} ${row.sha} ${String(row.lines).padStart(5)} lines ${String(row.atoms).padStart(4)} atoms ${String(row.steps).padStart(4)} steps ${String(row.wordsPerStep).padStart(4)} w/step  ${row.title}`);
    if (!r.coverage.ok) console.log(`    missing: ${r.coverage.missing.slice(0, 5).join(", ")}  duplicated: ${r.coverage.duplicated.slice(0, 5).join(", ")}`);
    // A model that stops answering (billing, auth, rate limits) would make the rest of the run
    // measure template text, so stop and keep what ran.
    if (failure) {
      modelStop = failure;
      console.log(`    model failed: ${failure}`);
      break;
    }
  }

  writeFileSync(join(out, "bench.json"), JSON.stringify(rows, null, 2));
  if (rows.length) {
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(","), ...rows.map((r) => cols.map((k) => JSON.stringify(r[k] ?? "")).join(","))].join("\n");
    writeFileSync(join(out, "bench.csv"), csv);
  }
  console.log(`\nCoverage held on ${passed}/${ran} PRs. Results in ${out}`);
  if (modelStop) console.log(`Stopped after ${ran} PR(s) because the model failed. Fix the cause and run again.`);
  if (passed !== ran) process.exitCode = 2;
  else if (modelStop) process.exitCode = 3;
}

async function atomsCmd(target: string | undefined, v: Values, config: Config) {
  const pr = await loadInput(target, v, config);
  const atoms = classifyAtoms(pr, await atomizePR(pr, createHost()));
  const edges = buildGraph(atoms);
  for (const a of atoms) {
    const { add, del } = lineCounts(a);
    console.log(`${a.id}  ${atomLabel(a)}  [${a.kind}${a.mechanical ? `, ${a.mechanical}` : ""}, tier ${a.supportTier}, +${add} −${del}]`);
    if (a.defines.length) console.log(`           defines: ${a.defines.join(", ")}`);
  }
  console.log(`\n${edges.length} edges`);
  for (const e of edges) console.log(`  ${e.from} → ${e.to}  (${e.symbol})`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
