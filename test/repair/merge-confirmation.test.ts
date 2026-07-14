import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  confirmAlreadyMergedPullRequest,
  graphqlPullRequestMergeConfirmed,
  pullRequestMainBaseBlock,
  restPullRequestMergeConfirmed,
} from "../../dist/repair/merge-confirmation.js";

const reviewedHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const mergeCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function mergedRestPull(overrides = {}) {
  return {
    state: "closed",
    merged_at: "2026-07-13T20:00:00Z",
    base: { ref: "main" },
    head: { sha: reviewedHead },
    merge_commit_sha: mergeCommit,
    ...overrides,
  };
}

function mergedGraphqlPull(overrides = {}) {
  return {
    state: "MERGED",
    mergedAt: "2026-07-13T20:00:00Z",
    baseRefName: "main",
    headRefOid: reviewedHead,
    mergeCommit: { oid: mergeCommit },
    ...overrides,
  };
}

test("already-merged replay confirms both GitHub views and the durable reviewed head", () => {
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull(),
      view: mergedGraphqlPull(),
    }),
    {
      status: "executed",
      reason: "pull request is confirmed merged after the recorded ClawSweeper merge request",
      mergedAt: "2026-07-13T20:00:00Z",
      mergeCommitSha: mergeCommit,
      headSha: reviewedHead,
    },
  );
});

test("already-merged replay waits for dual-view convergence without merging again", () => {
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull(),
      view: mergedGraphqlPull({ state: "OPEN", mergedAt: null }),
    }),
    {
      status: "waiting",
      reason: "waiting for both GitHub pull request views to confirm the previous merge",
    },
  );
  assert.equal(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({ state: "open", merged_at: null }),
      view: mergedGraphqlPull({ state: "OPEN", mergedAt: null }),
    }),
    null,
  );
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({ state: "open", merged_at: null, base: { ref: "release" } }),
      view: mergedGraphqlPull({ state: "OPEN", mergedAt: null, baseRefName: "release" }),
    }),
    { status: "blocked", reason: "pull request base is not main" },
  );
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({
        state: "open",
        merged_at: null,
        head: { sha: "cccccccccccccccccccccccccccccccccccccccc" },
      }),
      view: mergedGraphqlPull({
        state: "OPEN",
        mergedAt: null,
        headRefOid: "cccccccccccccccccccccccccccccccccccccccc",
      }),
    }),
    {
      status: "blocked",
      reason: "pull request head does not match the durable reviewed head SHA",
    },
  );
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({ state: "closed", merged_at: null }),
      view: mergedGraphqlPull({ state: "CLOSED", mergedAt: null }),
    }),
    {
      status: "not_merged",
      reason: "pull request closed without a confirmed merge",
    },
  );
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({ state: "closed", merged_at: null }),
      view: mergedGraphqlPull({ state: "OPEN", mergedAt: null }),
    }),
    {
      status: "waiting",
      reason: "waiting for GitHub pull request state views to converge",
    },
  );
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({ state: "", merged_at: null }),
      view: mergedGraphqlPull({ state: "", mergedAt: null }),
    }),
    {
      status: "blocked",
      reason: "GitHub pull request views returned an unknown unmerged state",
    },
  );
});

test("already-merged replay fails closed on base, head, or merge identity drift", () => {
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({ base: { ref: "release" } }),
      view: mergedGraphqlPull(),
    }),
    { status: "blocked", reason: "pull request base is not main" },
  );
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({ head: { sha: "cccccccccccccccccccccccccccccccccccccccc" } }),
      view: mergedGraphqlPull(),
    }),
    {
      status: "blocked",
      reason: "pull request head does not match the durable reviewed head SHA",
    },
  );
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({ merge_commit_sha: null }),
      view: mergedGraphqlPull(),
    }),
    {
      status: "waiting",
      reason: "waiting for both GitHub pull request views to confirm the merge commit SHA",
    },
  );
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull({ merge_commit_sha: "not-a-sha" }),
      view: mergedGraphqlPull(),
    }),
    {
      status: "blocked",
      reason: "GitHub pull request views returned an invalid merge commit SHA",
    },
  );
  assert.deepEqual(
    confirmAlreadyMergedPullRequest({
      expectedHeadSha: reviewedHead,
      pull: mergedRestPull(),
      view: mergedGraphqlPull({
        mergeCommit: { oid: "dddddddddddddddddddddddddddddddddddddddd" },
      }),
    }),
    {
      status: "blocked",
      reason: "GitHub pull request views disagree on the merge commit SHA",
    },
  );
});

