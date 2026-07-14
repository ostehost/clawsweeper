# ClawSweeper Internal Feature Map

Read when: changing ClawSweeper automation, debugging a generated PR, wiring
comment commands, or deciding where a new lane belongs.

This document explains how the current ClawSweeper features fit together. It is
an internal maintainer map, not a runbook with secrets. Keep token values,
private key material, and one-off execution windows out of this file.

## Design Shape

ClawSweeper is a conservative, targeted automation layer for OpenClaw issue and
PR maintenance. It does not scan the whole backlog by itself. It takes a known
cluster, hydrates current GitHub state, asks Codex for a structured decision,
then lets deterministic scripts perform only the allowed no-publication writes.
Prepared code remains an exact hash-bound bundle for a future trusted publisher.

The core invariants:

- One cluster maps to one job file.
- One implementation path reserves one target branch:
  `clawsweeper/<cluster-id>`.
- One prepared bundle carries the metadata for at most one future PR.
- Codex workers do not get GitHub write tokens.
- Guarded comments and closeouts happen through deterministic scripts with
  live-state checks; prepared code is never pushed by the production workflow.
- Automated merge always fails closed at the atomic base-binding check.
- Security-sensitive work is out of scope and must be routed elsewhere.

## Main Objects

### Job File

Path: `jobs/<repo-slug>/inbox/*.md`

A job file is the durable request. It contains frontmatter for the repo,
cluster id, refs, mode, allowed actions, gates, and the maintainer prompt. It
is committed before dispatch because Actions reads the job file from GitHub.

Common creation paths:

- `pnpm run repair:create-job -- --repo openclaw/openclaw --refs 123 --prompt-file /tmp/prompt.md`
- `pnpm run repair:create-job -- --from-report ../clawsweeper/records/.../items/123.md`
- gitcrawl import scripts for larger clustered backlog batches
- `repair-cluster-intake.yml` for scheduled imported gitcrawl cluster drip-feed

`create-job` checks for an existing matching PR or branch before writing a new
job. That is the primary duplicate-PR guard.

### Cluster Plan

Path: `.clawsweeper-repair/runs/<run>/cluster-plan.json`

Created by `scripts/plan-cluster.ts`. It hydrates the listed GitHub refs,
linked refs, labels, bodies, comments, PR files, PR reviews, PR review
comments, checks, and current `main` state. The Codex worker receives this as
its live evidence bundle.

### Worker Result

Path: `.clawsweeper-repair/runs/<run>/result.json`

Created by `scripts/run-worker.ts` via `codex exec` using
`schema/repair/codex-result.schema.json`. The worker can recommend actions and fix
artifacts, but it must not mutate GitHub directly.

`scripts/review-results.ts` validates the result before any follow-up lane
trusts it.

Long Codex calls emit periodic `[clawsweeper repair] ... still running` log
lines from the wrapper process. This covers both the planning worker and
execute-side edit, review, and rebase-reconcile subprocesses,
so GitHub Actions does not kill otherwise healthy repair jobs for lack of output
before the debug artifact collection steps can run.

### Codex Debug Artifacts

Artifact names:

- `clawsweeper-codex-debug-cluster-<run-id>-<attempt>`
- `clawsweeper-codex-debug-execute-<run-id>-<attempt>`

The repair workflow snapshots recent Codex session JSONL files, Codex log files,
and ClawSweeper-captured `codex exec --json` outputs after both the planning job
and the fix execution job. Session/log files come from the job's isolated
run-scoped `CODEX_HOME`; the workflow never restores a Codex cache or reuses a
session across jobs or attempts. Local invocations may fall back to `~/.codex`.
Captured repair outputs come from
`.clawsweeper-repair/runs`.
The collector deliberately excludes Codex auth and config files, redacts common
OpenAI and GitHub token shapes, and writes a `manifest.json` with
source-relative paths, byte counts, mtimes, and SHA-256 hashes. These debug
artifacts are separate from the worker-transfer artifact, so the execute job
does not download raw session logs just to continue a repair.

### Fix Artifact

Path: `.clawsweeper-repair/runs/<run>/fix-artifact.json` and embedded result
fields.

A fix artifact tells the deterministic executor how to prepare local changes
intended for a contributor branch or ClawSweeper replacement branch. It
includes likely files, validation commands, credit notes, changelog
requirements, source PRs, and the planned future PR title/body.

### Published Ledger

