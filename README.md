# PR Story Mode

Turns a pull request into a near-linear, narrated story. The diff is broken into small **change atoms** (one function, method, class member, config key or import list each), ordered so concepts come before their uses, and explained step by step.

This repo implements the [technical design](https://claude.ai/artifact/8sYLrCQsfX4pGtwiwS4FvP) as a CLI and a Chrome extension. **Phase 1** (ingest and parse, atoms, plan and validate, HTML output) is done. **Phase 2** (story quality) is nearly done: the symbol graph, unchanged context beside each step, staged ordering for large PRs, linked issues and the grounding check are in; the benchmark has not yet run with a model. **Phase 3** (the extension) is under way: the reader, streaming, settings, caching, review comments, reuse after new pushes and context from unchanged files on GitHub work; more providers and enterprise settings are next.

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
- **Reader** (`src/reader/`): an extension page shown in a full-window overlay. It runs the whole pipeline in the browser: GitHub ingest, tree-sitter in WASM, ordering and explanation. While it works, a loading card shows each stage with what it found, and the summary and step titles appear as the model plans them. Once the order is settled the outline and code appear; each step arrives as soon as its part of the model's reply is complete, and the one being written shows its code and its words as they stream. The top bar shows which step is being written, the time, and tokens and cost (estimated while a reply streams). The reader shows tokens and estimated cost while it writes, a per-step reviewed checkbox, raw diffs, expand buttons above, below and inside each code chunk that show the surrounding lines as GitHub does (lines changed in other steps are dimmed), citations that highlight lines, and a banner when the model failed or new commits have landed.
- **Why an extension page and not the service worker**: Chrome stops idle service workers after about 30 seconds, and one model call can take longer. An extension page in an iframe also keeps GitHub's styles and content security policy out of the reader. The service worker only opens settings.
- **Settings** (`src/options/`, `src/settings.ts`): stored in `chrome.storage.local`, never synced. A custom base URL (gateway or self-hosted server) asks Chrome for permission to reach that host. Settings are re-read on every run, so a key or token saved while a reader is open applies on the next try. When GitHub's rate limit is hit or a repository isn't found, the reader explains why and links to settings.
- **Review comments** (`src/reader/comments.tsx`, `core/src/review.ts`): existing review threads show under their lines, with replies. The **+** beside a line number starts a comment. Drag it across lines, or shift-click another line, for a range; a range can run from removed lines into the added lines that replace them, within one hunk as GitHub requires. Post it on its own, or add it to a pending review that is kept in the browser until you submit it from **Finish review** as a comment, approval or change request. Everything goes through GitHub's review API, so teammates without the extension see ordinary review comments. Only lines inside the diff's hunks can take comments, the same rule GitHub applies. Threads the story can't show (outdated, or on hunk lines outside the story's snippets) are listed under the title. When the story is older than the PR's head, threads are placed only if they were written on the story's commit. Comments are Markdown, as on GitHub: the box has a toolbar and shortcuts (⌘B bold, ⌘I italic, ⌘E code, ⌘K link, ⌘⇧. quote, ⌘⇧8 and ⌘⇧7 lists) that keep ⌘Z working, a **Suggest** button that adds a `suggestion` block with the commented lines' current code (GitHub shows it with a button to apply it), and a Preview tab rendered by GitHub's Markdown API. Existing comments show as GitHub renders them. That HTML is cleaned again against a strict allowlist (`src/reader/sanitize.ts`) before it is shown, since the reader page can read your keys. Posting needs a fine-grained token with **Pull requests: Read and write**.
- **Cache** (`src/cache.ts`): finished stories in IndexedDB, keyed by repository and PR number, with the head commit they cover. Reopening a PR is free; if new commits landed, the old story shows with a regenerate banner. Stories where the model failed are not cached.
- **Reuse after a push** (`core/src/reuse.ts`): regenerating a story that's behind the PR's head starts from the cached one when the same model made it. Atoms are matched by what their snippet says (file, symbol, kind and the text of every shown row, not line numbers or commit). Steps whose code and unchanged context are the same keep their explanations, moved to the new line numbers; a changed atom takes its old place and its step is explained again; new atoms get their own step after what they use, next to a step in the same file when one fits. The ordering call is skipped and the summary kept. When more than two-thirds of the steps would need explaining, or the new code doesn't fit the old order, the story is made from scratch. The footer says how many steps were kept.
- **Context on GitHub** (`core/src/remote-context.ts`, `githubContextSource`): without a clone, one API request lists the repository at the PR's head. Likely files are ranked (what the changed files import or include, in TS/JS, Python, C/C++, Go, Java and Rust, then files in the same and nearby directories), and up to 80 files or 3 MB are read from the raw host while the model orders the steps. Definitions and callers are then found in those files, plus files named after a missing symbol. On luau#2579 this finds the same callers as `git grep` on a clone.

To work on the reader without loading the extension, serve `packages/extension/dist` locally and open `reader.html?pr=<PR URL>`; settings then fall back to the page's `localStorage`. Add `&demo` to use a scripted model (`src/reader/demo.ts`) that streams a plausible plan and explanations, to see the loading and writing screens without a key or cost. Demo mode only works on a local server, never in the extension, and its stories aren't cached.

## Commands

