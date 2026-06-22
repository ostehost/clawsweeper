# Linear Integration (Design)

This is a design document for planned work. Nothing described here has been
implemented or shipped yet. The goal is to let ClawSweeper triage and review all
Linear issues once weekly or on demand, preserving the same conservative doctrine
ClawSweeper already applies to GitHub issues and pull requests: proposal-only by
default, no mutations without concrete evidence, one durable marker-backed comment
per item, and safety gates that default closed.

## Doctrine

The Linear integration inherits ClawSweeper's core invariants without relaxation.

Read, write, propose. Never the other way round. Weekly runs default to
review-only: snapshot the board, produce a plan, run in dry-run mode — no apply.
The integration produces a proposal and stops there unless an operator has
explicitly pre-authorized a bounded mutation scope. Codex never holds write
credentials during a review run; only deterministic, post-plan scripts hold
short-lived tokens for any mutation step.

Safety gates default closed. Every write capability — state change, label update,
comment post — is independently gated and must be explicitly enabled. Disabling
one gate does not open another.

One durable, marker-backed comment per item, edited in place. The marker shape
is `<!-- clawsweeper-review:<n> -->`, matching the HTML marker convention
ClawSweeper already uses for GitHub items. A review run finds the existing
comment if present and edits it rather than stacking a new one. No comment is
posted at all unless the marker-keyed review-comment capability is explicitly
enabled.

Never close or change state without concrete evidence. A Linear issue may only
be proposed for closure when it meets ClawSweeper's existing decision taxonomy:
implemented on current main, unreproducible, duplicate with a canonical item,
incoherent, or stale beyond sixty days with insufficient data. Maintainer-authored
issues are never proposed for auto-close.

Label writes merge rather than replace. The Linear `issueUpdate` mutation replaces
the full `labelIds` array; the integration always reads existing label IDs,
computes the union with proposed additions, and writes that union. Labels are
never silently removed.

## Architecture — Two Paths

The implementation has a clear near-term starting point and a longer-term graduate
path. Both paths share the new pieces described in the next section; they differ
only in how ClawSweeper's existing lanes interact with Linear.

### Option B — Hub-Side (Start Here)

A new OpenClaw cron job running hub-side drives the existing receipt-gated Linear
skills — `linear-board-triage` and `openclaw-linear-intake` — through the
`snapshot → plan → review-only` sequence per team and project. The weekly run
emits a human-readable review report and, when the gated comment capability is
enabled, posts a single marker-backed Linear review comment per issue touched.

This path requires no changes to ClawSweeper's source. There is no new webhook
infrastructure; the cron job survives node reinstalls because it lives gateway-side
in OpenClaw, not in a local daemon. It inherits the existing doctrine without
forking any GitHub code. The two genuinely-new pieces — the auto-classifier and
the marker-keyed comment capability — are built once here and remain reusable
whether the integration stays hub-side or graduates to Option A.

Note: the hub-side scripts live in the OpenClaw config repo
(`~/projects/config/openclaw/scripts/`), not in this repository. This document
describes the design and the seam; the implementation artifacts belong there.

### Option A — TrackerProvider Seam (Graduate to This)

Introduce a `TrackerProvider` interface in `src/` that abstracts the inline
`gh`-CLI calls ClawSweeper currently makes throughout `src/clawsweeper.ts`.
The interface would expose the operations the rest of the code needs:
`listItems / getItem / upsertReviewComment(marker) / setLabels / setState /
setPriority / closeWithEvidence`. A `GithubProvider` wraps the current `gh`
calls behind that interface; a `LinearProvider` implements the same contract via
GraphQL, driving `linear_import.py`'s client for writes and adding a new
marker-keyed `commentCreate / commentUpdate` for the durable comment guarantee.
A parallel Linear-webhook ingress would emit the same dispatch payloads as
today's `repository_dispatch`, letting exact-event reviews arrive for Linear
issues through the same planner the GitHub lane already uses.

This is the right end-state for native lane and record parity: Linear issues
flowing through the exact same review, apply, and repair paths as GitHub items,
with `records/<workspace>/items/<id>.md` audit files and identical safety checks.
It touches the monolith — `src/clawsweeper.ts` is a 19,500-line file — and adds
a hosted webhook receiver, so it is appropriate only after the new pieces have
been proven in Option B.

