import assert from "node:assert/strict";
import test from "node:test";

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
  const resultReceipt = publisher.indexOf("type: ACTION_EVENT_TYPES.repairPublish", resultWrite);
  assert.ok(resultWrite >= 0);
  assert.ok(resultReceipt > resultWrite);
  assert.match(publisher, /ACTION_EVENT_TYPES\.publicationLifecycle/);
  assert.match(publisher, /ACTION_EVENT_TYPES\.dashboardLifecycle/);
  assert.match(publisher, /await flushRepairActionEvents\(\)/);
  assert.match(publisher, /recordRepairLifecycleFailureSafely/);
  assert.match(
    publisher,
    /reviewedResultRevision\([\s\S]*readPublishedSourceContext\(clusterPlan\)[\s\S]*missing one exact reviewed target revision/,
  );
  assert.match(
    publisher,
    /eventIdentity:\s*\{\s*publicationKind: "cluster_result",\s*runId: runId \|\| clusterId/,
  );
  assert.doesNotMatch(publisher, /recordAggregatePublication\([^)]*,/);
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
  const mutationRegistration = mutate.slice(
    mutate.indexOf("- name: Resume repair lifecycle"),
    mutate.indexOf("- name: Create exact-repository mutation token"),
  );

  assert.match(cluster, /permissions:\s+actions: read\s+contents: read/);
  assert.match(cluster, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(cluster, /Finalize cluster repair action ledger/);
  assert.match(cluster, /clawsweeper-repair-action-ledger-cluster-/);
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
  assert.match(mutate, /clawsweeper-repair-action-ledger-mutate-/);
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
  assert.match(execute, /clawsweeper-repair-action-ledger-execute-/);
  assert.match(
    execute,
    /checkpoint_recovered \}\}" = "1"[\s\S]*allow_empty_args\+=\(--allow-empty\)[\s\S]*--repair-lane execute/,
  );
  assert.match(report, /id: publish_terminal_status/);
  assert.match(report, /Finalize report status repair action ledger/);
  assert.match(report, /--repair-lane report-status/);
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
    /EXECUTE_LEDGER_ALLOW_EMPTY:[\s\S]*allow_empty_args\+=\(--allow-empty\)[\s\S]*verify_lane execute execute "\$EXECUTE_LEDGER_ATTEMPT" "\$EXECUTE_LEDGER_ALLOW_EMPTY"[\s\S]*publish_lane execute execute "\$EXECUTE_LEDGER_ATTEMPT" "\$EXECUTE_LEDGER_ALLOW_EMPTY"/,
  );
  assert.match(publisher, /publish_lane cluster cluster/);
  assert.match(publisher, /publish_lane execute execute/);
  assert.match(publisher, /publish_lane mutate mutate/);
  assert.match(
    publisher,
    /require_lane cluster[\s\S]*require_lane execute[\s\S]*require_lane mutate[\s\S]*verify_lane cluster[\s\S]*verify_lane execute[\s\S]*verify_lane mutate[\s\S]*publish_lane cluster/,
  );
  assert.match(publisher, /--message "chore: append repair action ledger"/);
});

