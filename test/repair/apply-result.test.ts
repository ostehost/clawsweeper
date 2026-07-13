import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readSpooledActionEvents } from "../../dist/action-ledger.js";
import {
  exactHeadMergeClaimBody,
  exactHeadMergeClaimDispatchBody,
} from "../../dist/repair/exact-head-merge-claim.js";
import { createReviewedTimelineCursor } from "../../dist/repair/timeline-cursor.js";
import { mockGhBinEnv } from "../helpers.ts";

const repoRoot = process.cwd();

test("repair apply blocks PR duplicate close when coverage proof keeps the source open", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B only rewrites parser setup.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "keep_open" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "PR close coverage proof kept the source pull request open: PR B does not carry forward the legacy behavior.",
    );
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply blocks stale covering PR refs instead of crashing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.match(
      report.actions[0].reason,
      /PR close coverage proof failed: .*issue not found: #202/s,
    );
    assert.equal(report.actions[0].requeue_required, undefined);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply requeues transient coverage proof setup failures", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      prViewFailure: { number: 202, message: "HTTP 502 Bad Gateway" },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.match(report.actions[0].reason, /HTTP 502 Bad Gateway/);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply blocks proof subprocess failures after hydrating valid covering PRs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      proofFailureMessage: "model subprocess crashed after valid hydration",
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.match(
      report.actions[0].reason,
      /PR close coverage proof failed: .*model subprocess crashed after valid hydration/s,
    );
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply blocks F-rated covering PRs before coverage proof", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient", "rating: 🧂 unranked krab"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "linked canonical PR #202 is F-rated");
    assert.equal(report.actions[0].requeue_required, undefined);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply compacts PR bodies in coverage proof prompts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const unboundedTail = "UNBOUNDED_BODY_TAIL_SHOULD_NOT_REACH_PROMPT";
    const longBody = `${"legacy config ".repeat(30)}${unboundedTail}`;
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: { ...pull({ number: 101, title: "Add config validation" }), body: longBody },
        202: { ...pull({ number: 202, title: "Rewrite config validation" }), body: longBody },
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      unexpectedPromptIncludes: unboundedTail,
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply filters automation comments from coverage proof prompts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [
          comment(
            "clawsweeper[bot]",
            [
              "AUTOMATION_SHOULD_NOT_REACH_REPAIR_PROOF",
              "",
              "<!-- clawsweeper-repair:close:repair-pr-close-proof:#101:proof-gated-close -->",
            ].join("\n"),
          ),
          comment("alice", "HUMAN_SOURCE_CONTEXT_REACHES_REPAIR_PROOF"),
        ],
        202: [
          comment(
            "clawsweeper[bot]",
            [
              "AUTOMATION_SHOULD_NOT_REACH_REPAIR_PROOF",
              "",
              "<!-- clawsweeper-review item=202 -->",
            ].join("\n"),
          ),
          comment("bob", "HUMAN_COVERING_CONTEXT_REACHES_REPAIR_PROOF"),
        ],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      expectedPromptIncludes: "HUMAN_COVERING_CONTEXT_REACHES_REPAIR_PROOF",
      unexpectedPromptIncludes: "AUTOMATION_SHOULD_NOT_REACH_REPAIR_PROOF",
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "superseded",
    action: {
      action: "close_superseded",
      classification: "superseded",
      canonical: "#202",
    },
  },
  {
    name: "generic-duplicate",
    action: {
      action: "close",
      classification: "duplicate",
      canonical: "#202",
    },
  },
  {
    name: "generic-superseded",
    action: {
      action: "close",
      classification: "superseded",
      canonical: "#202",
    },
  },
  {
    name: "generic-fixed-by-candidate",
    action: {
      action: "close",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
  },
  {
    name: "superseded-candidate",
    action: {
      action: "close_superseded",
      classification: "superseded",
      candidate_fix: "#202",
    },
    mergedCandidate: true,
  },
  {
    name: "fixed-by-candidate",
    action: {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
  },
  {
    name: "post-merge",
    action: {
      action: "post_merge_close",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
    mergedCandidate: true,
  },
]) {
  test(`repair apply blocks PR ${scenario.name} close when coverage proof keeps the source open`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
    try {
      const paths = writeApplyFixture(tmp, scenario.action);
      writeFakeGh(paths.binDir, {
        issues: {
          101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
          202: issue({
            number: 202,
            title: "Rewrite config validation",
            pullRequest: true,
            labels: ["proof: sufficient"],
          }),
        },
        pulls: {
          101: pull({ number: 101, title: "Add config validation" }),
          202: pull({
            number: 202,
            title: "Rewrite config validation",
            mergedAt: scenario.mergedCandidate ? "2026-05-26T00:00:00Z" : undefined,
          }),
        },
        comments: {
          101: [comment("alice", "PR A keeps legacy config behavior intact.")],
          202: [comment("bob", "PR B only rewrites parser setup.")],
        },
        logPath: paths.ghLogPath,
      });
      writeFakeCodex(paths.binDir);

      runApplyResult(paths, { proofDecision: "keep_open" });

      const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
      assert.equal(report.actions[0].status, "blocked");
      assert.equal(
        report.actions[0].reason,
        "PR close coverage proof kept the source pull request open: PR B does not carry forward the legacy behavior.",
      );
      assert.equal(hasPrCloseCall(paths.ghLogPath), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("repair apply checks superseded candidate PR coverage before canonical issue", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_superseded",
      classification: "superseded",
      canonical: "#303",
      candidate_fix: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
        303: issue({ number: 303, title: "Tracking issue", pullRequest: false }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B only rewrites parser setup.")],
        303: [comment("carol", "Tracking the canonical cleanup.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "keep_open" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "PR close coverage proof kept the source pull request open: PR B does not carry forward the legacy behavior.",
    );
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply bounds covering PR comments when issue comment count is absent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: Array.from({ length: 160 }, (_, index) =>
          comment(
            "bob",
            index === 159
              ? "Recent discussion: PR B carries forward the legacy behavior."
              : `Older discussion ${index}`,
          ),
        ),
      },
      omitIssueCommentCounts: [202],
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      expectedPromptIncludes: "Recent discussion: PR B carries forward the legacy behavior.",
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), true);
    const coveringCommentFetches = ghCalls(paths.ghLogPath).filter(
      (call) =>
        call.args[0] === "api" &&
        call.args.some((arg) => arg.includes("/issues/202/comments")) &&
        !call.args.includes("--method"),
    );
    assert.equal(
      coveringCommentFetches.some((call) => call.args.includes("--slurp")),
      false,
    );
    assert.equal(coveringCommentFetches.length, 2);
    assert.ok(coveringCommentFetches.every((call) => call.args.includes("-i")));
    assert.ok(
      coveringCommentFetches.every((call) =>
        call.args.some((arg) => /[?&]per_page=100(?:&|$)/.test(arg)),
      ),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply blocks PR close when open covering PR lacks positive proof", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["triage: needs-real-behavior-proof"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "linked canonical PR #202 is still waiting for real behavior proof",
    );
    assert.equal(
      ghCalls(paths.ghLogPath).some((call) => call.args[0] === "pr" && call.args[1] === "close"),
      false,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply executes PR duplicate close when coverage proof says covered", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "superseded",
    action: {
      action: "close_superseded",
      classification: "superseded",
      canonical: "#202",
    },
  },
  {
    name: "superseded-candidate",
    action: {
      action: "close_superseded",
      classification: "superseded",
      candidate_fix: "#202",
    },
    mergedCandidate: true,
  },
  {
    name: "duplicate-of alias",
    action: {
      action: "close_duplicate",
      classification: "duplicate",
      duplicate_of: "#202",
    },
  },
  {
    name: "fixed-by-candidate",
    action: {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
  },
  {
    name: "fixed-by alias",
    action: {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      fixed_by: "#202",
    },
  },
  {
    name: "fix-candidate alias",
    action: {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      fix_candidate: "#202",
    },
  },
  {
    name: "post-merge",
    action: {
      action: "post_merge_close",
      classification: "fixed_by_candidate",
      candidate_fix: "#202",
    },
    mergedCandidate: true,
  },
]) {
  test(`repair apply executes PR ${scenario.name} close when coverage proof says covered`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
    try {
      const paths = writeApplyFixture(tmp, scenario.action);
      writeFakeGh(paths.binDir, {
        issues: {
          101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
          202: issue({
            number: 202,
            title: "Rewrite config validation",
            pullRequest: true,
            labels: ["proof: sufficient"],
          }),
        },
        pulls: {
          101: pull({ number: 101, title: "Add config validation" }),
          202: pull({
            number: 202,
            title: "Rewrite config validation",
            mergedAt: scenario.mergedCandidate ? "2026-05-26T00:00:00Z" : undefined,
          }),
        },
        comments: {
          101: [comment("alice", "PR A keeps legacy config behavior intact.")],
          202: [comment("bob", "PR B carries forward the legacy config behavior.")],
        },
        logPath: paths.ghLogPath,
      });
      writeFakeCodex(paths.binDir);

      runApplyResult(paths, { proofDecision: "covered" });

      const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
      assert.equal(report.actions[0].status, "executed");
      assert.equal(hasPrCloseCall(paths.ghLogPath), true);
      assert.equal(
        report.actions[0].pr_close_coverage_proof.reason,
        "PR B carries forward the legacy behavior.",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("repair apply rechecks target freshness after coverage proof passes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofIssueUpdates: {
        101: "2026-05-25T00:05:00Z",
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", afterProofPath });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "target changed since worker review");
    assert.equal(report.actions[0].expected_updated_at, "2026-05-25T00:00:00Z");
    assert.equal(report.actions[0].live_updated_at, "2026-05-25T00:05:00Z");
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply rechecks covering PR safety after coverage proof passes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofIssues: {
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["triage: needs-real-behavior-proof"],
        }),
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", afterProofPath });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "linked canonical PR #202 is still waiting for real behavior proof",
    );
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply rechecks covering PR freshness after coverage proof passes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofPulls: {
        202: {
          updated_at: "2026-05-25T00:05:00Z",
          body: "Changed after proof ran.",
        },
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", afterProofPath });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "linked canonical PR #202 changed after coverage proof");
    assert.equal(report.actions[0].requeue_required, true);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply requeues transient post-proof covering PR safety failures", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofPrViewFailure: { number: 202, message: "HTTP 502 Bad Gateway" },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", afterProofPath });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.match(report.actions[0].reason, /HTTP 502 Bad Gateway/);
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply skips target closed after proof when updated_at is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
      omitTargetUpdatedAt: true,
    });
    const afterProofPath = path.join(tmp, "proof-ran");
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
        202: issue({
          number: 202,
          title: "Rewrite config validation",
          pullRequest: true,
          labels: ["proof: sufficient"],
        }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "PR A keeps legacy config behavior intact.")],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      afterProofPath,
      postProofIssues: {
        101: issue({
          number: 101,
          title: "Add config validation",
          pullRequest: true,
          state: "closed",
        }),
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, {
      proofDecision: "covered",
      afterProofPath,
      allowMissingUpdatedAt: true,
    });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "skipped");
    assert.equal(report.actions[0].reason, "already closed");
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply treats already-closed PR duplicate close as idempotent before coverage proof", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({
          number: 101,
          title: "Add config validation",
          pullRequest: true,
          state: "closed",
        }),
        202: issue({ number: 202, title: "Rewrite config validation", pullRequest: true }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [
          comment(
            "clawsweeper[bot]",
            [
              "Thanks for the work here. PR B is the canonical repair path.",
              "",
              "<!-- clawsweeper-repair:close:repair-pr-close-proof:#101:proof-gated-close -->",
            ].join("\n"),
          ),
        ],
        202: [comment("bob", "PR B carries forward the legacy config behavior.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "keep_open", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(
      report.actions[0].reason,
      "already closed with matching clawsweeper-repair comment",
    );
    assert.equal(hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply leaves issue duplicate close behavior unchanged", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_duplicate",
      classification: "duplicate",
      canonical: "#202",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: false }),
        202: issue({ number: 202, title: "Rewrite config validation", pullRequest: true }),
      },
      pulls: {
        202: pull({ number: 202, title: "Rewrite config validation" }),
      },
      comments: {
        101: [comment("alice", "Issue A is duplicated by PR B.")],
        202: [comment("bob", "PR B carries the fix.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "keep_open" });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "executed");
    assert.equal(
      ghCalls(paths.ghLogPath).some((call) => call.args[0] === "comment-body"),
      true,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply leaves current-main fixed closeout outside coverage proof", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-"));
  try {
    const paths = writeApplyFixture(tmp, {
      action: "close_fixed_by_candidate",
      classification: "fixed_by_candidate",
      reason: "Already fixed on current main.",
    });
    writeFakeGh(paths.binDir, {
      issues: {
        101: issue({ number: 101, title: "Add config validation", pullRequest: true }),
      },
      pulls: {
        101: pull({ number: 101, title: "Add config validation" }),
      },
      comments: {
        101: [comment("alice", "Current main already has the config validation fix.")],
      },
      logPath: paths.ghLogPath,
    });
    writeFakeCodex(paths.binDir);

    runApplyResult(paths, { proofDecision: "covered", failIfProofRuns: true });

    const report = JSON.parse(fs.readFileSync(paths.reportPath, "utf8"));
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "closure requires candidate_fix");
    assert.equal(fs.existsSync(paths.ghLogPath) && hasPrCloseCall(paths.ghLogPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("repair apply certifies a successful squash from the recorded commit object", () => {
  const fixture = writeMergeApplyFixture();
  try {
    runMergeApplyResult(fixture);

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "executed");
    assert.equal(report.actions[0].merge_method, "squash");
    assert.equal(report.actions[0].merge_commit_sha, "c".repeat(40));
    assert.equal(mergeCallCount(fixture.ghLogPath), 1);
    assert.equal(
      ghCalls(fixture.ghLogPath).some(
        (call) =>
          call.args[0] === "api" &&
          call.args[1] === `repos/openclaw/openclaw/commits/${"c".repeat(40)}`,
      ),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

for (const mergeCommitMode of ["message_mismatch", "two_parents"] as const) {
  test(`repair apply rejects ${mergeCommitMode} squash proof`, () => {
    const fixture = writeMergeApplyFixture({ mergeCommitMode });
    try {
      runMergeApplyResult(fixture);

      const report = readApplyReport(fixture.reportPath);
      assert.equal(report.actions[0].status, "blocked");
      assert.match(report.actions[0].reason, /dispatched squash payload|squash-merge topology/);
      assert.equal(report.actions[0].merged_at, undefined);
    } finally {
      fixture.cleanup();
    }
  });
}

test("repair apply certifies an ambiguous squash response from the durable dispatch payload", () => {
  const fixture = writeMergeApplyFixture({ mergeMode: "ambiguous_exact" });
  try {
    runMergeApplyResult(fixture, { retryAttempts: 4 });

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "executed");
    assert.equal(report.actions[0].reason, "merge confirmed after ambiguous response");
    assert.equal(report.actions[0].merged_at, "2026-07-13T08:00:00Z");
    assert.equal(mergeCallCount(fixture.ghLogPath), 1);
    assert.equal(restPullCallCount(fixture.ghLogPath), 5);
    const mergeCall = ghCalls(fixture.ghLogPath).find(
      (call) => call.args[0] === "pr" && call.args[1] === "merge",
    );
    assert.ok(mergeCall);
    assert.deepEqual(mergeCall.args.slice(mergeCall.args.indexOf("--match-head-commit")), [
      "--match-head-commit",
      fixture.headSha,
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("repair apply rejects a merged REST snapshot for a different head", () => {
  const fixture = writeMergeApplyFixture({ mergeMode: "wrong_head_merged" });
  try {
    runMergeApplyResult(fixture);

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "merged pull request head does not match the authorized preflight head",
    );
    assert.equal(report.actions[0].merged_at, undefined);
    assert.equal(mergeCallCount(fixture.ghLogPath), 1);
    assert.equal(restPullCallCount(fixture.ghLogPath), 5);
  } finally {
    fixture.cleanup();
  }
});

for (const pendingKind of ["queue", "auto_merge"] as const) {
  test(`repair apply observes exact-head ${pendingKind} state without reissuing merge`, () => {
    const fixture = writeMergeApplyFixture({
      mergeMode: "pending_after_command",
      pendingKind,
    });
    try {
      runMergeApplyResult(fixture);
      let report = readApplyReport(fixture.reportPath);
      assert.equal(report.actions[0].status, "blocked");
      assert.equal(report.actions[0].requeue_required, true);
      assert.equal(
        report.actions[0].reason,
        pendingKind === "queue"
          ? "merge is pending in GitHub's merge queue for the authorized pull request head"
          : "auto-merge is pending for the authorized pull request head",
      );
      assert.equal(mergeCallCount(fixture.ghLogPath), 1);
      assert.equal(pullRequestViewCallCount(fixture.ghLogPath), 6);

      runMergeApplyResult(fixture);
      report = readApplyReport(fixture.reportPath);
      assert.equal(report.actions[0].status, "blocked");
      assert.equal(report.actions[0].requeue_required, true);
      assert.equal(mergeCallCount(fixture.ghLogPath), 1);
      assert.equal(pullRequestViewCallCount(fixture.ghLogPath), 7);
    } finally {
      fixture.cleanup();
    }
  });
}

for (const pendingKind of ["queue", "auto_merge"] as const) {
  test(`repair apply reports terminal check failure before exact-head ${pendingKind} state`, () => {
    const fixture = writeMergeApplyFixture({
      mergeMode: "pending_after_command",
      pendingKind,
      terminalCheckFailure: true,
    });
    try {
      fs.writeFileSync(fixture.mergeCountPath, "1");
      runMergeApplyResult(fixture);

      const report = readApplyReport(fixture.reportPath);
      assert.equal(report.actions[0].status, "blocked");
      assert.equal(report.actions[0].reason, "checks are not clean: test: FAILURE");
      assert.equal(report.actions[0].requeue_required, undefined);
      assert.equal(mergeCallCount(fixture.ghLogPath), 0);
    } finally {
      fixture.cleanup();
    }
  });
}

test("repair apply reports a post-command terminal check failure before queue state", () => {
  const fixture = writeMergeApplyFixture({
    mergeMode: "pending_after_command",
    pendingKind: "queue",
    terminalCheckFailureAfterCommand: true,
  });
  try {
    runMergeApplyResult(fixture);

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "checks are not clean: test: FAILURE");
    assert.equal(report.actions[0].requeue_required, undefined);
    assert.equal(mergeCallCount(fixture.ghLogPath), 1);
    assert.equal(pullRequestViewCallCount(fixture.ghLogPath), 6);
  } finally {
    fixture.cleanup();
  }
});

test("repair apply blocks completed checks without a conclusion before queue state", () => {
  const fixture = writeMergeApplyFixture({
    mergeMode: "pending_after_command",
    pendingKind: "queue",
    terminalCheckMissingConclusion: true,
  });
  try {
    fs.writeFileSync(fixture.mergeCountPath, "1");
    runMergeApplyResult(fixture);

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "checks are not clean: test: UNKNOWN (COMPLETED without conclusion)",
    );
    assert.equal(report.actions[0].requeue_required, undefined);
    assert.equal(mergeCallCount(fixture.ghLogPath), 0);
  } finally {
    fixture.cleanup();
  }
});

test("repair apply accepts legacy successful status contexts before queue state", () => {
  const fixture = writeMergeApplyFixture({
    mergeMode: "pending_after_command",
    pendingKind: "queue",
    legacyStatusContextSuccess: true,
  });
  try {
    fs.writeFileSync(fixture.mergeCountPath, "1");
    runMergeApplyResult(fixture);

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "merge is pending in GitHub's merge queue for the authorized pull request head",
    );
    assert.equal(report.actions[0].requeue_required, true);
    assert.equal(mergeCallCount(fixture.ghLogPath), 0);
  } finally {
    fixture.cleanup();
  }
});

test("repair apply does not transport-retry an ambiguous merge mutation", () => {
  const fixture = writeMergeApplyFixture({ mergeMode: "ambiguous_unconfirmed" });
  try {
    runMergeApplyResult(fixture, { retryAttempts: 5 });

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.match(report.actions[0].reason, /merge command failed.*HTTP 502/i);
    assert.equal(mergeCallCount(fixture.ghLogPath), 1);
    assert.equal(restPullCallCount(fixture.ghLogPath), 5);
    const comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
    assert.equal(comments.length, 2);
    assert.doesNotMatch(
      comments.map((comment: Record<string, unknown>) => comment.body).join("\n"),
      /rejection/,
    );
  } finally {
    fixture.cleanup();
  }
});

for (const mergeMode of ["ambiguous_unconfirmed", "timeout_unconfirmed"] as const) {
  test(`repair apply preserves reconciliation-only claims after ${mergeMode}`, () => {
    const fixture = writeMergeApplyFixture({ mergeMode });
    try {
      runMergeApplyResult(fixture, { runAttempt: 1 });
      let report = readApplyReport(fixture.reportPath);
      assert.equal(report.actions[0].status, "blocked");
      assert.equal(report.actions[0].requeue_required, true);
      assert.equal(mergeCallCount(fixture.ghLogPath), 1);

      let comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
      assert.equal(comments.length, 2);
      assert.match(comments[0].body, /clawsweeper-exact-head-merge-claim:v1/);
      assert.match(comments[1].body, /clawsweeper-exact-head-merge-dispatch:v2 claim=1001/);

      runMergeApplyResult(fixture, { runAttempt: 2 });
      report = readApplyReport(fixture.reportPath);
      assert.equal(report.actions[0].status, "blocked");
      assert.equal(report.actions[0].requeue_required, true);
      assert.equal(mergeCallCount(fixture.ghLogPath), 1);
      comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
      assert.equal(comments.length, 2);
    } finally {
      fixture.cleanup();
    }
  });
}

test("repair apply retires a definitively rejected claim so the same head can retry", () => {
  const fixture = writeMergeApplyFixture({ mergeMode: "definitive_rejection" });
  try {
    runMergeApplyResult(fixture, { runAttempt: 1 });
    let report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.match(report.actions[0].reason, /definitively rejected/i);
    assert.equal(mergeCallCount(fixture.ghLogPath), 1);

    let comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
    assert.equal(comments.length, 3);
    assert.match(comments[2].body, /clawsweeper-exact-head-merge-rejection:v1 claim=1001/);

    const refreshedResult = JSON.parse(fs.readFileSync(fixture.resultPath, "utf8"));
    refreshedResult.actions[0].target_updated_at = "2026-07-13T07:03:02.000Z";
    refreshedResult.actions[0].target_timeline_cursor = createReviewedTimelineCursor(
      comments.map((comment: Record<string, unknown>) => ({ ...comment, event: "commented" })),
    );
    fs.writeFileSync(fixture.resultPath, JSON.stringify(refreshedResult, null, 2));
    runMergeApplyResult(fixture, { runAttempt: 2 });
    report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.equal(mergeCallCount(fixture.ghLogPath), 2);
    comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
    assert.equal(comments.length, 6);
    assert.match(comments[5].body, /clawsweeper-exact-head-merge-rejection:v1 claim=1004/);
  } finally {
    fixture.cleanup();
  }
});

test("repair apply recovers a terminal pre-merge dispatch marker after proving no effect", () => {
  const fixture = writeMergeApplyFixture({ priorWorkflowConclusion: "failure" });
  try {
    const request = {
      repository: "openclaw/openclaw",
      number: 101,
      headSha: fixture.headSha,
      method: "squash" as const,
      owner: "apply_result",
      claimant: "apply_result:9001:1",
      appId: 3306130,
      appSlug: "openclaw-clawsweeper",
    };
    fs.writeFileSync(
      fixture.mergeClaimPath,
      JSON.stringify([
        {
          id: 1001,
          body: exactHeadMergeClaimBody(request),
          created_at: "2026-07-13T07:01:00Z",
          performed_via_github_app: { id: 3306130, slug: "openclaw-clawsweeper" },
          user: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          id: 1002,
          body: exactHeadMergeClaimDispatchBody(
            request,
            1001,
            "fix: interrupted merge\n\nno request reached GitHub",
          ),
          created_at: "2026-07-13T07:02:00Z",
          performed_via_github_app: { id: 3306130, slug: "openclaw-clawsweeper" },
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]),
    );

    runMergeApplyResult(fixture, { runAttempt: 2 });

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].requeue_required, true);
    assert.match(
      report.actions[0].reason,
      /failed after dispatch without an observable merge effect/i,
    );
    assert.equal(mergeCallCount(fixture.ghLogPath), 0);
    const comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
    assert.equal(comments.length, 3);
    assert.match(comments[2].body, /clawsweeper-exact-head-merge-recovery:v1 claim=1001/);
  } finally {
    fixture.cleanup();
  }
});

test("repair apply fails closed when post-claim timeline hydration reaches its cap", () => {
  const fixture = writeMergeApplyFixture({ foreignActivityBeyondTimelineCap: true });
  try {
    runMergeApplyResult(fixture);

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "target changed after exact-head merge claim");
    assert.equal(mergeCallCount(fixture.ghLogPath), 0);
    const comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
    assert.equal(comments.length, 2);
    assert.match(comments[0].body, /clawsweeper-exact-head-merge-claim:v1/);
    assert.match(comments[1].body, /clawsweeper-exact-head-merge-release:v1 claim=1001/);
  } finally {
    fixture.cleanup();
  }
});

test("repair apply blocks same-second foreign activity before claiming the merge", () => {
  const fixture = writeMergeApplyFixture();
  try {
    fs.writeFileSync(fixture.unrelatedDriftPath, "same_timestamp");
    runMergeApplyResult(fixture);

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "target changed since worker review");
    assert.equal(mergeCallCount(fixture.ghLogPath), 0);
    assert.equal(fs.existsSync(fixture.mergeClaimPath), false);
  } finally {
    fixture.cleanup();
  }
});

for (const postClaimContentDrift of ["body", "title", "label", "reaction"] as const) {
  test(`repair apply rejects same-window ${postClaimContentDrift} drift after claiming`, () => {
    const fixture = writeMergeApplyFixture({ postClaimContentDrift });
    try {
      runMergeApplyResult(fixture);

      const report = readApplyReport(fixture.reportPath);
      assert.equal(report.actions[0].status, "blocked");
      assert.equal(report.actions[0].reason, "target changed after exact-head merge claim");
      assert.equal(mergeCallCount(fixture.ghLogPath), 0);
      const comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
      assert.equal(comments.length, 2);
      assert.match(comments[1].body, /clawsweeper-exact-head-merge-release:v1 claim=1001/);
    } finally {
      fixture.cleanup();
    }
  });
}

for (const [postDispatchGuardDrift, reason] of [
  ["timeline", /target changed at the merge dispatch boundary/],
  ["security", /security-sensitive target/],
] as const) {
  test(`repair apply retires post-marker ${postDispatchGuardDrift} drift before merge`, () => {
    const fixture = writeMergeApplyFixture({ postDispatchGuardDrift });
    try {
      runMergeApplyResult(fixture);

      const report = readApplyReport(fixture.reportPath);
      assert.equal(report.actions[0].status, "blocked");
      assert.match(report.actions[0].reason, reason);
      assert.equal(mergeCallCount(fixture.ghLogPath), 0);
      const comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
      assert.equal(comments.length, 3);
      assert.match(comments[2].body, /clawsweeper-exact-head-merge-rejection:v1 claim=1001/);
    } finally {
      fixture.cleanup();
    }
  });
}

for (const [postPolicyDrift, reason] of [
  ["rest_head", /REST head changed/],
  ["view_head", /head changed during merge preflight/],
  ["base", /base is not main|base changed during final merge preflight/],
  ["readiness", /merge state status is BLOCKED/],
] as const) {
  test(`repair apply catches absolute-final ${postPolicyDrift} drift before merge`, () => {
    const fixture = writeMergeApplyFixture({ postPolicyDrift });
    try {
      runMergeApplyResult(fixture);

      const report = readApplyReport(fixture.reportPath);
      assert.equal(report.actions[0].status, "blocked");
      assert.match(report.actions[0].reason, reason);
      assert.equal(mergeCallCount(fixture.ghLogPath), 0);
      const comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
      assert.equal(comments.length, 3);
      assert.match(comments[2].body, /clawsweeper-exact-head-merge-rejection:v1 claim=1001/);
    } finally {
      fixture.cleanup();
    }
  });
}

test("repair apply reconstructs durable squash proof in a fresh process", () => {
  const fixture = writeMergeApplyFixture();
  try {
    runMergeApplyResult(fixture, { runAttempt: 1 });
    let report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "executed");
    assert.equal(mergeCallCount(fixture.ghLogPath), 1);

    runMergeApplyResult(fixture, { runAttempt: 2 });
    report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "executed");
    assert.equal(report.actions[0].reason, "already merged");
    assert.equal(report.actions[0].merge_commit_sha, "c".repeat(40));
    assert.equal(mergeCallCount(fixture.ghLogPath), 1);
    assert.ok(
      ghCalls(fixture.ghLogPath).filter(
        (call) =>
          call.args[0] === "api" &&
          call.args[1] === `repos/openclaw/openclaw/commits/${"c".repeat(40)}`,
      ).length >= 2,
    );
  } finally {
    fixture.cleanup();
  }
});

test("repair apply blocks final security drift before the merge request", () => {
  const fixture = writeMergeApplyFixture({ securityOnFinalIssueFetch: true });
  try {
    runMergeApplyResult(fixture);

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "security-sensitive target requires central security triage",
    );
    assert.equal(mergeCallCount(fixture.ghLogPath), 0);
  } finally {
    fixture.cleanup();
  }
});

test("repair apply requires a fresh reviewed timestamp after releasing a post-claim abort", () => {
  const fixture = writeMergeApplyFixture({ securityOnPostClaimIssueFetchOnce: true });
  try {
    runMergeApplyResult(fixture, { runAttempt: 1 });
    let report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(
      report.actions[0].reason,
      "security-sensitive target requires central security triage",
    );
    assert.equal(mergeCallCount(fixture.ghLogPath), 0);
    let comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
    assert.equal(comments.length, 2);
    assert.match(comments[0].body, /clawsweeper-exact-head-merge-claim:v1/);
    assert.match(comments[1].body, /clawsweeper-exact-head-merge-release:v1 claim=1001/);

    runMergeApplyResult(fixture, { runAttempt: 2 });
    report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "blocked");
    assert.equal(report.actions[0].reason, "target changed since worker review");
    assert.equal(mergeCallCount(fixture.ghLogPath), 0);
    comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
    assert.equal(comments.length, 2);

    const refreshedResult = JSON.parse(fs.readFileSync(fixture.resultPath, "utf8"));
    refreshedResult.actions[0].target_updated_at = "2026-07-13T07:02:02.000Z";
    refreshedResult.actions[0].target_timeline_cursor = createReviewedTimelineCursor(
      comments.map((comment: Record<string, unknown>) => ({ ...comment, event: "commented" })),
    );
    fs.writeFileSync(fixture.resultPath, JSON.stringify(refreshedResult, null, 2));
    runMergeApplyResult(fixture, { runAttempt: 3 });
    report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "executed");
    assert.equal(mergeCallCount(fixture.ghLogPath), 1);
    comments = JSON.parse(fs.readFileSync(fixture.mergeClaimPath, "utf8"));
    assert.equal(comments.length, 4);
    assert.match(comments[2].body, /clawsweeper-exact-head-merge-claim:v1/);
    assert.match(comments[3].body, /clawsweeper-exact-head-merge-dispatch:v2 claim=1003/);
  } finally {
    fixture.cleanup();
  }
});

