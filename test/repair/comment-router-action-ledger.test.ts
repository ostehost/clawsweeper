import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("comment router records receipts after durable command boundaries", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.match(source, /rawCommands\.push\(command\);\s+recordCommandReceived\(command\);/);
  assert.match(
    source,
    /writeLedger\(ledgerPath\(\), ledger\);\s+for \(const command of claimedCommands\) recordCommandClaimed\(command\);/,
  );
  assert.match(
    source,
    /writeLedger\(ledgerPath\(\), ledger\);\s+for \(const key of dispatchClaimLookupKeys\(claim\)\) priorDispatchClaims\.set\(key, claim\);\s+recordCommandClaimRefreshed\(claim\);/,
  );
  assert.match(
    source,
    /function executeCommandWithReceipt[\s\S]*executeCommand\(command\);\s+recordCommandOutcome\(command\);[\s\S]*recordCommandFailure\(command, error\);/,
  );
  assert.match(source, /await flushCommandActionEvents\(\);/);
});

test("comment router wraps every GitHub mutation at the request boundary", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.equal(source.match(/\bghText\(/g)?.length, 2);
  assert.equal(source.match(/\bresult = ghSpawn\(/g)?.length, 1);
  assert.doesNotMatch(source, /\bghBestEffort\b/);
  assert.doesNotMatch(source, /ghTextWithRetry as ghText/);
  assert.match(source, /function runGitHubTextMutation[\s\S]*runCommandMutationWithRetry/);
  assert.match(source, /function runGitHubBestEffortMutation[\s\S]*runGitHubTextMutationOnce/);
  assert.match(source, /function runGitHubSpawnMutation[\s\S]*runCommandMutation/);
  for (const kind of [
    "label_create",
    "label_add",
    "label_remove",
    "description_update",
    "reaction_add",
    "reaction_delete",
    "ack_comment_update",
    "ack_comment_delete",
    "comment_create",
    "comment_update",
    "pull_request_close",
    "issue_close",
    "pull_request_merge",
    "review_dispatch",
    "assist_dispatch",
    "repair_dispatch",
  ]) {
    assert.match(source, new RegExp(`"${kind}"`), kind);
  }
});

test("exact comment convergence classifies a missing comment as no mutation", () => {
  const source = readText("src/repair/comment-router.ts");
  const fastPath = source.slice(source.indexOf("function convergeExactCommentVersionFastPathAck"));

  assert.match(source, /function githubNotFoundNoMutation[\s\S]*isGitHubNotFoundError\(error\)/);
  assert.match(
    fastPath,
    /"ack_comment_update"[\s\S]*githubNotFoundNoMutation[\s\S]*return "already_converged"/,
  );
});

test("forced replay attempt identity flows through the production workflow", () => {
  const source = readText("src/repair/comment-router.ts");
  const workflow = readText(".github/workflows/repair-comment-router.yml");

  assert.match(source, /forcedReplayCommandFields\(\{ forceReprocess, attemptId \}\)/);
  assert.match(workflow, /attempt_id:/);
  assert.match(workflow, /attempt_id="forced-replay-\$\{GITHUB_RUN_ID\}"/);
  assert.equal(workflow.match(/args\+=\(--attempt-id "\$attempt_id"\)/g)?.length, 2);
});

test("command receipt identity excludes list position and binds command attempts", () => {
  const source = readText("src/repair/command-action-ledger.ts");

  assert.match(source, /idempotencyKey: String\(command\.idempotency_key/);
  assert.match(source, /commentBodySha256: sha256OrNull\(command\.comment_body_sha256\)/);
  assert.match(source, /const attemptId = commandDurableAttemptId\(command\)/);
  assert.match(source, /\.\.\.\(attemptId \? \{ attemptId \} : \{\}\)/);
  assert.match(source, /durableAttemptId: commandDurableAttemptId\(command\)/);
  assert.match(source, /invocation: String\(process\.env\.CLAWSWEEPER_ACTION_LEDGER_INVOCATION/);
  assert.doesNotMatch(source, /\bindex\b/);
});

test("automerge reconciles command responses inside the merge receipt without certifying ambiguous methods", () => {
  const source = readText("src/repair/comment-router.ts");
  const executeAutomerge = source.slice(
    source.indexOf("function executeAutomerge("),
    source.indexOf("function automergeReadinessAction("),
  );

  assert.match(
    executeAutomerge,
    /result = runGitHubSpawnMutation\([\s\S]*buildAutomergeMergeArgs\([\s\S]*onDispatchStart:[\s\S]*reconcile:/,
  );
  assert.match(executeAutomerge, /knownNoMutation: \(\) => !mergeRequestStarted/);
  assert.match(
    executeAutomerge,
    /reconcile: \(\{ result: commandResult, error: commandError \}\) => \{[\s\S]*fetchAutomergeEffectSnapshot\(command\.issue_number\)[\s\S]*fetchAutomergeSquashCommitProof\([\s\S]*expectedSquashCommitMessage\(mergeMessage\.subject, mergeMessage\.body\)/,
  );
  assert.match(
    executeAutomerge,
    /confirmAutomergeEffectSnapshot\([\s\S]*command\.expected_head_sha,[\s\S]*squashCommitProof \? \{ squashCommit: squashCommitProof \} : \{\}[\s\S]*outcome: automergeAttemptReceiptOutcome/,
  );
  assert.doesNotMatch(executeAutomerge, /"merge confirmed after ambiguous response"/);
  assert.match(
    source,
    /function fetchAutomergeEffectSnapshot[\s\S]*repos\/\$\{targetRepo\}\/pulls\/\$\{number\}[\s\S]*attempts: 1[\s\S]*"pr",[\s\S]*"view"[\s\S]*"isInMergeQueue"[\s\S]*attempts: 1/,
  );
  assert.match(
    source,
    /function fetchAutomergeSquashCommitProof[\s\S]*repos\/\$\{targetRepo\}\/commits\/\$\{mergeCommitSha\}/,
  );
  assert.match(
    source,
    /function claimAutomergeMergeRequest[\s\S]*dispatchedClaimEffectAbsent:[\s\S]*requireSquashMethod: false/,
  );
  assert.match(executeAutomerge, /outcome: automergeAttemptReceiptOutcome/);
  assert.match(
    executeAutomerge,
    /automergeUnconfirmedFailureDisposition\(result\) === "waiting"[\s\S]*status: "waiting"/,
  );
  assert.match(
    executeAutomerge,
    /rejectAutomergeMergeClaim\(command, mergeClaim\.claimId\)[\s\S]*status !== "rejected"[\s\S]*ensureMergeReadyLabel\(command\)/,
  );
  assert.match(
    source,
    /function rejectAutomergeMergeClaim[\s\S]*rejectExactHeadMergeClaim[\s\S]*isTrustedExactHeadMergeClaimRejectionComment/,
  );
  assert.match(
    source,
    /const merge = executeAutomerge\(command\);[\s\S]*if \(applyAutomergeResultToCommand\(command, merge\)\) return;/,
  );
});

test("automerge blocks a merged REST snapshot from the wrong head", () => {
  const confirmation = readText("src/repair/automerge-effect.ts");

  assert.match(confirmation, /pull\.merged_at/);
  assert.match(confirmation, /pull\.head\?\.sha/);
  assert.match(
    confirmation,
    /observed !== expected[\s\S]*merged pull request head does not match the authorized automerge head/,
  );
  assert.match(
    confirmation,
    /if \(mergedAt\)[\s\S]*squashMergedMethodBlock[\s\S]*block: methodBlock/,
  );
});

test("automerge observes exact-head queue state before issuing another merge", () => {
  const source = readText("src/repair/comment-router.ts");
  const executeAutomerge = source.slice(
    source.indexOf("function executeAutomerge("),
    source.indexOf("function automergeReadinessAction("),
  );
  const hardCheck = executeAutomerge.indexOf("validateAutomergeHardReadiness({");
  const strictBaseCheck = executeAutomerge.indexOf("runtimeStrictBaseBindingBlock({");
  const pendingCheck = executeAutomerge.indexOf("exactHeadAutomergePendingReason(command, view)");
  const readinessCheck = executeAutomerge.indexOf("validateAutomergeReadiness({");
  const gateAction = executeAutomerge.indexOf("if (gateBlock) {");
  const mergeCall = executeAutomerge.indexOf("result = runGitHubSpawnMutation(");

  assert.ok(hardCheck >= 0);
  assert.ok(strictBaseCheck > hardCheck);
  assert.ok(pendingCheck > strictBaseCheck);
  assert.ok(readinessCheck > pendingCheck);
  assert.ok(gateAction > readinessCheck);
  assert.ok(mergeCall > pendingCheck);
  const finalHardCheck = executeAutomerge.indexOf("const finalHardBlock");
  const finalStrictBaseCheck = executeAutomerge.indexOf("const finalStrictBaseBindingBlock");
  const finalPendingCheck = executeAutomerge.indexOf("const finalPendingReason");
  const finalReadinessCheck = executeAutomerge.indexOf("const finalReadinessBlock");
  assert.ok(finalStrictBaseCheck > finalHardCheck);
  assert.ok(finalPendingCheck > finalStrictBaseCheck);
  assert.ok(finalReadinessCheck > finalPendingCheck);
  assert.match(
    source,
    /function exactHeadAutomergePendingReason[\s\S]*view\.headRefOid[\s\S]*currentHeadSha !== expectedHeadSha[\s\S]*view\.isInMergeQueue[\s\S]*view\.autoMergeRequest/,
  );
  assert.equal(source.match(/"isInMergeQueue"/g)?.length, 3);
  assert.equal(source.match(/"autoMergeRequest"/g)?.length, 3);
});

test("automerge fresh attempts reconcile a durable exact-head claim before merge", () => {
  const source = readText("src/repair/comment-router.ts");
  const executeAutomerge = source.slice(
    source.indexOf("function executeAutomerge("),
    source.indexOf("function automergeReadinessAction("),
  );
  const claim = executeAutomerge.indexOf("claimAutomergeMergeRequest(command)");
  const reconciliation = executeAutomerge.indexOf("reconcileClaimedAutomergeRequest(");
  const merge = executeAutomerge.indexOf("result = runGitHubSpawnMutation(");

  assert.ok(claim >= 0);
  assert.ok(reconciliation > claim);
  assert.ok(merge > reconciliation);
  assert.match(
    source,
    /function claimAutomergeMergeRequest[\s\S]*ensureExactHeadMergeClaim[\s\S]*"pull_request_merge_claim"/,
  );
  assert.match(
    source,
    /function reconcileClaimedAutomergeRequest[\s\S]*fetchAutomergeEffectSnapshot[\s\S]*status: "waiting"/,
  );
  assert.match(
    source,
    /function observeExistingAutomergeEffect[\s\S]*inspectAutomergeMergeClaim[\s\S]*claim\.expectedSquashMessage[\s\S]*fetchAutomergeSquashCommitProof/,
  );
  assert.match(
    source,
    /function reconcileClaimedAutomergeRequest[\s\S]*claim\.expectedSquashMessage[\s\S]*fetchAutomergeSquashCommitProof/,
  );
  assert.match(
    source,
    /markAutomergeMergeClaimDispatched\([\s\S]*expectedSquashCommitMessage\(mergeMessage\.subject, mergeMessage\.body\)/,
  );
});

test("trusted verdict automerge rechecks reviewed PR activity around the merge claim", () => {
  const source = readText("src/repair/comment-router.ts");
  const executeAutomerge = source.slice(
    source.indexOf("function executeAutomerge("),
    source.indexOf("function automergeReadinessAction("),
  );
  const first = executeAutomerge.indexOf(
    "const reviewActivityBlock = trustedAutomergeReviewActivityBlockReason(command)",
  );
  const final = executeAutomerge.indexOf(
    "const finalReviewActivityBlock = trustedAutomergeReviewActivityBlockReason(command)",
  );
  const claim = executeAutomerge.indexOf("claimAutomergeMergeRequest(command)");
  const claimed = executeAutomerge.indexOf(
    "const claimedReviewActivityBlock = trustedAutomergeReviewActivityBlockReason(command)",
  );
  const merge = executeAutomerge.indexOf("result = runGitHubSpawnMutation(");

  assert.ok(first >= 0);
  assert.ok(final > first);
  assert.ok(claim > final);
  assert.ok(claimed > claim);
  assert.ok(merge > claimed);
  assert.match(
    source,
    /function trustedAutomergeReviewActivityBlockReason[\s\S]*expected_review_activity_cursor[\s\S]*pulls\/\$\{command\.issue_number\}\/reviews[\s\S]*pulls\/\$\{command\.issue_number\}\/comments/,
  );
  assert.match(executeAutomerge, /claimedReviewActivityBlock[\s\S]*releaseBeforeDispatch/);
});

test("activity and strict-base policy are checked after durable dispatch marking", () => {
  const source = readText("src/repair/comment-router.ts");
  const executeAutomerge = source.slice(
    source.indexOf("function executeAutomerge("),
    source.indexOf("function automergeReadinessAction("),
  );
  const dispatchBoundary = executeAutomerge.slice(
    executeAutomerge.indexOf("beforeDispatch: () => {"),
    executeAutomerge.indexOf("onDispatchStart: () => {"),
  );
  const liveDispatchState = executeAutomerge.slice(
    executeAutomerge.indexOf("const liveDispatchStateBlock ="),
    executeAutomerge.indexOf(
      "let result;",
      executeAutomerge.indexOf("const liveDispatchStateBlock ="),
    ),
  );
  const mergeAttempt = executeAutomerge.indexOf("const dispatchBoundaryState");
  const preDispatchCatch = executeAutomerge.indexOf("} catch (error) {", mergeAttempt);
  const preDispatchFailure = executeAutomerge.slice(
    preDispatchCatch,
    executeAutomerge.indexOf("return reconcileClaimedAutomergeRequest(", preDispatchCatch),
  );
  const preMarkerActivityCheck = dispatchBoundary.indexOf(
    "trustedAutomergeReviewActivityBlockReason(command)",
  );
  const guard = dispatchBoundary.indexOf("guardAutomergeMergeDispatch({");
  const claimDispatch = dispatchBoundary.indexOf("markDispatched: () =>");
  const postMarkerActivityCheck = dispatchBoundary.indexOf(
    "reviewActivityBlock: () => trustedAutomergeReviewActivityBlockReason(command)",
  );
  const postMarkerStrictBaseCheck = dispatchBoundary.indexOf(
    "strictBaseBindingBlock: () => liveDispatchStateBlock(true)",
  );
  const finalStateCheck = dispatchBoundary.indexOf(
    "finalStateBlock: () => liveDispatchStateBlock(false)",
  );
  const reject = dispatchBoundary.indexOf("rejectAutomergeMergeClaim(command, mergeClaim.claimId)");

  assert.ok(preMarkerActivityCheck >= 0);
  assert.ok(guard > preMarkerActivityCheck);
  assert.ok(claimDispatch > guard);
  assert.ok(postMarkerActivityCheck > claimDispatch);
  assert.ok(postMarkerStrictBaseCheck > postMarkerActivityCheck);
  assert.ok(finalStateCheck > postMarkerStrictBaseCheck);
  assert.ok(reject > finalStateCheck);
  assert.match(
    liveDispatchState,
    /fetchPullRequestView\(command\.issue_number\)[\s\S]*latestAutomergeTarget\([\s\S]*validateAutomergeHardReadiness\([\s\S]*validateAutomergeReadiness\([\s\S]*runtimeStrictBaseBindingBlock\([\s\S]*policyReadJson: rulesetPolicyReader\(\)/,
  );
  assert.match(executeAutomerge, /knownNoMutation: \(\) => !mergeRequestStarted/);
  assert.match(
    executeAutomerge,
    /const dispatchBoundaryState: \{[\s\S]*preMarkerReviewActivityBlock:[\s\S]*dispatchedAbortAction: LooseRecord \| null;[\s\S]*\}/,
  );
  assert.match(
    preDispatchFailure,
    /if \(dispatchBoundaryState\.dispatchedAbortAction\) \{[\s\S]*return dispatchBoundaryState\.dispatchedAbortAction;[\s\S]*const dispatchReviewActivityBlock = dispatchBoundaryState\.preMarkerReviewActivityBlock;[\s\S]*releaseBeforeDispatch/,
  );
  assert.match(
    source,
    /function trustedAutomergeReviewActivityBlockReason[\s\S]*command\.intent !== "clawsweeper_auto_merge"\) return null;/,
  );
});

test("all exact-head merge owners release unused claims and require squash auto-merge", () => {
  const apply = readText("src/repair/apply-result.ts");
  const router = readText("src/repair/comment-router.ts");
  const postFlight = readText("src/repair/post-flight.ts");
  const effect = readText("src/repair/automerge-effect.ts");
  const applyExecution = apply.slice(
    apply.indexOf("function applyMergeAction("),
    apply.indexOf("function validateMergeHeadBinding("),
  );
  const routerExecution = router.slice(
    router.indexOf("function executeAutomerge("),
    router.indexOf("function automergeReadinessAction("),
  );
  const postFlightExecution = postFlight.slice(
    postFlight.indexOf("function finalizeFixPr("),
    postFlight.indexOf("function reconcileMergeState("),
  );

  assert.match(
    apply,
    /function releaseApplyMergeClaim[\s\S]*releaseExactHeadMergeClaim[\s\S]*"apply_result_merge_claim_release"/,
  );
  assert.match(
    router,
    /function releaseAutomergeMergeClaim[\s\S]*releaseExactHeadMergeClaim[\s\S]*"pull_request_merge_claim_release"/,
  );
  assert.match(
    postFlight,
    /function releasePostFlightMergeClaim[\s\S]*releaseExactHeadMergeClaim[\s\S]*"post_flight_merge_claim_release"/,
  );
  assert.match(applyExecution, /markApplyMergeClaimDispatched\(/);
  assert.match(applyExecution, /kind: "apply_result_merge"/);
  assert.ok(
    applyExecution.indexOf('kind: "apply_result_merge"') <
      applyExecution.indexOf("markApplyMergeClaimDispatched("),
  );
  assert.match(routerExecution, /markAutomergeMergeClaimDispatched\(/);
  assert.match(routerExecution, /result = runGitHubSpawnMutation\(/);
  assert.ok(
    routerExecution.indexOf("result = runGitHubSpawnMutation(") <
      routerExecution.indexOf("markAutomergeMergeClaimDispatched("),
  );
  assert.match(postFlightExecution, /markPostFlightMergeClaimDispatched\(/);
  assert.match(postFlightExecution, /kind: "post_flight_merge"/);
  assert.ok(
    postFlightExecution.indexOf('kind: "post_flight_merge"') <
      postFlightExecution.indexOf("markPostFlightMergeClaimDispatched("),
  );
  assert.match(applyExecution, /let mergeRequestStarted = false/);
  assert.match(routerExecution, /let mergeRequestStarted = false/);
  assert.match(postFlightExecution, /let mergeRequestStarted = false/);
  assert.match(apply, /validateMergeablePullRequestHard[\s\S]*squashAutomergeMethodBlock/);
  assert.match(router, /validateAutomergeHardReadiness[\s\S]*squashAutomergeMethodBlock/);
  assert.match(postFlight, /validateFixPrMergeHardReadiness[\s\S]*squashAutomergeMethodBlock/);
  assert.match(
    effect,
    /function squashAutomergeMethodBlock[\s\S]*method === "SQUASH"[\s\S]*instead of SQUASH/,
  );
});

test("automerge execution never invents a merge timestamp", () => {
  const source = readText("src/repair/comment-router.ts");
  const executeAutomerge = source.slice(
    source.indexOf("function executeAutomerge("),
    source.indexOf("function automergeReadinessAction("),
  );

  assert.match(executeAutomerge, /merged_at: result\.confirmation\.mergedAt/);
  assert.doesNotMatch(executeAutomerge, /merged_at:[^\n]*new Date/);
  assert.doesNotMatch(executeAutomerge, /mergedAt \?\? new Date/);
});
