import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("comment router records receipts after durable command boundaries", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.match(source, /rawCommands\.push\(command\);\s+recordCommandReceived\(command\);/);
  assert.match(
    source,
    /writeLedger\(ledgerPath\(\), ledger\);\s+publishDurableDispatchClaims\(claimedCommands, "initial"\);\s+for \(const command of claimedCommands\) recordCommandClaimed\(command\);/,
  );
  assert.match(
    source,
    /writeLedger\(ledgerPath\(\), ledger\);\s+publishDurableDispatchClaims\(\[claim\], "refresh"\);\s+for \(const key of dispatchClaimLookupKeys\(claim\)\) priorDispatchClaims\.set\(key, claim\);[\s\S]*recordCommandClaimRefreshed\(claim\);/,
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
  assert.equal(source.match(/\bghSpawn\(/g)?.length, 1);
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

test("durable dispatch recovery is scoped to the routed repository", () => {
  const source = readText("src/repair/comment-router.ts");
  const claimIndex = source.indexOf("const priorDispatchClaims = new Map");
  const claimOwner = source.slice(
    claimIndex,
    source.indexOf("const processedCommentVersions", claimIndex),
  );
  const recoveryIndex = source.indexOf("function resolveProtectedLedgerSources(");
  const recoveryOwner = source.slice(
    recoveryIndex,
    source.indexOf("function listCandidateComments()", recoveryIndex),
  );

  assert.ok(claimIndex >= 0);
  assert.match(
    claimOwner,
    /for \(const entry of ledger\.commands \?\? \[\]\) \{\s+if \(String\(entry\.repo \?\? ""\) !== targetRepo\) continue;\s+if \(!hasDurableDispatchBarrier\(entry\)\) continue;/,
  );
  assert.match(
    recoveryOwner,
    /\(ledger\.commands \?\? \[\]\)\s+\.filter\(\(candidate: JsonValue\) => String\(candidate\.repo \?\? ""\) === targetRepo\)\s+\.filter\(isProtectedCommentRouterLedgerCommand\)/,
  );
});

test("a stale dispatch claim refreshes once and redispatches through the refreshed binding", () => {
  const source = readText("src/repair/comment-router.ts");
  const refreshIndex = source.indexOf("function refreshDispatchClaim(");
  const refreshOwner = source.slice(
    refreshIndex,
    source.indexOf("function publishDurableDispatchClaims(", refreshIndex),
  );
  const stateIndex = source.indexOf("function claimedDispatchState(");
  const stateOwner = source.slice(
    stateIndex,
    source.indexOf("function durableDispatchRetryBlockReason(", stateIndex),
  );
  const reconcileIndex = source.indexOf("function reconcilePriorDispatchClaimBeforeMutations(");
  const reconcileOwner = source.slice(
    reconcileIndex,
    source.indexOf("function boundDispatchClaimAction(", reconcileIndex),
  );

  assert.match(
    refreshOwner,
    /publishDurableDispatchClaims\(\[claim\], "refresh"\)[\s\S]*command\.dispatch_retry_binding = \(Array\.isArray\(claim\.actions\)/,
  );
  assert.match(
    stateOwner,
    /if \(decision\.action === "dispatch"\)[\s\S]*refreshDispatchClaim\(command\);\s+return null;/,
  );
  assert.match(
    reconcileOwner,
    /if \(!receipt\) \{\s+command\.dispatch_retry_authorized = true;\s+command\.dispatch_retry_binding \?\?= boundAction;\s+return false;/,
  );

  for (const [name, nextName, action, claimGuard] of [
    [
      "dispatchClawSweeperReview",
      "dispatchClawSweeperAssist",
      "dispatch_clawsweeper",
      /if \(!retryBinding\) \{\s+const claimed = claimedDispatchState/,
    ],
    [
      "dispatchClawSweeperAssist",
      "freeformReviewPrompt",
      "dispatch_assist",
      /if \(!retryBinding\) \{\s+const claimed = claimedDispatchState/,
    ],
    [
      "dispatchRepair",
      "dispatchRepairActionStatus",
      "dispatch_repair",
      /const claimed = retryBinding\s+\? null\s+: claimedDispatchState/,
    ],
  ]) {
    const index = source.indexOf(`function ${name}(`);
    const owner = source.slice(index, source.indexOf(`function ${nextName}(`, index));
    assert.match(
      owner,
      new RegExp(`authorizedDispatchRetryBinding\\(command, "${action}"\\)`),
      name,
    );
    assert.match(owner, claimGuard, name);
  }
});

test("dispatch claims bind immutable destinations and retry searches cross the claim boundary", () => {
  const source = readText("src/repair/comment-router.ts");
  const bindIndex = source.indexOf("function bindDispatchClaimAction(");
  const bindOwner = source.slice(
    bindIndex,
    source.indexOf("function refreshDispatchClaim(", bindIndex),
  );
  const stateIndex = source.indexOf("function claimedDispatchState(");
  const stateOwner = source.slice(
    stateIndex,
    source.indexOf("function durableDispatchRetryBlockReason(", stateIndex),
  );

  for (const field of [
    "dispatch_repo",
    "dispatch_workflow",
    "dispatch_event",
    "dispatch_title",
    "dispatch_mode",
    "dispatch_runner",
    "dispatch_execution_runner",
    "dispatch_model",
  ]) {
    assert.match(bindOwner, new RegExp(`\\b${field}:`), field);
  }
  assert.match(source, /const MAX_DISPATCH_RUN_PAGES = 100;/);
  assert.match(
    stateOwner,
    /const claimBoundaryMs = Date\.parse\(String\(claim\.processed_at \?\? ""\)\) - 5_000;/,
  );
  assert.match(stateOwner, /for \(let page = 1; page <= MAX_DISPATCH_RUN_PAGES; page \+= 1\)/);
  assert.match(stateOwner, /runs\?per_page=100&page=\$\{page\}/);
  assert.match(
    stateOwner,
    /if \(pageRuns\.length < 100\)[\s\S]*if \(runOrderingVerified && priorRunCreatedAtMs < claimBoundaryMs\)/,
  );
  assert.match(
    stateOwner,
    /if \(decision\.action === "dispatch"\)[\s\S]*if \(!searchComplete\)[\s\S]*refreshDispatchClaim\(command\)/,
  );
});
