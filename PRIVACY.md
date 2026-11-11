# PR Story Mode privacy policy

_Last updated: November 7, 2026_

PR Story Mode is a browser extension that turns a GitHub pull request into an ordered, explained walkthrough. This page explains what it stores, what it sends, and where.

**In short:** the developer runs no servers, collects nothing, and never receives your data. The extension talks only to GitHub and to the AI provider you configure.

## What is stored on your computer

All of this stays in your browser's local extension storage. None of it is synced to your Google account.

- **Settings:**
  - your AI provider, model and API key;
  - an optional custom API address;
  - your GitHub token and any GitHub Enterprise hosts and tokens;
  - appearance choices.
- **Generated walkthroughs:** cached so that reopening a pull request is instant and free.
- **Questions you ask about code, with their answers:** cached per pull request.

Uninstalling the extension deletes all of it.

## What is sent, and to whom

| Sent to | What | When |
|---|---|---|
| GitHub (github.com, api.github.com, raw.githubusercontent.com, or your GitHub Enterprise host) | Your GitHub token; requests for the pull request's details, changed files, related source files, linked issues and review comments | When you open a walkthrough |
| GitHub | Review comments, replies and reviews you write | Only when you click to post them |
| The AI provider you choose (Anthropic, OpenAI, or an address you enter) | Your API key; the pull request's title, description, linked issues, the changed code with nearby source code, and any questions you type | When a walkthrough is generated or you ask a question |

Your GitHub token is sent only to GitHub, and your API key only to the AI provider. The AI provider handles the code under its own terms and privacy policy. Check them before using the extension on code you aren't allowed to share with that provider.

## What is not done

- No analytics, tracking, advertising or crash reporting.
- No data is sent to the developer or to any service other than those listed above.
- No data is sold, or used for anything other than producing the walkthrough you asked for.
- No remote code is loaded. Everything the extension runs ships inside it.

## Permissions

- **Storage:** keeps the settings and caches described above.
- **Scripting:** adds the "Story mode" button to pull request pages, including on GitHub Enterprise hosts you add.
- **Access to github.com and GitHub's API:** reads the pull request.
- **Access to api.anthropic.com and api.openai.com:** the built-in AI providers.
- **Optional access to other sites:** requested only when you add a custom AI address or a GitHub Enterprise host, and only for that host.

## Contact

Questions about this policy: egbenedictdev@gmail.com.
