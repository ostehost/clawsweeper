# Handoff — ClawSweeper × Linear: weekly / on-demand issue triage & review

**Prepared:** 2026-06-18 · **For:** the main OpenClaw agent (hub, user `ostemini`)
**Status:** research complete, scaffolding done, ready to implement. **No code changed yet.**

---

## 0. What you're picking up

Goal: make **ClawSweeper** (today a GitHub-only conservative maintenance bot) able to **triage and review all Linear issues, once weekly or on demand** — preserving ClawSweeper's doctrine ("Read, write, propose. Never the other way round.", no-close-without-evidence, marker-backed single comment, gates default closed).

A 4-agent research round produced the design below. The findings are grounded in the **actual ClawSweeper source** (now checked out — see §1) and OpenClaw's existing Linear tooling.

---

## 1. Scaffolding already done (non-negotiable setup — complete)

- ✅ **Cloned the ClawSweeper source** (was NOT on this machine; it was the single biggest research blocker):
  `~/projects/clawsweeper` ← `github.com/openclaw/clawsweeper` (PUBLIC, branch `main`, `@openclaw/clawsweeper`, TS/pnpm).
  Its own description already states the target behavior: *"scans all issues and PRs and suggest what we can close, and why. It runs every PR / Issue once a week."*
- ✅ This handoff lives at `~/projects/clawsweeper/LINEAR-INTEGRATION-HANDOFF.md` (untracked; clean working tree, deliberately **not** placed in `~/projects/config` which is mid-branch with unrelated uncommitted edits + subject to the node dirty-tree sweep).

**You still need to do:** create a feature branch before any edits — `git -C ~/projects/clawsweeper checkout -b feat/linear-provider`. Commit early/often (see §7 dirty-tree warning).

---

## 2. Ground truth: ClawSweeper's current shape (verified from source)

| Aspect | Reality (file paths are real) |
|---|---|
| **Core** | `src/clawsweeper.ts` — a single ~19,500-line monolith. Entrypoints: `node dist/clawsweeper.js review\|plan\|status` (pnpm scripts `review`/`plan`/`status`); commit lane `dist/commit-sweeper.js`. |
| **GitHub I/O** | **No provider/tracker abstraction exists** (`grep -rE 'interface (Tracker\|Provider\|IssueSource\|Forge)' src` → empty). All reads/writes shell out to the **`gh` CLI inline**. `src/github-json.ts` (31 lines) only *parses* `gh` JSON; `src/github-retry.ts` (99 lines) wraps retry/backoff. Repair-lane GitHub writes live in `src/repair/*-github.ts`. |
| **Lanes** | Event-driven via GitHub `repository_dispatch` + scheduled scans. README:19/48 — *"reviews open issues and pull requests on a schedule and on exact GitHub events; scheduled runs scan open issues and PRs, while target repos forward exact issue/PR events with `repository_dispatch` for low-latency."* Dispatcher (in `openclaw/openclaw`): `.github/workflows/clawsweeper-dispatch.yml`. |
| **Decision contract** | `schema/clawsweeper-decision.schema.json` — per-item decision record. Audit records: `records/<repo>/items/<n>.md`, `records/<repo>/closed/<n>.md`, `records/<repo>/commits/<sha>.md`. |
| **Comment model** | One durable, marker-backed comment per item (HTML marker `<!-- clawsweeper-... -->`), edited in place — never stacked. |
| **Safety gates** | Env vars `CLAWSWEEPER_ALLOW_EXECUTE / _ALLOW_FIX_PR / _ALLOW_MERGE / _ALLOW_AUTOMERGE / _COMMENT_ROUTER_EXECUTE` — write lanes are no-ops unless explicitly opened. Workers run with stripped secrets; only deterministic scripts hold short-lived tokens. |
| **Auth** | GitHub App `clawsweeper` (client ID `Iv23liOECG0slfuhz093`), private key from secret, minted as short-lived scoped tokens per step. |