Paths:

- `results/runs/*.json`
- `results/openclaw/*.md`
- `repair-apply-report.json`
- `docs/repair/README.md` dashboard sections

These are the sanitized durable record. Full prompts, transcripts, and raw run
artifacts stay in Actions artifacts or local `.clawsweeper-repair/runs`.

## Modes

### `plan`

Read-only recommendation mode. The worker classifies the cluster and returns
structured JSON. No GitHub writes should happen.

### `execute`

Structured-result application mode. It can apply reviewed safe comments and
closures through deterministic scripts when gates permit. It can validate and
record merge intent, but production merge always fails closed at strict base
binding.

### `autonomous`

Full targeted repair mode. ClawSweeper hydrates live state, asks Codex to produce
or refine a fix plan, then `execute-fix-artifact` prepares and validates the
exact branch or replacement-PR bundle. The production workflow defers that
publication; direct code mutation remains disabled.

## Cloud Worker Flow

Workflow: `.github/workflows/repair-cluster-worker.yml`

The cluster worker has three jobs:

1. `cluster`
   - checks out ClawSweeper
   - mints a read GitHub App token when configured
   - installs Codex
   - validates the job
   - hydrates the cluster
   - runs Codex in read-only mode
   - reviews the structured result
   - finalizes and uploads the exact current-attempt cluster action ledger
   - uploads transfer artifacts

2. `execute`
   - runs only for `execute` or `autonomous`
   - mints only exact-repository read access
   - downloads worker artifacts
   - runs `execute-fix-artifact --prepare-publication` under a dedicated,
     capability-free UID
   - kills and proves that UID empty, then stages only the exact bounded
     manifest and bundle (or an atomic empty pair for no-publication)
   - finalizes and uploads the exact current-attempt execute action ledger

3. `publish`
   - runs on a fixed trusted runner without Codex or target toolchains
   - checks out the immutable state commit and validates the exact transferred
     result, plan, base, tree, paths, lease, and bundle
   - retains prepared code as a hash-bound deferred publication with no target
     token or mutation
   - permits only guarded no-publication comment/closeout work with a narrow
     issues/pull-requests token
   - leaves automated merge disabled because the API cannot atomically bind
     the reviewed base branch
   - uploads final artifacts

The workflow concurrency group is based on job path and mode, so repeat
dispatches of the same job queue instead of racing each other.

Neither worker job receives state-repository write credentials solely for ledger publication. The trusted `repair-publish-results` workflow capability-detects the exact worker SHA, verifies every current run, attempt, job, and manifest, then imports the cluster and execute lanes with its own publication lane before durable result mutation. Legacy in-flight workers that did not advertise this topology remain compatible without synthetic receipts.

## Preparing Implementation Bundles

Script: `scripts/execute-fix-artifact.ts`

This is the branch/PR preparation engine. Its library routines can publish in a
separately trusted context, but the production target workflow deliberately
stops at a validated deferred bundle.

It can:

- prepare local changes intended for a maintainer-editable contributor branch
  when that path is safe
- prepare a replacement-branch bundle when the source branch is uneditable or
  unsafe
- fast-path adopted automerge base-sync preparation by rebasing and applying
  known mechanical conflict resolvers
- build the local `clawsweeper/<cluster-id>` target ref
- commit checkpoint changes locally after Codex edits
- run changed-surface validation
- run Codex `/review`
- address Codex review findings
- prepare the metadata needed to open or update the target PR
- post an idempotent adopted-automerge outcome comment when no executable fix
  artifact is available
- preserve contributor credit in co-author trailers, PR body, and closeout comments

The executor prepares a temporary checkout of the target repo. Codex edits that
checkout without GitHub write credentials, and the deterministic executor
commits and validates the reviewed tree locally. In the production Actions
workflow, the fresh publisher retains that commit as a deferred bundle instead
of pushing or opening a PR.

The same-branch post-push shepherd remains library support for a future trusted
publisher. The production target workflow does not reach it because prepared
code is deferred before any branch push. See
[`automerge-flow.md`](automerge-flow.md) for the intended future wait and repair
decision table.

When preparing a replacement for a meaningful contributor PR, the executor
fetches the source PR author, skips bot authors, adds `Co-authored-by` trailers
to replacement checkpoint commits, and records carried-forward credit in the
future PR body and planned source close comment.

Existing ClawSweeper PRs, and PRs created by a future trusted publisher, are
identified by:

- branch prefix: `clawsweeper/`
- committed repair job metadata for the branch cluster id

The `clawsweeper` label is a reporting hint from `scripts/tag-clawsweeper-targets.ts`,
not a PR identity boundary.

Post-publication operational gotcha: OpenClaw's PR queue policy can close PRs
when the ClawSweeper app author has more than 10 active PRs. That is a
target-repo policy interaction, not evidence that the generated PR is invalid.
A future trusted publisher must respect the active queue before opening or
reopening those PRs.

Replacement-bundle preparation also has a per-area backpressure guard. Before
finalizing a bundle for a new `clawsweeper/*` replacement branch,
`execute-fix-artifact` groups the proposed `likely_files` into touched areas
such as `extensions/discord`, `src/core`, or `docs`, reads open ClawSweeper PRs
in the target repo, and blocks if the same area already has
`CLAWSWEEPER_MAX_ACTIVE_PRS_PER_AREA` open ClawSweeper PRs. The default limit is
`50`; set it to `0` only for a deliberately uncapped preparation window.
Common changelog and release-note files are ignored for this backpressure check
because they are shared support files rather than a meaningful repair area.

## ClawSweeper Commit Findings

Workflow: `.github/workflows/repair-commit-finding-intake.yml`
Script: `scripts/commit-finding-intake.ts`

ClawSweeper can dispatch `clawsweeper_commit_finding` when a main-branch commit
review report has `result: findings`. ClawSweeper treats that report as a source
finding, not as an order to open a PR.

The intake step fetches one report from `openclaw/clawsweeper-state` at an exact state commit, verifies its SHA-256 and embedded repository/commit identity, writes one audit file, and then decides whether automatic repair-bundle preparation is allowed:

- audit path: `results/commit-findings/<repo-slug>/<sha>.md`
- job path: `jobs/<owner>/inbox/clawsweeper-commit-<repo-slug>-<shortsha>.md`
- branch: `clawsweeper/clawsweeper-commit-<repo-slug>-<shortsha>`

Non-finding, disabled, security/privacy/supply-chain, and broad findings stop
at the audit record. Eligible ordinary bug/regression/reliability findings get
a deterministic synthetic ClawSweeper result and fix artifact. The worker
handoff binds the published state commit and exact job digest so a later state
update cannot replace queued work. That skips the normal cluster-planning Codex
pass and sends the report straight to
`execute-fix-artifact`, where Codex is used for the repair loop against latest
target `main`. The executor handles trivial branch-refresh work before asking
Codex to edit: a clean rebase that changes only commit ancestry skips the edit
pass, and an isolated `CHANGELOG.md` rebase conflict is merged mechanically by
preserving both sides before validation continues. Generated config checksum
conflicts are also merged mechanically by keeping replayed checksum entries and
current-main entries that the replayed commit did not touch.

Commit-finding fix artifacts set `allow_no_pr: true`. If the repair loop
verifies the report but produces no target-repo diff, ClawSweeper records a clean
skipped no-PR outcome instead of failing the workflow.

The generated job uses `source: clawsweeper_commit` and may have no issue/PR
`candidates`. The fix artifact uses `repair_strategy: new_fix_pr`; merge and
close actions remain blocked.

The immutable worker handoff applies to every repair source, not only commit
findings. Cluster and issue intake, report-only requeues, failed-run self-heal,
open-PR finalization, and conflict self-heal resolve the exact state commit and
job SHA-256 before dispatch. The worker checks those bytes during planning and
again during execution authorization, then includes a sealed copy and identity
record with each result artifact. Result publication never reopens the mutable
job path to reconstruct provenance.

## Issue Implementation Commands

Maintainer comments can request one ClawSweeper implementation bundle for an
open issue with `/clawsweeper implement`, `@clawsweeper fix`,
`/clawsweeper build`, `@clawsweeper create pr`, or
`@clawsweeper fix issue`. Command names retain the intended PR vocabulary, but
production publication is deferred.

The comment router creates or reuses
`jobs/<owner>/inbox/issue-<owner>-<repo>-<number>.md` with
`source: issue_implementation` and target branch
`clawsweeper/issue-<owner>-<repo>-<number>`. The job records comment, label, fix,
and raise-PR intent, blocks close and merge, and tells the repair worker to
verify the issue against latest `main` before emitting
`repair_strategy: new_fix_pr`. The raise-PR intent becomes deferred metadata,
not a live PR mutation.