| Command | What it does |
|---|---|
| `story <pr-url>` / `story --repo --base --head` | Build a story and write the HTML reader |
| `atoms --repo --base --head` | Print the change atoms and dependency edges (debugging) |
| `bench --repo <dir> [--count 20] [--mode merges\|commits]` | Run the pipeline over recent merged PRs and check the coverage guarantee. With a model it records tokens and cost per PR, and stops at the first PR where the model fails (exit code 3), so a billing or auth problem can't produce a run of template text |

Provider options: `--provider anthropic|openai|openai-compatible|none`, `--model`, `--base-url`, `--effort`. Context options: `--repo <clone>` with a PR URL, `--no-context`. The default model is `claude-opus-5-5`. `openai-compatible` covers self-hosted servers such as Ollama and vLLM (`--base-url http://localhost:11434/v1 --model llama3.3`).

## How it works

```
ingest → parse (tree-sitter) → atomize → classify + symbol graph → [summarize (LLM)] → order (LLM) → validate & repair → context → explain (LLM)
```

- **Ingest** (`github.ts`, `cli/src/local.ts`): the diff, the base and head versions of changed files, and for GitHub PRs up to three issues the description says it fixes or closes. Linked issues go into every prompt after the description. Without a token, GitHub's API allows 60 requests an hour, so file contents are read from `raw.githubusercontent.com` instead (falling back to the API if that fails). A story then uses about four API requests, whatever the PR's size. With a token, everything goes through the API.
- **Atomize** (`packages/core/src/atomize.ts`): each changed line is mapped to its smallest enclosing syntactic unit. A hunk that spans two functions becomes two atoms, and several hunks inside one function merge into one atom. Comments and decorators attach to the code they precede.
- **Classify** (`classify.ts`): formatting-only edits, pure renames, import reshuffles, lockfiles and generated files are tagged mechanical. A rename must be consistent across the PR and introduce a new name, so swapped arguments are never hidden as "mechanical". Code removed in one place and added verbatim elsewhere is tagged as moved.
- **Graph** (`symbols.ts`, `graph.ts`): `A → B` when A defines a symbol that B references. Cycles are handled as strongly connected components.
  - Definitions are the unit's name plus what the grammar's `tags.scm` query marks as defined in it, for example `const a = 1, b = 2`. Members are also known by their class, as `C.m`.
  - References are identifiers, minus parameters and local variables bound inside the atom, and minus keyword-argument names. Name matching alone can't do this, because C and C++ ship no reference queries and JS/Python only tag calls.
  - Members get special rules. `this.m()` / `self.m()` inside class `C` becomes `C.m` and links only to C's own `m`, or to an inherited `m` when C has none in the PR. Other property reads and writes, and object keys (`opts.retries`, `{ retries: 3 }`), link only to class or interface members, never to a global of the same name. `a.b()` and `@a.b` decorators link by name.
  - On the 60 benchmark PRs this removed 92 edge pairs (class atoms "using" their own method names, `ctx.request` matched to the global `request`, local variables shadowing functions) and found 87 new ones, mostly calls between `#private` methods that weren't visible before.
- **Staged ordering** (`order.ts → summarizeAtoms`): when the ordering prompt with code would exceed 40k tokens (or half the model's context window), atoms are first summarized in batches of up to 30, four calls at a time. The planner then sees one or two lines per atom plus the dependency edges, not the code. Atoms the model skips get a template line, so nothing drops out.
- **Order** (`order.ts`): the model returns a flat list of steps. `validatePlan` checks that every atom appears exactly once, no IDs are unknown, and no step comes before a dependency unless it declares an `orderOverride`. Errors are sent back for up to 3 repair rounds, then the pipeline falls back to pure dependency order.
- **Context** (`context.ts`): each step gets up to 3 snippets (60 lines) of code the PR did not change. In rank order: the best definition of a symbol the step uses, the best existing caller of something the step modifies, then the rest by score, then the header of the class the code sits in. Symbols used on the changed lines rank first. Definitions keep the doc comment above them. A slice of a long function or table keeps its opening line, and the lines that mention the symbol are highlighted. A snippet is never shown twice in a story. Definitions come from the PR's own files, and from the rest of the repository through `git grep` with a local clone (a definition-shaped regex at the head commit) or the GitHub source in the extension. A declaration of the changed function itself, such as a C prototype in a header, never counts as a caller. To avoid false matches, a definition in another file needs a matching import in TS, JS and Python, ambiguous names (more than 3 definitions) are skipped, one-line class members are skipped, and test files never supply context for non-test code. The reader shows context collapsed above the step, labeled "Unchanged".
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
npm test            # 81 tests: diff parsing, GitHub ingest, rate-limit errors and review comments, comment formatting, model failures, reuse after a push, streaming steps and plan drafts, reading half-written JSON, context from a listed repository and import resolution, atomization (TS, Python, C++, Go, JSON), classification, re-indent folding, beats, validation, repair loop, grounding, context retrieval, staged ordering, linked issues, PR page detection, settings
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

- Phase 2: the full 60-PR benchmark with a model. A 15-PR pilot on Opus 5.5 (5 each from Flask, ky and luau) cost $3.75: coverage held on all 15, no fallbacks or failed calls, 2 repair rounds, at most 5.4% of citations dropped by the grounding check, a median of 29 s to the first explained step. The full run should cost about $15.
- Phase 3: Bedrock, Vertex and Azure adapters; enterprise policy settings and GitHub Enterprise hosts. Review comments have been checked against a fake GitHub API, not yet on a real pull request. Reuse after a push is tested with a scripted model, not yet with a real one.
- The 200 to 500 PR benchmark, model comparison and reviewer study (Phase 4).