**Recommendation:** ship Option B now to deliver weekly review value with minimal
risk. Refactor toward the `TrackerProvider` seam in Option A once the
auto-classifier and comment capability are in production and their behaviour is
understood.

## What Must Be Built (Child Work Items)

These are the genuinely new pieces both paths require. They correspond to the
child issues under Linear epic PAR-208.

**1. Auto-classification and review heuristic.** This is the central gap. The
existing `linear-board-triage` skill requires an operator-supplied `--selected`
list; nothing today scans all issues and decides which ones are ready, stale,
duplicate, or need a human review. The classifier should start from the eligibility
rules in `linear_conductor_snapshot.py` and apply ClawSweeper's existing decision
taxonomy from `schema/clawsweeper-decision.schema.json`: implemented /
unreproducible / duplicate / incoherent / stale-60d+ / keep-open-maintainer-authored.
The LLM judgment step should reuse the Codex review-worker pattern already
established in `src/codex-*.ts`, driving the same kind of prompt-plus-decision
record that the GitHub lane produces.

**2. Workspace-wide scope.** Both existing Linear skills are hardwired to a single
team and project. The integration needs to loop all teams and projects via the
`LinearClient`'s `list_teams` and `list_projects` methods, making the weekly sweep
genuinely workspace-wide rather than targeting a single named board.

**3. Marker-keyed review-comment capability.** The `linear-board-triage` skill
explicitly forbids comments. A new gated capability must add
`commentCreate / commentUpdate` via `linear_import.py`'s GraphQL client, keyed on
the `<!-- clawsweeper-review:<n> -->` marker to preserve the single-durable-comment
guarantee. This capability is independently gated and disabled by default.

The marker-backed review-comment upsert planner is now implemented in
`src/linear/comment.ts`. It produces a deterministic create/update/noop plan keyed
by the durable marker from `linearReviewMarker()`, detects and surfaces stale
duplicates, and computes a planHash that fingerprints only the write (not the
reasons) so re-plans that yield identical output stay hash-stable. The plan bridges
into the authority layer via `reviewCommentMutationRequest()`, which gates the
comment-upsert MutationKind behind the "comment" gate (default closed). Inert
GraphQL mutation strings (`COMMENT_CREATE_MUTATION`, `COMMENT_UPDATE_MUTATION`) are
exported for downstream consumption by the short-lived-token apply script — they are
never executed here.

**4. Unattended apply authority and receipt contract.** The default for weekly
runs is review-only: snapshot plus plan plus dry-run, no apply. Any real
mutation — state change, label write, comment post — requires a pre-authorized
scope and a drift-fingerprint receipt contract, matching how the existing skills
gate `apply` behind a `planHash` and `snapshotHash`. The contract must still
prohibit closing a Linear issue without concrete evidence matching the decision
taxonomy.

## Linear API Constraints

The Linear API is GraphQL only; there is no REST surface. Listing issues for
a weekly sweep uses an `updatedAt` filter — `issues(first: 250, orderBy: updatedAt,
filter: { team: { id: { eq } }, updatedAt: { gt: "<lastRun ISO>" } })` with
cursor pagination — so the sweep only processes what changed since the previous
run, keeping both request count and complexity budget low.

`labelIds` on `issueUpdate` is replace-all, not additive. Any label write must
read the existing label ID set, compute the union with the intended additions,
and write that union to avoid silently dropping labels. Workflow-state IDs and
label IDs are per-team UUIDs; resolve them once per run from `team.states` and
`team.labels`, then cache for the remainder of the run.

Rate limits are request-count and complexity based. The self-throttle signal is
an HTTP 400 with `extensions.code: "RATELIMITED"` — not an HTTP 429 — so the
backoff logic must check the response body, not just the status code, and back
off against the reset header. Read operations are cheap; mutations are the real
budget. Webhooks exist for real-time issue-create triggers but are optional; the
weekly batch relies on the `updatedAt` poll rather than a public webhook endpoint.
MCP tooling is available for interactive, read-only discovery but is not suitable
for deterministic batch sweeps requiring precise pagination and complexity control.