This lane is intentionally bundle-only in production: it does not push, open a
PR, merge, close the source issue, or convert broad/security-sensitive requests
into public branches. Reruns reuse the same job and intended branch identity so
repeated maintainer comments update one deferred bundle instead of creating
duplicate publication targets.

### Reviewed Reproducible Bug Intake

`repair-issue-implementation-intake.yml` is the automatic version of the issue
implementation lane. It is enabled only when
`CLAWSWEEPER_AUTO_IMPLEMENT_REPRO_BUGS=1`.

The review report must be a strict bug candidate:

- `type: issue`
- `decision: keep_open`
- `confidence: high`
- `work_candidate: queue_fix_pr`
- `work_confidence: high`
- `item_category: bug`
- `reproduction_status: reproduced`
- `reproduction_confidence: high`
- `requires_new_feature: false`
- `requires_new_config_option: false`
- `requires_product_decision: false`

The sibling vision-fit lane is enabled separately with
`CLAWSWEEPER_AUTO_IMPLEMENT_VISION_FIT=1`. It requires
`auto_implementation_candidate: vision_fit`, `vision_fit: aligned`,
`implementation_complexity: small`, high-confidence `queue_fix_pr` work, no
security/protected signal, no product-decision blocker, and complete VISION.md
evidence plus repair shape. This lane is for small VISION.md-aligned issue work;
medium or broad aligned work stays manual.

The intake re-fetches the live issue before writing a job. It skips protected,
security-sensitive, locked, closed, stale, or already-PR-attached issues, and it
also skips when the deterministic `clawsweeper/issue-<owner>-<repo>-<number>`
branch already has an open PR.

Eligible jobs reuse `source: issue_implementation`,
`trigger_source: review_reproducible_bug` or
`trigger_source: review_vision_fit`, and the deterministic issue implementation
branch. Strict-bug worker prompts are bug-only: reproduce first, fix broken
existing behavior only, and stop if implementation requires a feature, config
option, product decision, or broad design change. Vision-fit worker prompts
re-read `VISION.md`, keep the PR small, and stop when the work no longer fits
the vision guardrails. Future-publication metadata reserves
`clawsweeper:autogenerated` in addition to the normal `clawsweeper` tracking
label.

## Applying Comments And Closures

Script: `scripts/apply-result.ts`

This script owns safe no-publication GitHub mutations from reviewed worker
results. Prepared-publication mode does not invoke it with a target write token.

It re-fetches every live target before writing. It blocks when:

- the target changed since review
- the target is closed
- the target is maintainer-authored and not explicitly allowed
- the target is security-sensitive
- the job does not allow the action
- the action lacks required canonical/fix evidence
- merge preflight is incomplete

Close comments include idempotency markers so reruns do not post duplicates.

The schema retains merge evidence for audit and a future trusted publisher.
Even when all of the following are present, production merge fails closed at
the atomic base-binding check:

- job allows merge
- `allow_merge: true`
- `CLAWSWEEPER_ALLOW_MERGE=1`
- clean merge state
- clean relevant checks
- resolved human review threads
- resolved review-bot findings
- passed Codex `/review`
- validation evidence
- security clearance

ClawSweeper can label ready candidates for human review, but it never merges
them automatically.

## Post-Flight Finalization

Script: `scripts/post-flight.ts`

Post-flight can inspect existing PRs associated with prepared work. It validates
merge preflight and either labels the PR with human-review/merge-ready labels or
records the exact blocker. The production path never merges.

After a canonical fix lands through a human or other trusted publisher,
post-flight can apply planned post-merge closeouts
for duplicate or superseded items covered by that fix.

## Open PR Finalizer

Workflow: `.github/workflows/finalize-open-prs.yml`
Script: `scripts/finalize-open-prs.ts`

The finalizer scans open ClawSweeper PRs in the target repo. It finds PRs by the
`clawsweeper/*` branch prefix. It classifies blockers:

- draft
- stale/conflicting branch
- dirty or unknown merge state
- failing or pending checks
- unresolved review threads
- review required or changes requested
- missing merge preflight
- missing result backfill
- security hold

When `--dispatch-repairs --execute` is enabled, it dispatches the existing
cluster job back through `repair-cluster-worker.yml` instead of creating another PR.
The idempotency key includes target repo, PR number, and head SHA, so the same
PR/head is not repeatedly repaired unless `--allow-repeat` is used.

