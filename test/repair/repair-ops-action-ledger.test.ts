import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { readText } from "../helpers.ts";

test("repair sessions, statuses, and result publication flush immutable receipts", () => {
  const session = readText("src/repair/action-session.ts");
  const status = readText("src/repair/issue-implementation-status.ts");
  const publisher = readText("src/repair/publish-result.ts");

  assert.match(session, /ACTION_EVENT_TYPES\.sessionRegistered/);
  assert.match(session, /ACTION_EVENT_TYPES\.repairQueue/);
  assert.match(session, /repairEventType\(state, phase, completionReason\)/);
  assert.match(session, /withActionSessionReceiptFinalization/);
  assert.match(session, /recordRepairLifecycleFailureSafely/);
  assert.match(session, /repairSourceRevision\(job\.frontmatter\)/);
  assert.match(session, /metadata\.remoteEnabled === true/);
  assert.equal([...session.matchAll(/outcome: repairHttpMutationOutcome/g)].length, 2);
  assert.match(status, /outcome: repairHttpMutationOutcome/);
  const registration = session.slice(
    session.indexOf("async function registerActionSession"),
    session.indexOf("async function updateActionSession"),
  );
  const update = session.slice(
    session.indexOf("async function updateActionSession"),
    session.indexOf("function actionSessionLifecycle"),
  );
  assert.ok(
    registration.indexOf("type: ACTION_EVENT_TYPES.repairQueue") <
      registration.indexOf("if (remoteEnabled)"),
  );
  assert.ok(
    update.indexOf("type: repairEventType(state, phase, completionReason)") <
      update.indexOf("if (metadata.remoteEnabled === true)"),
  );

  const statusMutation = status.indexOf("mutateCommentWithReceipt();");
  const statusReceipt = status.indexOf("type: ACTION_EVENT_TYPES.statusLifecycle", statusMutation);
  assert.ok(statusMutation >= 0);
  assert.ok(statusReceipt > statusMutation);
  assert.match(status, /ACTION_EVENT_TYPES\.dashboardLifecycle/);
  assert.match(status, /await flushRepairActionEvents\(\)/);
  assert.match(status, /recordRepairLifecycleFailureSafely/);

  const resultWrite = publisher.indexOf("writeClosedRecord");
  const resultReceipt = publisher.indexOf(
    "type: ACTION_EVENT_TYPES.publicationLifecycle",
    resultWrite,
  );
  assert.ok(resultWrite >= 0);
  assert.ok(resultReceipt > resultWrite);
  assert.match(publisher, /ACTION_EVENT_TYPES\.publicationLifecycle/);
  assert.match(publisher, /ACTION_EVENT_TYPES\.dashboardLifecycle/);
  assert.match(publisher, /await flushRepairActionEvents\(\)/);
  assert.match(publisher, /recordRepairLifecycleFailureSafely/);
  assert.match(publisher, /resultPublicationSourceRevision\([\s\S]*sourceContext[\s\S]*resultPath/);
  assert.match(
    publisher,
    /eventIdentity:\s*\{\s*publicationKind: "cluster_result",\s*runId: runId \|\| clusterId,\s*state: "prepared"/,
  );
  assert.match(publisher, /state: "prepared"/);
  assert.doesNotMatch(publisher, /state: "published"/);
  assert.doesNotMatch(publisher, /recordAggregatePreparation\([^)]*,/);
});

test("repair worker jobs upload shards and one credentialed job publishes them", () => {
  const workflow = readText(".github/workflows/repair-cluster-worker.yml");
  const cluster = workflow.slice(
    workflow.indexOf("\n  cluster:"),
    workflow.indexOf("\n  authorize:"),
  );
  const mutate = workflow.slice(
    workflow.indexOf("\n  mutate:"),
    workflow.indexOf("\n  publish-repair-action-ledger:"),
  );
  const report = workflow.slice(workflow.indexOf("\n  report:"), workflow.indexOf("\n  mutate:"));
  const execute = workflow.slice(
    workflow.indexOf("\n  execute:"),
    workflow.indexOf("\n  validate:"),
  );
  const publisher = workflow.slice(workflow.indexOf("\n  publish-repair-action-ledger:"));
  const clusterRegistration = cluster.slice(
    cluster.indexOf("- name: Register repair lifecycle"),
    cluster.indexOf("- name: Verify GitHub read token"),
  );
  const clusterWorker = cluster.slice(
    cluster.indexOf("- name: Run worker"),
    cluster.indexOf("- name: Review worker result"),
  );
  const mutationRegistration = mutate.slice(
    mutate.indexOf("- name: Resume repair lifecycle"),
    mutate.indexOf("- name: Create exact-repository mutation token"),
  );

  assert.match(cluster, /permissions:\s+actions: read\s+contents: read/);
  assert.match(cluster, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(cluster, /Finalize cluster repair action ledger/);
  assert.match(cluster, /clawsweeper-repair-worker-action-ledger-cluster-/);
  assert.match(clusterWorker, /id: run_worker/);
  assert.match(clusterWorker, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION: repair-worker-codex/);
  assert.ok(
    cluster.indexOf("uses: ./.github/actions/setup-action-ledger") <
      cluster.indexOf("- name: Run worker"),
  );
  assert.ok(
    cluster.indexOf("- name: Run worker") <
      cluster.indexOf("- name: Finalize cluster repair action ledger"),
  );
  assert.match(clusterRegistration, /CLAWSWEEPER_ACTION_SESSION_REMOTE:/);
  assert.match(
    clusterRegistration,
    /CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: \$\{\{ env\.CLAWSWEEPER_STEERABLE_CODEX == '1' && !inputs\.dry_run && secrets\.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN \|\| '' \}\}/,
  );
  assert.doesNotMatch(
    clusterRegistration,
    /CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: \$\{\{ secrets\.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN \}\}/,
  );
  assert.doesNotMatch(clusterRegistration, /if:.*CLAWSWEEPER_STEERABLE_CODEX/);
  assert.match(mutate, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(mutate, /Finalize mutation repair action ledger/);
  assert.match(mutate, /clawsweeper-repair-worker-action-ledger-mutate-/);
  assert.match(mutationRegistration, /CLAWSWEEPER_ACTION_SESSION_REMOTE:/);
  assert.match(
    mutationRegistration,
    /CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: \$\{\{ env\.CLAWSWEEPER_STEERABLE_CODEX == '1' && secrets\.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN \|\| '' \}\}/,
  );
  assert.doesNotMatch(
    mutationRegistration,
    /CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: \$\{\{ secrets\.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN \}\}/,
  );
  assert.match(mutationRegistration, /--skip-repair-receipt/);
  assert.doesNotMatch(mutationRegistration, /if:.*CLAWSWEEPER_STEERABLE_CODEX/);
  assert.match(
    mutate,
    /Resolve planning action ledger context[\s\S]*--expected-artifact-id "\$\{\{ needs\.cluster\.outputs\.action_ledger_artifact_id \}\}"[\s\S]*Download planning action ledger context[\s\S]*artifact-ids: \$\{\{ steps\.planning_action_ledger\.outputs\.artifact_id \}\}/,
  );
  assert.match(mutate, /CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS:/);
  assert.doesNotMatch(mutate, /create-state-token|setup-state/);
  assert.match(execute, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(execute, /CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS:/);
  assert.match(execute, /Resolve planning action ledger context/);
  assert.match(execute, /Finalize execution repair action ledger/);
  assert.match(execute, /clawsweeper-repair-worker-action-ledger-execute-/);
  assert.match(
    execute,
    /checkpoint_recovered \}\}" = "1"[\s\S]*allow_empty_args\+=\(--allow-empty\)[\s\S]*--repair-lane execute/,
  );
  assert.match(report, /id: publish_terminal_status/);
  assert.match(report, /Finalize report status repair action ledger/);
  assert.match(report, /--repair-lane report-status[\s\S]*--allow-empty/);
  assert.match(report, /Finalize report command action ledger/);
  assert.match(report, /--lane report-requeue/);
  assert.match(report, /Publish immutable report action ledgers/);
  assert.match(
    report,
    /publish_manifest[\s\S]*repair[\s\S]*report-status[\s\S]*publish_manifest[\s\S]*command[\s\S]*report-requeue/,
  );
  assert.match(report, /--message "chore: append report action ledgers"/);

  assert.match(publisher, /name: Publish immutable repair action ledger/);
  assert.match(publisher, /needs:\s+- cluster\s+- execute\s+- mutate/);
  assert.match(
    publisher,
    /if: \$\{\{ always\(\) && needs\.cluster\.result != 'skipped' && needs\.cluster\.outputs\.job_exists == '1' \}\}/,
  );
  assert.match(publisher, /create-state-token/);
  assert.ok(
    publisher.indexOf("- uses: ./.github/actions/setup-pnpm") <
      publisher.indexOf("- name: Create repair action ledger state token"),
    "repair ledger publisher must build before minting state write credentials",
  );
  assert.match(
    publisher,
    /artifact-ids: \$\{\{ needs\.cluster\.outputs\.action_ledger_artifact_id \}\}/,
  );
  assert.match(
    publisher,
    /artifact-ids: \$\{\{ needs\.execute\.outputs\.action_ledger_artifact_id \}\}/,
  );
  assert.match(
    publisher,
    /artifact-ids: \$\{\{ needs\.mutate\.outputs\.action_ledger_artifact_id \}\}/,
  );
  assert.match(publisher, /repair:action-ledger -- publish/);
  assert.match(publisher, /--repair-lane "\$lane"/);
  assert.match(publisher, /--expected-job "\$job"/);
  assert.match(publisher, /--expected-run-attempt "\$run_attempt"/);
  assert.match(
    publisher,
    /EXECUTE_LEDGER_ALLOW_EMPTY:[\s\S]*allow_empty_args\+=\(--allow-empty\)[\s\S]*collect_lane execute execute "\$EXECUTE_JOB_RESULT" "\$EXECUTE_LEDGER_ARTIFACT_ID" "\$EXECUTE_LEDGER_ATTEMPT" "\$EXECUTE_DOWNLOAD_OUTCOME" "\$EXECUTE_LEDGER_ALLOW_EMPTY"/,
  );
  assert.match(publisher, /collect_lane cluster cluster/);
  assert.match(publisher, /collect_lane execute execute/);
  assert.match(publisher, /collect_lane mutate mutate/);
  assert.match(publisher, /\$lane job \(\$job_result\) did not expose an action ledger artifact/);
  assert.match(publisher, /record_lane "\$lane" "\$\{job_result:-not-started\}" "missing"/);
  assert.match(publisher, /One or more advertised repair action ledger lanes failed closed/);
  assert.match(publisher, /continue-on-error: true/);
  assert.doesNotMatch(publisher, /require_lane/);
  assert.match(publisher, /--message "chore: append repair action ledger"/);
});

test("repair ledger collector publishes present lanes when downstream lanes are absent", () => {
  const result = runRepairLedgerCollector();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.summary, /\| cluster \| success \| published \|/);
  assert.match(result.summary, /\| execute \| skipped \| missing \|/);
  assert.match(result.summary, /\| mutate \| skipped \| missing \|/);
  assert.match(result.published, /ledger\/cluster\.json/);
});

test("repair ledger collector accepts a genuinely non-started lane without an artifact", () => {
  const result = runRepairLedgerCollector({ executeResult: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.summary, /\| cluster \| success \| published \|/);
  assert.match(result.summary, /\| execute \| not-started \| missing \|/);
  assert.match(result.published, /ledger\/cluster\.json/);
});

for (const jobResult of ["success", "failure", "cancelled"]) {
  test(`repair ledger collector rejects a ${jobResult} lane without an artifact`, () => {
    const result = runRepairLedgerCollector({ executeResult: jobResult });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`execute job \\(${jobResult}\\) did not expose an action ledger artifact`),
    );
    assert.match(result.stderr, /advertised repair action ledger lanes failed closed/);
    assert.match(result.summary, /\| cluster \| success \| published \|/);
    assert.match(
      result.summary,
      new RegExp(`\\| execute \\| ${jobResult} \\| invalid: missing started artifact \\|`),
    );
    assert.match(result.published, /ledger\/cluster\.json/);
  });
}

test("repair ledger collector preserves valid lanes but fails closed on a forged lane", () => {
  const result = runRepairLedgerCollector({ forgedMutate: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /advertised repair action ledger lanes failed closed/);
  assert.match(result.summary, /\| cluster \| success \| published \|/);
  assert.match(result.summary, /\| mutate \| failure \| invalid: verification failed \|/);
  assert.match(result.published, /ledger\/cluster\.json/);
});

test("repair mutation and Codex boundaries emit exact immutable receipts", () => {
  const ledger = readText("src/repair/repair-action-ledger.ts");
  const codexLedger = readText("src/repair/repair-codex-action-ledger.ts");
  const worker = readText("src/repair/run-worker.ts");
  const handoff = readText("src/repair/execution-handoff.ts");
  const executor = readText("src/repair/execute-fix-artifact.ts");
  const github = readText("src/repair/execute-fix-github.ts");
  const postFlight = readText("src/repair/post-flight.ts");

  assert.match(ledger, /ACTION_EVENT_TYPES\.repairMutation/);
  assert.match(ledger, /requestAttempt/);
  assert.match(ledger, /mutation_outcome_unknown/);
  assert.match(ledger, /repairMutationState/);
  assert.match(handoff, /recordPublicationWorkflowEventSafely\(lifecycle, "started"\)/);
  assert.match(handoff, /recordPublicationWorkflowEventSafely\(lifecycle, "failed", error\)/);
  assert.match(handoff, /recordPublicationWorkflowEventSafely\(lifecycle, "finalized"\)/);
  for (const boundary of [
    "branch_push",
    "pull_request_create",
    "pull_request_reopen",
    "pull_request_comment",
    "pull_request_labels",
    "source_pull_request_close",
    "source_pull_request_reopen_compensation",
  ]) {
    assert.match(handoff, new RegExp(`kind: "${boundary}"`));
  }
  assert.match(executor, /beginRepairCodexAction/);
  for (const action of [
    "repair_plan",
    "repair_result_repair",
    "repair_edit",
    "repair_write_preflight",
    "repair_base_reconcile",
    "repair_review",
    "repair_review_fix",
    "repair_validation_fix",
  ]) {
    assert.match(codexLedger, new RegExp(`"${action}"`));
    assert.match(
      ["repair_plan", "repair_result_repair"].includes(action) ? worker : executor,
      new RegExp(`action: "${action}"`),
    );
  }
  assert.equal([...worker.matchAll(/beginRepairCodexAction\(/g)].length, 2);
  assert.match(
    worker,
    /action: "repair_plan"[\s\S]*paths: \{ jsonl: transcriptPath, stderr: codexStderrPath \}/,
  );
  assert.match(
    worker,
    /action: "repair_result_repair"[\s\S]*paths: \{ jsonl: repairTranscriptPath, stderr: repairStderrPath \}/,
  );
  assert.match(worker, /plannerAction\.complete\(\)/);
  assert.match(worker, /plannerAction\.fail\(/);
  assert.match(worker, /repairAction\.complete\(\)/);
  assert.match(worker, /repairAction\.fail\(/);
  assert.match(executor, /repairCodexAttempt\(attempt, "final"\)/);
  assert.match(executor, /repair_execution_report/);
  assert.match(
    executor,
    /recordRepairWorkflowEventSafely\(repairWorkflowTerminalPhase\(report\)\)/,
  );
  assert.match(
    executor,
    /recordRepairWorkflowEventSafely\(repairWorkflowTerminalPhase\(persistedReport\)\)/,
  );
  for (const boundary of [
    "branch_push",
    "pull_request_create",
    "pull_request_reopen",
    "pull_request_comment",
    "pull_request_label_add",
    "pull_request_label_remove",
    "source_pull_request_comment",
    "source_pull_request_close",
    "issue_comment_create",
    "issue_comment_update",
    "automerge_router_dispatch",
    "automerge_review_dispatch",
  ]) {
    assert.match(executor, new RegExp(`"${boundary}"`));
  }
  assert.match(github, /"review_thread_resolve"/);
  assert.match(executor, /mutationBoundary: runDirectRepairMutation/);
  assert.match(postFlight, /post_flight_merge/);
  assert.match(postFlight, /closeout_comment/);
  assert.match(postFlight, /source_pull_request_closeout/);
  assert.match(
    postFlight,
    /kind: "post_flight_merge"[\s\S]*ghText\(mergeArgs\)[\s\S]*outcome:[\s\S]*"accepted"[\s\S]*"unknown"/,
  );
  assert.match(postFlight, /recordRepairMutationObservedSafely\(/);
  assert.match(postFlight, /\(\) => ghText\(\["pr", "close"/);
  assert.doesNotMatch(postFlight, /\(\) => ghWithRetry\(mergeArgs\)/);
  assert.doesNotMatch(postFlight, /\(\) => ghWithRetry\(\["pr", "close"/);
  assert.doesNotMatch(postFlight, /ghBestEffort/);
  assert.match(postFlight, /recordPostFlightWorkflowEventSafely\("started"\)/);
  assert.match(postFlight, /recordPostFlightWorkflowEventSafely\("failed", error\)/);
  assert.match(postFlight, /recordPostFlightWorkflowEventSafely\("finalized"\)/);
  assert.match(
    postFlight,
    /recordPostFlightWorkflowEventSafely\(repairWorkflowTerminalPhase\(finalReport\)\)/,
  );
});

test("commit review and notification workflows publish their operation receipts", () => {
  const commit = readText(".github/workflows/commit-review.yml");
  const activity = readText(".github/workflows/github-activity.yml");
  const maintainer = readText(".github/workflows/maintainer-report-discord.yml");
  const review = commit.slice(commit.indexOf("\n  review:"), commit.indexOf("\n  attest:"));
  const attestor = commit.slice(commit.indexOf("\n  attest:"), commit.indexOf("\n  publish:"));
  const publisher = commit.slice(commit.indexOf("\n  publish:"));

  assert.match(commit, /run-name:.*continuation_key/);
  assert.match(commit, /continuation_key:[\s\S]*Stable commit review continuation idempotency key/);
  assert.match(commit, /name: Deduplicate commit review continuation receipt/);
  assert.match(
    commit,
    /dispatch-receipt-owner\.sh \\\n\s+commit-review\.yml "\$expected_title" "\$GITHUB_RUN_ID" \\\n\s+"Commit reports" "Complete commit review continuation receipt"/,
  );
  assert.match(
    commit,
    /plan:\n\s+name: Plan commits\n\s+needs: receipt\n\s+if:.*needs\.receipt\.outputs\.proceed == 'true'/,
  );
  assert.doesNotMatch(review, /setup-action-ledger|CLAWSWEEPER_ACTION_LEDGER/);
  assert.match(review, /--defer-workflow-completion/);
  assert.doesNotMatch(review, /publish-check|permission-checks: write|finish-review/);
  assert.doesNotMatch(review, /create-state-token|setup-state|CLAWSWEEPER_STATE_DIR/);
  assert.match(attestor, /setup-action-ledger/);
  assert.match(attestor, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION: commit-\$\{\{ matrix\.sha \}\}/);
  assert.match(attestor, /node dist\/commit-sweeper\.js attest-review/);
  assert.match(attestor, /commit-review-raw-\$\{\{ matrix\.sha \}\}/);
  assert.match(attestor, /Upload attested commit review report/);
  assert.match(attestor, /--report-path "\$report_path"/);
  assert.ok(
    attestor.indexOf("- name: Attest immutable commit review report") <
      attestor.indexOf("- name: Finalize commit review action ledger"),
  );
  assert.match(
    attestor,
    /action-ledger-commit-review-\$\{\{ matrix\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(
    review,
    /commit-review-raw-\$\{\{ matrix\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(review, /commit-review-diagnostic-\$\{\{ matrix\.sha \}\}/);
  assert.match(
    publisher,
    /if: \$\{\{ always\(\) && needs\.plan\.result == 'success' && \(needs\.plan\.outputs\.planned_count != '0'/,
  );
  assert.match(publisher, /create-state-token/);
  assert.match(publisher, /setup-state/);
  assert.match(publisher, /--expected-job attest/);
  assert.doesNotMatch(publisher, /accepted-commit-review-check-shas|skipping duplicate write/);
  assert.match(publisher, /Resolve commit review artifact cohort/);
  assert.match(publisher, /CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT: "1"/);
  assert.match(publisher, /pnpm run --silent repair:resolve-run-artifact/);
  assert.match(publisher, /--commit-shas-file "\$expected_shas_file"/);
  assert.match(publisher, /--cohort-file "\$cohort_file"/);
  assert.match(
    publisher,
    /artifact-ids: \$\{\{ steps\.review-artifact-cohort\.outputs\.ledger_artifact_ids \}\}/,
  );
  assert.match(
    publisher,
    /artifact-ids: \$\{\{ steps\.review-artifact-cohort\.outputs\.report_artifact_ids \}\}/,
  );

  for (const workflowPath of [
    ".github/workflows/github-activity.yml",
    ".github/workflows/maintainer-report-discord.yml",
  ]) {
    const workflow = parse(readText(workflowPath)) as {
      jobs: Record<
        string,
        {
          steps: Array<{
            id?: string;
            name?: string;
            uses?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const steps = workflow.jobs.notify.steps;
    const dependencySetup = steps.findIndex((step) => step.id === "setup-pnpm");
    const stateToken = steps.findIndex(
      (step) => step.name === "Create notification ledger state token",
    );
    const stateCheckout = steps.findIndex((step) => step.uses === "./.github/actions/setup-state");
    assert.ok(dependencySetup >= 0, `${workflowPath}: missing dependency setup`);
    assert.ok(stateToken > dependencySetup, `${workflowPath}: state token minted before build`);
    assert.ok(
      stateCheckout > stateToken,
      `${workflowPath}: state credentials persisted before token creation`,
    );
    assert.equal(
      steps[stateCheckout]?.with?.token,
      "${{ steps.notification-state-token.outputs.token }}",
      workflowPath,
    );
  }
  assert.match(publisher, /normalize_single_download/);
  assert.match(publisher, /Verify and assemble commit review artifact cohort/);
  assert.match(publisher, /merge-multiple: false/);
  assert.match(publisher, /--commit-report "\$\{report_files\[0\]\}"/);
  assert.match(publisher, /--expected-commit-repository "\$EXPECTED_TARGET_REPO"/);
  assert.match(publisher, /--expected-commit-sha "\$commit_sha"/);
  assert.match(publisher, /state_revision="\$\(git -C "\$CLAWSWEEPER_STATE_DIR" rev-parse HEAD\)"/);
  assert.match(publisher, /--report-repo openclaw\/clawsweeper-state/);
  assert.match(
    publisher,
    /--report-revision "\$\{\{ steps\.publish-reports\.outputs\.state_revision \}\}"/,
  );
  assert.ok(
    publisher.indexOf("mapfile -d '' report_files") <
      publisher.indexOf('--commit-report "${report_files[0]}"'),
  );
  assert.match(publisher, /Publish immutable commit review action ledger/);
  assert.match(publisher, /append commit review action ledger/);
  assert.match(
    publisher,
    /CONTINUATION_REQUESTED:[\s\S]*DISPATCH_COUNT:[\s\S]*allow_empty=false[\s\S]*DISPATCH_COUNT" = "0"[\s\S]*CHECKS_REQUESTED" != "true"[\s\S]*CONTINUATION_REQUESTED" != "true"[\s\S]*allow_empty_args\+=\(--allow-empty\)/,
  );
  assert.match(publisher, /node dist\/commit-sweeper\.js dispatch-continuation/);
  assert.doesNotMatch(publisher, /\n\s+gh workflow run commit-review\.yml/);
  assert.ok(
    publisher.indexOf("- name: Verify and assemble commit review artifact cohort") <
      publisher.indexOf("- name: Commit reports"),
  );
  assert.ok(
    publisher.indexOf("- name: Dispatch commit findings to repair lane") <
      publisher.indexOf("- name: Finalize commit publication action ledger"),
  );
  assert.ok(
    publisher.indexOf("- name: Continue commit review range") <
      publisher.indexOf("- name: Finalize commit publication action ledger"),
  );
  assert.ok(
    publisher.indexOf("- name: Finalize commit publication action ledger") <
      publisher.indexOf("- name: Publish immutable commit review action ledger"),
  );
  assert.match(
    publisher,
    /name: Complete commit review continuation receipt\n\s+if: \$\{\{ success\(\) && \(github\.event\.inputs\.continuation_key \|\| github\.event\.client_payload\.continuation_key\) \}\}/,
  );
  assert.ok(
    publisher.indexOf("- name: Publish immutable commit review action ledger") <
      publisher.indexOf("- name: Complete commit review continuation receipt"),
  );
  const commitSweeper = readText("src/commit-sweeper.ts");
  const findingDispatch = commitSweeper.slice(
    commitSweeper.indexOf("function dispatchCommitFinding"),
    commitSweeper.indexOf("function dispatchFindingsCommand"),
  );
  assert.doesNotMatch(findingDispatch, /for \(let attempt = 0/);
  assert.doesNotMatch(findingDispatch, /ghRetryKind|ghRetryWaitMs/);
  assert.match(findingDispatch, /runCommitMutation\(lifecycle/);
  assert.match(findingDispatch, /kind: "commit_finding_dispatch"/);
  assert.match(commitSweeper, /reportSha256: createHash\("sha256"\)\.update\(markdown\)/);
  assert.match(commitSweeper, /reportRevision/);
  assert.match(commitSweeper, /report_sha256: dispatch\.reportSha256/);
  assert.match(commitSweeper, /report_revision: dispatch\.reportRevision/);
  assert.match(commitSweeper, /payload_version: 2/);
  assert.match(commitSweeper, /"payload_version=2"/);
  assert.match(commitSweeper, /kind: "commit_review_continuation_dispatch"/);
  assert.match(commitSweeper, /continuation_key=\$\{continuationKey\}/);
  assert.match(commitSweeper, /writeCommitPublicationOutput\("dispatch_count"/);
  for (const workflow of [activity, maintainer]) {
    assert.match(workflow, /setup-action-ledger/);
    assert.match(workflow, /repair:action-ledger -- finalize/);
    assert.match(workflow, /repair:action-ledger -- publish/);
  }
  assert.ok((activity.match(/--allow-empty/g) ?? []).length >= 2);
  assert.match(activity, /if \[ ! -s "\$paths_file" \]; then[\s\S]*exit 0/);
});

test("merge claim recovery reads ClawSweeper workflow state with central credentials", () => {
  const router = readText(".github/workflows/repair-comment-router.yml");
  const worker = readText(".github/workflows/repair-cluster-worker.yml");
  const sweep = readText(".github/workflows/sweep.yml");

  assert.equal(
    [
      ...router.matchAll(
        /CLAWSWEEPER_WORKFLOW_GH_TOKEN: \$\{\{ steps\.dispatch-token\.outputs\.token \}\}/g,
      ),
    ].length,
    2,
  );
  assert.match(worker, /CLAWSWEEPER_WORKFLOW_GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(sweep, /CLAWSWEEPER_WORKFLOW_GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test("issue implementation intake finalizes and publishes source-bound status receipts", () => {
  const workflow = readText(".github/workflows/repair-issue-implementation-intake.yml");

  assert.match(workflow, /permissions:\s+contents: write\s+actions: read/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(
    workflow,
    /--source-revision "\$\{\{ steps\.prepare\.outputs\.source_revision \}\}"/,
  );
  assert.match(workflow, /Finalize issue implementation intake action ledger/);
  assert.match(workflow, /repair:action-ledger -- finalize/);
  assert.match(
    workflow,
    /steps\.prepare\.outcome \}\}" = "success"[\s\S]*steps\.prepare\.outputs\.should_repair \}\}" != "true"[\s\S]*allow_empty_args\+=\(--allow-empty\)[\s\S]*--repair-lane issue-implementation-intake/,
  );
  assert.match(workflow, /Publish immutable issue implementation intake action ledger/);
  assert.match(workflow, /repair:action-ledger -- publish/);
  assert.match(
    workflow,
    /steps\.prepare\.outputs\.should_repair \}\}" != "true"[\s\S]*exit 0[\s\S]*Issue implementation intake action event shards existed but no paths were imported/,
  );
  assert.match(workflow, /jq -r '\.paths\[\]\?'/);
  assert.match(workflow, /append issue implementation intake action ledger/);
  assert.match(workflow, /--receipt-kind issue_implementation_intake_state/);
  assert.ok(
    workflow.indexOf("Dispatch repair worker") <
      workflow.indexOf("Finalize issue implementation intake action ledger"),
  );
  const dispatcher = readText("src/repair/dispatch-jobs.ts");
  assert.match(dispatcher, /runRepairMutation\(dispatchLifecycle\(jobPath\)/);
  assert.match(dispatcher, /kind: "repair_dispatch"/);
  assert.match(dispatcher, /`dispatch_key=\$\{dispatchKey\}`/);
  assert.match(dispatcher, /return `repair-dispatch-\$\{digest\}`/);
  assert.match(dispatcher, /repairSourceRevision\(job\.frontmatter\)/);
});

test("commit finding and cluster intake publish their dispatch receipts", () => {
  const workflows = [
    {
      path: ".github/workflows/repair-commit-finding-intake.yml",
      label: "commit finding intake",
      lane: "commit-finding-intake",
      decision: "steps.prepare.outputs.should_repair",
      dispatch: "Dispatch sealed repair worker",
    },
    {
      path: ".github/workflows/repair-cluster-intake.yml",
      label: "cluster intake",
      lane: "cluster-intake",
      decision: "steps.import.outputs.should_dispatch",
      dispatch: "Dispatch imported cluster repair",
    },
  ] as const;

  for (const expected of workflows) {
    const workflow = readText(expected.path);
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
    assert.match(workflow, new RegExp(`Finalize ${expected.label} action ledger`));
    assert.match(workflow, new RegExp(`--repair-lane ${expected.lane}`));
    assert.match(
      workflow,
      new RegExp(`${expected.decision.replaceAll(".", "\\.")}[^\\n]*!= "true"`),
    );
    assert.match(workflow, /allow_empty_args\+=\(--allow-empty\)/);
    assert.match(workflow, new RegExp(`Publish immutable ${expected.label} action ledger`));
    assert.match(workflow, /repair:action-ledger -- publish/);
    assert.match(workflow, /\.eventPaths == \$manifest\[0\]\.event_paths/);
    assert.match(workflow, /jq -r '\.paths\[\]\?'/);
    assert.match(workflow, new RegExp(`append ${expected.label} action ledger`));
    assert.match(workflow, /--receipt-kind [a-z0-9_]+_state/);
    assert.ok(
      workflow.indexOf(expected.dispatch) <
        workflow.indexOf(`Finalize ${expected.label} action ledger`),
    );
  }
  const commitFinding = readText(".github/workflows/repair-commit-finding-intake.yml");
  assert.match(commitFinding, /--dispatch-key "\$DISPATCH_KEY"/);
  assert.match(commitFinding, /"Intake commit finding" "Complete durable intake handoff"/);
  assert.match(commitFinding, /name: Complete durable intake handoff/);
});

test("result and finalizer workflows publish their repair operation receipts", () => {
  const results = readText(".github/workflows/repair-publish-results.yml");
  const finalizer = readText(".github/workflows/repair-finalize-open-prs.yml");

  for (const workflow of [results, finalizer]) {
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
    assert.match(workflow, /repair:action-ledger -- finalize/);
    assert.match(workflow, /repair:action-ledger -- publish/);
    assert.match(workflow, /steps\.setup-pnpm\.outcome == 'success'/);
  }
  assert.match(results, /append repair publication action ledger/);
  assert.match(results, /--receipt-kind repair_result_state/);
  assert.match(
    results,
    /steps\.download\.outputs\.has_artifacts[\s\S]*allow_empty_args\+=\(--allow-empty\)[\s\S]*--repair-lane repair-publication/,
  );
  assert.match(
    results,
    /if \[ "\$\{\{ steps\.download\.outputs\.has_artifacts \}\}" = "0" \]; then[\s\S]*exit 0/,
  );
  assert.match(results, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=cluster-results/);
  assert.match(results, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=open-pr-finalizer/);
  assert.match(results, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=finalizer-results/);
  assert.match(results, /Classify trusted worker artifact contract/);
  assert.match(results, /git merge-base --is-ancestor "\$WORKER_HEAD_SHA"/);
  assert.match(results, /-S'Seal immutable source job provenance'/);
  assert.match(results, /--trusted-legacy-worker-head "\$TRUSTED_LEGACY_WORKER_HEAD"/);
  assert.match(finalizer, /append repair finalizer action ledger/);
  assert.match(finalizer, /--receipt-kind open_pr_finalizer_state/);
  const finalizerSource = readText("src/repair/finalize-open-prs.ts");
  assert.match(finalizerSource, /runRepairMutation\(finalizerDispatchLifecycle\(candidate\)/);
  assert.match(finalizerSource, /operationName: "open_pr_finalizer"/);
});

test("the shared action ledger finalizer is operation-family agnostic", () => {
  const source = readText("src/repair/action-ledger-cli.ts");

  assert.match(source, /flushRepairActionEvents\(\)/);
  assert.doesNotMatch(source, /flushWorkflowActionEvents/);
  assert.doesNotMatch(source, /flushCommandActionEvents/);
});

test("repair and commit publishers require canonical exact manifests", () => {
  for (const workflowPath of [
    ".github/workflows/commit-review.yml",
    ".github/workflows/github-activity.yml",
    ".github/workflows/maintainer-report-discord.yml",
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-cluster-intake.yml",
    ".github/workflows/repair-commit-finding-intake.yml",
    ".github/workflows/repair-finalize-open-prs.yml",
    ".github/workflows/repair-issue-implementation-intake.yml",
    ".github/workflows/repair-publish-results.yml",
  ]) {
    const workflow = readText(workflowPath);
    assert.match(workflow, /CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT/);
    assert.match(workflow, /--repair-lane/);
    assert.match(workflow, /action-ledger-manifest\.json/);
    assert.match(workflow, /\.eventPaths == \$manifest\[0\]\.event_paths/);
    assert.doesNotMatch(workflow, /\.clawsweeper-repair\/action-ledger-state/);
  }
  const collector = readText("src/repair/action-ledger-cli.ts");
  assert.match(collector, /assertRepairActionLedgerManifestSource/);
  assert.match(collector, /command === "verify"/);
  assert.match(collector, /expectedProducer/);
  assert.match(collector, /expectedEventPaths: manifest\.event_paths/);
  assert.match(collector, /publication requires --repair-lane and --manifest/);
  const commit = readText(".github/workflows/commit-review.yml");
  assert.match(commit, /--receipt-kind commit_review_state/);
  assert.match(
    commit,
    /artifact-ids: \$\{\{ steps\.review-artifact-cohort\.outputs\.ledger_artifact_ids \}\}/,
  );
  assert.match(commit, /CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT: "1"/);
  assert.match(commit, /--commit-shas-file "\$expected_shas_file"/);
  assert.match(commit, /--cohort-file "\$cohort_file"/);
  assert.match(commit, /EXPECTED_COMMIT_MATRIX:/);
  assert.match(commit, /cmp -s "\$expected_shas_file" "\$actual_shas_file"/);
  assert.match(
    commit,
    /Verify and assemble commit review artifact cohort[\s\S]*repair:action-ledger -- verify[\s\S]*Commit reports[\s\S]*repair:action-ledger -- publish/,
  );
});

function runRepairLedgerCollector({
  forgedMutate = false,
  executeResult = "skipped",
}: {
  forgedMutate?: boolean;
  executeResult?: string;
} = {}) {
  const workflow = parse(readText(".github/workflows/repair-cluster-worker.yml"));
  const step = workflow.jobs["publish-repair-action-ledger"].steps.find(
    (candidate: { name?: string }) => candidate.name === "Publish immutable repair action ledger",
  );
  assert.equal(typeof step?.run, "string");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-ledger-collector-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const summary = path.join(root, "summary.md");
  const publishLog = path.join(root, "publish.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  writeLaneManifest(root, "cluster", "ledger/cluster.json");
  if (forgedMutate) writeLaneManifest(root, "mutate", "ledger/mutate.json");
  fs.writeFileSync(
    path.join(bin, "pnpm"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("repair:publish-main")) {
  fs.appendFileSync(process.env.PUBLISH_LOG, args.join(" ") + "\\n");
  process.exit(0);
}
const separator = args.indexOf("--");
const operation = separator >= 0 ? args[separator + 1] : "";
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const lane = value("--repair-lane");
if (operation === "verify") {
  process.exit(process.env.FORGED_MUTATE === "1" && lane === "mutate" ? 1 : 0);
}
if (operation === "publish") {
  const manifest = JSON.parse(fs.readFileSync(value("--manifest"), "utf8"));
  const stateRoot = value("--state-root");
  for (const relative of manifest.event_paths) {
    const target = path.join(stateRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, lane + "\\n");
  }
  process.stdout.write(JSON.stringify({ eventPaths: manifest.event_paths, paths: manifest.event_paths }));
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "jq"),
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "-r") {
  const input = JSON.parse(fs.readFileSync(args.at(-1), "utf8"));
  process.stdout.write(input.paths.map((value) => value + "\\n").join(""));
  process.exit(0);
}
const manifestIndex = args.indexOf("--slurpfile");
const manifest = JSON.parse(fs.readFileSync(args[manifestIndex + 2], "utf8"));
const input = JSON.parse(fs.readFileSync(args.at(-1), "utf8"));
process.exit(JSON.stringify(input.eventPaths) === JSON.stringify(manifest.event_paths) ? 0 : 1);
`,
    { mode: 0o755 },
  );

  try {
    const child = spawnSync("bash", ["-c", step.run], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        CLAWSWEEPER_STATE_DIR: state,
        GITHUB_STEP_SUMMARY: summary,
        PUBLISH_LOG: publishLog,
        FORGED_MUTATE: forgedMutate ? "1" : "0",
        CLUSTER_LEDGER_ARTIFACT_ID: "101",
        CLUSTER_LEDGER_ATTEMPT: "1",
        CLUSTER_JOB_RESULT: "success",
        CLUSTER_DOWNLOAD_OUTCOME: "success",
        EXECUTE_LEDGER_ARTIFACT_ID: "",
        EXECUTE_LEDGER_ATTEMPT: "",
        EXECUTE_LEDGER_ALLOW_EMPTY: "false",
        EXECUTE_JOB_RESULT: executeResult,
        EXECUTE_DOWNLOAD_OUTCOME: "skipped",
        MUTATE_LEDGER_ARTIFACT_ID: forgedMutate ? "303" : "",
        MUTATE_LEDGER_ATTEMPT: forgedMutate ? "1" : "",
        MUTATE_JOB_RESULT: forgedMutate ? "failure" : "skipped",
        MUTATE_DOWNLOAD_OUTCOME: forgedMutate ? "success" : "skipped",
      },
    });
    return {
      status: child.status,
      stderr: child.stderr,
      summary: fs.readFileSync(summary, "utf8"),
      published: fs.existsSync(publishLog) ? fs.readFileSync(publishLog, "utf8") : "",
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeLaneManifest(root: string, lane: string, eventPath: string) {
  const laneRoot = path.join(root, ".clawsweeper-repair", "action-ledger-download", lane);
  fs.mkdirSync(laneRoot, { recursive: true });
  fs.writeFileSync(
    path.join(laneRoot, "repair-action-ledger-manifest.json"),
    `${JSON.stringify({ event_paths: [eventPath] })}\n`,
  );
}