---

## 3. OpenClaw already built ~70% of the Linear write side — REUSE IT, don't reinvent

Two production-grade, receipt-gated Linear skills already exist in the config repo. **The Linear provider should drive these, not hand-roll new Linear writes.**

- **`~/projects/config/openclaw/skills/linear-board-triage/`** — the centerpiece. 6-phase state machine: `snapshot → plan → ensure-labels → dry-run → apply → read-back`. `scripts/linear_board_triage.py` (~1158 lines) holds a `LinearClient` (pagination, rate-limit/retry, secret redaction). Tiny mutation surface (`issueUpdate` stateId+labelIds only; comment/create/priority hard-disabled by `MUTATION_POLICY`). **Drift-fingerprint gate**: any live state/label change since snapshot blocks `apply`. Schemas `linear_board_triage_snapshot_v1` / `_plan_v1` with `snapshotHash`/`planHash`. **Limitation: selection is operator-supplied (`--selected PAR-85 …`) — there is no auto-classifier.**
- **`~/projects/config/openclaw/skills/openclaw-linear-intake/`** — creation counterpart. `scripts/linear_import.py` (~1078 lines): direct Linear GraphQL via stdlib `urllib` to `https://api.linear.app/graphql`; mutations `issueCreate/issueUpdate/issueRelationCreate/issueLabelCreate`; same dry-run-receipt + `planHash` gate; idempotent `[KEY]`-title lookup. **This is the de-facto Linear provider write side.**
- **`~/projects/config/openclaw/conductor/linear_conductor_snapshot.py`** — read-only eligibility review (rules: `ACTIVE_STATES`, `REQUIRED_LABELS={ready-for-agent}`, exclusion labels). Good basis for the "review all issues" report half.
- **Auth (reuse):** macOS Keychain service `openclaw-linear-api-key`, account `partnerai-config` (env override `LINEAR_API_KEY`/`LINEAR_TOKEN`). Header is the **raw token, no `Bearer`**.
- **Outbound notifier (reuse for alerts):** `~/projects/config/openclaw/scripts/notify-linear.mjs` (OAuth `actor=app`, dedupes, DLQ at `~/.openclaw/linear/pending.jsonl`).
- **Roadmap context:** `~/projects/config/openclaw/runbooks/openclaw-linear-native-roadmap.md` — Phase 1 (incident notifier) done; Phase 2 (inbound webhook) designed-not-built; Phase 3 (`@OpenClaw` mention/AgentSession) not ready. **None of it covers scheduled board triage — that's this work.**

---

## 4. Linear API constraints that shape the build (verified vs linear.app/developers)

- **GraphQL only.** List/page: `issues(first: 250, orderBy: updatedAt, filter: { team:{id:{eq}}, updatedAt:{gt: "<lastRun ISO>"} })` + cursor loop (`pageInfo.hasNextPage/endCursor`). The `updatedAt` filter is what makes "review all issues weekly" cheap — only touch what changed.
- **`labelIds` on `issueUpdate` is REPLACE-ALL, not additive** — read existing IDs, merge, write the union, or you wipe labels. (Existing skills handle this — another reason to drive them.)
- **IDs are UUIDs; workflow-state IDs are per-team.** Resolve `team.states{id,name,type}` and label name→ID maps once per run and cache. `type` ∈ `backlog/unstarted/started/completed/canceled` is stable; names/IDs are not.
- **Priority** is int: `0` none, `1` urgent, `2` high, `3` medium, `4` low.
- **Rate limit (API key): 2,500 req/hr; 3M complexity/hr; ≤10k complexity per query.** Reads are trivial (~40 pages/10k issues); **mutations are the budget** (1 req each). Self-throttle on `X-RateLimit-Requests-Remaining`; throttle error is **HTTP 400** with `extensions.code:"RATELIMITED"` (not 429) — exponential backoff off the reset header.
- **Webhooks** exist (HMAC-SHA256, `Linear-Signature`, ~1-min timestamp window) — for real-time triggers. **For the weekly batch, poll with `updatedAt`** (no public endpoint needed). Optionally add an Issue-create webhook later for instant new-issue triage.
- **Official MCP server** `https://mcp.linear.app/mcp` (OAuth 2.1 / Bearer) and **Linear Agents** (`actor=app`, `app:assignable`/`app:mentionable`) exist — good for *interactive/on-demand* triage in an LLM client, but **raw GraphQL/SDK is better for the deterministic batch sweep** (no bulk MCP op; precise pagination/complexity control). Doctrine in the existing skills: **MCP is read-only-discovery only, never batch apply.**

