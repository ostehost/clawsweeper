# OpenClaw Dispatch

Use this when ClawSweeper needs to be called by an OpenClaw operator, cron job,
or other local scheduler without installing local ClawSweeper runtime state.

The dispatcher is intentionally thin: it triggers the existing GitHub Actions
`workflow_dispatch` entrypoint in `openclaw/clawsweeper` and lets the workflow's
normal concurrency, credentials, state hydration, review, audit, and apply gates
own the work.

## Commands

Dry-run the default safe audit dispatch:

```bash
pnpm openclaw:dispatch:dry-run
```

Run the safe self-audit mode used by OpenClaw cron:

```bash
pnpm openclaw:audit
```

Review one issue or pull request on demand:

```bash
pnpm openclaw:dispatch -- \
  --mode exact-review \
  --target-repo openclaw/openclaw \
  --item-number 12345
```

Run hot intake or normal review for a target repository:

```bash
pnpm openclaw:dispatch -- --mode hot-intake --target-repo openclaw/openclaw
pnpm openclaw:dispatch -- --mode normal-review --target-repo openclaw/openclaw
```

Dispatch guarded apply or comment-only sync:

```bash
pnpm openclaw:dispatch -- --mode apply --target-repo openclaw/openclaw --apply-limit 10
pnpm openclaw:dispatch -- --mode comment-sync --target-repo openclaw/openclaw
```

List recent workflow runs without dispatching anything:

```bash
pnpm openclaw:status
```

## Cron pattern

Prefer scheduling the safe audit wrapper from OpenClaw rather than running local
review/build commands from cron:

```text
cd /Users/ostemini/projects/clawsweeper && pnpm openclaw:audit
```

For an OpenClaw `cron.add` agent turn, use a prompt equivalent to:

```text
Run ClawSweeper's safe OpenClaw audit dispatcher:
cd /Users/ostemini/projects/clawsweeper && pnpm openclaw:audit
Report the JSON/URL receipt or the exact blocker.
```

Use `--skip-if-running` for recurring jobs so a slow Actions run does not cause
cron fanout. The wrapper ignores stale queued/in-progress runs older than 12
hours by default; override with `--active-max-age-minutes` if needed. GitHub
Actions concurrency remains the final overlap guard.

## Requirements

- `gh` authenticated with permission to run workflows in `openclaw/clawsweeper`.
- The target workflow stays on `main` unless `--ref` is supplied.
- Exact reviews require `--item-number` or `--item-numbers`.
- Local ClawSweeper dependencies and generated state are not required for the
  dispatcher itself.

## Modes

| Mode | Workflow inputs |
| --- | --- |
| `audit` | `target_repo`, `audit_dashboard=true` |
| `hot-intake` | `target_repo`, `hot_intake=true` |
| `normal-review` | `target_repo` |
| `exact-review` | `target_repo`, `item_number` or `item_numbers` |
| `apply` | `target_repo`, `apply_existing=true`, optional `apply_limit` |
| `comment-sync` | `target_repo`, `apply_existing=true`, `apply_sync_comments_only=true` |
| `status` | no dispatch; runs `gh run list` |
