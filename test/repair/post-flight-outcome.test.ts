import assert from "node:assert/strict";
import test from "node:test";

import { postFlightExitCode } from "../../dist/repair/post-flight-outcome.js";

test("post-flight exit classification accepts only completed live outcomes", () => {
  assert.equal(
    postFlightExitCode({
      dry_run: false,
      actions: [{ status: "executed" }, { status: "published" }, { status: "ready" }],
    }),
    0,
  );
  assert.equal(postFlightExitCode({ dry_run: false, actions: [{ status: "planned" }] }), 1);
  assert.equal(postFlightExitCode({ dry_run: false, actions: [{ status: "skipped" }] }), 1);
  assert.equal(postFlightExitCode({ dry_run: false, actions: [] }), 1);
});

test("post-flight exit classification accepts planned actions only for dry-run reports", () => {
  assert.equal(postFlightExitCode({ dry_run: true, actions: [{ status: "planned" }] }), 0);
  assert.equal(
    postFlightExitCode({
      dry_run: true,
      actions: [{ status: "planned" }, { status: "executed" }],
    }),
    0,
  );
  assert.equal(
    postFlightExitCode({
      dry_run: true,
      actions: [{ status: "planned" }, { status: "blocked" }],
    }),
    1,
  );
});

test("post-flight accepts only documented audited commit-finding no-PR outcomes", () => {
  const reasons = [
    "Codex produced no target repo changes; treating this allow_no_pr artifact as an audited no-PR outcome",
    "prepared replacement branch has no changes versus base after repair",
    "replacement branch has no changes versus base after repair",
  ];
  for (const sourceReason of reasons) {
    assert.equal(postFlightExitCode(auditedNoPrReport(sourceReason)), 0, sourceReason);
  }

  assert.equal(postFlightExitCode(auditedNoPrReport("arbitrary skip")), 1);
  assert.equal(postFlightExitCode({ ...auditedNoPrReport(reasons[0]), allow_no_pr: false }), 1);
  assert.equal(
    postFlightExitCode({ ...auditedNoPrReport(reasons[0]), source: "issue_implementation" }),
    1,
  );
  assert.equal(
    postFlightExitCode({
      ...auditedNoPrReport(reasons[0]),
      actions: [
        ...auditedNoPrReport(reasons[0]).actions,
        { action: "post_merge_closeout", status: "executed" },
      ],
    }),
    1,
  );
});

test("post-flight exit classification uses a successful replacement PR fallback as terminal", () => {
  for (const sourceStatus of ["blocked", "failed", "skipped"]) {
    assert.equal(
      postFlightExitCode({
        dry_run: false,
        actions: [
          {
            action: "finalize_fix_pr",
            source_action: "repair_contributor_branch",
            source_status: sourceStatus,
            status: "skipped",
          },
          {
            action: "finalize_fix_pr",
            source_action: "open_fix_pr",
            source_status: "opened",
            status: "executed",
          },
        ],
      }),
      0,
      sourceStatus,
    );
  }

  assert.equal(
    postFlightExitCode({
      dry_run: true,
      actions: [
        {
          action: "finalize_fix_pr",
          source_action: "repair_contributor_branch",
          source_status: "failed",
          status: "skipped",
        },
        {
          action: "finalize_fix_pr",
          source_action: "open_fix_pr",
          source_status: "opened",
          status: "planned",
        },
      ],
    }),
    0,
  );
});

test("post-flight fallback classification does not hide active or downstream failures", () => {
  const successfulFallback = {
    action: "finalize_fix_pr",
    source_action: "open_fix_pr",
    source_status: "opened",
    status: "executed",
  };

  assert.equal(
    postFlightExitCode({
      actions: [
        {
          action: "finalize_fix_pr",
          source_action: "repair_contributor_branch",
          source_status: "pushed",
          status: "blocked",
        },
        successfulFallback,
      ],
    }),
    1,
  );
  assert.equal(
    postFlightExitCode({
      actions: [
        {
          action: "finalize_fix_pr",
          source_action: "repair_contributor_branch",
          source_status: "failed",
          status: "skipped",
        },
        { ...successfulFallback, status: "blocked" },
      ],
    }),
    1,
  );
  assert.equal(
    postFlightExitCode({
      actions: [
        {
          action: "finalize_fix_pr",
          source_action: "repair_contributor_branch",
          source_status: "failed",
          status: "skipped",
        },
        successfulFallback,
        { action: "post_merge_closeout", status: "blocked" },
      ],
    }),
    1,
  );
});

function auditedNoPrReport(sourceReason: string) {
  return {
    dry_run: false,
    job_intent: "commit_finding",
    source: "clawsweeper_commit",
    commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    allow_no_pr: true,
    actions: [
      {
        action: "finalize_fix_pr",
        source_action: "open_fix_pr",
        source_status: "skipped",
        source_reason: sourceReason,
        status: "skipped",
      },
    ],
  };
}