test("repair apply dry-run does not require workflow claim identity", () => {
  const fixture = writeMergeApplyFixture();
  try {
    runMergeApplyResult(fixture, { dryRun: true, omitClaimIdentity: true });

    const report = readApplyReport(fixture.reportPath);
    assert.equal(report.actions[0].status, "planned");
    assert.equal(report.actions[0].reason, "dry run");
    assert.equal(fs.existsSync(fixture.mergeClaimPath), false);
    assert.equal(
      ghCalls(fixture.ghLogPath).some(
        (call) =>
          call.args[0] === "api" &&
          call.args[1] === "repos/openclaw/openclaw/issues/101/comments" &&
          call.args.includes("-f"),
      ),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test("repair apply records a durable observed receipt after ambiguous exact merge", () => {
  const fixture = writeMergeApplyFixture({ mergeMode: "ambiguous_exact" });
  try {
    runMergeApplyResult(fixture, {
      actionLedgerInvocation: "apply-result-ambiguous-exact",
    });

    const allEvents = readSpooledActionEvents(fixture.ledgerRoot, "openclaw/openclaw");
    const events = allEvents.filter(
      (event) =>
        event.event_type === "repair.mutation" &&
        String(event.producer.component).startsWith("apply_result."),
    );
    assert.deepEqual(
      events
        .sort((left, right) => left.phase_seq - right.phase_seq)
        .map((event) => [event.action.status, event.attributes?.completion_reason]),
      [
        ["started", "mutation_attempted"],
        ["failed", "mutation_outcome_unknown"],
        ["executed", "mutation_observed"],
      ],
    );
    assert.deepEqual(
      allEvents
        .filter(
          (event) =>
            event.event_type === "repair.mutation" &&
            String(event.producer.component).startsWith("merge_claim."),
        )
        .sort((left, right) => left.phase_seq - right.phase_seq)
        .map((event) => [event.action.status, event.attributes?.completion_reason]),
      [
        ["started", "mutation_attempted"],
        ["executed", "mutation_accepted"],
        ["started", "mutation_attempted"],
        ["executed", "mutation_accepted"],
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

type ApplyFixturePaths = {
  binDir: string;
  jobPath: string;
  resultPath: string;
  reportPath: string;
  ghLogPath: string;
};

type ApplyFixtureAction = {
  action: string;
  classification: string;
  canonical?: string;
  duplicate_of?: string;
  candidate_fix?: string;
  fixed_by?: string;
  fix_candidate?: string;
  reason?: string;
  omitTargetUpdatedAt?: boolean;
};

type FakeGhData = {
  issues: Record<number, Record<string, unknown>>;
  pulls: Record<number, Record<string, unknown>>;
  comments: Record<number, Record<string, unknown>[]>;
  omitIssueCommentCounts?: number[];
  prViewFailure?: { number: number; message: string };
  afterProofPath?: string;
  postProofIssues?: Record<number, Record<string, unknown>>;
  postProofIssueUpdates?: Record<number, string>;
  postProofPulls?: Record<number, Record<string, unknown>>;
  postProofPrViewFailure?: { number: number; message: string };
  logPath: string;
};

function writeApplyFixture(tmp: string, action: ApplyFixtureAction): ApplyFixturePaths {
  const binDir = path.join(tmp, "bin");
  const runDir = path.join(tmp, "run");
  const jobPath = path.join(tmp, "job.md");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "apply-report.json");
  const ghLogPath = path.join(tmp, "gh.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: repair-pr-close-proof",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - close",
      "canonical:",
      "  - '#202'",
      "  - '#303'",
      "candidates:",
      "  - '#101'",
      "maintainer_close_refs:",
      "  - '#101'",
      "cluster_refs:",
      "  - '#101'",
      "  - '#202'",
      "  - '#303'",
      "allow_instant_close: true",
      "allow_post_merge_close: true",
      "allow_unmerged_fix_close: true",
      "require_fix_before_close: false",
      "---",
      "Repair job.",
      "",
    ].join("\n"),
  );
  const resultAction = { ...action };
  const omitTargetUpdatedAt = resultAction.omitTargetUpdatedAt === true;
  delete resultAction.omitTargetUpdatedAt;
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "repair-pr-close-proof",
        mode: "autonomous",
        actions: [
          {
            ...resultAction,
            target: "#101",
            target_kind: "pull_request",
            ...(omitTargetUpdatedAt ? {} : { target_updated_at: "2026-05-25T00:00:00Z" }),
            status: "planned",
            evidence: ["PR B is referenced as the canonical replacement for PR A."],
            idempotency_key: "proof-gated-close",
            comment: "Thanks for the work here. PR B is the canonical repair path.",
          },
        ],
      },
      null,
      2,
    ),
  );
  return { binDir, jobPath, resultPath, reportPath, ghLogPath };
}

function runApplyResult(
  paths: ApplyFixturePaths,
  options: {
    proofDecision: "covered" | "keep_open";
    expectedPromptIncludes?: string;
    unexpectedPromptIncludes?: string;
    failIfProofRuns?: boolean;
    proofFailureMessage?: string;
    afterProofPath?: string;
    allowMissingUpdatedAt?: boolean;
  },
) {
  const args = ["dist/repair/apply-result.js", paths.jobPath, paths.resultPath];
  if (options.allowMissingUpdatedAt) args.push("--allow-missing-updated-at");
  execFileSync(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAWSWEEPER_ALLOW_EXECUTE: "1",
      CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
      CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
      CLAWSWEEPER_MODEL: "model-test",
      // Coverage instrumentation plus the parallel repair suite can delay this child process.
      // Keep the bound short for a fake binary without making CI depend on a 10-second scheduler window.
      CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_TIMEOUT_MS: "30000",
      GH_TOKEN: "write-token",
      ...mockGhBinEnv(path.join(paths.binDir, "gh.js")),
      PATH: `${paths.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      PR_CLOSE_COVERAGE_PROOF_DECISION: options.proofDecision,
      PR_CLOSE_COVERAGE_PROOF_EXPECT_PROMPT: options.expectedPromptIncludes ?? "",
      PR_CLOSE_COVERAGE_PROOF_UNEXPECTED_PROMPT: options.unexpectedPromptIncludes ?? "",
      PR_CLOSE_COVERAGE_PROOF_FAIL_IF_INVOKED: options.failIfProofRuns ? "1" : "",
      PR_CLOSE_COVERAGE_PROOF_FAILURE_MESSAGE: options.proofFailureMessage ?? "",
      PR_CLOSE_COVERAGE_PROOF_AFTER_PROOF_PATH: options.afterProofPath ?? "",
    },
    stdio: "pipe",
  });
}

function writeFakeGh(binDir: string, data: FakeGhData) {
  fs.writeFileSync(
    path.join(binDir, "gh.js"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const data = ${JSON.stringify(data)};
fs.appendFileSync(data.logPath, JSON.stringify({ args }) + "\\n");
const includeHeaders = args[0] === "api" && args[1] === "-i";

function write(value) {
  process.stdout.write(JSON.stringify(value));
}

function writeWithHeaders(value, headers = []) {
  process.stdout.write(["HTTP/2 200", ...headers, "", JSON.stringify(value)].join("\\r\\n"));
}

if (args[0] === "api") {
  const apiPath = includeHeaders ? args[2] || "" : args[1] || "";
  const url = new URL(apiPath, "https://api.github.test/");
  let match = url.pathname.match(/\\/issues\\/(\\d+)\\/comments$/);
  if (match) {
    const number = Number(match[1]);
    if (args.includes("--method") && args.includes("POST")) {
      const input = args[args.indexOf("--input") + 1];
      const body = JSON.parse(fs.readFileSync(input, "utf8")).body;
      fs.appendFileSync(data.logPath, JSON.stringify({ args: ["comment-body", String(body)] }) + "\\n");
      write({ id: 9000 + number, body });
    } else if (args.includes("--slurp")) {
      write([data.comments[number] || []]);
    } else {
      const comments = data.comments[number] || [];
      const perPage = Number(url.searchParams.get("per_page") || comments.length || 100);
      const page = Number(url.searchParams.get("page") || "1");
      const start = Math.max(0, page - 1) * perPage;
      const pageComments = comments.slice(start, start + perPage);
      if (includeHeaders) {
        const lastPage = Math.max(1, Math.ceil(comments.length / Math.max(1, perPage)));
        const links = [];
        if (page < lastPage) {
          const next = new URL(url.toString());
          next.searchParams.set("page", String(page + 1));
          links.push("<" + next.toString() + ">; rel=\\"next\\"");
        }
        if (lastPage > 1) {
          const last = new URL(url.toString());
          last.searchParams.set("page", String(lastPage));
          links.push("<" + last.toString() + ">; rel=\\"last\\"");
        }
        writeWithHeaders(pageComments, links.length ? ["link: " + links.join(", ")] : []);
      } else {
        write(pageComments);
      }
    }
    process.exit(0);
  }
  match = url.pathname.match(/\\/issues\\/(\\d+)$/);
	if (match) {
	  const number = Number(match[1]);
	  const issue = data.issues[number];
	  if (!issue) {
	    process.stderr.write("issue not found: #" + match[1] + "\\n");
	    process.exit(1);
	  }
		  const postProofUpdatedAt =
		    data.afterProofPath &&
		    fs.existsSync(data.afterProofPath) &&
		    data.postProofIssueUpdates &&
		    data.postProofIssueUpdates[number];
		  const postProofIssue =
		    data.afterProofPath &&
		    fs.existsSync(data.afterProofPath) &&
		    data.postProofIssues &&
		    data.postProofIssues[number];
		  write({
		    ...issue,
		    ...(postProofIssue ? postProofIssue : {}),
		    ...(postProofUpdatedAt ? { updated_at: postProofUpdatedAt } : {}),
		    ...((data.omitIssueCommentCounts || []).includes(number)
		      ? {}
		      : { comments: data.comments[number]?.length || 0 }),
		  });
	  process.exit(0);
	}
  match = url.pathname.match(/\\/pulls\\/(\\d+)$/);
  if (match) {
    const number = Number(match[1]);
    const pull = data.pulls[number];
    if (!pull) {
      process.stderr.write("pull not found: #" + match[1] + "\\n");
      process.exit(1);
    }
    const postProofPull =
      data.afterProofPath &&
      fs.existsSync(data.afterProofPath) &&
      data.postProofPulls &&
      data.postProofPulls[number];
    write({
      ...pull,
      ...(postProofPull ? postProofPull : {}),
    });
    process.exit(0);
  }
  if (args[1] === "graphql") {
    write({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
    process.exit(0);
  }
}

if (args[0] === "pr" && args[1] === "close") {
  write({ closed: Number(args[2]) });
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const number = Number(args[2]);
  const postProofPrViewFailure =
    data.afterProofPath &&
    fs.existsSync(data.afterProofPath) &&
    data.postProofPrViewFailure &&
    data.postProofPrViewFailure.number === number;
  const prViewFailure =
    postProofPrViewFailure ? data.postProofPrViewFailure : data.prViewFailure;
  if (prViewFailure && prViewFailure.number === number) {
    process.stderr.write(prViewFailure.message + "\\n");
    process.exit(1);
  }
  const pull = data.pulls[number];
  write({
    baseRefName: "main",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeCommit: { oid: "abc123" },
    mergeStateStatus: "CLEAN",
    mergedAt: pull.merged_at || null,
    reviewDecision: null,
    state: String(pull.state || "open").toUpperCase(),
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    title: pull.title,
    updatedAt: pull.updated_at,
    url: pull.html_url,
  });
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + JSON.stringify(args) + "\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );
}

function writeFakeCodex(binDir: string) {
  fs.writeFileSync(
    path.join(binDir, "codex"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("--output-last-message");
if (outputIndex === -1) process.exit(2);
if (process.env.PR_CLOSE_COVERAGE_PROOF_FAIL_IF_INVOKED === "1") {
  process.stderr.write("coverage proof should not run");
  process.exit(1);
}
const prompt = fs.readFileSync(0, "utf8");
if (!prompt.includes("PR A repair close action report")) {
  process.stderr.write("missing target-specific repair source report");
  process.exit(1);
}
if (prompt.includes("Repair job.")) {
  process.stderr.write("repair job text leaked into source report");
  process.exit(1);
}
const decision = process.env.PR_CLOSE_COVERAGE_PROOF_DECISION;
const expectedPrompt = process.env.PR_CLOSE_COVERAGE_PROOF_EXPECT_PROMPT || "";
if (expectedPrompt && !prompt.includes(expectedPrompt)) {
  process.stderr.write("missing expected proof prompt text: " + expectedPrompt);
  process.exit(1);
}
const unexpectedPrompt = process.env.PR_CLOSE_COVERAGE_PROOF_UNEXPECTED_PROMPT || "";
if (unexpectedPrompt && prompt.includes(unexpectedPrompt)) {
  process.stderr.write("unexpected proof prompt text: " + unexpectedPrompt);
  process.exit(1);
}
if (process.env.GH_TOKEN === "write-token") {
  process.stderr.write("write token leaked into proof subprocess");
  process.exit(1);
}
	const failureMessage = process.env.PR_CLOSE_COVERAGE_PROOF_FAILURE_MESSAGE || "";
	if (failureMessage) {
	  process.stderr.write(failureMessage);
	  process.exit(1);
	}
	const afterProofPath = process.env.PR_CLOSE_COVERAGE_PROOF_AFTER_PROOF_PATH || "";
	if (afterProofPath) fs.writeFileSync(afterProofPath, "proof ran");
	const covered = decision === "covered";
fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({
  sourceSummary: "PR A preserves legacy config behavior.",
  coveringSummary: "PR B rewrites parser setup.",
  coveredWork: covered ? ["Legacy config validation behavior"] : [],
  uniqueSourceWork: covered ? [] : ["Legacy config validation behavior"],
  decision,
  reason: covered
    ? "PR B carries forward the legacy behavior."
    : "PR B does not carry forward the legacy behavior."
}));
`,
    { mode: 0o755 },
  );
}

function issue(options: {
  number: number;
  title: string;
  pullRequest: boolean;
  state?: string;
  labels?: string[];
}) {
  return {
    number: options.number,
    title: options.title,
    html_url: `https://github.com/openclaw/openclaw/pull/${options.number}`,
    state: options.state ?? "open",
    updated_at: "2026-05-25T00:00:00Z",
    author_association: "CONTRIBUTOR",
    user: { login: "contributor" },
    labels: (options.labels ?? []).map((name) => ({ name })),
    pull_request: options.pullRequest ? {} : null,
  };
}

function pull(options: { number: number; title: string; mergedAt?: string }) {
  return {
    number: options.number,
    title: options.title,
    html_url: `https://github.com/openclaw/openclaw/pull/${options.number}`,
    url: `https://github.com/openclaw/openclaw/pull/${options.number}`,
    state: options.mergedAt ? "closed" : "open",
    merged_at: options.mergedAt ?? null,
    body: `${options.title} body.`,
    updated_at: "2026-05-25T00:00:00Z",
  };
}

function comment(author: string, body: string) {
  return {
    user: { login: author },
    author_association: "CONTRIBUTOR",
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    body,
  };
}

function ghCalls(logPath: string): { args: string[] }[] {
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[] });
}

function hasPrCloseCall(logPath: string): boolean {
  return ghCalls(logPath).some((call) => call.args[0] === "pr" && call.args[1] === "close");
}

type MergeFixture = {
  root: string;
  binDir: string;
  jobPath: string;
  resultPath: string;
  reportPath: string;
  ghLogPath: string;
  mergeCountPath: string;
  mergeClaimPath: string;
  unrelatedDriftPath: string;
  ledgerRoot: string;
  ledgerOutputRoot: string;
  headSha: string;
  cleanup(): void;
};

function writeMergeApplyFixture(
  options: {
    mergeMode?:
      | "success_exact"
      | "ambiguous_exact"
      | "ambiguous_unconfirmed"
      | "timeout_unconfirmed"
      | "definitive_rejection"
      | "pending_after_command"
      | "wrong_head_merged";
    pendingKind?: "queue" | "auto_merge";
    mergeable?: "MERGEABLE" | "UNKNOWN";
    securityOnFinalIssueFetch?: boolean;
    securityOnPostClaimIssueFetchOnce?: boolean;
    terminalCheckFailure?: boolean;
    terminalCheckFailureAfterCommand?: boolean;
    terminalCheckMissingConclusion?: boolean;
    legacyStatusContextSuccess?: boolean;
    mergeCommitMode?: "exact" | "message_mismatch" | "two_parents";
    foreignActivityBeyondTimelineCap?: boolean;
    postClaimContentDrift?: "body" | "title" | "label" | "reaction";
    postDispatchGuardDrift?: "timeline" | "security";
    postPolicyDrift?: "rest_head" | "view_head" | "base" | "readiness";
    priorWorkflowConclusion?: "failure";
  } = {},
): MergeFixture {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-result-merge-")),
  );
  const binDir = path.join(root, "bin");
  const runDir = path.join(root, "run");
  const jobPath = path.join(root, "job.md");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "apply-report.json");
  const ghLogPath = path.join(root, "gh.log");
  const mergeCountPath = path.join(root, "merge-count");
  const mergeClaimPath = path.join(root, "merge-claim");
  const unrelatedDriftPath = path.join(root, "unrelated-drift");
  const mergeMessagePath = path.join(root, "merge-message");
  const issueCountPath = path.join(root, "issue-count");
  const ledgerRoot = path.join(root, "ledger");
  const ledgerOutputRoot = path.join(root, "ledger-output");
  const headSha = "a".repeat(40);
  const reviewedTimeline = options.foreignActivityBeyondTimelineCap
    ? Array.from({ length: 1_000 }, (_, index) => ({
        id: index + 1,
        event: "commented",
        created_at: new Date(Date.parse("2026-07-12T00:00:00Z") + index * 1_000).toISOString(),
        actor: { login: "reviewer" },
      }))
    : [];
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(ledgerRoot);
  fs.mkdirSync(ledgerOutputRoot);
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: repair-pr-merge-cas",
      "mode: autonomous",
      "allowed_actions:",
      "  - merge",
      "canonical:",
      "  - '#101'",
      "candidates:",
      "  - '#101'",
      "cluster_refs:",
      "  - '#101'",
      "allow_merge: true",
      "---",
      "Repair merge job.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "repair-pr-merge-cas",
        mode: "autonomous",
        actions: [
          {
            action: "merge_candidate",
            classification: "fixed_by_candidate",
            target: "#101",
            target_kind: "pull_request",
            target_updated_at: "2026-07-13T07:00:00Z",
            target_timeline_cursor: createReviewedTimelineCursor(reviewedTimeline),
            status: "planned",
          },
        ],
        merge_preflight: [
          {
            target: "#101",
            security_status: "cleared",
            security_evidence: ["No security signal."],
            comments_status: "resolved",
            comments_evidence: ["No unresolved review comments."],
            bot_comments_status: "resolved",
            bot_comments_evidence: ["No unresolved bot comments."],
            validation_commands: ["pnpm test"],
            codex_review: {
              command: "/review",
              status: "passed",
              findings_addressed: true,
              evidence: ["Codex /review passed."],
            },
          },
        ],
      },
      null,
      2,
    ),
  );

  const fakeData = {
    ghLogPath,
    mergeCountPath,
    mergeClaimPath,
    unrelatedDriftPath,
    mergeMessagePath,
    headSha,
    wrongHeadSha: "b".repeat(40),
    mergeMode: options.mergeMode ?? "success_exact",
    pendingKind: options.pendingKind ?? null,
    mergeable: options.mergeable ?? "MERGEABLE",
    securityOnFinalIssueFetch: options.securityOnFinalIssueFetch ?? false,
    securityOnPostClaimIssueFetchOnce: options.securityOnPostClaimIssueFetchOnce ?? false,
    terminalCheckFailure: options.terminalCheckFailure ?? false,
    terminalCheckFailureAfterCommand: options.terminalCheckFailureAfterCommand ?? false,
    terminalCheckMissingConclusion: options.terminalCheckMissingConclusion ?? false,
    legacyStatusContextSuccess: options.legacyStatusContextSuccess ?? false,
    mergeCommitMode: options.mergeCommitMode ?? "exact",
    reviewedTimeline,
    foreignActivityBeyondTimelineCap: options.foreignActivityBeyondTimelineCap ?? false,
    postClaimContentDrift: options.postClaimContentDrift ?? null,
    postDispatchGuardDrift: options.postDispatchGuardDrift ?? null,
    postPolicyDrift: options.postPolicyDrift ?? null,
    priorWorkflowConclusion: options.priorWorkflowConclusion ?? null,
    issueCountPath,
  };
  fs.writeFileSync(
    path.join(binDir, "gh.js"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const data = ${JSON.stringify(fakeData)};
fs.appendFileSync(data.ghLogPath, JSON.stringify({ args }) + "\\n");

function write(value) {
  process.stdout.write(JSON.stringify(value));
}

function mergeCount() {
  return fs.existsSync(data.mergeCountPath)
    ? Number(fs.readFileSync(data.mergeCountPath, "utf8"))
    : 0;
}

function issueCount() {
  return fs.existsSync(data.issueCountPath)
    ? Number(fs.readFileSync(data.issueCountPath, "utf8"))
    : 0;
}

function mergeComments() {
  return fs.existsSync(data.mergeClaimPath)
    ? JSON.parse(fs.readFileSync(data.mergeClaimPath, "utf8"))
    : [];
}

function dispatchRecorded(comments = mergeComments()) {
  return comments.some((comment) =>
    String(comment.body || "").includes("clawsweeper-exact-head-merge-dispatch:v2"),
  );
}

function loggedCallCount(predicate) {
  if (!fs.existsSync(data.ghLogPath)) return 0;
  return fs
    .readFileSync(data.ghLogPath, "utf8")
    .trim()
    .split("\\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).args)
    .filter(predicate).length;
}

function pullSnapshotReadCount() {
  return loggedCallCount(
    (callArgs) =>
      callArgs[0] === "api" && callArgs[1] === "repos/openclaw/openclaw/pulls/101",
  );
}

function pullViewReadCount() {
  return loggedCallCount(
    (callArgs) =>
      callArgs[0] === "pr" && callArgs[1] === "view" && callArgs[2] === "101",
  );
}

if (args[0] === "api") {
  const apiPath = args[1] || "";
  if (apiPath === "repos/openclaw/openclaw/issues/101/comments" && args.includes("-f")) {
    const body = String(args.find((arg) => arg.startsWith("body=")) || "").slice(5);
    const comments = fs.existsSync(data.mergeClaimPath)
      ? JSON.parse(fs.readFileSync(data.mergeClaimPath, "utf8"))
      : [];
    const comment = {
      id: 1001 + comments.length,
      body,
      created_at: new Date(Date.parse("2026-07-13T07:00:00Z") + (comments.length + 1) * 60_000).toISOString(),
      performed_via_github_app: { id: 3306130, slug: "openclaw-clawsweeper" },
      user: { login: "openclaw-clawsweeper[bot]" },
    };
    comments.push(comment);
    fs.writeFileSync(data.mergeClaimPath, JSON.stringify(comments));
    write(comment);
    process.exit(0);
  }
  if (apiPath === "repos/openclaw/clawsweeper/actions/runs/9001/attempts/1") {
    write({
      id: 9001,
      run_attempt: 1,
      status: data.priorWorkflowConclusion ? "completed" : "in_progress",
      conclusion: data.priorWorkflowConclusion,
    });
    process.exit(0);
  }
  if (apiPath.includes("/issues/101/comments")) {
    const comments = fs.existsSync(data.mergeClaimPath)
      ? JSON.parse(fs.readFileSync(data.mergeClaimPath, "utf8"))
      : [];
    write(args.includes("--slurp") ? [comments] : comments);
    process.exit(0);
  }
  if (apiPath.includes("/issues/101/timeline")) {
    const comments = mergeComments();
    const timeline = [
      ...data.reviewedTimeline,
      ...comments.map((comment) => ({ ...comment, event: "commented" })),
    ];
    const driftMode = fs.existsSync(data.unrelatedDriftPath)
      ? fs.readFileSync(data.unrelatedDriftPath, "utf8").trim()
      : "";
    if (driftMode === "same_timestamp") {
      timeline.push({
        id: 90001,
        event: "labeled",
        created_at: comments.at(-1).created_at,
        actor: { login: "maintainer" },
      });
    }
    if (data.foreignActivityBeyondTimelineCap && comments.length > 0) {
      timeline.push({
        id: 90002,
        event: "labeled",
        created_at: comments.at(-1).created_at,
        actor: { login: "maintainer" },
      });
    }
    if (data.postDispatchGuardDrift === "timeline" && dispatchRecorded(comments)) {
      timeline.push({
        id: 90003,
        event: "labeled",
        created_at: "2026-07-13T07:02:02Z",
        actor: { login: "maintainer" },
      });
    }
    if (args.includes("--slurp")) {
      write([timeline]);
    } else {
      const query = new URLSearchParams(apiPath.split("?")[1] || "");
      const perPage = Number(query.get("per_page") || timeline.length || 1);
      const page = Number(query.get("page") || 1);
      write(timeline.slice((page - 1) * perPage, page * perPage));
    }
    process.exit(0);
  }
  if (apiPath === "repos/openclaw/openclaw/issues/101") {
    const count = issueCount() + 1;
    fs.writeFileSync(data.issueCountPath, String(count));
    const comments = mergeComments();
    const dispatched = dispatchRecorded(comments);
    const contentDrift = comments.length > 0 ? data.postClaimContentDrift : null;
    const latestClaimMutation = comments.at(-1)?.created_at || "2026-07-13T07:00:00Z";
    const driftMode = fs.existsSync(data.unrelatedDriftPath)
      ? fs.readFileSync(data.unrelatedDriftPath, "utf8").trim()
      : "";
    const mergeCompleted =
      mergeCount() > 0 && ["success_exact", "ambiguous_exact"].includes(data.mergeMode);
    const claimUpdatedAt =
      comments.length > 0
        ? new Date(Date.parse(latestClaimMutation) + 2_000).toISOString()
        : latestClaimMutation;
    write({
      number: 101,
      title: contentDrift === "title" ? "Changed merge candidate" : "Exact merge candidate",
      body: contentDrift === "body" ? "Changed in the claim window." : "Original body.",
      html_url: "https://github.com/openclaw/openclaw/pull/101",
      state: mergeCompleted ? "closed" : "open",
      updated_at:
        driftMode === "same_timestamp"
          ? claimUpdatedAt
          : driftMode
            ? "2026-07-13T07:30:00Z"
            : mergeCompleted
              ? "2026-07-13T08:00:03Z"
              : claimUpdatedAt,
      author_association: "CONTRIBUTOR",
      user: { login: "contributor" },
      labels:
        (data.securityOnFinalIssueFetch && count > 1) ||
        (data.securityOnPostClaimIssueFetchOnce && count === 3) ||
        (data.postDispatchGuardDrift === "security" && dispatched)
          ? [{ name: "security" }]
          : contentDrift === "label"
            ? [{ name: "documentation" }]
            : [],
      comments: comments.length,
      reactions: { total_count: contentDrift === "reaction" ? 1 : 0 },
      pull_request: {},
    });
    process.exit(0);
  }
  if (apiPath === "repos/openclaw/openclaw/pulls/101") {
    const absoluteFinalSnapshot = dispatchRecorded() && pullSnapshotReadCount() >= 4;
    const attempted = mergeCount() > 0;
    const merged =
      attempted &&
      ["success_exact", "ambiguous_exact", "wrong_head_merged"].includes(data.mergeMode);
    const snapshotHead =
      (attempted && data.mergeMode === "wrong_head_merged") ||
      (absoluteFinalSnapshot && data.postPolicyDrift === "rest_head")
        ? data.wrongHeadSha
        : data.headSha;
    write({
      number: 101,
      title: "Exact merge candidate",
      html_url: "https://github.com/openclaw/openclaw/pull/101",
      state: merged ? "closed" : "open",
      draft: false,
      updated_at: merged ? "2026-07-13T08:00:00Z" : "2026-07-13T07:00:00Z",
      merged_at: merged ? "2026-07-13T08:00:00Z" : null,
      merge_commit_sha: merged ? "c".repeat(40) : null,
      auto_merge: null,
      mergeable_state: "clean",
      base: {
        ref: absoluteFinalSnapshot && data.postPolicyDrift === "base" ? "release" : "main",
      },
      head: { sha: snapshotHead },
    });
    process.exit(0);
  }
  if (apiPath === "repos/openclaw/openclaw/commits/" + "c".repeat(40)) {
    const message = fs.existsSync(data.mergeMessagePath)
      ? fs.readFileSync(data.mergeMessagePath, "utf8")
      : "";
    write({
      sha: "c".repeat(40),
      commit: {
        message:
          data.mergeCommitMode === "message_mismatch"
            ? "fix: raced merge\\n\\nwrong payload"
            : message,
      },
      parents:
        data.mergeCommitMode === "two_parents"
          ? [{ sha: "d".repeat(40) }, { sha: "e".repeat(40) }]
          : [{ sha: "d".repeat(40) }],
    });
    process.exit(0);
  }
  if (args[1] === "graphql") {
    write({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      },
    });
    process.exit(0);
  }
}

if (args[0] === "pr" && args[1] === "view") {
  const pending = mergeCount() > 0 && data.mergeMode === "pending_after_command";
  const absoluteFinalSnapshot = dispatchRecorded() && pullViewReadCount() >= 5;
  const terminalCheckFailure =
    data.terminalCheckFailure || (data.terminalCheckFailureAfterCommand && mergeCount() > 0);
  write({
    autoMergeRequest:
      pending && (data.pendingKind === "auto_merge" || data.pendingKind === "queue")
        ? { enabledAt: "2026-07-13T07:30:00Z", mergeMethod: "SQUASH" }
        : null,
    baseRefName:
      absoluteFinalSnapshot && data.postPolicyDrift === "base" ? "release" : "main",
    headRefOid:
      absoluteFinalSnapshot && data.postPolicyDrift === "view_head"
        ? data.wrongHeadSha
        : data.headSha,
    isDraft: false,
    isInMergeQueue: pending && data.pendingKind === "queue",
    mergeable: data.mergeable,
    mergeCommit: null,
    mergeStateStatus:
      absoluteFinalSnapshot && data.postPolicyDrift === "readiness" ? "BLOCKED" : "CLEAN",
    mergedAt: null,
    reviewDecision: null,
    state: "OPEN",
    statusCheckRollup: data.legacyStatusContextSuccess
      ? [{ context: "test", state: "SUCCESS" }]
      : [
          {
            name: "test",
            status: "COMPLETED",
            conclusion: data.terminalCheckMissingConclusion
              ? null
              : terminalCheckFailure
                ? "FAILURE"
                : "SUCCESS",
          },
        ],
    title: "Exact merge candidate",
    updatedAt: "2026-07-13T07:00:00Z",
    url: "https://github.com/openclaw/openclaw/pull/101",
  });
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "merge") {
  const count = mergeCount() + 1;
  fs.writeFileSync(data.mergeCountPath, String(count));
  const subjectIndex = args.indexOf("--subject");
  const bodyFileIndex = args.indexOf("--body-file");
  const subject = subjectIndex >= 0 ? args[subjectIndex + 1] : "";
  const body =
    bodyFileIndex >= 0 ? fs.readFileSync(args[bodyFileIndex + 1], "utf8").trimEnd() : "";
  fs.writeFileSync(data.mergeMessagePath, body ? subject + "\\n\\n" + body : subject);
  if (["ambiguous_exact", "ambiguous_unconfirmed"].includes(data.mergeMode)) {
    process.stderr.write("gh: HTTP 502: Bad Gateway\\n");
    process.exit(1);
  }
  if (data.mergeMode === "timeout_unconfirmed") {
    process.stderr.write("gh: ETIMEDOUT while waiting for api.github.com\\n");
    process.exit(1);
  }
  if (data.mergeMode === "definitive_rejection") {
    process.stderr.write("GraphQL: Pull Request is not mergeable (mergePullRequest)\\n");
    process.exit(1);
  }
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + JSON.stringify(args) + "\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );

  return {
    root,
    binDir,
    jobPath,
    resultPath,
    reportPath,
    ghLogPath,
    mergeCountPath,
    mergeClaimPath,
    unrelatedDriftPath,
    ledgerRoot,
    ledgerOutputRoot,
    headSha,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function runMergeApplyResult(
  fixture: MergeFixture,
  options: {
    retryAttempts?: number;
    runAttempt?: number;
    dryRun?: boolean;
    omitClaimIdentity?: boolean;
    actionLedgerInvocation?: string;
  } = {},
) {
  execFileSync(
    process.execPath,
    [
      "dist/repair/apply-result.js",
      fixture.jobPath,
      fixture.resultPath,
      ...(options.dryRun ? ["--dry-run"] : []),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOW_MERGE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        CLAWSWEEPER_APP_SLUG: "openclaw-clawsweeper",
        CLAWSWEEPER_AUTHENTICATED_APP_ID: options.omitClaimIdentity ? "" : "3306130",
        CLAWSWEEPER_AUTHENTICATED_APP_SLUG: options.omitClaimIdentity ? "" : "openclaw-clawsweeper",
        CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID: "7001",
        CLAWSWEEPER_RULESET_APP_ID: "3306130",
        CLAWSWEEPER_RULESET_APP_SLUG: "openclaw-clawsweeper",
        CLAWSWEEPER_RULESET_GH_TOKEN: "ruleset-token",
        CLAWSWEEPER_RULESET_INSTALLATION_ID: "7001",
        CLAWSWEEPER_GH_RETRY_ATTEMPTS: String(options.retryAttempts ?? 1),
        CLAWSWEEPER_WORKFLOW_GH_TOKEN: "workflow-read-token",
        GITHUB_RUN_ATTEMPT: String(options.runAttempt ?? 1),
        GITHUB_RUN_ID: "9001",
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        ...(options.actionLedgerInvocation
          ? {
              CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
              CLAWSWEEPER_ACTION_LEDGER_ROOT: fixture.ledgerRoot,
              CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: fixture.ledgerOutputRoot,
              CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
              CLAWSWEEPER_ACTION_LEDGER_INVOCATION: options.actionLedgerInvocation,
              GITHUB_ACTION: "apply_result",
              GITHUB_JOB: "mutate",
              GITHUB_SHA: "f".repeat(40),
              GITHUB_WORKFLOW: "repair cluster worker",
              GITHUB_WORKFLOW_REF:
                "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
            }
          : {}),
        GH_TOKEN: "write-token",
        ...mockGhBinEnv(path.join(fixture.binDir, "gh.js")),
      },
      stdio: "pipe",
    },
  );
}

function readApplyReport(reportPath: string) {
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

function mergeCallCount(logPath: string): number {
  if (!fs.existsSync(logPath)) return 0;
  return ghCalls(logPath).filter((call) => call.args[0] === "pr" && call.args[1] === "merge")
    .length;
}

function restPullCallCount(logPath: string): number {
  return ghCalls(logPath).filter(
    (call) => call.args[0] === "api" && call.args[1] === "repos/openclaw/openclaw/pulls/101",
  ).length;
}

function pullRequestViewCallCount(logPath: string): number {
  return ghCalls(logPath).filter(
    (call) => call.args[0] === "pr" && call.args[1] === "view" && call.args[2] === "101",
  ).length;
}