test("merge confirmation rejects successful commands that only queue a merge", () => {
  assert.equal(restPullRequestMergeConfirmed({ state: "open", merged_at: null }), false);
  assert.equal(graphqlPullRequestMergeConfirmed({ state: "OPEN", mergedAt: null }), false);
  assert.equal(
    restPullRequestMergeConfirmed({
      state: "closed",
      merged_at: "2026-07-13T20:00:00Z",
    }),
    true,
  );
  assert.equal(
    graphqlPullRequestMergeConfirmed({
      state: "MERGED",
      mergedAt: "2026-07-13T20:00:00Z",
    }),
    true,
  );
});

test("already-merged confirmation rejects off-main and disagreeing live bases", () => {
  const mergedPull = {
    state: "closed",
    merged_at: "2026-07-13T20:00:00Z",
    base: { ref: "main" },
  };
  const mergedView = {
    state: "MERGED",
    mergedAt: "2026-07-13T20:00:00Z",
    baseRefName: "main",
  };

  assert.equal(pullRequestMainBaseBlock(mergedPull, mergedView), "");
  assert.equal(
    pullRequestMainBaseBlock(
      { ...mergedPull, base: { ref: "release" } },
      { ...mergedView, baseRefName: "release" },
    ),
    "pull request base is not main",
  );
  assert.equal(
    pullRequestMainBaseBlock(mergedPull, { ...mergedView, baseRefName: "release" }),
    "pull request base is not main",
  );
  assert.equal(
    pullRequestMainBaseBlock({ ...mergedPull, base: undefined }, mergedView),
    "pull request base is not main",
  );
});

test("comment router replays only a durable waiting merge before open-state readiness", () => {
  const routerSource = readFileSync("src/repair/comment-router.ts", "utf8");
  const classifier = routerSource.slice(
    routerSource.indexOf("function classifyAutomergePass("),
    routerSource.indexOf("function classifyPassedAutomergeRepair("),
  );
  assert.match(
    classifier,
    /classifyWaitingMergeReplay\(command, pull\)[\s\S]*reason: "PR is not open"/,
  );
  assert.ok(
    classifier.indexOf("classifyWaitingMergeReplay(command, pull)") <
      classifier.indexOf('reason: "PR is not open"'),
  );
  const replayClassifier = routerSource.slice(
    routerSource.indexOf("function classifyWaitingMergeReplay("),
    routerSource.indexOf("function classifyNeedsHuman("),
  );
  assert.match(
    replayClassifier,
    /if \(!pull\) return null;[\s\S]*waitingMergeReplay\(ledger, command\)[\s\S]*mergeMutationReceiptStatus\(prior\)[\s\S]*expected_head_sha: prior\.expected_head_sha[\s\S]*status: "ready"[\s\S]*action: "merge"[\s\S]*merge_mutation_status: mergeMutationStatus/,
  );
  assert.doesNotMatch(replayClassifier, /issue\.state/);
  const maintainerClassifier = routerSource.slice(
    routerSource.indexOf("function classifyMaintainerApprovedAutomerge("),
    routerSource.indexOf("function classifyWaitingMergeReplay("),
  );
  assert.match(
    maintainerClassifier,
    /classifyWaitingMergeReplay\(command, pull\)[\s\S]*reason: "PR is not open"/,
  );

  const executor = routerSource.slice(
    routerSource.indexOf("function executeAutomerge("),
    routerSource.indexOf("function rulesetPolicyReader()"),
  );
  assert.match(
    executor,
    /fetchPullRequestView\(command\.issue_number\)[\s\S]*fetchPullRequest\(command\.issue_number\)[\s\S]*confirmAlreadyMergedPullRequest/,
  );
  assert.ok(
    executor.indexOf("confirmAlreadyMergedPullRequest") <
      executor.indexOf("validateAutomergeReadiness"),
  );
  assert.match(
    executor,
    /alreadyMerged\.status === "executed" && !acceptedMergeMutationReceipt[\s\S]*status: "skipped"[\s\S]*already merged without a recorded accepted ClawSweeper merge request/,
  );
  const acceptedReplayWait = executor.slice(
    executor.indexOf("if (acceptedMergeMutationReceipt || uncertainMergeMutationReceipt)"),
    executor.indexOf("let latestTarget ="),
  );
  assert.match(
    acceptedReplayWait,
    /status: "waiting"[\s\S]*waiting for GitHub to confirm the recorded accepted merge request[\s\S]*waiting for GitHub to resolve the recorded merge attempt with an unknown outcome[\s\S]*merge_mutation_status: mergeMutationStatus/,
  );
  assert.ok(
    executor.indexOf("if (acceptedMergeMutationReceipt || uncertainMergeMutationReceipt)") <
      executor.indexOf("validateAutomergeReadiness"),
  );
  assert.ok(
    executor.indexOf("if (acceptedMergeMutationReceipt || uncertainMergeMutationReceipt)") <
      executor.indexOf("runGitHubSpawnMutation("),
    "an accepted or uncertain replay must reconcile instead of submitting the merge again",
  );
});

