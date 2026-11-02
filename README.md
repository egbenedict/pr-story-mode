# PR Story Mode

Turns a pull request into a near-linear, narrated story. The diff is broken into small **change atoms** (one function, method, class member, config key or import list each), ordered so concepts come before their uses, and explained step by step.

This repo implements the [technical design](https://claude.ai/artifact/8sYLrCQsfX4pGtwiwS4FvP) as a CLI and a Chrome extension. **Phase 1** (ingest and parse, atoms, plan and validate, HTML output) is done. **Phase 2** (story quality) is nearly done: the symbol graph, unchanged context beside each step, staged ordering for large PRs, linked issues and the grounding check are in; the benchmark has not yet run with a model. **Phase 3** (the extension) has started: the reader, streaming, settings and caching work; comments, GitHub-only context and more providers are next.

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=...        # optional; without it the CLI runs without an LLM

# A GitHub PR (set GITHUB_TOKEN for private repos or higher rate limits)
npm run story -- story https://github.com/pallets/flask/pull/6133

# The same, also searching a local clone for unchanged definitions and callers
# (the clone needs the PR's head commit: git fetch origin pull/6133/head)
npm run story -- story https://github.com/pallets/flask/pull/6133 --repo ../flask

# A local branch
npm run story -- story --repo ../my-repo --base main --head my-branch
```

Each run writes `stories/<name>/story.html` (the reader) and `story.json` (Story, atoms, edges, metrics, coverage report).

Without an API key the pipeline still runs end to end. It uses pure dependency order and short template explanations, so you can check atoms, ordering and coverage for free.

## Browser extension

```bash
npm run build:extension   # writes packages/extension/dist
```

In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick `packages/extension/dist`. Settings open on install (and from the toolbar button): pick a provider, paste an API key, and optionally add a GitHub token for private repositories. Then open any pull request on github.com and press **Story mode**.

- **Content script** (`src/content.ts`): detects PR pages, including GitHub's in-page navigation, and adds one button. It goes in the PR header's action area when that is on screen, otherwise it floats at the bottom right. Nothing else on GitHub's page is changed.
- **Reader** (`src/reader/`): an extension page shown in a full-window overlay. It runs the whole pipeline in the browser: GitHub ingest, tree-sitter in WASM, ordering and explanation. The outline and code appear as soon as the order is settled, and explained steps stream in. The reader shows tokens and estimated cost while it writes, a per-step reviewed checkbox, raw diffs, citations that highlight lines, and a banner when the model failed or new commits have landed.
- **Why an extension page and not the service worker**: Chrome stops idle service workers after about 30 seconds, and one model call can take longer. An extension page in an iframe also keeps GitHub's styles and content security policy out of the reader. The service worker only opens settings.
- **Settings** (`src/options/`, `src/settings.ts`): stored in `chrome.storage.local`, never synced. A custom base URL (gateway or self-hosted server) asks Chrome for permission to reach that host.
- **Cache** (`src/cache.ts`): finished stories in IndexedDB, keyed by repository and PR number, with the head commit they cover. Reopening a PR is free; if new commits landed, the old story shows with a regenerate banner. Stories where the model failed are not cached.

To work on the reader without loading the extension, serve `packages/extension/dist` locally and open `reader.html?pr=<PR URL>`; settings then fall back to the page's `localStorage`.

## Commands

| Command | What it does |
|---|---|
| `story <pr-url>` / `story --repo --base --head` | Build a story and write the HTML reader |
| `atoms --repo --base --head` | Print the change atoms and dependency edges (debugging) |
| `bench --repo <dir> [--count 20] [--mode merges\|commits]` | Run the pipeline over recent merged PRs and check the coverage guarantee |

Provider options: `--provider anthropic|openai|openai-compatible|none`, `--model`, `--base-url`, `--effort`. Context options: `--repo <clone>` with a PR URL, `--no-context`. The default model is `claude-opus-5-5`. `openai-compatible` covers self-hosted servers such as Ollama and vLLM (`--base-url http://localhost:11434/v1 --model llama3.3`).

## How it works

```
ingest → parse (tree-sitter) → atomize → classify + symbol graph → [summarize (LLM)] → order (LLM) → validate & repair → context → explain (LLM)
```

- **Ingest** (`github.ts`, `cli/src/local.ts`): the diff, the base and head versions of changed files, and for GitHub PRs up to three issues the description says it fixes or closes. Linked issues go into every prompt after the description.
- **Atomize** (`packages/core/src/atomize.ts`): each changed line is mapped to its smallest enclosing syntactic unit. A hunk that spans two functions becomes two atoms, and several hunks inside one function merge into one atom. Comments and decorators attach to the code they precede.
- **Classify** (`classify.ts`): formatting-only edits, pure renames, import reshuffles, lockfiles and generated files are tagged mechanical. A rename must be consistent across the PR and introduce a new name, so swapped arguments are never hidden as "mechanical". Code removed in one place and added verbatim elsewhere is tagged as moved.
- **Graph** (`symbols.ts`, `graph.ts`): `A → B` when A defines a symbol that B references. Cycles are handled as strongly connected components.
  - Definitions are the unit's name plus what the grammar's `tags.scm` query marks as defined in it, for example `const a = 1, b = 2`. Members are also known by their class, as `C.m`.
  - References are identifiers, minus parameters and local variables bound inside the atom, and minus keyword-argument names. Name matching alone can't do this, because C and C++ ship no reference queries and JS/Python only tag calls.
  - Members get special rules. `this.m()` / `self.m()` inside class `C` becomes `C.m` and links only to C's own `m`, or to an inherited `m` when C has none in the PR. Other property reads and writes, and object keys (`opts.retries`, `{ retries: 3 }`), link only to class or interface members, never to a global of the same name. `a.b()` and `@a.b` decorators link by name.
  - On the 60 benchmark PRs this removed 92 edge pairs (class atoms "using" their own method names, `ctx.request` matched to the global `request`, local variables shadowing functions) and found 87 new ones, mostly calls between `#private` methods that weren't visible before.
- **Staged ordering** (`order.ts → summarizeAtoms`): when the ordering prompt with code would exceed 40k tokens (or half the model's context window), atoms are first summarized in batches of up to 30, four calls at a time. The planner then sees one or two lines per atom plus the dependency edges, not the code. Atoms the model skips get a template line, so nothing drops out.
- **Order** (`order.ts`): the model returns a flat list of steps. `validatePlan` checks that every atom appears exactly once, no IDs are unknown, and no step comes before a dependency unless it declares an `orderOverride`. Errors are sent back for up to 3 repair rounds, then the pipeline falls back to pure dependency order.
- **Context** (`context.ts`): each step gets up to 3 snippets (60 lines) of code the PR did not change. In rank order: the best definition of a symbol the step uses, the best existing caller of something the step modifies, then the rest by score, then the header of the class the code sits in. Symbols used on the changed lines rank first. Definitions keep the doc comment above them. A slice of a long function or table keeps its opening line, and the lines that mention the symbol are highlighted. A snippet is never shown twice in a story. Definitions come from the PR's own files, and with a local clone from the rest of the repository through `git grep` (a definition-shaped regex at the head commit). To avoid false matches, a definition in another file needs a matching import in TS, JS and Python, ambiguous names (more than 3 definitions) are skipped, one-line class members are skipped, and test files never supply context for non-test code. The reader shows context collapsed above the step, labeled "Unchanged".
- **Explain** (`explain.ts`): steps are explained in windows sized to the context budget. The PR description and full step order go in a shared prefix, so prompt caching reuses them across windows. Each step is written as a series of **beats**, in the voice of the author walking a colleague through the code: a few sentences, then the 5 to 25 lines they describe. The model picks where each beat ends, and `walkthrough()` in `snippet.ts` cuts the code at those points. Every line still appears exactly once, and a bad cut point snaps to the nearest valid line. Context snippets go in the prompt as `C1`, `C2`… and the model can cite them. A grounding check drops citations that point outside the window's atoms or context.
- **Re-indented code** (`snippet.ts`): removed and added lines that differ only in whitespace are paired in order. Runs of them collapse into one expandable "re-indented, otherwise unchanged" row, for example when old code moves into an `else` branch.
- **Coverage guarantee** (`validate.ts → checkCoverage`): the union of `hunkLines` over all atoms in `steps` and `mechanical` must equal the set of changed lines in the diff, with no line or atom repeated. The CLI exits with code 2 if it ever fails.

### Language support

| Tier | Languages | Atoms |
|---|---|---|
| 2 | TypeScript, TSX, JavaScript, Python | Hand-tuned boundaries (classes, methods, fields, top-level statements, `test("…")` calls) |
| 1 | C, C++, Go, Rust, Java, JSON | Generic node-type patterns. C/C++ also reads names through declarators and flag macros, and looks through `#if` regions and templates. JSON gets one atom per top-level key |
| 0 | Everything else | One atom per hunk |

A new language is a `LanguagePack` in `languages.ts` plus a grammar entry in `packages/cli/src/grammars.ts`.

## Packages

- `packages/core`: the pipeline and validators. It uses no browser or Node APIs (`fetch` only), so the same code runs in the CLI and the extension.
- `packages/providers`: `LLMProvider` adapters (Anthropic, OpenAI and OpenAI-compatible servers, plus a scripted mock for tests).
- `packages/cli`: local git and GitHub ingest, grammar loading, the HTML reader, and the `story`, `atoms` and `bench` commands.
- `packages/extension`: the Manifest V3 extension (content script, reader, settings, cache), bundled with esbuild.

## Tests and benchmark

```bash
npm test            # 47 tests: diff parsing, atomization (TS, Python, C++, Go, JSON), classification, re-indent folding, beats, validation, repair loop, grounding, context retrieval, staged ordering, linked issues, PR page detection, settings
npm run typecheck
```

Phase 1 gate ("coverage holds on 20 real PRs"), run without an LLM:

| Repo | PRs | Language | Coverage |
|---|---|---|---|
| pallets/flask (last 20 merges) | 20 | Python | 20/20 |
| sindresorhus/ky (last 20 commits ≥ 20 lines) | 20 | TypeScript | 20/20 |
| luau-lang/luau (last 20 commits, 20 to 3,000 lines) | 20 | C++ | 20/20 |

With context retrieval from the local clone (still no LLM), coverage holds on all 60. Edges: Flask 235, ky 235, luau 258. Unchanged snippets: Flask 143 across 376 steps, ky 401 across 468, luau 190 across 222. Average time per PR: 0.4 s, 0.9 s and 2.6 s.

## Not done yet

- Phase 2: context outside the PR's files for GitHub PRs without a local clone; running the benchmark end to end with a model (needs an API key) to measure grounding, repair rounds and cost.
- Phase 3: comment round-trip to GitHub reviews; context from unchanged files for PRs without a local clone (the extension only uses the PR's own files for now); Bedrock, Vertex and Azure adapters; enterprise policy settings; re-using cached atoms when new commits land. The extension has not yet been tested loaded in Chrome, only its reader page served locally and its content script injected by hand on github.com.
- The 200 to 500 PR benchmark, model comparison and reviewer study (Phase 4).
