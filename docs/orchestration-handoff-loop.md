# ClawSweeper Orchestration Handoff Loop

Read when changing how ClawSweeper backlog items move from a Linear issue to a
committed change, who the orchestration acts as, or what a dispatched
implementation agent may and may not do during a turn.

This is the end-to-end loop that carries one ClawSweeper backlog item from a
Linear issue to a committed change with a pending-review receipt. ClawSweeper
dogfoods it on its own backlog: the same conservative doctrine it applies to
foreign GitHub items — read, write, propose; never the other way round — now
governs ClawSweeper's own work. This document was produced by running the loop on
issue PAR-244 / CSLIN-10.

## Dedicated ClawSweeper user

Orchestration acts as a dedicated ClawSweeper identity, never a maintainer's
personal account. The dedicated user owns the loop's outward attribution so
handoff receipts — and any future gated Linear review comment — read as
ClawSweeper, not as a person.

- Read-only sweeps resolve a personal-scope token from the macOS Keychain
  service `openclaw-linear-api-key` (env override `LINEAR_API_KEY` /
  `LINEAR_TOKEN`). The header is the raw token, no `Bearer` prefix.
- Outward posts — notifications today, and any future marker-keyed review
  comment — use the OAuth `actor=app` identity so they attribute to the bot, not
  the operator.
- This resolves the auth-identity open decision in
  [`linear-integration.md`](linear-integration.md) toward a dedicated bot
  identity. Until the gated comment capability is explicitly enabled, the
  dedicated user performs no Linear writes; the weekly lane stays review-only.

## The loop

| Stage | Owner | What happens |
| --- | --- | --- |
| Intake | OpenClaw / Symphony | A ClawSweeper backlog item (a `CSLIN-*` Linear issue) is selected and dispatched. A `task_id` correlates terminal, task registry, finalizer, and review output. |
| Implementation | Launcher-spawned agent | Works the launcher's branch/workspace, makes the smallest safe change, runs the documented checks, commits locally with a message naming the issue key. |
| Receipt | Launcher wrapper + finalizer | On normal process exit, the committed tree and the ephemeral `.oste-report.yaml` summary produce a pending-review receipt. |
| Status | OpenClaw / Symphony | Advances the Linear issue and writes the workroom receipt. The agent never does this itself. |

Completion is derived from process exit and receipt predicates, never
self-certified. The implementation agent exits the CLI once its artifact is
ready; the wrapper and finalizer close the loop.

## What the implementation agent owns

- The smallest safe code/docs/test change that satisfies the issue.
- Running the repo's documented checks before committing (`pnpm run check` for
  code/test/workflow changes; `node scripts/build-docs-site.mjs` to validate
  docs-only changes).
- One local commit on the launcher's branch, referencing the issue key, with a
  clean final `git status`.
- Evidence in the final receipt: HEAD SHA and subject, files changed, the exact
  commands run and their results, and any blocker.

## What the implementation agent must not do

- Push, publish, deploy, or contact external services beyond local tooling.
- Mutate Linear or Discord. Status and workroom receipts belong to
  OpenClaw / Symphony.
- Mark the task completed or hand-author lifecycle hints to trigger completion.
- Close or change a Linear issue's state without concrete evidence matching the
  decision taxonomy. Maintainer-authored issues are never auto-closed.

## Invariants

- Review-only by default. No mutation leaves the loop unless an operator has
  pre-authorized a bounded scope and a drift-fingerprint receipt gate is met.
- Deterministic code owns auth, repo boundaries, the dedicated identity, and the
  final receipt. Model judgment decides what to change, never whether the
  resulting handoff is allowed. See [`orchestration.md`](orchestration.md).
- The dispatcher stays thin: it triggers existing entrypoints and lets their
  concurrency, credentials, and gates own the work. See
  [`openclaw-dispatch.md`](openclaw-dispatch.md).