This is the lane to extend for richer CI self-repair. The next improvement is
to fetch compact failed-check logs, classify transient infra failures, rerun
clearly transient jobs, and pass branch-caused failures into the repair prompt.

## Self-Heal Failed ClawSweeper Runs

Workflow: `.github/workflows/repair-self-heal.yml`
Script: `src/repair/self-heal-failed-runs.ts`

Self-heal retries failed ClawSweeper cluster-worker runs. It reads published
`results/runs/*.json`, selects the latest failed run per source job, skips jobs
already retried unless `--allow-repeat` is set, and dispatches fresh worker
runs.

Important distinction: this heals failed ClawSweeper worker runs. It does not
currently inspect target PR CI logs. Target PR repair belongs in the open PR
finalizer/comment command repair path.

## Maintainer Comment Routing

Workflow: `.github/workflows/repair-comment-router.yml`
Scripts:

- `src/repair/comment-router.ts`
- `src/repair/comment-router-core.ts`

Comment routing scans recent target-repo issue/PR comments and accepts only
maintainer-authored commands. Default allowed GitHub `author_association`
values:

- `OWNER`
- `MEMBER`
- `COLLABORATOR`

Contributor comments are ignored without a reply.

The generated-PR auto-update design is documented in
[`docs/repair/auto-update-prs.md`](auto-update-prs.md). That lane lets trusted
ClawSweeper comments dispatch a repair run for an existing ClawSweeper PR or a
PR explicitly opted into `clawsweeper:automerge` without allowing arbitrary
comment authors to trigger work.

Accepted command styles:

```text
/clawsweeper status
@clawsweeper status
@openclaw-clawsweeper status
@openclaw-clawsweeper[bot] status
```

Accepted mentions are `@clawsweeper`, `@clawsweeper[bot]`,
`@openclaw-clawsweeper`, and `@openclaw-clawsweeper[bot]`.

Supported commands:

```text
/review
/clawsweeper status
/clawsweeper re-review
/clawsweeper re-run
/clawsweeper fix ci
/clawsweeper address review
/clawsweeper rebase
/clawsweeper autofix
/clawsweeper automerge
/clawsweeper approve
/clawsweeper explain
/clawsweeper stop
@clawsweeper re-review
@clawsweeper re-run
@clawsweeper review
@openclaw-clawsweeper fix ci
@clawsweeper why did automerge stop here?
```

Behavior:

- `status` and `explain`: post a short status response.
- `review`, `re-review`, and `re-run`: dispatch ClawSweeper review again for an
  open issue or PR. Authors may use only these read-only review commands on
  their own open item; maintainer permission remains required for write actions.
- Freeform `@clawsweeper ...` maintainer mentions: dispatch a read-only assist
  review with the mention text as one-off instructions. The model can answer or
  recommend existing structured safe actions, but cannot directly merge, close,
  label, or push code.
- `fix ci`: dispatch the existing ClawSweeper PR's job for repair.
- `address review`: dispatch the existing ClawSweeper PR's job for repair.
- `rebase`: dispatch the existing ClawSweeper PR's job for repair.
- `autofix`: label any open PR with `clawsweeper:autofix`, create an adopted
  job if needed, and dispatch a ClawSweeper review for the current head without
  allowing merge.
- `automerge`: label any open PR with `clawsweeper:automerge`, create an
  adopted job if needed, and dispatch a ClawSweeper review for the current
  head.
- `approve`: maintainer-only exact-head approval after human review; clears
  eligible pause labels and reruns readiness checks, but automated merge remains
  blocked at strict base binding.
- `stop`: label the item for human review.

Repair commands apply to existing ClawSweeper PRs and PRs opted into
`clawsweeper:autofix` or `clawsweeper:automerge`. The router finds ClawSweeper PRs by the
`clawsweeper/*` branch, resolves or creates the backing job, posts one
idempotent response marker, and dispatches `repair-cluster-worker.yml`.

Trusted ClawSweeper comments become `clawsweeper_auto_repair`. Preferred
comments use hidden `clawsweeper-verdict:*` markers and include
`clawsweeper-action:fix-required` only when ClawSweeper should wake up. For PRs
already opted into `clawsweeper:autofix` or `clawsweeper:automerge`, trusted
`needs-human` and `human-review` verdicts pause the loop with
`clawsweeper:human-review`. Repair dispatch requires an accepted repair verdict
or action marker. The default caps are ten automatic repair iterations per PR
and one dispatch per PR head SHA. The per-PR cap is total across head SHA
changes, so repeated findings on the same commit do not stampede the branch and
a single PR cannot loop forever.