---

## 5. The integration design — two paths

### Option B — hub-side "ClawSweeper for Linear" (START HERE)
A new **OpenClaw cron job** (hub-side) drives the **existing Linear skills** in `snapshot → plan → review-only` per team/project, emitting a weekly review report + (gated) a marker-backed Linear review comment. No webhook infra; survives `node install --force`; inherits ClawSweeper doctrine without forking its GitHub code. Lets you build the two genuinely-new pieces (§6) once.

### Option A — extend ClawSweeper proper (graduate to this)
Introduce a **`TrackerProvider` interface** in `src/` abstracting the `gh`-CLI calls (`listItems / getItem / upsertReviewComment(marker) / setLabels / setState / setPriority / closeWithEvidence`), implement `GithubProvider` (wrap today's `gh` calls) + `LinearProvider` (wrap `linear_import.py`'s GraphQL client + a new marker-keyed `commentCreate/commentUpdate`), and add a **parallel Linear-webhook ingress** emitting the same dispatch payloads. Right end-state for Linear issues flowing through ClawSweeper's exact lanes/records, but touches the monolith and adds a hosted receiver.

**Recommendation:** ship Option B for the weekly review value now; refactor toward Option A's `TrackerProvider` once the classifier + comment capability (§6) are proven. The new pieces are identical either way.

---

## 6. What must be BUILT (true for both paths — these are the real work)

1. **Auto-classification / review heuristic** — THE central gap. `linear-board-triage` needs a human `--selected`; nothing scans all issues and decides ready/stale/duplicate/needs-review. Start from `linear_conductor_snapshot.py` eligibility rules + ClawSweeper's existing decision taxonomy (`schema/clawsweeper-decision.schema.json`: implemented / unreproducible / duplicate / incoherent / stale-60d+ / keep-open-maintainer-authored). Reuse the Codex review worker pattern (`src/codex-*.ts`) for the LLM judgment.
2. **Workspace-wide scope** — both skills are single team+project (`PAR`). Loop teams/projects (`LinearClient` already has `list_teams`/`list_projects`).
3. **A "review" (comment) capability** — board-triage *forbids* comments. Add a gated, marker-keyed (`<!-- clawsweeper-review:<n> -->`) `commentCreate/commentUpdate` via `linear_import.py`'s client, preserving the single-durable-comment guarantee.
4. **Unattended apply authority** — every existing mutation path requires a *fresh operator approval*. **Default weekly runs to review-only** (snapshot + plan + dry-run, NO apply) — safest and doctrine-compliant. Gate any real mutation behind a pre-authorized scope/receipt contract.

---

## 7. Trigger wiring (recommended, concrete)

**Weekly → OpenClaw cron (hub-side), not launchd.** It's an agent turn (fits LLM triage), survives `node install --force` (cron is gateway-side), has built-in failure-alerting + audit (`openclaw cron runs --id <id>`), and weekly cadence is negligible cost.
```sh
openclaw cron add --name "Linear weekly triage" \
  --cron "0 9 * * 1" --tz America/Chicago \
  --agent main --tools exec,message --timeout-seconds 600 \
  --message "Weekly Linear triage. Run: node /Users/ostemini/projects/config/openclaw/scripts/<triage>.mjs --review-only --json. Summarize; end with TRIAGE_OK or TRIAGE_ALERT_SENT."
```
**On-demand → the same entry:** `openclaw cron run <id>` ( `--wait` / `--expect-final` to block). Callable by a human or by another agent via the exec tool. This is the local-hub equivalent of ClawSweeper's `repository_dispatch`.

