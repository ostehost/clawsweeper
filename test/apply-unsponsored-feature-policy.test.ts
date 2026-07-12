import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";

const maintainerDecision = {
  required: true,
  kind: "product_direction",
  question: "Should a maintainer sponsor this feature direction?",
  rationale: "Core implementation needs an explicit product owner.",
  options: [
    {
      title: "Sponsor",
      body: "Keep the request open with a maintainer owner.",
      recommended: false,
    },
    {
      title: "Leave unsponsored",
      body: "Close until a maintainer sponsors the direction.",
      recommended: true,
    },
  ],
  likelyOwner: {
    person: "@alice",
    reason: "Recent history shows ownership of this product area.",
    confidence: "high",
  },
};

function unsponsoredCloseReport(overrides = {}) {
  return `${workPlanCandidateReport({
    repository: "openclaw/openclaw",
    type: "issue",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "unsponsored_feature_request",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-01-01T00:00:00Z",
    item_updated_at: "2026-01-01T00:00:00Z",
    author_association: "CONTRIBUTOR",
    item_category: "feature",
    requires_product_decision: "true",
    maintainer_decision: JSON.stringify(maintainerDecision),
    ...overrides,
  })}

## Evidence

- **product direction:** No maintainer has sponsored this old feature request.

## Close Comment

This is not planned unless a maintainer sponsors the direction. Reopening is welcome if that changes.
`;
}

function staleInsufficientInfoCloseReport(overrides = {}) {
  return `${workPlanCandidateReport({
    repository: "openclaw/openclaw",
    type: "issue",
    decision: "close",
    action_taken: "proposed_close",
    close_reason: "stale_insufficient_info",
    confidence: "high",
    work_candidate: "none",
    work_status: "none",
    item_snapshot_hash: "reviewed-snapshot",
    item_created_at: "2026-01-01T00:00:00Z",
    item_updated_at: "2026-01-01T00:00:00Z",
    author_association: "CONTRIBUTOR",
    item_category: "bug",
    ...overrides,
  })}

## Evidence

- **current verification:** The old report cannot be verified against current main.

## Close Comment

Please open a new issue with current reproduction details if this still occurs.
`;
}

function unsponsoredApplyGhMock(reviewComment: string, options: { recentHuman?: boolean } = {}) {
  const recentHuman = options.recentHuman
    ? `,{
      id: 9901,
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9901",
      created_at: ${JSON.stringify(new Date().toISOString())},
      updated_at: ${JSON.stringify(new Date().toISOString())},
      author_association: "NONE",
      user: { login: "community-member", type: "User" },
      body: "I can still reproduce the need for this feature."
    }`
    : "";
  return `
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const path = args[1] || "";
if (args[0] === "api" && args[1] === "-i" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(args[2] || "")) {
  console.log("HTTP/2 200\\n\\n[]");
} else if (args[0] === "api" && /\\/issues\\/321\\/comments(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[{
    id: 9321,
    html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
    created_at: "2026-01-01T01:00:00Z",
    updated_at: "2026-01-01T01:00:00Z",
    author_association: "NONE",
    user: { login: "clawsweeper[bot]", type: "Bot" },
    body: ${JSON.stringify(reviewComment)}
  }${recentHuman}]]));
} else if (args[0] === "api" && /\\/issues\\/321\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify([[]]));
} else if (args[0] === "api" && /\\/issues\\/321$/.test(path)) {
  console.log(JSON.stringify({
    number: 321,
    title: "Old unsponsored feature request",
    html_url: "https://github.com/openclaw/openclaw/issues/321",
    body: "Please add this optional feature.",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    assignees: [],
    milestone: null,
    reactions: { total_count: 0 },
    comments: ${options.recentHuman ? 2 : 1},
    pull_request: null
  }));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "label" || args[0] === "issue") {
  console.log("");
} else if (args[0] === "api" && args.includes("--method")) {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
}

function runUnsponsoredApply(options: {
  gateEnabled: boolean;
  recentHuman?: boolean;
  closeReason?: "unsponsored_feature_request" | "stale_insufficient_info";
}) {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const closeReason = options.closeReason ?? "unsponsored_feature_request";
    const report =
      closeReason === "unsponsored_feature_request"
        ? unsponsoredCloseReport({ number: 321, title: "Old unsponsored feature request" })
        : staleInsufficientInfoCloseReport({ number: 321, title: "Old unverifiable bug" });
    const synced = reportWithSyncedReviewComment(report, 321, closeReason);
    const itemPath = join(itemsDir, "321.md");
    writeFileSync(
      itemPath,
      options.gateEnabled
        ? synced.report
        : synced.report.replace(/^review_comment_sha256:.*$/m, "review_comment_sha256: stale"),
      "utf8",
    );

    const original = process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED;
    if (options.gateEnabled) {
      process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED = "true";
    } else {
      delete process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED;
    }
    try {
      withMockGh(root, unsponsoredApplyGhMock(synced.comment, options), () => {
        runApplyDecisionsForTest({
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: [
            "--target-repo",
            "openclaw/openclaw",
            "--apply-kind",
            "issue",
            "--item-number",
            "321",
            "--processed-limit",
            "1",
            "--skip-dashboard",
            "--dry-run",
          ],
        });
      });
    } finally {
      if (original === undefined) {
        delete process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED;
      } else {
        process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED = original;
      }
    }

    return {
      entries: JSON.parse(readFileSync(reportPath, "utf8")) as Array<{
        number: number;
        action: string;
        reason: string;
      }>,
      markdown: readFileSync(itemPath, "utf8"),
      closedExists: existsSync(join(closedDir, "321.md")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("unsponsored feature apply gate is default-off without consuming the proposal", () => {
  const result = runUnsponsoredApply({ gateEnabled: false });
  assert.deepEqual(result.entries, [
    {
      number: 321,
      action: "kept_open",
      reason: "unsponsored feature-request apply policy is disabled",
    },
  ]);
  assert.match(result.markdown, /^action_taken: proposed_close$/m);
  assert.equal(result.closedExists, false);
});

test("unsponsored feature apply accepts an old inactive unsponsored issue", () => {
  const result = runUnsponsoredApply({ gateEnabled: true });
  assert.equal(result.entries[0]?.action, "closed");
  assert.match(
    result.entries[0]?.reason ?? "",
    /would close as feature request without maintainer sponsorship/,
  );
});

test("unsponsored feature apply blocks a recent human comment", () => {
  const result = runUnsponsoredApply({ gateEnabled: true, recentHuman: true });
  assert.deepEqual(result.entries, [
    {
      number: 321,
      action: "kept_open",
      reason: "issue has a non-bot comment within the last 60 days",
    },
  ]);
  assert.equal(result.closedExists, false);
});

test("stale-insufficient-info apply blocks a recent non-bot comment", () => {
  const result = runUnsponsoredApply({
    gateEnabled: true,
    recentHuman: true,
    closeReason: "stale_insufficient_info",
  });
  assert.deepEqual(result.entries, [
    {
      number: 321,
      action: "kept_open",
      reason: "issue has a non-bot comment within the last 60 days",
    },
  ]);
});

test("stale-insufficient-info apply allows old bot-only comment history", () => {
  const result = runUnsponsoredApply({
    gateEnabled: true,
    closeReason: "stale_insufficient_info",
  });
  assert.equal(result.entries[0]?.action, "closed");
});
