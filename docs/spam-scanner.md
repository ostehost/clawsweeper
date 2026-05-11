# Spam Scanner

Read when changing ClawSweeper comment spam detection, audit records, or org
blocking policy.

The spam scanner is an audit-only intake lane. It watches new GitHub comments,
applies cheap deterministic filters, sends likely candidates to `gpt-instant`,
and writes durable audit records. It does not block users, hide comments, label
items, reply, or mutate target repositories.

This lane is deliberately separate from the weekly issue/PR review cadence.
Spam cost scales with new comments, not with the total open issue count.

Default behavior:

- target repo: `openclaw/openclaw`
- model: `gpt-instant`
- schedule: hourly cron at minute 17
- catch-up window: 3 hours
- cap: 100 comments
- dedupe: comment kind, id, and `updated_at`
- action: `none`

The first live audit-only run on 2026-05-11 scanned 50 recent comments, found no
model candidates, and published `results/spam-scanner-latest.json`.

## Workflow

The workflow is `.github/workflows/spam-scanner.yml`.

Inputs:

- `target_repo`: repository to scan
- `lookback_minutes`: fallback window for scheduled/manual catch-up
- `since`: optional explicit ISO lower bound
- `max_comments`: cap across issue comments and PR review comments
- `comment_ids`: exact issue comment replay
- `review_comment_ids`: exact PR review comment replay
- `model`: cheap scanner model, default `gpt-instant`
- `force_reprocess`: ignore the processed-version ledger for replay

The workflow checks out the live ClawSweeper repo plus hydrated generated state,
creates a target-read GitHub App token, runs `pnpm run repair:spam-scan`, and
publishes the resulting files through `repair:publish-main`.

The current scheduled workflow is active, but GitHub cron delivery can lag or
drop a newly added workflow's first tick. Manual dispatch is the immediate
verification path.

## Comment Sources

The scanner reads:

- issue and PR conversation comments from
  `repos/<repo>/issues/comments?since=...`
- PR review/diff comments from `repos/<repo>/pulls/comments?since=...`
- exact issue comments from `repos/<repo>/issues/comments/<id>`
- exact review comments from `repos/<repo>/pulls/comments/<id>`

It also hydrates GraphQL minimization metadata for scanned comment node ids. If
GitHub has already minimized a comment as spam or abuse, that becomes a
deterministic signal.

Protected authors are skipped before model spend:

- `OWNER`
- `MEMBER`
- `COLLABORATOR`
- GitHub bot accounts
- configured trusted bots

Outputs in `openclaw/clawsweeper-state`:

- `results/spam-scanner-latest.json`: latest run summary
- `results/spam-scanner.json`: durable processed comment-version ledger
- `results/spam-audit/<repo-slug>/<kind>-<comment-id>.json`: per-comment audit

Audit records include the comment URL, author association, body hash, short body
excerpt, deterministic signals, model, model result, and `action: none`.

## Detection

Deterministic signals are intentionally simple and cheap:

- GitHub minimized reason contains `spam` or `abuse`
- known URL shortener
- multiple links
- outside author with a link
- service-pitch wording such as web scraping, data extraction, flash sale, or
  sample work
- priced short service pitch

Only comments with deterministic signals are sent to `gpt-instant`. The model
returns strict JSON:

- `spam_signal`: `none`, `low`, `medium`, or `high`
- `confidence`: 0-1
- `reasons`: short strings
- `should_investigate`: scheduler hint only

The model result is not an enforcement decision. In audit-only mode it only
decides whether an audit record is worth writing and whether a later Codex
investigation lane should prioritize the comment.

## Safety

Current safety properties:

- no org block endpoint is called
- no comment hiding/deletion endpoint is called
- no target labels or replies are written
- full comment bodies are not required in durable state; records store a body
  hash plus a short excerpt
- processed comment versions are deduped, so edits are reviewed but unchanged
  comments are not reprocessed forever

Future blocking must be a separate apply step. It needs explicit org permission
`Blocking users: write`, maintainer/collaborator allowlisting, and audit records
that prove the exact comment and reason for each block.

## Operations

Run manually:

```bash
pnpm run build:repair
OPENAI_API_KEY=... pnpm run repair:spam-scan -- \
  --write-report \
  --repo openclaw/openclaw \
  --lookback-minutes 180 \
  --max-comments 100
```

Use exact comment ids for event replays:

```bash
pnpm run repair:spam-scan -- --write-report --repo openclaw/openclaw --comment-ids 123
pnpm run repair:spam-scan -- --write-report --repo openclaw/openclaw --review-comment-ids 456
```

Inspect latest generated state:

```bash
git -C ../clawsweeper-state fetch origin state
git -C ../clawsweeper-state show origin/state:results/spam-scanner-latest.json
git -C ../clawsweeper-state ls-tree -r --name-only origin/state results/spam-audit
```

Manual workflow dispatch:

```bash
gh workflow run spam-scanner.yml \
  --repo openclaw/clawsweeper \
  --ref main \
  -f target_repo=openclaw/openclaw \
  -f lookback_minutes=180 \
  -f max_comments=100 \
  -f model=gpt-instant \
  -f force_reprocess=false
```
