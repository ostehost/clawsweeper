# ClawSweeper Vision

ClawSweeper is the conservative maintenance bot for OpenClaw repositories.

It keeps issue, pull request, commit, repair, and automerge work reviewable at
scale without turning agent output into uncontrolled write access. Its job is to
surface evidence, preserve state, propose narrow actions, and let maintainers
stay in control.

Project overview and operator docs: [`README.md`](README.md)
Agent and contributor rules: [`AGENTS.md`](AGENTS.md)
Generated public state: [openclaw/clawsweeper-state](https://github.com/openclaw/clawsweeper-state)

This document explains the current state and direction of the project. The
current hosted instance is for OpenClaw-operated repositories, with production
coverage centered on `openclaw/openclaw`, `openclaw/clawhub`, and self-review
for `openclaw/clawsweeper`.

## Goal

ClawSweeper should make OpenClaw maintenance safer, faster, and easier to audit.

A maintainer should be able to answer:

- what changed
- what was reviewed
- what proof exists
- what ClawSweeper proposes
- what ClawSweeper already did
- why it stopped
- what the maintainer or contributor should do next

The system should prefer a clear pause over a risky automatic action.

## Current Focus

Priority:

- P0: Maintainer and contributor workflow completion UX. A review, repair,
  apply, or automerge flow that cannot complete or leaves its user without a
  trustworthy status and next action is release-blocking.
- Correct, evidence-backed issue and PR reviews.
- Durable review comments edited in place instead of noisy repeated comments.
- Real behavior proof before PRs are marked proof-sufficient,
  maintainer-ready, or mergeable; proof-only blockers stay human-owned.
- Conservative apply rules that re-check live GitHub state immediately before mutation.
- Reliable durable state, live dashboard, queue, audit, and repair reporting.
- Smaller, testable scheduler, apply, repair, dashboard, and proof-gating units.
- Lower GitHub API load without changing maintainer-visible behavior.

Next priorities:

- Better maintainer decision surfaces.
- Better proof triage and proof nudge workflows.
- Stronger repair/automerge recovery when CI, comments, or target branches move.
- Clearer dashboard views for active lanes, stalled work, and safe next actions.
- More reusable policy modules with focused tests and live smoke proof.

## Principles

### 1. Proposal before mutation

Review lanes propose. Deterministic apply and repair lanes mutate only after
policy checks, live state refresh, and maintainer gates allow it.

### 2. Maintainer intent wins

Maintainer commands, protected labels, human-review labels, and explicit stops
must override automation. ClawSweeper should make maintainer choices visible,
not work around them.

### 3. Workflow UX is part of correctness

When ClawSweeper accepts a command or starts a workflow, its durable comment,
labels, state record, and dashboard must agree on the current state and next
safe action. Silent stalls, false success, ambiguous terminal states, and
errors without a recovery path are P0 release blockers. Automation may stop
when safety requires it, but it must stop visibly and guide recovery.

### 4. Evidence over volume

A smaller number of high-confidence reviews is better than a large number of
thin ones. Proof, source links, logs, CI state, and exact-head checks matter more
than throughput.

### 5. Models do not own GitHub mutations

Review models inspect and report. Repair models may edit, rebase, and validate a
local checkout, but model subprocesses do not receive GitHub write credentials.
Deterministic executor steps own comments, labels, branch pushes, closes, checks,
and merges.

Mantis is a proof worker, not a mutation worker. ClawSweeper may recommend it
for supported Telegram, Discord, or web UI chat reproduction and redacted
evidence capture, but never for code changes, CI fixes, branch updates, PR
repair, or GitHub mutations. Those remain in ClawSweeper's deterministic lanes.

### 6. Public state must be durable and safe

Durable records, dashboard output, labels, and comments are operational history.
They should be reproducible, link back to source records, and never expose
secrets, private artifacts, or unredacted security-sensitive details.

### 7. Models propose maintainer decisions; deterministic code enforces them

Models decide whether a maintainer choice exists and produce the question,
rationale, options, recommendation, and likely owner. Deterministic code
validates and persists that structured intent, refreshes live state, and blocks
unsafe or stale mutations. It must fail closed when required intent is missing
or malformed; it must not invent product judgment from hard-coded heuristics.

## Security

ClawSweeper is a maintenance automation tool, not the security response owner.
True vulnerability reports, leaked secrets, exploitability claims, and boundary
bypass reports must route to OpenClaw's
[`SECURITY.md`](https://github.com/openclaw/openclaw/blob/main/SECURITY.md)
handling instead of backlog cleanup or autonomous repair.

Security-sensitive review findings can pause, label, or request human handling.
They should not silently dispatch repair, close an item, or merge code without
explicit maintainer authorization and the normal exact-head review, validation,
and gate checks.

## State and Dashboards

`openclaw/clawsweeper-state` is the durable public state store and generated
dashboard surface. Its `state` branch stores records, jobs, results, audit
output, repair ledgers, run status, per-item reports, and the rendered
dashboard. Its `main` branch is the dashboard renderer source, not the generated
records source of truth.

The live Cloudflare dashboard is observability-first. It can show worker state,
queue pressure, CI snapshots, repair progress, and exact-review admission, but
GitHub mutations still belong to ClawSweeper workflows and deterministic
executor steps.

## Product Boundaries

ClawSweeper is not a generic public review service. The hosted OpenClaw instance
exists for OpenClaw-operated repositories and explicitly configured targets.

ClawSweeper is also not a replacement for maintainer judgment. It can review,
summarize, label, repair, and sometimes merge, but only through bounded lanes
with exact policy checks and visible evidence.

## Contribution Rules

- One PR = one topic or lane. Do not bundle unrelated scheduler, dashboard,
  repair, apply, and workflow changes.
- Prefer narrow modules with focused tests over broad rewrites of large files.
- Behavior-preserving refactors still need proof from the real lane they affect.
- Changes to report schemas, dashboard state, labels, comments, or hidden markers
  need fixtures or replay proof.
- Changes that affect mutation, credentials, merge gates, or security boundaries
  require explicit maintainer review.

## What We Will Not Merge For Now

- A generic hosted review service for third-party repositories.
- Model-driven GitHub writes without deterministic rechecks.
- Direct model-provider frameworks in ClawSweeper review or repair workers.
- PAT fallback paths for production mutations.
- Automatic closes for maintainer-authored items without verified
  implemented-on-main evidence.
- Automatic closes for items carrying other protected labels such as
  `security`, `beta-blocker`, or `release-blocker`.
- Broad rewrites of scheduler, apply, repair, dashboard, or state storage without
  a narrow proof path.
- A second dashboard or state mutation engine outside the approved ClawSweeper
  and clawsweeper-state boundaries.
- Silent public report, marker, or artifact schema churn.

This list is a roadmap guardrail, not a permanent rule.
Strong maintainer need and strong technical rationale can change it.
