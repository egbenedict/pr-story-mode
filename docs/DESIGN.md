# PR Story Mode: design and internals

How PR Story Mode works inside, for contributors. To use the tool, see the [README](../README.md). The original plan is in the [technical design](https://claude.ai/artifact/8sYLrCQsfX4pGtwiwS4FvP).

**Contents:** [Reader internals](#reader-internals) · [How it works](#how-it-works) · [Development](#development) · [Benchmarks](#benchmarks)

## Reader internals

### Asking about code

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
  - If more than two-thirds of the steps would need explaining, the new code doesn't fit the old order, or the detail level changed, the story is made from scratch.

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
- Formatting-only edits, pure renames, import reshuffles, lockfiles and generated files are tagged **mechanical** and shown after the steps, in a section that's marked reviewed like a step.
- A rename must be consistent across the PR and introduce a new name, so swapped arguments are never hidden as "mechanical". Code removed in one place and added verbatim elsewhere is tagged **moved**.

### Symbol graph

`A → B` when A defines a symbol that B references. Cycles are handled as strongly connected components.

<details>
<summary>How definitions and references are found</summary>

- **Definitions** are the unit's name plus what the grammar's `tags.scm` query marks as defined in it (for example `const a = 1, b = 2`). Members are also known by their class, as `C.m`.
- **References** are identifiers, minus parameters, locals bound inside the atom, and keyword-argument names. Name matching alone can't do this: C and C++ ship no reference queries, and JS/Python only tag calls.
- **Members** have special rules. `this.m()` / `self.m()` inside class `C` becomes `C.m` and links only to C's own `m` (or an inherited one when C has none in the PR). Other property reads and writes and object keys (`opts.retries`, `{ retries: 3 }`) link only to class or interface members, never to a global of the same name. `a.b()` and `@a.b` decorators link by name.
- On the benchmark PRs this removed wrong edges (class atoms "using" their own method names, `ctx.request` matched to the global `request`, locals shadowing functions) and found new ones, mostly calls between `#private` methods.
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
- **Sources:** the PR's own files, then the rest of the repository, through `git grep` on a local clone or, without one, the GitHub source: one API request lists the repository, likely files are ranked (what the changed files import or include in TS/JS, Python, C/C++, Go, Java, Rust, Ruby, PHP and C#, then nearby directories), and up to 80 files or 3 MB are read while the model orders the steps, plus files named after a symbol that wasn't found.
- **Avoiding false matches:** a definition in another file needs a matching import in TS, JS and Python; names with more than 3 definitions are skipped; one-line class members are skipped; a C prototype of the changed function isn't a caller; test files never supply context for non-test code.
</details>

### Explaining

- Steps are explained in windows sized to the context budget. The PR description and full step order are a shared prefix, so prompt caching reuses them.
- Each step is a series of **beats**, in the voice of the author walking a colleague through the code: a few sentences, then the 5 to 25 lines they describe. The model picks where each beat ends, and `walkthrough()` cuts the code there; a bad cut point snaps to the nearest valid line.
- **More detail** adds one instruction after the usual prompt (`EXPLAIN_MORE_DETAIL`) and raises each step's word target by half. Standard sends exactly the same prompt as before the setting existed.
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
| 2 | Go, Rust, Java, Ruby, C#, PHP | Generic node patterns plus each language's own rules (below). A changed doc comment joins the declaration it documents |
| 1 | C, C++, JSON, YAML, TOML | Generic node patterns. C/C++ also reads names through declarators and flag macros, and looks through `#if` regions and templates. JSON gets one atom per top-level key, YAML and TOML as below |
| 0 | Everything else | One atom per hunk |

- **Go:** methods are named by their receiver (`func (c *Client) Send` is `Client.Send`), so same-named methods on different types stay apart. `c.flush()` inside a method on `Client` links only to `Client.flush`. `api.Limit` links to `Limit` when `api` is an imported package. Each entry of a grouped `const ( … )`, `var ( … )` or `type ( … )` is its own atom.
- **Rust:** `impl` blocks are named by their type, without generics (`impl<T> Sp<T>` is `Sp`). Each trait impl stays apart (`From<io::Error> for Error`). `Thing::new()` links only to `Thing`'s own `new`, and `self.m()` to the impl's type. Signature lines right below a `///` doc comment belong to their function. Module docs (`//!`) stay on their own.
- **Java:** `helper()` and `this.helper()` link to the enclosing class's own method, `Util.helper()` to `Util`'s. Methods after an enum's constants are members of the enum.
- **Ruby:** methods are named by class and module (`Shop.Cart.add`), and methods in `class << self` under it. Inside a method, `recalc()` and `self.recalc` link only to the class's own `recalc`, and `Cart.build` to `Cart`'s. RSpec groups split into their examples, named by group (`describe(Cart).context("when empty").it("has no total")`), including examples written in a loop inside a group. Class-body lines are named by call (`has_many(:posts)`, `include(Enumerable)`) and constants by name. `require` lines are imports. A comment line joins the code below it.
- **C#:** members are named by class and namespace. `Recalc()` and `this.Recalc()` link to the enclosing class's own method, `Helpers.Log()` to `Helpers`'. Fields are named by their variable, and a file-scoped `namespace X;` line is its own atom, like Java's `package`. When an `#if` splits a signature, which the grammar can't parse, the declarations around it still get their names.
- **PHP:** `$this->recalc()`, `self::log()` and `static::` link to the class's own members, `Helpers::format()` to `Helpers`'. Variables never link to anything. Constants and properties are named (`LIMIT`, `items`), as are calls such as `Route::get('/cart')` and Pest's `it('adds items')`. A `namespace` line is its own atom, and the opening `<?php` joins what follows. Blade templates (`.blade.php`) stay at tier 0.
- **YAML:** one atom per top-level key, and per key under it when it holds keys (`jobs.build`, `on.push`, `spec.replicas`). The same key in two `---` documents stays apart, named by `kind` and `metadata.name` where there are any (`Deployment web.spec.replicas`). A comment line joins the key below it.
- **TOML:** one atom per table (`[package]`, `[tool.ruff.lint]`, `[[bin]]`) or top-level key. A comment line joins the table below it.
- YAML and TOML keys name their atoms but don't link to code of the same name, and config files are never read as context. Lockfiles (`pnpm-lock.yaml`, `Cargo.lock`) stay folded with the mechanical changes.

A new language is a `LanguagePack` in `languages.ts` plus a grammar entry in `packages/cli/src/grammars.ts`. A pack's optional rules (receiver owners, grouped declarations, doc comments, references, statement names, bindings) apply only to that language.

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
npm test                  # 181 tests
npm run typecheck
npm run build             # extension and CLI
npm run build:extension   # packages/extension/dist
npm run build:cli         # packages/cli/dist
```

<details>
<summary>What the tests cover</summary>

Diff parsing, GitHub ingest, rate-limit errors and review comments, comment formatting, GitHub Enterprise hosts and tokens, model failures, reuse after a push, streaming steps and plan drafts, reading half-written JSON, context from a listed repository and import resolution, atomization (TS, Python, C++, Go, Rust, Java, Ruby, C#, PHP, JSON, YAML, TOML), classification, re-indent folding, beats, validation, the repair loop, grounding, context retrieval, staged ordering, linked issues, PR page detection, settings, appearance, CLI config and key sources, gateway keys that expire, asking about selected code (definitions, citations, carrying answers over a push), and folding data runs, repeated edits and deleted files.
</details>

### Working on the reader

Serve `packages/extension/dist` locally and open `reader.html?pr=<PR URL>`. Settings then fall back to the page's `localStorage`.

Add `&demo` for a scripted model (`src/reader/demo.ts`) that streams a plausible plan, explanations and answers, so the loading, writing and asking screens can be seen without a key or cost. Demo mode works only on a local server, never in the extension, and its stories aren't cached.

### Extension internals

- **Content script** (`src/content.ts`): detects PR pages, including GitHub's in-page navigation, and adds one button: in the PR header when it's on screen, otherwise floating at the bottom right. Nothing else on the page changes.
- **Why an extension page, not the service worker:** Chrome stops idle service workers after about 30 seconds, and one model call can take longer. An extension page in an iframe also keeps GitHub's styles and content security policy out of the reader. The service worker only opens settings and registers buttons on enterprise hosts.

## Benchmarks

The same 40 PRs throughout: the last 20 Flask merges and the last 20 ky commits, each of 20 to 3,000 lines.

### Phase 1: coverage without a model

With unchanged context read from local clones.

| Repo | Language | Coverage | Edges | Unchanged snippets | Time per PR |
|---|---|---|---|---|---|
| pallets/flask | Python | 20/20 | 235 | 143 across 376 steps | 0.4 s |
| sindresorhus/ky | TypeScript | 20/20 | 235 | 401 across 468 steps | 0.9 s |

### Phase 2: Opus 5.5 (November 2026, $8.15 in all)

| Repo | Coverage | Steps | Cost | Repair rounds | Fallbacks | Citations dropped (worst PR) | First step (median) | Whole story (median) |
|---|---|---|---|---|---|---|---|---|
| Flask | 20/20 | 171 | $3.24 | 3 | 0 | 1.9% | 15.5 s | 28.4 s |
| ky | 20/20 | 258 | $4.91 | 4 | 0 | 3.8% | 14.8 s | 45.5 s |

- No model call failed, every step got an explanation, and no plan broke dependency order without saying why. One beat cut point had to be moved.
- 0.27% of citations were dropped by the grounding check on average.
- The most expensive PR cost $1.11 (ky, 1,576 lines). No PR was large enough to need staged ordering.
- On the 15 PRs from the earlier pilot, tighter context cut what the model is sent (ky: 384k to 338k input tokens, 169 to 94 context snippets).
- This measures the pipeline's mechanics, not how good the explanations read; that needs people reading the stories.

Per-PR results: [`bench/results/2026-11-opus-5-5`](../bench/results/2026-11-opus-5-5).