For PRs labeled `clawsweeper:autofix` or `clawsweeper:automerge`, trusted
ClawSweeper `pass`, `approved`, or `no-changes` verdict markers become
`clawsweeper_auto_merge` intent. Autofix can wait for required checks to appear,
settle green, and reach GitHub merge-state readiness, then treat that marker as
terminal success and leave the PR open. Automerge records readiness only when
the marker SHA matches the current PR head, checks are green, GitHub
mergeability is clean, no human-review label is present, the PR is not draft,
and `CLAWSWEEPER_ALLOW_MERGE=1` is set. Strict atomic base binding still blocks
the merge itself. The `clawsweeper:automerge` opt-in is authorization metadata,
not sufficient publication or merge authority. Ready PRs remain open for human
review.

The scheduled workflow is dry by default. Set
`CLAWSWEEPER_COMMENT_ROUTER_EXECUTE=1` to let scheduled runs post replies and
dispatch workers. Manual workflow dispatch can also pass `execute=true`.
Repair-bundle preparation still requires the downstream
`CLAWSWEEPER_ALLOW_EXECUTE=1` and `CLAWSWEEPER_ALLOW_FIX_PR=1` gates; those gates
do not grant branch mutation authority.

Ledgers:

- `results/comment-router.json`: processed command ledger
- `results/comment-router-latest.json`: latest scan report

Command replies are marker-backed and edited in place per item, intent, and
head SHA. Repeated maintainer nudges update the same small status comment
instead of leaving duplicate crustacean notes.

## Label Backfill

Script: `scripts/tag-clawsweeper-targets.ts`

This script labels ClawSweeper-created or ClawSweeper-tracked PRs/issues in the
target repo. It helps downstream tools and maintainers distinguish generated
work from ordinary contributor work.

The exact label is `clawsweeper`. The script intentionally refuses alternate
label names to keep the marker stable. Live GitHub reads and label mutations use
the retrying `gh` helpers so transient GitHub 502/503/504 responses do not fail
an otherwise completed worker run. The worker workflow also treats this tagging
step as non-blocking metadata; durable repair/apply results remain the source of
truth.

## Job Hygiene

Scripts:

- `scripts/sweep-openclaw-jobs.ts`
- `scripts/promote-stuck-jobs.ts`
- `scripts/requeue-job.ts`

These scripts manage the ClawSweeper backlog:

- move finalized jobs out of inbox
- park old or never-run jobs in outbox/stuck
- promote parked jobs back into inbox
- resolve a run id or job path and requeue it

They should not create new implementation PRs by themselves. They control job
inventory and dispatch pressure. Source-head drift records
`requeue_required: true` and stops; only this trusted external tooling or an
operator starts the fresh run. The worker never requeues itself.

## Dashboard Publishing

Workflow: `.github/workflows/publish-results.yml`
Script: `scripts/publish-result.ts`

Publishing turns raw run artifacts into durable, sanitized summaries. It updates
the README dashboard, per-cluster markdown reports, and aggregate JSON ledgers.

The README dashboard is the public status surface, but it is derived from the
latest published artifacts. For live truth, check GitHub Actions and the target
PR directly.

## Gates And Variables

Important gates:

- `CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED`: opt-in for the scheduled
  `repair-cluster-intake.yml` imported-cluster intake. Direct repair import and
  dispatch commands are not blocked by this variable; they keep the existing
  repair execution gates. Gitcrawl cluster import skips clusters with at least
  75% closed members by default; `--skip-closed-percent` is the explicit
  override.
- `CLAWSWEEPER_CLUSTER_REPAIR_IMPORT_LIMIT`: scheduled imported-cluster intake
  limit; default `1` cluster per daily `repair-cluster-intake.yml` run.
  The upstream `openclaw/gitcrawl-store` refreshes `openclaw/openclaw` every 15
  minutes, so the intake records the processed portable DB SHA in
  `results/cluster-repair-intake/<repo>.json` and skips duplicate ticks against
  the same store snapshot.
- `CLAWSWEEPER_ALLOW_EXECUTE`: allows deterministic write lanes. Workflows treat
  any value except literal `1` as closed.