## Trigger Wiring

Weekly runs are driven by an OpenClaw cron job on the hub (user `ostemini`).
This keeps the schedule gateway-side so it survives node reinstalls, provides
built-in failure alerting, and keeps an audit trail in `openclaw cron runs`.
On-demand runs use the same cron entry via `openclaw cron run <id>`, callable
by a human or by another agent through the exec tool. This is the Linear-side
equivalent of ClawSweeper's `repository_dispatch` trigger for exact GitHub events.

Conventions from existing cron jobs apply: logic lives in a committed
`openclaw/scripts/*.mjs` file (the cron agent only routes and summarizes); an
`expectations.json` block specifies `deliveryStrict`, `semanticFailurePatterns`,
and `maxRunAgeMs`; runs end with a sentinel string such as `TRIAGE_OK` or
`TRIAGE_ALERT_SENT`. Paths in the cron message use `/Users/ostemini/...` (the
hub user path), not `/Users/ostehost/...`.

The deterministic trigger-wiring and run-expectations contract is now implemented
in `src/linear/trigger.ts`. `weeklyTriageCronSpec()` builds the OpenClaw cron spec
(the Monday-09:00 `America/Chicago` schedule, the `main` agent with `exec,message`
tools, a 600s timeout, and a message that routes to the committed review-only
runner and ends with the `TRIAGE_OK` / `TRIAGE_ALERT_SENT` sentinels); it rejects
a `/Users/ostehost/...` macbook-node path so the schedule never ships a path the
hub user cannot run. `onDemandTriggerHandle(id)` builds the `openclaw cron run`
handles for the same entry, the Linear-side equivalent of `repository_dispatch`.
`triageRunExpectations()` produces the `deliveryStrict` / `semanticFailurePatterns`
/ `maxRunAgeMs` contract, and `evaluateRunExpectations()` is a pure, clock-free
verdict over a run outcome — sentinel recognition, failure-pattern matching, and
freshness — so alerting stays deterministic.

## Open Decisions

Before any mutation scope is enabled, several questions need operator answers:

- **Scope.** Which Linear team or teams constitute "all issues"? The existing
  skills hardwire the `PAR` / "PartnerAI Board" team. The design calls for
  workspace-wide looping, but the initial sweep target needs a deliberate choice.

- **Auth identity.** Personal API key via macOS Keychain service
  `openclaw-linear-api-key` (simplest) versus OAuth `actor=app` so triage
  comments post as a named bot identity rather than a person's account.

- **Apply authority.** Keep weekly runs review-only indefinitely, or define a
  pre-authorized scope where ClawSweeper may auto-apply bounded state and label
  moves? Either way, closing a Linear issue without concrete evidence matching the
  decision taxonomy is never in scope.

- **Comment cadence.** Post a per-issue review comment, updated in place on
  subsequent runs, or emit a single weekly digest as a Linear issue, a Slack
  message, or a Discord notification?

## Guardrails

- Weekly runs do not apply mutations by default. The run exits after dry-run; no
  state is changed, no label is written, no comment is posted unless a gate is
  explicitly opened.
- No review comment is posted to a Linear issue unless the gated marker-keyed
  comment capability is explicitly enabled for that run.
- The integration never proposes closing a Linear issue without concrete evidence
  matching the decision taxonomy. Maintainer-authored issues are excluded.
- Label writes always read-merge-write the union. Labels are never silently removed
  by a partial `labelIds` write.
- MCP and discovery tooling operate read-only. They are never used for batch apply.
- Drift-fingerprint gates block apply if the live issue state has changed since
  the snapshot was taken, matching the existing `snapshotHash` / `planHash`
  contract in `linear-board-triage`.
- Codex never holds write credentials during a review run.

## Source Research

The full source-of-truth research, verified key paths, and build sequence are in
[`LINEAR-INTEGRATION-HANDOFF.md`](https://github.com/openclaw/clawsweeper/blob/main/LINEAR-INTEGRATION-HANDOFF.md).
