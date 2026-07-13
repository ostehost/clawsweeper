import assert from "node:assert/strict";
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
    /eventIdentity:\s*\{\s*publicationKind: "cluster_result",\s*runId: runId \|\| clusterId,\s*state: canonicalDecision\.publish \? "prepared" : "stale_noop"/,
  );
  assert.equal(
    [...publisher.matchAll(/state: canonicalDecision\.publish \? "prepared" : "stale_noop"/g)]
      .length,
    2,
  );
  assert.doesNotMatch(publisher, /state: "published"/);
  assert.doesNotMatch(publisher, /recordAggregatePreparation\([^)]*,/);
});

test("repair worker jobs upload current-attempt ledgers for the trusted publisher", () => {
  const worker = readText(".github/workflows/repair-cluster-worker.yml");
  const publisher = readText(".github/workflows/repair-publish-results.yml");
  const cluster = worker.slice(worker.indexOf("\n  cluster:"), worker.indexOf("\n  execute:"));
  const execute = worker.slice(worker.indexOf("\n  execute:"));
  const clusterWorker = cluster.slice(
    cluster.indexOf("- name: Run worker"),
    cluster.indexOf("- name: Review worker result"),
  );

  assert.match(worker, /concurrency:[\s\S]*cancel-in-progress: false[\s\S]*queue: max/);
  assert.match(cluster, /permissions:\s+actions: read\s+contents: read/);
  assert.match(cluster, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(cluster, /Finalize cluster repair action ledger/);
  assert.match(
    cluster,
    /clawsweeper-repair-worker-action-ledger-cluster-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(clusterWorker, /pnpm run repair:worker/);
  assert.ok(
    cluster.indexOf("uses: ./.github/actions/setup-action-ledger") <
      cluster.indexOf("- name: Run worker"),
  );
  assert.ok(
    cluster.indexOf("- name: Run worker") <
      cluster.indexOf("- name: Finalize cluster repair action ledger"),
  );
  assert.match(execute, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(execute, /Finalize execution repair action ledger/);
  assert.match(
    execute,
    /clawsweeper-repair-worker-action-ledger-execute-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(publisher, /attempts\/\$\{RUN_ATTEMPT\}\/jobs\?per_page=100/);
  assert.match(publisher, /exactJobResult\(jobs, "Plan and review cluster"\)/);
  assert.match(publisher, /exactJobResult\(jobs, "Execute and apply cluster actions"\)/);
  assert.match(publisher, /Download cluster action ledger/);
  assert.match(publisher, /Download execution action ledger/);
  assert.match(publisher, /Verify current worker action ledgers/);
  assert.match(
    publisher,
    /\$lane job \(\$job_result\) did not expose its current-attempt action ledger/,
  );
  assert.match(publisher, /--expected-repository "\$GITHUB_REPOSITORY"/);
  assert.match(publisher, /--expected-sha "\$WORKER_HEAD_SHA"/);
  assert.match(publisher, /--expected-workflow repair-cluster-worker\.yml/);
  assert.match(publisher, /--expected-run-id "\$WORKER_RUN_ID"/);
  assert.match(
    publisher,
    /verify_lane cluster cluster "\$CLUSTER_JOB_RESULT" "\$CLUSTER_LEDGER_FOUND"/,
  );
  assert.match(
    publisher,
    /verify_lane execute execute "\$EXECUTE_JOB_RESULT" "\$EXECUTE_LEDGER_FOUND" true/,
  );
  assert.match(publisher, /import_worker_lane cluster cluster "\$CLUSTER_JOB_RESULT"/);
  assert.match(publisher, /import_worker_lane execute execute "\$EXECUTE_JOB_RESULT" true/);
  assert.ok(
    publisher.indexOf("- name: Verify current worker action ledgers") <
      publisher.indexOf("- name: Publish result ledger"),
  );
  assert.doesNotMatch(
    worker,
    /\n  (authorize|report|mutate|validate|publish-repair-action-ledger):/,
  );
  assert.doesNotMatch(publisher, /resolve-run-artifact|prior-attempt|allowPriorAttempts/);
});

test("repair mutation and Codex boundaries emit exact immutable receipts", () => {
  const ledger = readText("src/repair/repair-action-ledger.ts");
  const codexLedger = readText("src/repair/repair-codex-action-ledger.ts");
  const worker = readText("src/repair/run-worker.ts");
  const executor = readText("src/repair/execute-fix-artifact.ts");
  const github = readText("src/repair/execute-fix-github.ts");
  const postFlight = readText("src/repair/post-flight.ts");

  assert.match(ledger, /ACTION_EVENT_TYPES\.repairMutation/);
  assert.match(ledger, /requestAttempt/);
  assert.match(ledger, /mutation_outcome_unknown/);
  assert.match(ledger, /repairMutationState/);
  assert.match(executor, /beginRepairCodexAction/);
  for (const action of [
    "repair_plan",
    "repair_result_repair",
    "repair_edit",
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
  const review = commit.slice(commit.indexOf("\n  review:"), commit.indexOf("\n  publish:"));
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
  assert.match(review, /setup-action-ledger/);
  assert.match(review, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION: commit-\$\{\{ matrix\.sha \}\}/);
  assert.match(review, /--defer-workflow-completion/);
  assert.doesNotMatch(review, /publish-check|permission-checks: write|finish-review/);
  assert.doesNotMatch(review, /create-state-token|setup-state|CLAWSWEEPER_STATE_DIR/);
  assert.match(
    review,
    /commit-review-\$\{\{ matrix\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(review, /Finalize commit review action ledger/);
  assert.match(review, /Prepare commit review receipt bundle/);
  assert.match(review, /commit-review-diagnostic-\$\{\{ matrix\.sha \}\}/);
  assert.match(
    publisher,
    /if: \$\{\{ always\(\) && needs\.plan\.result == 'success' && \(needs\.plan\.outputs\.planned_count != '0'/,
  );
  assert.match(publisher, /create-state-token/);
  assert.match(publisher, /setup-state/);
  assert.match(publisher, /--expected-job review/);
  assert.doesNotMatch(publisher, /accepted-commit-review-check-shas|skipping duplicate write/);
  assert.match(
    publisher,
    /pattern: commit-review-\*-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(
    publisher,
    /artifact_name="commit-review-\$\{commit_sha\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
  );
  assert.doesNotMatch(
    publisher,
    /resolve-run-artifact|CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT|prior-attempt/,
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
  assert.match(publisher, /Verify current-attempt commit review bundles/);
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
  assert.match(publisher, /Publish immutable current-attempt commit review action ledger/);
  assert.match(publisher, /append commit review action ledger/);
  assert.match(
    publisher,
    /CONTINUATION_REQUESTED:[\s\S]*DISPATCH_COUNT:[\s\S]*allow_empty=false[\s\S]*DISPATCH_COUNT" = "0"[\s\S]*CHECKS_REQUESTED" != "true"[\s\S]*CONTINUATION_REQUESTED" != "true"[\s\S]*allow_empty_args\+=\(--allow-empty\)/,
  );
  assert.match(publisher, /node dist\/commit-sweeper\.js dispatch-continuation/);
  assert.doesNotMatch(publisher, /\n\s+gh workflow run commit-review\.yml/);
  assert.ok(
    publisher.indexOf("- name: Verify current-attempt commit review bundles") <
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
      publisher.indexOf("- name: Publish immutable current-attempt commit review action ledger"),
  );
  assert.match(
    publisher,
    /name: Complete commit review continuation receipt\n\s+if: \$\{\{ success\(\) && \(github\.event\.inputs\.continuation_key \|\| github\.event\.client_payload\.continuation_key\) \}\}/,
  );
  assert.ok(
    publisher.indexOf("- name: Publish immutable current-attempt commit review action ledger") <
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
  const sweep = readText(".github/workflows/sweep.yml");

  assert.equal(
    [
      ...router.matchAll(
        /CLAWSWEEPER_WORKFLOW_GH_TOKEN: \$\{\{ steps\.dispatch-token\.outputs\.token \}\}/g,
      ),
    ].length,
    2,
  );
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
  const commitFinding = readText(".github/workflows/repair-commit-finding-intake.yml");
  const cluster = readText(".github/workflows/repair-cluster-intake.yml");

  for (const [workflow, lane, label] of [
    [commitFinding, "commit-finding-intake", "commit finding intake"],
    [cluster, "cluster-intake", "cluster intake"],
  ] as const) {
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
    assert.match(workflow, new RegExp(`Finalize ${label} action ledger`));
    assert.match(workflow, new RegExp(`--repair-lane ${lane}`));
    assert.match(workflow, new RegExp(`Publish immutable ${label} action ledger`));
    assert.match(workflow, /repair:action-ledger -- publish/);
    assert.match(workflow, /\.eventPaths == \$manifest\[0\]\.event_paths/);
    assert.match(workflow, /jq -r '\.paths\[\]\?'/);
    assert.match(workflow, new RegExp(`append ${label} action ledger`));
  }
  assert.match(commitFinding, /--receipt-kind commit_finding_intake_state/);
  assert.ok(
    commitFinding.indexOf("Commit intake ledger") <
      commitFinding.indexOf("Finalize commit finding intake action ledger"),
  );
  assert.match(cluster, /allow_empty_args\+=\(--allow-empty\)/);
  assert.match(cluster, /--receipt-kind cluster_intake_state/);
  assert.ok(
    cluster.indexOf("Dispatch imported cluster repair") <
      cluster.indexOf("Finalize cluster intake action ledger"),
  );
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
  assert.match(results, /Verify current worker action ledgers/);
  assert.match(results, /import_worker_lane cluster cluster/);
  assert.match(results, /import_worker_lane execute execute/);
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
    /pattern: commit-review-\*-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.doesNotMatch(commit, /CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT|resolve-run-artifact/);
  assert.match(commit, /EXPECTED_COMMIT_MATRIX:/);
  assert.match(commit, /cmp -s "\$expected_shas_file" "\$actual_shas_file"/);
  assert.match(
    commit,
    /Verify current-attempt commit review bundles[\s\S]*repair:action-ledger -- verify[\s\S]*Commit reports[\s\S]*repair:action-ledger -- publish/,
  );
});
