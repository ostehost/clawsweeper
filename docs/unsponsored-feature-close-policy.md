# Unsponsored Feature Request Close Policy

Read when changing automatic handling for old feature requests that still need
a maintainer product decision.

ClawSweeper can propose `unsponsored_feature_request` only for
`openclaw/openclaw` issues that meet every deterministic review gate:

- `item_category: feature`;
- `requires_product_decision: true`;
- `maintainer_decision.required: true` with `kind: product_direction`;
- no `impact:security` or `clawsweeper:needs-security-review` label.

The review lane only writes a durable close proposal. Apply is default-off and
requires the repository variable
`CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED=true`. When the gate is disabled,
apply records the skip without consuming or rewriting the durable proposal.

Even when enabled, apply fails closed unless the issue is older than 90 days.
It re-fetches live state and keeps the issue open when it is assigned,
milestoned, no longer open, has 20 or more reactions, has a
`clawsweeper:linked-pr-open` label, has any maintainer comment, or has any
non-bot comment from the last 60 days.

GitHub reads are mandatory evidence. Any issue or paginated-comment read
failure becomes a recorded keep-open reason. Snapshot drift and the standard
protected-label gates still apply.

Successful closes use GitHub's `not_planned` state reason. The public comment
acknowledges the idea, says it is not planned unless a maintainer sponsors the
direction, explains that no maintainer confirmed product direction, invites
reopening if sponsorship or circumstances change, and points to ClawHub when
the request can live as an extension.
