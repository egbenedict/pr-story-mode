# Phase 2 benchmark: 60 PRs with Opus 5.5 (November 2026)

One row per PR, as written by `pr-story bench`. Run from local clones at the same commits as the Phase 1 gate:

```bash
pr-story bench --repo flask --count 20 --mode merges  --min-lines 20 --max-lines 3000 --provider anthropic
pr-story bench --repo ky    --count 20 --mode commits --min-lines 20 --max-lines 3000 --provider anthropic
pr-story bench --repo luau  --count 20 --mode commits --min-lines 20 --max-lines 3000 --provider anthropic
```

Model `claude-opus-5-5`, medium effort. Total cost $10.53 (token columns × $4 input, $20 output, $0.20 cache read, $5 cache write per million). Summary in the main README.