test("merge owners gate terminal success on the focused confirmation helpers", () => {
  const applySource = readFileSync("src/repair/apply-result.ts", "utf8");
  const applyOwner = applySource.slice(
    applySource.indexOf("function applyMergeAction("),
    applySource.indexOf("function rulesetPolicyReader()"),
  );
  const applyPostMerge = applyOwner.slice(applyOwner.indexOf("ghWithRetry(mergeArgs);"));
  assert.match(
    applyPostMerge,
    /const merged = fetchPullRequest[\s\S]*const mergedView = fetchPullRequestView/,
  );
  assert.match(
    applyPostMerge,
    /!restPullRequestMergeConfirmed\(merged\)[\s\S]*!graphqlPullRequestMergeConfirmed\(mergedView\)[\s\S]*status: "blocked"/,
  );
  assert.match(applyPostMerge, /requeue_required: true/);

  const candidateCloseout = applySource.slice(
    applySource.indexOf("function validateMergedCandidateFix("),
    applySource.indexOf("function validateResolvedReviewThreads("),
  );
  assert.match(
    candidateCloseout,
    /fetchPullRequest[\s\S]*fetchPullRequestView[\s\S]*pullRequestMainBaseBlock[\s\S]*restPullRequestMergeConfirmed[\s\S]*graphqlPullRequestMergeConfirmed/,
  );

  const alreadyMerged = applyOwner.slice(
    applyOwner.indexOf("const mergedAt = pullRequest.merged_at"),
    applyOwner.indexOf("const lockedSkip ="),
  );
  assert.match(
    alreadyMerged,
    /pullRequestMainBaseBlock\(pullRequest, view\)[\s\S]*reason: "already merged"/,
  );

  const routerSource = readFileSync("src/repair/comment-router.ts", "utf8");
  const routerOwner = routerSource.slice(
    routerSource.indexOf("function executeAutomerge("),
    routerSource.indexOf(
      "function rulesetPolicyReader()",
      routerSource.indexOf("function executeAutomerge("),
    ),
  );
  const routerMutation = routerOwner.slice(
    routerOwner.indexOf('persistMergeMutationReceipt(command, "attempted")'),
  );
  assert.match(
    routerMutation,
    /persistMergeMutationReceipt\(command, "attempted"\)[\s\S]*runGitHubSpawnMutation\([\s\S]*ghSpawnMutationOutcome\(result\)[\s\S]*persistMergeMutationReceipt\(command, mutationReceiptStatus\)[\s\S]*const mergedPull = fetchPullRequest[\s\S]*const mergedView = fetchPullRequestView[\s\S]*confirmAlreadyMergedPullRequest\([\s\S]*expectedHeadSha: command\.expected_head_sha/,
  );
  assert.match(routerMutation, /merge_mutation_status: mutationReceiptStatus/);
  assert.match(routerMutation, /retry_recommended: true/);
  assert.doesNotMatch(routerMutation, /mergedAt \?\? new Date\(\)\.toISOString\(\)/);
  assert.ok(
    routerMutation.indexOf('persistMergeMutationReceipt(command, "attempted")') <
      routerMutation.indexOf("runGitHubSpawnMutation("),
    "the attempted receipt must be durable before the merge subprocess starts",
  );
  assert.ok(
    routerMutation.indexOf("persistMergeMutationReceipt(command, mutationReceiptStatus)") <
      routerMutation.indexOf('if (mutationReceiptStatus === "rejected")'),
    "the observed outcome must be durable before failure handling",
  );
  assert.ok(
    routerMutation.indexOf("persistMergeMutationReceipt(command, mutationReceiptStatus)") <
      routerMutation.indexOf("const mergedPull = fetchPullRequest"),
    "the observed outcome must be durable before post-mutation GitHub lookups",
  );
  const receiptWriter = routerOwner.slice(
    routerOwner.indexOf("function persistMergeMutationReceipt("),
    routerOwner.indexOf("function rulesetPolicyReader()"),
  );
  assert.match(
    receiptWriter,
    /"attempted" \| "accepted" \| "unknown" \| "rejected"[\s\S]*status: "waiting"[\s\S]*merge_mutation_status: mergeMutationStatus[\s\S]*appendLedger\(ledger, \[receipt\]\)[\s\S]*writeLedger\(ledgerPath\(\), ledger\)[\s\S]*publishDurableMergeMutationReceipt\(command, mergeMutationStatus\)/,
  );
  const durableReceiptWriter = receiptWriter.slice(
    receiptWriter.indexOf("function publishDurableMergeMutationReceipt("),
  );
  assert.match(
    durableReceiptWriter,
    /CLAWSWEEPER_STATE_DIR[\s\S]*writeReportFile\(repoRoot\(\)[\s\S]*publishMainCommit\(\{[\s\S]*paths: \["results\/comment-router\.json", "results\/comment-router-latest\.json", "jobs"\][\s\S]*rebaseStrategy: "comment-router-ledger"/,
  );
  assert.match(
    durableReceiptWriter,
    /publishMainCommit\([\s\S]*readLedger\([\s\S]*stateDir[\s\S]*entry\.repo[\s\S]*entry\.idempotency_key[\s\S]*entry\.comment_version_key[\s\S]*entry\.attempt_id[\s\S]*entry\.expected_head_sha[\s\S]*mergeMutationReceiptStatus\(entry as LooseRecord\) === mergeMutationStatus/,
  );

  const postFlightSource = readFileSync("src/repair/post-flight.ts", "utf8");
  const postFlightOwner = postFlightSource.slice(
    postFlightSource.indexOf("function finalizeFixPr("),
    postFlightSource.indexOf("function rulesetPolicyReader()"),
  );
  const postFlightPostMerge = postFlightOwner.slice(
    postFlightOwner.indexOf("ghWithRetry(mergeArgs);"),
  );
  assert.match(
    postFlightPostMerge,
    /const merged = fetchPullRequest[\s\S]*const mergedView = fetchPullRequestView/,
  );
  assert.match(
    postFlightPostMerge,
    /pullRequestMainBaseBlock\(merged, mergedView\)[\s\S]*!restPullRequestMergeConfirmed\(merged\)[\s\S]*!graphqlPullRequestMergeConfirmed\(mergedView\)[\s\S]*status: "blocked"/,
  );
});
