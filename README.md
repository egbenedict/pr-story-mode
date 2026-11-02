# PR Story Mode

Turns a pull request into a near-linear, narrated story. The diff is broken into small **change atoms** (one function, method, class member, config key or import list each), ordered so concepts come before their uses, and explained step by step.

This repo is **Phase 1 (CLI prototype)** of the [technical design](https://claude.ai/artifact/8sYLrCQsfX4pGtwiwS4FvP): ingest and parse, atoms for TypeScript and Python, plan and validate, HTML story output.

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=...        # optional; without it the CLI runs without an LLM

# A GitHub PR (set GITHUB_TOKEN for private repos or higher rate limits)
npm run story -- story https://github.com/pallets/flask/pull/6133

# A local branch
npm run story -- story --repo ../my-repo --base main --head my-branch
```

Each run writes `stories/<name>/story.html` (the reader) and `story.json` (Story, atoms, edges, metrics, coverage report).

Without an API key the pipeline still runs end to end. It uses pure dependency order and short template explanations, so you can check atoms, ordering and coverage for free.

## Commands

| Command | What it does |
|---|---|
| `story <pr-url>` / `story --repo --base --head` | Build a story and write the HTML reader |
| `atoms --repo --base --head` | Print the change atoms and dependency edges (debugging) |
| `bench --repo <dir> [--count 20] [--mode merges\|commits]` | Run the pipeline over recent merged PRs and check the coverage guarantee |

Provider options: `--provider anthropic|openai|openai-compatible|none`, `--model`, `--base-url`, `--effort`. The default model is `claude-opus-5-5`. `openai-compatible` covers self-hosted servers such as Ollama and vLLM (`--base-url http://localhost:11434/v1 --model llama3.3`).

## How it works

```
ingest → parse (tree-sitter) → atomize → classify + symbol graph → order (LLM) → validate & repair → explain (LLM)
```

- **Atomize** (`packages/core/src/atomize.ts`): each changed line is mapped to its smallest enclosing syntactic unit. A hunk that spans two functions becomes two atoms, and several hunks inside one function merge into one atom. Comments and decorators attach to the code they precede.
- **Classify** (`classify.ts`): formatting-only edits, pure renames, import reshuffles, lockfiles and generated files are tagged mechanical. A rename must be consistent across the PR and introduce a new name, so swapped arguments are never hidden as "mechanical". Code removed in one place and added verbatim elsewhere is tagged as moved.
- **Graph** (`graph.ts`): `A → B` when A defines a symbol that B references. Cycles are handled as strongly connected components.
- **Order** (`order.ts`): the model returns a flat list of steps. `validatePlan` checks that every atom appears exactly once, no IDs are unknown, and no step comes before a dependency unless it declares an `orderOverride`. Errors are sent back for up to 3 repair rounds, then the pipeline falls back to pure dependency order.
- **Explain** (`explain.ts`): steps are explained in windows sized to the context budget. The PR description and full step order go in a shared prefix, so prompt caching reuses them across windows. A grounding check drops citations that point outside the window's atoms.
- **Coverage guarantee** (`validate.ts → checkCoverage`): the union of `hunkLines` over all atoms in `steps` and `mechanical` must equal the set of changed lines in the diff, with no line or atom repeated. The CLI exits with code 2 if it ever fails.

### Language support

| Tier | Languages | Atoms |
|---|---|---|
| 2 | TypeScript, TSX, JavaScript, Python | Hand-tuned boundaries (classes, methods, fields, top-level statements, `test("…")` calls) |
| 1 | Go, Rust, Java, JSON | Generic node-type patterns; JSON gets one atom per top-level key |
| 0 | Everything else | One atom per hunk |

A new language is a `LanguagePack` in `languages.ts` plus a grammar entry in `packages/cli/src/grammars.ts`.

## Packages

- `packages/core`: the pipeline and validators. It uses no browser or Node APIs (`fetch` only), so it can run inside the extension's service worker later.
- `packages/providers`: `LLMProvider` adapters (Anthropic, OpenAI and OpenAI-compatible servers, plus a scripted mock for tests).
- `packages/cli`: local git and GitHub ingest, grammar loading, the HTML reader, and the `story`, `atoms` and `bench` commands.

## Tests and benchmark

```bash
npm test            # 22 tests: diff parsing, atomization (TS, Python, Go, JSON), classification, validation, repair loop, grounding
npm run typecheck
```

Phase 1 gate ("coverage holds on 20 real PRs"), run without an LLM:

| Repo | PRs | Language | Coverage |
|---|---|---|---|
| pallets/flask (last 20 merges) | 20 | Python | 20/20 |
| sindresorhus/ky (last 20 commits ≥ 20 lines) | 20 | TypeScript | 20/20 |

## Not done yet (later phases)

- Hierarchical summarization for very large PRs, and ranked context retrieval (Phase 2).
- Browser extension, comment round-trip, IndexedDB caching, and Bedrock, Vertex and Azure adapters (Phase 3).
- The 200 to 500 PR benchmark, model comparison and reviewer study (Phase 4).
- Linked issues are not fetched yet.