- `CLAWSWEEPER_ALLOW_FIX_PR`: allows isolated branch/PR preparation and immutable
  bundle validation. Workflows treat any value except literal `1` as closed;
  production publication remains deferred.
- `CLAWSWEEPER_ALLOW_MERGE`: records merge authorization. Strict base binding
  still blocks automated merge even when a maintainer explicitly opens it.
- `CLAWSWEEPER_COMMENT_ROUTER_EXECUTE`: lets scheduled comment routing post
  replies and dispatch workers.

Important defaults:

- `CLAWSWEEPER_MODEL`: GitHub Actions secret containing the actual worker model.
  Public workflow inputs and generated state use only `internal`; the public
  `model` input is a deprecated no-op retained for caller compatibility.
- `CLAWSWEEPER_CODEX_REASONING_EFFORT`: model reasoning effort. Repair workers
  default to `high` and normalize accidental `xhigh` overrides back to `high`
  to keep automerge repair latency predictable.
- `CLAWSWEEPER_CODEX_SERVICE_TIER`: Codex service tier. Repair workers default
  to `fast`.
- `CLAWSWEEPER_CODEX_LOGIN_METHOD`: Codex login mode for local runs. Defaults
  to `api`; set `chatgpt` to preserve an existing Codex OAuth session. Any other
  non-empty value fails before Codex starts.
- Workflow Codex state is run-scoped: each invocation receives a fresh
  `CODEX_HOME`, and no Actions cache or prior session is restored across jobs or
  attempts.
- `CLAWSWEEPER_CODEX_HEARTBEAT_MS`: repair-worker and execute-side Codex
  subprocess heartbeat interval; default `60000`.
- `CODEX_BIN`: optional Codex executable override. Native Windows runs resolve
  npm-installed `codex.cmd` launchers through an escaped `cmd.exe` invocation;
  native executables and Unix runs keep direct process spawning.
- `CLAWSWEEPER_MAX_LIVE_WORKERS`: dispatch capacity guard. Existing repair
  lanes derive their checked-in default from `workers.max`; imported gitcrawl
  cluster jobs use `lanes.repair.cluster_max_live_runs`.
- `CLAWSWEEPER_DISPATCH_RECHECK_MS`: short active-worker recheck before
  dispatching a repair worker; default `5000` to avoid duplicate queued workers
  when parallel routers race GitHub run visibility.
- In-flight repair preparation re-fetches live PR labels immediately before
  finalizing the bundle and stops when `clawsweeper:human-review` is present.
  This makes trusted needs-human verdicts and maintainer stop commands win over
  stale already-queued repair workers without attempting a push.
- `CLAWSWEEPER_MAX_ACTIVE_PRS_PER_AREA`: replacement PR area backpressure; default
  is `50` open ClawSweeper PRs per touched area, and `0` disables the cap.
- ClawSweeper commit-finding repair PRs get the `clawsweeper:commit-finding`
  label in addition to the standard `clawsweeper` tracking label.
- `CLAWSWEEPER_TARGET_VALIDATION_MODE`: changed-only validation by default.
- `CLAWSWEEPER_RESOLVE_REVIEW_THREADS`: reserved for a trusted publication lane;
  current bundle preparation records addressed-thread evidence without mutating
  review threads.

## Where To Add New Behavior

- New issue/PR-to-PR entrypoint: extend `create-job` or add an importer that
  writes the same job schema.
- Better CI self-repair: extend `finalize-open-prs` to collect failed check
  logs and classify rerun vs repair.
- New maintainer command: extend `comment-router-core.ts` parsing and
  `comment-router.ts` execution.
- New mutation type: add schema support, worker prompt policy, result review
  validation, and deterministic application in `apply-result`.
- New dashboard field: publish it from `publish-result`, not from ad hoc README
  edits.

## Safety Checklist For Changes

Before shipping automation changes:

```bash
pnpm run repair:validate
pnpm run check
actionlint .github/workflows/<changed-workflow>.yml
git diff --check
```

For live lanes, dry-run first when available:

```bash
pnpm run repair:comment-router -- --repo openclaw/openclaw --lookback-minutes 180
pnpm run repair:finalize-open-prs -- --write-report
pnpm run repair:tag-clawsweeper -- --live
```

Do not treat a dry report as permission to mutate. A maintainer still needs to
open the relevant execution gate or run the workflow with `execute=true`.
