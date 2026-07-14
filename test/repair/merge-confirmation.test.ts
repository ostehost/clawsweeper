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

test("comment router replays a durable dispatched claim before closed-state exit", () => {
  const routerSource = readFileSync("src/repair/comment-router.ts", "utf8");
  const classifier = routerSource.slice(
    routerSource.indexOf("function classifyAutomergePass("),
    routerSource.indexOf("function classifyPassedAutomergeRepair("),
  );
  assert.match(classifier, /reason: "PR is not open"/);
  assert.ok(
    classifier.indexOf("classifyDispatchedMergeClaimReplay(command, pull)") <
      classifier.indexOf('reason: "PR is not open"'),
  );
  const replayClassifier = routerSource.slice(
    routerSource.indexOf("function classifyDispatchedMergeClaimReplay("),
    routerSource.indexOf("function classifyNeedsHuman("),
  );
  assert.match(
    replayClassifier,
    /if \(!pull\) return null;[\s\S]*inspectAutomergeMergeClaim\(command\)[\s\S]*claim\.status !== "existing" \|\| claim\.dispatched !== true[\s\S]*status: "ready"[\s\S]*action: "merge"/,
  );
  assert.match(replayClassifier, /status: claim\.status === "unknown" \? "waiting" : "blocked"/);
  const maintainerClassifier = routerSource.slice(
    routerSource.indexOf("function classifyMaintainerApprovedAutomerge("),
    routerSource.indexOf("function classifyDispatchedMergeClaimReplay("),
  );
  assert.match(
    maintainerClassifier,
    /classifyDispatchedMergeClaimReplay\(command, pull\)[\s\S]*reason: "PR is not open"/,
  );

  const executor = routerSource.slice(
    routerSource.indexOf("function executeAutomerge("),
    routerSource.indexOf("function rulesetPolicyReader()"),
  );
  assert.ok(
    executor.indexOf("observeExistingAutomergeEffect(command, view)") <
      executor.indexOf("validateAutomergeReadiness"),
  );
  assert.ok(
    executor.indexOf("priorClaim = inspectAutomergeMergeClaim(command)") <
      executor.indexOf("const stoppedReason = repairLoopStoppedReason(command)"),
    "a dispatched exact-head claim must reconcile even when a later stop signal is present",
  );
  assert.match(
    executor,
    /priorClaim\.status === "existing" && priorClaim\.dispatched === true[\s\S]*return reconcileClaimedAutomergeRequest\(/,
  );
  assert.ok(
    executor.indexOf("claimAutomergeMergeRequest(command)") <
      executor.indexOf("result = runGitHubSpawnMutation("),
  );
  assert.ok(
    executor.indexOf("reconcileClaimedAutomergeRequest(") <
      executor.indexOf("runGitHubSpawnMutation("),
    "an existing durable claim must reconcile instead of submitting the merge again",
  );
  const dualConfirmation = routerSource.slice(
    routerSource.indexOf("function confirmDualViewAutomergeEffectSnapshot("),
    routerSource.indexOf("function fetchAutomergeSquashCommitProof("),
  );
  assert.match(
    dualConfirmation,
    /confirmAutomergeEffectSnapshot\(snapshot, expectedHeadSha, proof\)[\s\S]*confirmAlreadyMergedPullRequest\([\s\S]*pull,[\s\S]*view/,
  );
  assert.match(
    dualConfirmation,
    /confirmation\.status === "waiting"[\s\S]*pendingReason: confirmation\.reason/,
  );
  const effectSnapshot = routerSource.slice(
    routerSource.indexOf("function fetchAutomergeEffectSnapshot("),
    routerSource.indexOf("function confirmDualViewAutomergeEffectSnapshot("),
  );
  assert.match(effectSnapshot, /"baseRefName"[\s\S]*"mergeCommit"[\s\S]*"mergedAt"/);
  assert.doesNotMatch(effectSnapshot, /if \(pull\.merged_at\) return/);
  assert.equal(
    routerSource.match(/confirmDualViewAutomergeEffectSnapshot\(/g)?.length,
    4,
    "the helper definition and all three automerge confirmation paths must use dual views",
  );
});

test("merge owners gate terminal success on the focused confirmation helpers", () => {
  const applySource = readFileSync("src/repair/apply-result.ts", "utf8");
  const applyOwner = applySource.slice(
    applySource.indexOf("function applyMergeAction("),
    applySource.indexOf("function rulesetPolicyReader()"),
  );
  const applyConfirmation = applySource.slice(
    applySource.indexOf("function confirmExactMergeSnapshot("),
    applySource.indexOf("function claimApplyMergeRequest("),
  );
  assert.match(
    applyConfirmation,
    /confirmAlreadyMergedPullRequest\(\{[\s\S]*expectedHeadSha: authorizedHeadSha,[\s\S]*pull: pullRequest,[\s\S]*view/,
  );
  assert.match(
    applyConfirmation,
    /confirmation\.status === "waiting"[\s\S]*pendingReason: confirmation\.reason[\s\S]*confirmation\.status !== "executed"[\s\S]*block: confirmation\.reason/,
  );
  assert.equal(
    applyOwner.match(/confirmExactMergeSnapshot\(/g)?.length,
    5,
    "every apply merge observation boundary must require the dual-view helper",
  );
  assert.match(
    applyOwner,
    /runRepairMutation\([\s\S]*return ghText\(mergeArgs\)[\s\S]*merged = fetchPullRequestOnce\(result\.repo, target\)[\s\S]*mergedView = fetchPullRequestViewOnce\(result\.repo, target\)[\s\S]*confirmExactMergeSnapshot\(merged, mergedView, authorizedHeadSha/,
  );
  assert.match(
    applyOwner,
    /if \(confirmation\.pendingReason\)[\s\S]*status: "blocked"[\s\S]*requeue_required: true/,
  );
  assert.match(applyOwner, /merge_commit_sha: confirmation\.mergeCommitSha/);

  const candidateCloseout = applySource.slice(
    applySource.indexOf("function validateMergedCandidateFix("),
    applySource.indexOf("function validateResolvedReviewThreads("),
  );
  assert.match(
    candidateCloseout,
    /fetchPullRequest[\s\S]*fetchPullRequestView[\s\S]*pullRequestMainBaseBlock[\s\S]*restPullRequestMergeConfirmed[\s\S]*graphqlPullRequestMergeConfirmed/,
  );

  const routerSource = readFileSync("src/repair/comment-router.ts", "utf8");
  const routerConfirmation = routerSource.slice(
    routerSource.indexOf("function confirmDualViewAutomergeEffectSnapshot("),
    routerSource.indexOf("function fetchAutomergeSquashCommitProof("),
  );
  assert.match(
    routerConfirmation,
    /confirmAlreadyMergedPullRequest\(\{[\s\S]*expectedHeadSha,[\s\S]*pull,[\s\S]*view/,
  );

  const postFlightSource = readFileSync("src/repair/post-flight.ts", "utf8");
  const postFlightConfirmation = postFlightSource.slice(
    postFlightSource.indexOf("function confirmPostFlightMergeSnapshot("),
    postFlightSource.indexOf("function confirmMergedPullSnapshot("),
  );
  assert.match(
    postFlightConfirmation,
    /confirmAlreadyMergedPullRequest\(\{[\s\S]*expectedHeadSha,[\s\S]*pull,[\s\S]*view/,
  );
});
