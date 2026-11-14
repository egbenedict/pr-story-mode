# Chrome Web Store submission

Everything the store's dashboard asks for, ready to paste. Upload `release/pr-story-mode-<version>.zip`, made by `npm run package:extension` at the repo root.

## Package tab

- **Zip:** `packages/extension/release/pr-story-mode-1.1.0.zip`

## Store listing tab

**Name:** PR Story Mode

**Summary** (from the manifest; at most 132 characters):
> Read a GitHub pull request as an ordered, narrated story where every changed line appears exactly once.

**Category:** Developer Tools  **Language:** English

**Description:**

```text
Big pull requests are hard to review in file order. PR Story Mode re-reads a GitHub pull request as a story: the changes are put in an order that makes sense — the new type before the code that uses it, the helper before its callers — and each step comes with a short explanation of what changed and why.

Every changed line appears exactly once, so nothing is skipped or repeated, and you can still review it line by line.

What you get
• A "Story mode" button on every GitHub pull request page.
• Steps in dependency order, each with a plain-language explanation that cites the lines it talks about.
• Nearby unchanged code (the definition a change relies on, the caller it affects) shown where it helps.
• Bulky, repetitive changes — data tables, the same edit repeated many times, deleted files — folded so the real code stands out.
• Select any lines and ask the AI to walk you through them.
• Write review comments and submit your review without leaving the story.
• Walkthroughs are cached, so reopening a pull request is instant and free; after a new push, only the changed steps are redone.
• GitHub Enterprise support, custom fonts, colors and themes.

Bring your own model
PR Story Mode uses your own API key with Anthropic (Claude), OpenAI, or any OpenAI-compatible endpoint, including company AI gateways. Without a key it still shows the changes in a sensible order, without the explanations.

Privacy
There are no servers, accounts or analytics. Your settings and keys stay in your browser, your GitHub token goes only to GitHub, and code goes only to the AI provider you choose.
```

**Graphics** (in this folder):

| Asset | File | Size |
|---|---|---|
| Store icon | `../icons/icon-128.png` (also inside the zip) | 128×128 |
| Screenshot 1 | `screenshot-1.png`: summary, outline and the first step | 1280×800 |
| Screenshot 2 | `screenshot-2.png`: lines selected, with the "Explain 6 lines" / "Ask…" bar | 1280×800 |
| Screenshot 3 | `screenshot-3.png`: dark theme, re-indented lines folded | 1280×800 |
| Screenshot 4 | `screenshot-4.png`: model settings (Anthropic, OpenAI, gateway, none) | 1280×800 |
| Screenshot 5 | `screenshot-5.png`: appearance settings with live preview | 1280×800 |
| Small promo tile | `promo-small.png` (source: `promo.html`) | 440×280 |

All are PNGs without transparency, as the store requires. The screenshots show a real story for [luau-lang/luau#2981](https://github.com/luau-lang/luau/pull/2981), written by Claude Opus 5.5 and loaded from the reader's cache.

**Links:**
- Homepage URL: the GitHub repo, once it's public; otherwise leave it empty.
- Support URL: the repo's issues page, once public; otherwise leave it empty.

## Privacy tab

**Single purpose:**
> Turns the GitHub pull request you are viewing into an ordered, explained walkthrough of its changes.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings (AI provider, API key, GitHub token, appearance) locally. |
| `scripting` | Adds the "Story mode" button to pull request pages on GitHub Enterprise hosts the user adds in settings. Those hosts aren't known in advance, so the content script is registered at runtime. |
| Host: `github.com`, `api.github.com`, `raw.githubusercontent.com` | Shows the "Story mode" button on pull request pages and reads the pull request's files, comments and linked issues through GitHub's API. Posts review comments only when the user clicks to post. |
| Host: `api.anthropic.com`, `api.openai.com` | The two built-in AI providers. The pull request's changes are sent to whichever one the user chooses, to write the explanations. |
| Optional host: `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | Not granted at install. Requested for one host at a time, only when the user enters a custom AI address (company gateway or self-hosted model) or a GitHub Enterprise host. |

**Remote code:** No, I am not using remote code. All scripts and WebAssembly ship inside the package.

**Data usage.** Tick these, because data goes from the browser to services the user configures:
- ☑ **Authentication information:** the user's API key and GitHub token, sent only to the AI provider and GitHub respectively.
- ☑ **Website content:** pull request code and text, sent to the AI provider the user chose.

Leave everything else unticked: personally identifiable info, health, financial, personal communications, location, web history and user activity.

**Certify all three:**
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://gist.github.com/egbenedict/3c19667ca8fc936adfc44e807461c373 (a copy of [`PRIVACY.md`](../../../PRIVACY.md); update the gist when the policy changes)

## Distribution tab

- **Visibility:**
  - **Unlisted:** only people with the link can install it.
  - **Private:** only your Google Workspace domain.
  - **Public:** listed in search.

  For company use, unlisted plus an IT allowlist entry for the extension's ID is the usual route.
- **Regions:** all.

## Before each update

1. Bump `version` in both `manifest.json` and `package.json` (the package script refuses mismatched versions).
2. Run `npm run package:extension`.
3. Upload the new zip from the Package tab and submit for review.
