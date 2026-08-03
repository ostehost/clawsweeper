# Linear Sidecar Workflow

Status: maintained operator-run sidecar on current upstream ClawSweeper. It is not
a native tracker provider and does not participate in the GitHub review, apply,
repair, or automerge workflows.

The sidecar keeps the useful Linear workflow from the historical fork without
retaining the removed lifecycle implementation. `src/linear/` owns deterministic
mapping, classification, scope, policy, authorization, comments, repository
inference, and analysis helpers. `scripts/linear-*.mjs` owns the network and CLI
boundaries.

## Safety Contract

- All commands are dry-run or read-only by default.
- Snapshot and triage commands have no mutation path.
- Codex analysis uses a read-only sandbox and receives no GitHub or Linear write
  credential.
- The sidecar never closes a Linear issue or changes its workflow state or
  priority.
- A live comment requires `--apply`, `OPENCLAW_NOTIFY_LINEAR=1`, and reviewed
  plan and snapshot hashes from the current dry-run.
- Existing marker comments are reused only when their stable Linear bot actor ID
  matches `LINEAR_APP_ACTOR_ID`; display names are never treated as ownership.
- A live routing-label update additionally requires `--apply-labels` and its own
  reviewed hashes.
- Every live operation re-fetches the issue and blocks on snapshot drift.
- Label writes use read-merge-write and preserve labels not owned by this
  sidecar.
- Review comments are marker-backed and updated in place rather than stacked.

## Prerequisites

Use Node 24 or newer, install dependencies, and build before running a sidecar
command:

```bash
corepack enable
pnpm install
pnpm run build
```

Read access is resolved in this order:

1. `LINEAR_API_KEY`
2. `LINEAR_TOKEN`
3. macOS Keychain generic password, service `openclaw-linear-api-key`, account
   `partnerai-config`

Live comment or label writes mint a short-lived OAuth token from the macOS
Keychain services `openclaw-linear-clawsweeper-client-id` and
`openclaw-linear-clawsweeper-secret`. Do not pass those credentials on the
command line.

## Read-Only Workflow

Capture one team or the whole workspace:

```bash
pnpm linear:snapshot -- --team PAR --out .artifacts/linear-snapshot.json
pnpm linear:snapshot -- --out .artifacts/linear-workspace.json
```

A requested `--team` that matches no team is an error. This prevents an empty
snapshot from being reported as a successful triage.

Generate a deterministic review-only digest:

```bash
pnpm linear:triage:review -- \
  --snapshot .artifacts/linear-snapshot.json \
  --protected-label human-review
```

Or stream snapshot directly into triage:

```bash
pnpm linear:review -- --team PAR
```

The streamed form is convenient for inspection. Use a saved snapshot when the
output will be independently reviewed or used to establish apply approvals.

## Exact-Item Analysis

Inspect what an exact-item analysis would do without calling a model:

```bash
pnpm linear:analyze -- --identifier PAR-244 --json
```

Run the read-only model against the inferred local repository checkout:

```bash
pnpm linear:analyze -- --identifier PAR-244 --analyze --json
```

Analysis fails closed unless that checkout is clean, on `main`, and exactly at
the live canonical remote's `main` tip. Close-leaning advice additionally
requires at least one cited commit reachable from that revision. The Codex
subprocess receives neither Linear read tokens nor Linear OAuth credentials.

Repository inference fails closed when links and labels do not identify exactly
one supported repository. Model output is validated with ClawSweeper's current
decision schema, cited Git SHAs are re-verified by the host, and any close leaning
is advisory only. Analysis does not write to Linear.

## Review and Apply

First create and save a dry-run report for an exact issue, a list, a project, or
a team:

```bash
pnpm linear:review-apply:dry-run -- \
  --team PAR \
  > .artifacts/linear-par-dry-run.json
```

Review the proposed comment and label changes plus every `planHash` and
`snapshotHash`. The report can then serve as the approvals file for exactly that
reviewed state.

Apply only marker-backed review comments:

```bash
LINEAR_APP_ACTOR_ID=<linear-bot-actor-id> \
OPENCLAW_NOTIFY_LINEAR=1 pnpm linear:review-apply -- \
  --team PAR \
  --apply \
  --approvals .artifacts/linear-par-dry-run.json \
  --rate-ms 400 \
  --json
```

Because either mutation advances the Linear snapshot, comments and labels use
separate reviewed runs. After applying comments, generate and review a fresh
dry-run report, then apply only additive routing labels:

```bash
pnpm linear:review-apply:dry-run -- \
  --team PAR \
  > .artifacts/linear-par-label-dry-run.json

LINEAR_APP_ACTOR_ID=<linear-bot-actor-id> \
OPENCLAW_NOTIFY_LINEAR=1 pnpm linear:review-apply -- \
  --team PAR \
  --apply-labels \
  --approvals .artifacts/linear-par-label-dry-run.json \
  --rate-ms 400 \
  --json
```

The CLI rejects simultaneous live `--apply` and `--apply-labels` modes to avoid
performing one mutation and invalidating the approval for the other.

A changed issue, changed plan, missing approval, closed gate, ineligible item, or
ambiguous scope is skipped rather than written.

For a single comment, use `pnpm linear:comment:dry-run -- --identifier PAR-244`,
review and save that receipt, then pass it to `linear-comment-apply.mjs` with
`--apply --dry-run-receipt <path>` and the same environment gate.

## Scheduling

Scheduling belongs to the operator layer, not this repository's GitHub Actions.
A scheduler should invoke the committed snapshot and review-only triage commands,
require a final `TRIAGE_OK` or `TRIAGE_ALERT_SENT` sentinel, enforce a maximum run
age, and alert on missing delivery or Linear rate-limit failures.

`src/linear/trigger.ts` provides deterministic OpenClaw cron specifications and
expectation evaluation for that operator integration. Creating or updating the
actual cron remains an explicit deployment action.

## Boundaries

This integration intentionally does not add a `TrackerProvider`, Linear webhook,
Linear state machine, native Linear record store, or Linear automerge lane. Those
would create a second production control plane and should be considered only
after the sidecar has sustained operational evidence.