**Conventions to match** (from live cron jobs + `~/projects/config/openclaw/cron/expectations.json`): logic in a committed `openclaw/scripts/*.mjs` (the agent only routes/summarizes); add an `expectations.json` block (`deliveryStrict`, `semanticFailurePatterns`, `maxRunAgeMs`); end with a sentinel string. **Path/user split:** cron runs as hub user **`ostemini`** → use `/Users/ostemini/...` paths (NOT `/Users/ostehost/...`, which is this MacBook node).

⚠️ **Dirty-tree sweep (real):** a node automation periodically commits any uncommitted `~/projects/config` tree onto `wip/*-dirty-<ts>` and resets `main`. `~/projects/config` is *already* dirty on `fix/linear-intake-multidash-dependency-resolution` with unrelated edits. **Commit your new script + `expectations.json` block promptly on a feature branch;** if edits vanish, recover from `wip/*` / `git reflog`, don't redo blind.

---

## 8. Suggested build sequence

1. `git -C ~/projects/clawsweeper checkout -b feat/linear-provider`; `pnpm install`; `pnpm build`; confirm `node dist/clawsweeper.js status` runs.
2. **Spike the classifier** against a real board: drive `linear_board_triage.py snapshot` for one team, run the ClawSweeper decision taxonomy over it, emit a read-only review report. No mutations.
3. Wrap step 2 as `~/projects/config/openclaw/scripts/linear-triage.mjs --review-only --json` (commit immediately).
4. Add the marker-keyed review-comment capability (gated; dry-run receipt).
5. Register the weekly cron + on-demand handle (§7); add the `expectations.json` block.
6. Only then: refactor the `gh`-CLI seam in `src/clawsweeper.ts` into `TrackerProvider` (Option A) if/when you want native lane parity.

---

## 9. Open decisions for the operator (Mike) — confirm before mutating

- **Scope:** which Linear team(s)/workspace = "all issues"? (Skills currently hardwire `PAR` / "PartnerAI Board".)
- **Auth identity:** personal API key via Keychain (simplest) vs OAuth `actor=app` so triage comments post as a bot, not a person.
- **Apply authority:** keep weekly runs review-only indefinitely, or define a pre-authorized scope where ClawSweeper may auto-apply state/label moves (never closes without evidence).
- **Comment cadence:** post a per-issue review comment, or a single weekly digest issue/Slack/Discord summary?

---

## 10. Key paths (all real, verified)

- ClawSweeper source: `~/projects/clawsweeper/` — seam: `src/clawsweeper.ts` (gh calls), `src/github-json.ts`, `src/github-retry.ts`, `src/repair/*-github.ts`; contract: `schema/clawsweeper-decision.schema.json`; dispatcher (other repo): `openclaw/openclaw .github/workflows/clawsweeper-dispatch.yml`.
- Linear write side to reuse: `~/projects/config/openclaw/skills/linear-board-triage/scripts/linear_board_triage.py`, `~/projects/config/openclaw/skills/openclaw-linear-intake/scripts/linear_import.py`, `~/projects/config/openclaw/conductor/linear_conductor_snapshot.py`.
- Scheduling: OpenClaw cron (`openclaw cron add/run/runs/list`); `~/projects/config/openclaw/cron/expectations.json`; launchd precedent `~/projects/config/openclaw/launchd/ai.openclaw.linear-dlq-drain.plist`; notifier `~/projects/config/openclaw/scripts/notify-linear.mjs`.
- Roadmap: `~/projects/config/openclaw/runbooks/openclaw-linear-native-roadmap.md`.
