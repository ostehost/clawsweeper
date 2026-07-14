import assert from "node:assert/strict";
import test from "node:test";

import { readText } from "../helpers.ts";

test("command status mutations have exact attempt and outcome receipts", () => {
  const source = readText("src/repair/update-command-status.ts");
  const patchIndex = source.indexOf('kind: "status_comment_update"');
  const receiptIndex = source.indexOf("recordCommandProgress(lifecycle", patchIndex);

  assert.ok(patchIndex >= 0);
  assert.ok(receiptIndex > patchIndex);
  assert.match(source, /runCommandLifecycleMutation\(lifecycle,/);
  assert.match(source, /kind: "ack_comment_delete"/);
  assert.match(source, /status: "unchanged"/);
  assert.match(source, /status: "skipped"/);
  assert.match(source, /recordCommandLifecycleFailure/);
  assert.match(source, /await flushCommandActionEvents\(\)/);
});

test("repair requeue receipts remain stable but the isolated worker never recursively dispatches", () => {
  const setupAction = readText(".github/actions/setup-action-ledger/action.yml");
  const source = readText("src/repair/requeue-job.ts");
  const workflow = readText(".github/workflows/repair-cluster-worker.yml");
  const dispatchIndex = source.indexOf(
    "dispatchJob(sourceJobPath, mode, dispatchKey, requeueLifecycle)",
  );
  const receiptIndex = source.indexOf("recordCommandRequeue(requeueLifecycle", dispatchIndex);

  assert.ok(dispatchIndex >= 0);
  assert.ok(receiptIndex > dispatchIndex);
  assert.match(source, /deterministicRequeueDispatchKey\(\{/);
  assert.match(source, /authorizationSha256/);
  assert.match(source, /depth: nextRequeueDepth/);
  assert.match(source, /boundedNextRequeueDepth\(requeueDepth, maxRequeueDepth\)/);
  assert.match(source, /`dispatch_key=\$\{dispatchKey\}`/);
  assert.match(source, /`job=\$\{jobPath\}`/);
  assert.match(source, /`requeue_depth=\$\{nextRequeueDepth\}`/);
  assert.match(source, /operationKey: `repair-requeue:/);
  assert.match(source, /sourceRevision: immutableJob\.stateRevision/);
  assert.match(source, /immutableJob\.identityKey/);
  assert.match(source, /sourceJobSha256: authorizationSha256/);
  assert.match(source, /runCommandLifecycleMutation\(lifecycle,/);
  assert.match(source, /await flushCommandActionEvents\(\)/);
  assert.match(setupAction, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT=\$output_root/);
  assert.match(workflow, /- name: Create read-only state token/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(workflow, /execute:[\s\S]*?permissions:\n\s+actions: read/);
  assert.match(workflow, /JOB_PATH: \$\{\{ inputs\.job \}\}/);
  assert.doesNotMatch(workflow, /sparse-checkout: \|\n\s+jobs\n\s+ledger/);
  assert.doesNotMatch(workflow, /^\s+REQUEUE_(?:MODE|DEPTH|RUNNER|EXECUTION_RUNNER|MODEL):/m);
  assert.doesNotMatch(workflow, /repair:requeue|requeue-job\.js/);
  assert.doesNotMatch(workflow, /repair-requeue action ledger/);
  assert.doesNotMatch(workflow, /count-requeue-required|--source-job-path/);
});

test("exact review publishes post-ack status receipts in a second ledger", () => {
  const setupAction = readText(".github/actions/setup-action-ledger/action.yml");
  const source = readText("src/repair/update-command-status.ts");
  const workflow = readText(".github/workflows/sweep.yml");
  const exactEventFinalize = workflow.indexOf("- name: Finalize exact event action ledger");
  const exactEventPublish = workflow.indexOf("- name: Publish exact event action ledger");
  const completeLease = workflow.indexOf("- name: Complete exact-review queue lease");
  const sourceDriftStatus = workflow.indexOf("- name: Mark source-drift re-review queued");
  const lateFinalize = workflow.indexOf("- name: Finalize late command status action ledger");
  const latePublish = workflow.indexOf("- name: Publish late command status action ledger");
  const exactReviewQueuePublisher = workflow.indexOf(
    "\n  publish-exact-review-action-ledger:",
    latePublish,
  );
  const targetFanout = workflow.indexOf("\n  target-fanout:", latePublish);
  const finalizeStep = workflow.slice(lateFinalize, latePublish);
  const publishStep = workflow.slice(latePublish, exactReviewQueuePublisher);

  assert.ok(exactEventFinalize >= 0);
  assert.ok(exactEventPublish > exactEventFinalize);
  assert.ok(completeLease > exactEventPublish);
  assert.ok(sourceDriftStatus > completeLease);
  assert.ok(lateFinalize > sourceDriftStatus);
  assert.ok(latePublish > lateFinalize);
  assert.ok(exactReviewQueuePublisher > latePublish);
  assert.ok(targetFanout > latePublish);
  assert.match(setupAction, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT=\$output_root/);
  assert.match(source, /await flushCommandActionEvents\(\)/);
  assert.match(
    publishStep,
    /if: \$\{\{ always\(\) && steps\.setup-state\.outcome == 'success' && steps\.setup-pnpm\.outcome == 'success' && steps\.publish-event-result\.outputs\.requeue_latest == 'true' && steps\.complete-exact-review-queue\.outcome == 'success' && steps\.finalize-late-command-status-action-ledger\.outcome == 'success' \}\}/,
  );
  assertCommandFinalizerUsesCanonicalRoot(finalizeStep);
  assertCommandPublisherUsesCanonicalRoot(publishStep);
  assert.match(finalizeStep, /--lane late-command-status/);
  assert.match(publishStep, /--lane late-command-status/);
  assert.match(publishStep, /--message "chore: append command status action ledger"/);
});

function assertCommandFinalizerUsesCanonicalRoot(step: string): void {
  assert.match(
    step,
    /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT:\?setup-action-ledger output root is required/,
  );
  assert.match(step, /repair:action-ledger -- finalize \\\n\s+--lane [a-z0-9-]+ \\\n/);
  assert.match(step, /> \.artifacts\/[a-z0-9-]+-action-ledger-manifest\.json/);
}

function assertCommandPublisherUsesCanonicalRoot(step: string): void {
  assert.match(
    step,
    /source_root="\$\{CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT:\?setup-action-ledger output root is required\}"/,
  );
  assert.match(step, /manifest_file="\.artifacts\/[a-z0-9-]+-action-ledger-manifest\.json"/);
  assert.match(step, /test -s "\$manifest_file"/);
  assert.match(step, /repair:action-ledger -- publish/);
  assert.match(step, /--lane [a-z0-9-]+/);
  assert.match(step, /--manifest "\$manifest_file"/);
  assert.match(step, /--source-root "\$source_root"/);
  assert.match(
    step,
    /jq -e --slurpfile manifest "\$manifest_file"[\s\S]*?'\.eventPaths == \$manifest\[0\]\.event_paths'/,
  );
  assert.match(step, /jq -r '\.paths\[\]\?' "\$import_result_file"/);
  assert.match(step, /if \[ ! -s "\$event_paths_file" \]; then[\s\S]*?exit 1[\s\S]*?fi/);
  assert.doesNotMatch(step, /command_shard_found/);
  assert.doesNotMatch(step, /\.created > 0/);
  assert.doesNotMatch(step, /exit 0/);
}
