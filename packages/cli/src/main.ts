#!/usr/bin/env -S npx tsx
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  atomLabel,
  atomizePR,
  classifyAtoms,
  buildGraph,
  fetchPullRequest,
  lineCounts,
  parsePrUrl,
  runPipeline,
  type LLMProvider,
  type PipelineResult,
  type PRInput,
} from "@prstory/core";
import { createProvider, estimateCost, type ProviderConfig } from "@prstory/providers";
import { createHost } from "./grammars";
import { listCommits, listMerges, loadLocalPR } from "./local";
import { renderStoryHtml } from "./render";

const USAGE = `pr-story: turn a pull request into a narrated, ordered story.

Usage:
  pr-story story <github-pr-url>                       Story for a GitHub PR
  pr-story story --repo <dir> --base <ref> --head <ref> Story for a local branch diff
  pr-story bench --repo <dir> [--count 20] [--mode merges|commits] [--min-lines 1] [--max-lines 100000]
                                                        Run the pipeline over recent merged PRs and check coverage
  pr-story atoms --repo <dir> --base <ref> --head <ref> Print the change atoms and dependency edges

Options:
  --provider anthropic|openai|openai-compatible|none   LLM provider (default: anthropic if ANTHROPIC_API_KEY is set, else none)
  --model <id>          Model (default claude-opus-5-5 for anthropic)
  --base-url <url>      Endpoint for openai-compatible servers or a gateway
  --effort <level>      Anthropic effort: low|medium|high|xhigh|max (default medium)
  --out <dir>           Output directory (default ./stories/<name>)
  --token <token>       GitHub token (default GITHUB_TOKEN)

Env: ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, GITHUB_API_URL (GitHub Enterprise).`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      title: { type: "string" },
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
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }

  if (cmd === "story") return storyCmd(rest[0], values);
  if (cmd === "bench") return benchCmd(values);
  if (cmd === "atoms") return atomsCmd(values);
  console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
  process.exitCode = 1;
}

type Values = Record<string, string | boolean | undefined>;
const str = (v: Values, k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);

function providerFrom(v: Values): LLMProvider | null {
  let name = str(v, "provider");
  if (!name) {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) name = "anthropic";
    else {
      console.error("No ANTHROPIC_API_KEY found, so running without an LLM: dependency order and template explanations.");
      console.error("Set ANTHROPIC_API_KEY, or pass --provider anthropic to use an `ant auth login` profile.\n");
      name = "none";
    }
  }
  const model = str(v, "model");
  const baseURL = str(v, "base-url");
  let cfg: ProviderConfig;
  switch (name) {
    case "none":
      cfg = { provider: "none" };
      break;
    case "anthropic":
      cfg = { provider: "anthropic", model, baseURL, effort: str(v, "effort") as "medium" | undefined };
      break;
    case "openai":
      cfg = { provider: "openai", model, baseURL, apiKey: process.env.OPENAI_API_KEY };
      break;
    case "openai-compatible":
      if (!model || !baseURL) throw new Error("--provider openai-compatible needs --model and --base-url");
      cfg = { provider: "openai-compatible", model, baseURL, apiKey: process.env.OPENAI_API_KEY };
      break;
    default:
      throw new Error(`Unknown provider "${name}"`);
  }
  return createProvider(cfg);
}

async function loadInput(target: string | undefined, v: Values): Promise<PRInput> {
  if (target) {
    const ref = parsePrUrl(target);
    if (!ref) throw new Error(`Not a pull request URL: ${target}`);
    return fetchPullRequest(ref, {
      token: str(v, "token") ?? process.env.GITHUB_TOKEN,
      apiBase: process.env.GITHUB_API_URL,
    });
  }
  const repo = str(v, "repo");
  const base = str(v, "base");
  const head = str(v, "head");
  if (!repo || !base || !head) throw new Error("Give a PR URL, or --repo, --base and --head.");
  return loadLocalPR(resolve(repo), base, head, { title: str(v, "title") });
}

function githubLinker(pr: PRInput) {
  if (!pr.url) return undefined;
  return (file: string, side: "LEFT" | "RIGHT", line: number) =>
    `${pr.url}/files#diff-${createHash("sha256").update(file).digest("hex")}${side === "LEFT" ? "L" : "R"}${line}`;
}

async function storyCmd(target: string | undefined, v: Values) {
  const provider = providerFrom(v);
  process.stderr.write("Ingesting… ");
  const pr = await loadInput(target, v);
  process.stderr.write(`${pr.files.length} files.\n`);

  const result = await runPipeline(pr, {
    host: createHost(),
    provider,
    onEvent: (e) => {
      if (e.type === "stage" && e.stage !== "done") process.stderr.write(`  ${e.stage}…\n`);
      if (e.type === "order-attempt" && e.errors.length) process.stderr.write(`    plan round ${e.round + 1}: ${e.errors.length} problem(s), repairing\n`);
      if (e.type === "step") process.stderr.write(`    step ${e.index + 1}: ${e.step.label}\n`);
    },
  });

  const name = pr.repo ? `${pr.repo.replace("/", "-")}-${pr.number}` : `local-${pr.headSha.slice(0, 7)}`;
  const out = resolve(str(v, "out") ?? join("stories", name));
  mkdirSync(out, { recursive: true });
  const cost = provider ? estimateCost(provider.model, result.metrics.usage) : null;
  writeFileSync(join(out, "story.json"), JSON.stringify({ story: result.story, atoms: result.atoms, edges: result.edges, metrics: result.metrics, coverage: result.coverage }, null, 2));
  writeFileSync(join(out, "story.html"), renderStoryHtml(pr, result, { githubLink: githubLinker(pr), costUsd: cost }));

  printSummary(result, cost);
  console.log(`\nWrote ${join(out, "story.html")}`);
  if (!result.coverage.ok) process.exitCode = 2;
}

