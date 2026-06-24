---
name: clawsweeper-single-item
description: "Run ClawSweeper's full review pipeline on one Linear item by identifier: dry-run review by default; gated live comment posted as the ClawSweeper app identity."
metadata:
  version: "2026-06-23"
---

# ClawSweeper — single-item review/comment

Use when asked to run ClawSweeper for **one** Linear item — e.g. "run clawsweeper
on PAR-123", a single-item review/triage, or leaving a ClawSweeper review comment
on one issue. For the whole board use the bulk review path (see Related).

Entrypoint: `scripts/linear-comment-apply.mjs` (this repo). Build first if `dist/`
is stale (`pnpm run build`; tsgo — scripts import `../dist/linear`).

## Quick start

```sh
# DRY-RUN (default; read-only; writes nothing; mints no token):
node scripts/linear-comment-apply.mjs --identifier PAR-XXX --json
# alias: pnpm run linear:comment:dry-run -- --identifier PAR-XXX

# LIVE (leaves a marker-backed comment as the ClawSweeper app identity):
OPENCLAW_NOTIFY_LINEAR=1 node scripts/linear-comment-apply.mjs --identifier PAR-XXX --apply
```

## Always dry-run first

Read the dry-run JSON before any `--apply`:

- `action` — `create` | `update` | `noop` (marker-backed upsert; idempotent).
- `disposition` — if `closed`/skipped the body is a "state is closed — skipped"
  note; confirm you actually want to post that (see Caveats).
- `authorized` must be `true`; `body` is exactly what will be posted.

## Live-write gate (ALL THREE required)

A comment is written only when every condition holds — otherwise it stays dry:

1. `--apply` flag, AND
2. env `OPENCLAW_NOTIFY_LINEAR=1`, AND
3. `authorizeMutation().allowed === true` (`src/linear/authority.ts`:
   snapshotHash == live, planHash == approved, comment gate open).

A stray `--apply` without the env stays dry-run. No OAuth token is minted unless
a live write actually fires.

## Pipeline

`fetchIssueByIdentifier` → `mapWorkspaceItem` → `classifyRecord` →
`planReviewCommentUpsert` (marker `<!-- clawsweeper-review:<issueUUID> -->`) →
`authorizeMutation` → `commentCreate`/`commentUpdate`. Re-running is safe: same
body ⇒ `noop`, changed ⇒ `update`, absent ⇒ `create`. One durable marker comment
per issue.

## Credentials (macOS Keychain, account `partnerai-config`)

- READ: service `openclaw-linear-api-key` (personal key, raw `Authorization`
  header, auto-resolved — no `LINEAR_API_KEY` env needed).
- WRITE: ClawSweeper OAuth app `client_credentials` from services
  `openclaw-linear-clawsweeper-client-id` + `openclaw-linear-clawsweeper-secret`,
  minted to a `Bearer` token only at write time.
- Never log or echo secrets/tokens.

## Identity

Comments author as the dedicated Linear app user **ClawSweeper** (OAuth
`actor=app`, non-billable) — not a human. The write transport sends
`Authorization: Bearer <minted-token>`; the read path stays raw-token.

## Verify after a live write

Query the issue's comments and confirm one carries the marker and
`comment.user.name == "ClawSweeper"`. The script also prints the apply result.

## Caveats / safety

- Production stays **review-only**: leave `OPENCLAW_NOTIFY_LINEAR` unset outside
  an explicit test. The weekly triage job runs `snapshot | triage --review-only`
  and never writes.
- The current build still posts a comment on **closed/skipped** items — prefer
  not writing to closed issues; gate on `disposition` from the dry-run before
  `--apply`.
- Bulk writes need the separate mutation-authority gate + operator approval; this
  skill is the single-item path only.

## Related

- Bulk read-only review:
  `node scripts/linear-snapshot.mjs | node scripts/linear-triage.mjs --review-only --json`.
- `src/linear/comment.ts` (planner), `src/linear/authority.ts` (gate),
  `src/linear/client.ts` (transport + `mintLinearAppToken`).
