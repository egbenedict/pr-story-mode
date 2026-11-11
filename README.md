# PR Story Mode

Turns a pull request into a narrated story you can read top to bottom.

- The diff is split into small **change atoms**: one function, method, class member, config key or import list each.
- Atoms are **ordered so concepts come before their uses**, then explained step by step, with the code each explanation describes right below it.
- **Every changed line appears exactly once**, so nothing in the PR goes unseen.

It comes as a **CLI** (writes an HTML story) and a **Chrome extension** (adds a Story mode button to GitHub pull requests). See the [technical design](https://claude.ai/artifact/8sYLrCQsfX4pGtwiwS4FvP) for the full plan.

**Contents:** [Status](#status) · [Quick start](#quick-start) · [Reader features](#reader-features) · [CLI reference](#cli-reference) · [How it works](#how-it-works) · [Development](#development) · [Benchmarks](#benchmarks) · [Roadmap](#roadmap)

## Status

| Phase | Scope | State |
|---|---|---|
| 1. Pipeline | Ingest and parse, atoms, plan and validate, HTML output | ✅ Done |
| 2. Story quality | Symbol graph, unchanged context, staged ordering, linked issues, grounding check, [60-PR benchmark](#benchmarks) | ✅ Done |
| 3. Extension | Reader, streaming, settings, caching, review comments, reuse after a push, context from GitHub, GitHub Enterprise, appearance, asking about code | 🚧 In progress: more providers and enterprise policy next |
| 4. Evaluate | 200–500 PR benchmark, model comparison, reviewer study, write-up | Not started |

## Quick start

### CLI

```bash
npm install
export ANTHROPIC_API_KEY=...   # optional: without it, stories use dependency order and template text

npm run story -- story https://github.com/pallets/flask/pull/6133                # a GitHub PR
npm run story -- story https://github.com/pallets/flask/pull/6133 --repo ../flask # read unchanged context from a local clone
npm run story -- story --repo ../my-repo --base main --head my-branch            # a local branch
```

Each run writes `stories/<name>/story.html` (the story) and `story.json` (story, atoms, edges, metrics and coverage report).

- For private repositories, or more than 60 GitHub requests an hour, set `GITHUB_TOKEN`.
- A clone given with `--repo` needs the PR's head commit: `git fetch origin pull/6133/head`.
- Without a key, the whole pipeline still runs, so atoms, ordering and coverage can be checked for free.

### Browser extension

```bash
npm run build:extension   # writes packages/extension/dist
```

1. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and pick `packages/extension/dist`.
3. In the settings page that opens, pick a provider and paste an API key. A GitHub token is optional (needed for private repositories and posting comments).
4. Open any pull request on github.com and press **Story mode**.

### Using the CLI at work

For companies that route models through a gateway, hand out short-lived tokens, or block installing packages from the public npm registry.

Build once on a computer that can install from npm, then copy `packages/cli/dist` to the work computer. It needs only Node 20 or later, no `npm install`.

```bash
npm install
npm run build:cli          # packages/cli/dist: one script plus parser files, about 12 MB
```

Put the folder on the `PATH` (or run `node pr-story.mjs` inside it), then:

```bash
pr-story setup             # where code goes, how to get keys, GitHub hosts and tokens
pr-story check <PR URL>    # tries the key, the gateway and GitHub, and lists where code is sent
pr-story <PR URL>          # writes the story and opens it
```

| | |
|---|---|
| **Gateways** | `setup` takes the base URL, the key header (`x-api-key` or `Authorization: Bearer`) and any extra headers. |
| **Keys that expire** | A key can come from a command that prints it (its last line is used). It runs before each story and again whenever the gateway refuses the key, so an hourly token never needs pasting. Keys can also live in the macOS Keychain (saved by macOS's own prompt) or an environment variable. |
| **GitHub tokens** | Per host (github.com, `github.acme.com`, `acme.ghe.com`): from the GitHub CLI's login, a command, Keychain or an environment variable. Read access is enough. |
| **Config file** | `~/.config/pr-story/config.json` (or `$PR_STORY_CONFIG`). It records where to read each secret, never the secret itself, and only you can read it. A company can hand out one prepared file. |
| **Unchanged context** | Read through the GitHub API, so no clone is needed. Turn it off in `setup` (or with `--no-context`) to send only the changed code to the model. |
| **Without a saved setup** | The CLI reads the same variables as Claude Code: `ANTHROPIC_API_KEY` (sent as `x-api-key`), `ANTHROPIC_AUTH_TOKEN` (sent as a Bearer token) and `ANTHROPIC_BASE_URL`. Flags override the setup for one run. |

## Reader features

The extension's reader opens over the pull request page and runs the whole pipeline in the browser.

### Reading a story

- **Streaming:** a loading card shows each stage as it finishes (steps planned, context found, first step written). Then each step appears as soon as it's written, and the one being written streams in.
- **Top bar:** which step is being written, the time, and tokens and estimated cost. Once written, the cost stays, including questions asked about the code.
- **Per step:** a reviewed checkbox, a **Raw diff** toggle (code only, as GitHub shows it), and citations that highlight the lines they mention.
- **Expanding code:** buttons above, below and inside each chunk show surrounding lines as GitHub does. Lines changed in other steps are dimmed.
- **Folding:** re-indented code, long runs of data, repeated edits and deleted files fold behind a one-line summary ([details](#display)).
- **Banners** when the model failed or new commits were pushed.

### Ask about this code

Select lines in a step's code (or in unchanged code beside it). A bar offers **Explain** (a walkthrough) or **Ask…** (your own question).

- The answer streams into a panel under the last selected line.
- **Line references** like `L12` highlight the code. References to definitions, labelled by name (`clamp L3–5`), open that code under the paragraph that cites them.
- **Follow-up questions** continue the conversation. Each panel has Stop, Delete and its cost.
- Answers are **private**, never posted to GitHub, and saved per PR. After a push they're kept when their lines still read the same.

<details>
<summary>What the model is sent</summary>

- The selected lines.
- The enclosing function (or 40 lines either side), in the new and old versions.
- The step's own explanation, so answers go deeper instead of repeating it.
- The PR description and story summary, as a cached prefix shared by every question.
- Definitions of names the selection calls, or that look like types and constants. They're found in the PR's files first, then through the same GitHub context source the story uses. Code inside comments doesn't count.

Answers cite lines as `[L12]`, `[old L12]` or `[D1 L3-5]`. Citations of lines the model wasn't shown are struck through. Asking is off, with the reason, when no model is set up. Code: `src/reader/ask.tsx`, `core/src/ask.ts`.
</details>

### Review comments

- Existing threads show under their lines, with replies. Threads the story can't place are listed under the title.
- The **+** beside a line number starts a comment. Drag it, or shift-click another line, for a range. A range can run from removed lines into the added lines that replace them, within one hunk.
- Post a comment on its own, or add it to a **pending review** (kept in the browser) and submit it from **Finish review** as a comment, approval or change request.
- Comments are Markdown, with a toolbar, shortcuts (⌘B, ⌘I, ⌘E, ⌘K, ⌘⇧., ⌘⇧8, ⌘⇧7) that keep ⌘Z working, a **Suggest** button for GitHub suggestion blocks, and a preview.
- Everything goes through GitHub's review API, so teammates without the extension see ordinary comments. Posting needs a token with **Pull requests: Read and write**.

<details>
<summary>Details</summary>

- Only lines inside the diff's hunks can take comments, as on GitHub.
- When the story is older than the PR's head, threads are placed only if they were written on the story's commit.
- Existing comments show as GitHub renders them. That HTML is cleaned again against a strict allowlist (`src/reader/sanitize.ts`), since the reader page can read your keys.
- Code: `src/reader/comments.tsx`, `core/src/review.ts`.
</details>

### Caching and reuse after a push

- **Cache** (`src/cache.ts`): finished stories are kept in IndexedDB by repository and PR, with the commit they cover. Reopening a PR is free; if new commits landed, the old story shows with a regenerate banner. Stories where the model failed aren't kept.
- **Reuse** (`core/src/reuse.ts`): when new commits land, regenerating starts from the cached story (if the same model made it).
  - Atoms are matched by what their code says, not by line numbers.
  - Unchanged steps keep their explanations, moved to the new line numbers. Changed atoms keep their place and are explained again. New atoms get their own step after what they use, next to a step in the same file when one fits.
  - The ordering call is skipped and the summary kept. The footer says how many steps were kept.
  - If more than two-thirds of the steps would need explaining, or the new code doesn't fit the old order, the story is made from scratch.

### Settings and appearance

- **Settings** (`src/options/`, `src/settings.ts`) are stored in `chrome.storage.local`, never synced, and re-read on every run. A custom base URL (gateway or self-hosted server) asks Chrome for permission to reach that host. For Anthropic gateways, the key can be sent as `x-api-key` or a Bearer token.
- **Appearance** (`src/appearance.ts`): theme (system, light or dark), accent color, diff colors (green and red, or blue and orange for color-blind readers), text and code fonts, and sizes. Changes apply to open stories at once. Each choice becomes CSS variables over the shared stylesheet, text on the accent switches between white and near-black for contrast, and font names are checked before they go into CSS.
- **Errors** such as GitHub's rate limit or a missing repository are explained in plain words, with a link to settings.

### GitHub Enterprise

- Settings take GitHub Enterprise Server hosts (`github.acme.com`, API at `/api/v3`) and Enterprise Cloud hosts with their own address (`acme.ghe.com`, API at `api.acme.ghe.com`), each with its own token.
- Saving asks Chrome for access to just those hosts, and the Story mode button appears on exactly those hosts.
- Files are read through the host's API, never the public raw host. Stories, drafts and tokens are kept per host.
- Since any https page could embed the reader, it checks `location.ancestorOrigins` first and does nothing unless every page above it is github.com or a saved host.
- Tested against a simulated server, not a real one.

## CLI reference

| Command | What it does |
|---|---|
| `setup` | Ask where code goes and how to get keys and GitHub tokens, and save the answers |
| `check [<PR URL>]` | Try the key, gateway and GitHub access, and list where code will be sent |
| `<PR URL>` or `story <PR URL>` | Write a story for a GitHub PR |
| `story --repo <dir> --base <ref> --head <ref>` | Write a story for a local branch diff |
| `atoms <PR URL>` or `atoms --repo … --base … --head …` | Print change atoms and dependency edges (for debugging) |
| `bench --repo <dir> [--count 20] [--mode merges\|commits]` | Run the pipeline over recent PRs and check coverage. With a model it records tokens and cost per PR, and stops at the first model failure (exit code 3). `--shas a,b,…` runs exactly those commits. Each story is saved in `<out>/stories/`, and the results include words per step, words per changed line and beats per step |

| Option | |
|---|---|
| `--provider anthropic\|openai\|openai-compatible\|none` | Model provider. Default model: `claude-opus-5-5` |
| `--model`, `--base-url`, `--effort` | Model, gateway or server URL, and Anthropic effort (`low` … `max`) |
| `--repo <clone>` | With a PR URL: read unchanged context from a local clone instead of GitHub |
| `--no-context` | Don't show unchanged definitions and callers |
| `--open` / `--no-open` | Open the story in the browser, or don't |
| `--out <dir>`, `--token <token>`, `--config <file>` | Output folder, GitHub token, config file |

`openai-compatible` covers self-hosted servers such as Ollama and vLLM: `--base-url http://localhost:11434/v1 --model llama3.3`.

Exit codes: `2` if coverage fails, `3` if the model failed.

## How it works

```
ingest → parse (tree-sitter) → atomize → classify + symbol graph → [summarize] → order → validate & repair → context → explain
```

| Stage | Code | In short |
|---|---|---|
| [Ingest](#ingest) | `github.ts`, `cli/src/local.ts` | The diff, both versions of changed files, and linked issues |
| [Atomize](#atomize-and-classify) | `atomize.ts` | Each changed line goes to its smallest enclosing unit |
| [Classify](#atomize-and-classify) | `classify.ts` | Tag mechanical changes (formatting, renames, imports, lockfiles, generated) and moves |
| [Symbol graph](#symbol-graph) | `symbols.ts`, `graph.ts` | `A → B` when A defines something B uses |
| [Order](#ordering) | `order.ts`, `validate.ts` | The model orders the steps; the plan is checked and repaired |
| [Context](#context) | `context.ts`, `remote-context.ts` | Unchanged definitions and callers shown beside each step |
| [Explain](#explaining) | `explain.ts`, `snippet.ts` | Each step written as beats: a few sentences, then the code they describe |
| [Display](#display) | `snippet.ts`, `collapse.ts` | Re-indented code, data runs, repeated edits and deleted files fold |

All of it lives in `packages/core/src`, which runs unchanged in the CLI and the extension.

### Ingest

- Fetches the diff, the base and head versions of changed files, and up to three issues the description says it fixes or closes. Linked issues go into every prompt after the description.
- Without a token, GitHub's API allows 60 requests an hour, so file contents come from `raw.githubusercontent.com` (falling back to the API). A story then uses about four API requests, whatever the PR's size. With a token, everything goes through the API.

### Atomize and classify

- Each changed line maps to its smallest enclosing syntactic unit. A hunk spanning two functions becomes two atoms; several hunks in one function become one.
- Comments and decorators attach to the code they precede. A deleted file is one atom.
- Formatting-only edits, pure renames, import reshuffles, lockfiles and generated files are tagged **mechanical** and listed at the end.
- A rename must be consistent across the PR and introduce a new name, so swapped arguments are never hidden as "mechanical". Code removed in one place and added verbatim elsewhere is tagged **moved**.

### Symbol graph

`A → B` when A defines a symbol that B references. Cycles are handled as strongly connected components.

<details>
<summary>How definitions and references are found</summary>

- **Definitions** are the unit's name plus what the grammar's `tags.scm` query marks as defined in it (for example `const a = 1, b = 2`). Members are also known by their class, as `C.m`.
- **References** are identifiers, minus parameters, locals bound inside the atom, and keyword-argument names. Name matching alone can't do this: C and C++ ship no reference queries, and JS/Python only tag calls.
- **Members** have special rules. `this.m()` / `self.m()` inside class `C` becomes `C.m` and links only to C's own `m` (or an inherited one when C has none in the PR). Other property reads and writes and object keys (`opts.retries`, `{ retries: 3 }`) link only to class or interface members, never to a global of the same name. `a.b()` and `@a.b` decorators link by name.
- On the 60 benchmark PRs this removed 92 wrong edges (class atoms "using" their own method names, `ctx.request` matched to the global `request`, locals shadowing functions) and found 87 new ones, mostly calls between `#private` methods.
</details>

### Ordering

- The model returns a flat list of steps. `validatePlan` checks that every atom appears exactly once, no IDs are unknown, and no step comes before a dependency unless it declares an `orderOverride`.
- Errors go back to the model for up to 3 repair rounds, then the pipeline falls back to plain dependency order.
- **Staged ordering:** when the prompt with code would exceed 40k tokens (or half the context window), atoms are first summarized in batches of up to 30, four calls at a time. The planner then sees a line or two per atom plus the edges. Atoms the model skips get a template line, so nothing drops out.

### Context

Each step can show code the PR didn't change, collapsed above the step and labelled "Unchanged":

- definitions of names used **on the changed lines**;
- existing callers of what the step modifies;
- the header of the class the code sits in.

<details>
<summary>Rules and limits</summary>

- **Budget:** up to 3 snippets per step, and 24 lines plus 3 per changed line (at most 60). A snippet is never shown twice in a story.
- **Steps that change only comments** get no context. Comment lines are found per file, including doc blocks written without a leading `*`.
- **Test steps** skip helpers from outside the PR and callers that are other tests.
- Definitions keep the doc comment above them. A slice of a long function or table keeps its opening line, and the lines that mention the symbol are highlighted.
- **Sources:** the PR's own files, then the rest of the repository, through `git grep` on a local clone or, without one, the GitHub source: one API request lists the repository, likely files are ranked (what the changed files import or include in TS/JS, Python, C/C++, Go, Java and Rust, then nearby directories), and up to 80 files or 3 MB are read while the model orders the steps, plus files named after a symbol that wasn't found. On luau#2579 this finds the same callers as `git grep`.
- **Avoiding false matches:** a definition in another file needs a matching import in TS, JS and Python; names with more than 3 definitions are skipped; one-line class members are skipped; a C prototype of the changed function isn't a caller; test files never supply context for non-test code.
</details>

### Explaining

- Steps are explained in windows sized to the context budget. The PR description and full step order are a shared prefix, so prompt caching reuses them.
- Each step is a series of **beats**, in the voice of the author walking a colleague through the code: a few sentences, then the 5 to 25 lines they describe. The model picks where each beat ends, and `walkthrough()` cuts the code there; a bad cut point snaps to the nearest valid line.
- Context snippets are labelled `C1`, `C2`… and can be cited. A **grounding check** drops citations that point outside the window's code or context.

### Display

| Fold | When | Shows |
|---|---|---|
| Re-indented code | Removed and added lines that differ only in whitespace, e.g. code moved into an `else` | "~ 40 lines re-indented, otherwise unchanged" |
| Similar lines | 12+ added (or removed) lines with the same shape once numbers and strings are blanked: data tables, string lists, enum members, repeated calls, repeating multi-line objects | First 3 lines, "⋯ 36 more similar lines of numbers", last line |
| Repeated edits | 4+ hunks in a row making the same kind of edit | First 2 hunks, "⋯ 49 more edits like these (`latitude`, `longitude`)" |
| Deleted file | A whole file removed | "Deleted file · 151 lines · removed `engine`, `play_human`…" |

- Lines with keywords never count as data, and a line that breaks the pattern splits the run, so a real change inside a table stays in view.
- The model gets folded code shortened too: a deleted file as its first 15 lines and the names it defined. On a commit that re-geocoded 94 hostels, visible lines went from 1,288 to 388, and the explain prompt's code from about 18,600 tokens to 4,100.
- Folded lines are still in the story, and a citation or comment inside a fold opens it.

### Coverage guarantee

The `hunkLines` of all atoms in the steps and the mechanical list must equal the diff's changed lines exactly, with no line or atom repeated (`validate.ts → checkCoverage`). The CLI exits with code 2 if it ever fails.

### Language support

| Tier | Languages | Atoms |
|---|---|---|
| 2 | TypeScript, TSX, JavaScript, Python | Hand-tuned boundaries: classes, methods, fields, top-level statements, `test("…")` calls |
| 1 | C, C++, Go, Rust, Java, JSON | Generic node patterns. C/C++ also reads names through declarators and flag macros, and looks through `#if` regions and templates. JSON gets one atom per top-level key |
| 0 | Everything else | One atom per hunk |

A new language is a `LanguagePack` in `languages.ts` plus a grammar entry in `packages/cli/src/grammars.ts`.

## Development

### Packages

| Package | Contents |
|---|---|
| `packages/core` | The pipeline and validators. No browser or Node APIs (only `fetch`), so it runs in both the CLI and the extension |
| `packages/providers` | Model adapters: Anthropic, OpenAI and OpenAI-compatible servers, with gateway keys that refresh, plus a scripted mock for tests |
| `packages/cli` | Local git and GitHub ingest, grammar loading, the HTML story, and the commands |
| `packages/extension` | The Manifest V3 extension (content script, reader, settings, cache), bundled with esbuild |

### Commands

```bash
npm test                  # 153 tests
npm run typecheck
npm run build             # extension and CLI
npm run build:extension   # packages/extension/dist
npm run build:cli         # packages/cli/dist
npm run package:extension # store zip in packages/extension/release (no source maps)
```

<details>
<summary>What the tests cover</summary>

Diff parsing, GitHub ingest, rate-limit errors and review comments, comment formatting, GitHub Enterprise hosts and tokens, model failures, reuse after a push, streaming steps and plan drafts, reading half-written JSON, context from a listed repository and import resolution, atomization (TS, Python, C++, Go, JSON), classification, re-indent folding, beats, validation, the repair loop, grounding, context retrieval, staged ordering, linked issues, PR page detection, settings, appearance, CLI config and key sources, gateway keys that expire, asking about selected code (definitions, citations, carrying answers over a push), and folding data runs, repeated edits and deleted files.
</details>

### Working on the reader

Serve `packages/extension/dist` locally and open `reader.html?pr=<PR URL>`. Settings then fall back to the page's `localStorage`.

Add `&demo` for a scripted model (`src/reader/demo.ts`) that streams a plausible plan, explanations and answers, so the loading, writing and asking screens can be seen without a key or cost. Demo mode works only on a local server, never in the extension, and its stories aren't cached.

### Extension internals

- **Content script** (`src/content.ts`): detects PR pages, including GitHub's in-page navigation, and adds one button: in the PR header when it's on screen, otherwise floating at the bottom right. Nothing else on the page changes.
- **Why an extension page, not the service worker:** Chrome stops idle service workers after about 30 seconds, and one model call can take longer. An extension page in an iframe also keeps GitHub's styles and content security policy out of the reader. The service worker only opens settings and registers buttons on enterprise hosts.

### Publishing the extension

`npm run package:extension` builds a release and zips it for the Chrome Web Store. [`packages/extension/store/STORE.md`](packages/extension/store/STORE.md) has everything the store's dashboard asks for, ready to paste:

- the listing text;
- a justification for each permission;
- the privacy answers;
- screenshots and a promo tile.

The privacy policy is [`PRIVACY.md`](PRIVACY.md), published at [this gist](https://gist.github.com/egbenedict/3c19667ca8fc936adfc44e807461c373).

## Benchmarks

The same 60 PRs throughout: the last 20 Flask merges, and the last 20 ky and luau commits of 20 to 3,000 lines.

### Phase 1: coverage without a model

With unchanged context read from local clones.

| Repo | Language | Coverage | Edges | Unchanged snippets | Time per PR |
|---|---|---|---|---|---|
| pallets/flask | Python | 20/20 | 235 | 143 across 376 steps | 0.4 s |
| sindresorhus/ky | TypeScript | 20/20 | 235 | 401 across 468 steps | 0.9 s |
| luau-lang/luau | C++ | 20/20 | 258 | 190 across 222 steps | 2.6 s |

### Phase 2: Opus 5.5 (November 2026, $10.53 in all)

| Repo | Coverage | Steps | Cost | Repair rounds | Fallbacks | Citations dropped (worst PR) | First step (median) | Whole story (median) |
|---|---|---|---|---|---|---|---|---|
| Flask | 20/20 | 171 | $3.24 | 3 | 0 | 1.9% | 15.5 s | 28.4 s |
| ky | 20/20 | 258 | $4.91 | 4 | 0 | 3.8% | 14.8 s | 45.5 s |
| luau | 20/20 | 102 | $2.38 | 8 | 0 | 10.0% | 16.4 s | 25.8 s |

- No model call failed, every step got an explanation, and no plan broke dependency order without saying why. One beat cut point had to be moved.
- 0.46% of citations were dropped by the grounding check on average.
- The most expensive PR cost $1.11 (ky, 1,576 lines). No PR was large enough to need staged ordering.
- On the 15 PRs from the earlier pilot, tighter context cut what the model is sent (ky: 384k to 338k input tokens, 169 to 94 context snippets).
- This measures the pipeline's mechanics, not how good the explanations read; that needs people reading the stories.

Per-PR results: [`bench/results/2026-11-opus-5-5`](bench/results/2026-11-opus-5-5).

## Roadmap

**Phase 3, still open**
- Bedrock, Vertex and Azure adapters.
- Enterprise policy settings (managed storage), so IT can preset the extension.
- Not yet tried in real conditions: GitHub Enterprise on a real server, review comments on a real pull request, and reuse after a push with a real model.

**Phase 4**
- A 200 to 500 PR benchmark, a model comparison, a seeded-bug reviewer study, and a public write-up.