test("repair mutation and Codex boundaries emit exact immutable receipts", () => {
  const ledger = readText("src/repair/repair-action-ledger.ts");
  const codexLedger = readText("src/repair/repair-codex-action-ledger.ts");
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
    "repair_edit",
    "repair_write_preflight",
    "repair_base_reconcile",
    "repair_review",
    "repair_review_fix",
    "repair_validation_fix",
  ]) {
    assert.match(codexLedger, new RegExp(`"${action}"`));
    assert.match(executor, new RegExp(`action: "${action}"`));
  }
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
  assert.match(postFlight, /\(\) => ghText\(mergeArgs\)/);
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
  const review = commit.slice(commit.indexOf("\n  review:"), commit.indexOf("\n  publish:"));
  const publisher = commit.slice(commit.indexOf("\n  publish:"));

  assert.match(review, /setup-action-ledger/);
  assert.match(review, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION: commit-\$\{\{ matrix\.sha \}\}/);
  assert.match(review, /--defer-workflow-completion/);
  assert.match(review, /--continue-workflow/);
  assert.match(review, /node dist\/commit-sweeper\.js finish-review/);
  assert.match(review, /--review-outcome "\$REVIEW_OUTCOME"/);
  assert.match(review, /report_path=.*matrix\.sha[\s\S]*--report-path "\$report_path"/);
  assert.match(review, /--check-outcome "\$CHECK_OUTCOME"/);
  assert.match(review, /--checks-requested "\$CHECKS_REQUESTED"/);
  assert.doesNotMatch(review, /CHECK_OUTCOME" = "skipped"/);
  assert.doesNotMatch(review, /create-state-token|setup-state|CLAWSWEEPER_STATE_DIR/);
  assert.ok(
    review.indexOf("- name: Review commit") < review.indexOf("- name: Create target checks token"),
  );
  assert.ok(
    review.indexOf("- name: Publish commit check") <
      review.indexOf("- name: Finish commit review lifecycle"),
  );
  assert.ok(
    review.indexOf("- name: Finish commit review lifecycle") <
      review.indexOf("- name: Finalize commit review action ledger"),
  );
  assert.match(review, /action-ledger-commit-review-\$\{\{ matrix\.sha \}\}/);
  assert.match(review, /codex-logs-commit-review-\$\{\{ matrix\.sha \}\}/);
  assert.match(publisher, /create-state-token/);
  assert.match(publisher, /setup-state/);
  assert.match(publisher, /merge-multiple: true/);
  assert.match(publisher, /Publish immutable commit review action ledger/);
  assert.match(publisher, /append commit review action ledger/);
  assert.match(
    publisher,
    /CONTINUATION_REQUESTED:[\s\S]*DISPATCH_COUNT:[\s\S]*allow_empty=false[\s\S]*DISPATCH_COUNT" = "0"[\s\S]*CHECKS_REQUESTED" != "true"[\s\S]*CONTINUATION_REQUESTED" != "true"[\s\S]*allow_empty_args\+=\(--allow-empty\)/,
  );
  assert.match(publisher, /node dist\/commit-sweeper\.js dispatch-continuation/);
  assert.doesNotMatch(publisher, /\n\s+gh workflow run commit-review\.yml/);
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
  const commitSweeper = readText("src/commit-sweeper.ts");
  const findingDispatch = commitSweeper.slice(
    commitSweeper.indexOf("function dispatchCommitFinding"),
    commitSweeper.indexOf("function dispatchFindingsCommand"),
  );
  assert.doesNotMatch(findingDispatch, /for \(let attempt = 0/);
  assert.doesNotMatch(findingDispatch, /ghRetryKind|ghRetryWaitMs/);
  assert.match(findingDispatch, /runCommitMutation\(lifecycle/);
  assert.match(findingDispatch, /kind: "commit_finding_dispatch"/);
  assert.match(commitSweeper, /kind: "commit_review_continuation_dispatch"/);
  assert.match(commitSweeper, /writeCommitPublicationOutput\("dispatch_count"/);
  for (const workflow of [activity, maintainer]) {
    assert.match(workflow, /setup-action-ledger/);
    assert.match(workflow, /repair:action-ledger -- finalize/);
    assert.match(workflow, /repair:action-ledger -- publish/);
  }
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
  assert.ok(
    workflow.indexOf("Dispatch repair worker") <
      workflow.indexOf("Finalize issue implementation intake action ledger"),
  );
  const dispatcher = readText("src/repair/dispatch-jobs.ts");
  assert.match(dispatcher, /runRepairMutation\(dispatchLifecycle\(jobPath\)/);
  assert.match(dispatcher, /kind: "repair_dispatch"/);
  assert.match(dispatcher, /repairSourceRevision\(job\.frontmatter\)/);
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
  assert.match(finalizer, /append repair finalizer action ledger/);
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
  assert.match(commit, /pattern: action-ledger-commit-review-\*-\$\{\{ github\.run_attempt \}\}/);
  assert.match(commit, /EXPECTED_COMMIT_MATRIX:/);
  assert.match(commit, /cmp -s "\$expected_shas_file" "\$actual_shas_file"/);
  assert.match(
    commit,
    /repair:action-ledger -- verify[\s\S]*for review_root in "\$\{review_roots\[@\]\}"[\s\S]*repair:action-ledger -- publish/,
  );
});