function printSummary(r: PipelineResult, cost: number | null) {
  const m = r.metrics;
  const c = r.coverage;
  console.log(`\n${r.story.steps.length} steps, ${r.story.mechanical.length} mechanical, ${m.atoms} atoms (tier 2/1/0: ${m.tierCounts[2]}/${m.tierCounts[1]}/${m.tierCounts[0]}), ${m.edges} dependency edges`);
  console.log(c.ok ? `Coverage: OK, all ${c.totalLines} changed lines shown exactly once` : `Coverage: FAILED (${c.missing.length} missing, ${c.duplicated.length} duplicated, ${c.extra.length} extra)`);
  console.log(`Order: ${m.fallbackOrder ? "dependency fallback" : "model plan"}, ${m.repairRounds} repair round(s), ${m.orderOverrides} declared override(s), ${m.undeclaredViolations} undeclared violation(s)`);
  if (r.story.meta.provider !== "none") {
    const failPct = m.citations ? ((100 * m.groundingFailures) / m.citations).toFixed(1) : "0";
    console.log(`Citations: ${m.citations}, ${m.groundingFailures} failed grounding (${failPct}%)`);
    console.log(`Tokens: ${m.tokens.toLocaleString()}${cost != null ? ` (~$${cost.toFixed(3)})` : ""}`);
  }
  console.log(`Time: ${(m.ms.total / 1000).toFixed(1)}s total, first step at ${m.ms.firstStep != null ? (m.ms.firstStep / 1000).toFixed(1) + "s" : "n/a"}`);
}

async function benchCmd(v: Values) {
  const repo = str(v, "repo");
  if (!repo) throw new Error("bench needs --repo <dir>");
  const dir = resolve(repo);
  const count = +(str(v, "count") ?? 20);
  const mode = str(v, "mode") ?? "merges";
  const minLines = +(str(v, "min-lines") ?? 1);
  const maxLines = +(str(v, "max-lines") ?? 100000);
  const provider = providerFrom({ provider: "none", ...v });
  const host = createHost();

  // Scan more history than needed, since size filters skip some.
  const candidates = mode === "commits" ? listCommits(dir, count * 5) : listMerges(dir, count * 5);
  const rows: Record<string, unknown>[] = [];
  let ran = 0;
  let passed = 0;
  for (const c of candidates) {
    if (ran >= count) break;
    let pr: PRInput;
    try {
      pr = mode === "commits" ? loadLocalPR(dir, `${c.sha}^`, c.sha, { title: c.subject, body: c.body }) : loadLocalPR(dir, `${c.sha}^1`, `${c.sha}^2`, { title: c.subject, body: c.body });
    } catch {
      continue;
    }
    const changed = pr.files.reduce((n, f) => n + f.hunks.reduce((k, h) => k + h.lines.filter((l) => l.type !== "context").length, 0), 0);
    if (changed < minLines || changed > maxLines) continue;
    ran++;
    const r = await runPipeline(pr, { host, provider });
    if (r.coverage.ok) passed++;
    const m = r.metrics;
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
      coverage: r.coverage.ok ? "ok" : `FAIL(${r.coverage.missing.length}m/${r.coverage.duplicated.length}d/${r.coverage.extra.length}x)`,
      repairRounds: m.repairRounds,
      undeclaredViolations: m.undeclaredViolations,
      groundingFailPct: m.citations ? +((100 * m.groundingFailures) / m.citations).toFixed(1) : 0,
      tokens: m.tokens,
      ms: m.ms.total,
    };
    rows.push(row);
    console.log(`${row.coverage === "ok" ? "✓" : "✗"} ${row.sha} ${String(row.lines).padStart(5)} lines ${String(row.atoms).padStart(4)} atoms ${String(row.steps).padStart(4)} steps  ${row.title}`);
    if (!r.coverage.ok) console.log(`    missing: ${r.coverage.missing.slice(0, 5).join(", ")}  duplicated: ${r.coverage.duplicated.slice(0, 5).join(", ")}`);
  }

  const out = resolve(str(v, "out") ?? join("bench", dir.split("/").pop()!));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "bench.json"), JSON.stringify(rows, null, 2));
  if (rows.length) {
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(","), ...rows.map((r) => cols.map((k) => JSON.stringify(r[k] ?? "")).join(","))].join("\n");
    writeFileSync(join(out, "bench.csv"), csv);
  }
  console.log(`\nCoverage held on ${passed}/${ran} PRs. Results in ${out}`);
  if (passed !== ran) process.exitCode = 2;
}

async function atomsCmd(v: Values) {
  const pr = await loadInput(undefined, v);
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
