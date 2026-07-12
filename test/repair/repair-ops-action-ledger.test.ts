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

  assert.match(publisher, /name: Publish immutable repair action ledger/);
  assert.match(publisher, /needs:\s+- cluster\s+- execute\s+- mutate/);
  assert.match(publisher, /create-state-token/);
  assert.match(publisher, /name: Resolve repair action ledger shards/);
  assert.match(publisher, /has_artifacts=0/);
  assert.match(
    publisher,
    /artifact-ids: \$\{\{ steps\.repair-action-ledger-artifacts\.outputs\.artifact_ids \}\}/,
  );
  assert.doesNotMatch(
    publisher,
    /continue-on-error: true[\s\S]*Download repair action ledger shards/,
  );
  assert.match(publisher, /repair:action-ledger -- publish/);
  assert.match(publisher, /clawsweeper-repair-action-ledger-execute-/);
  assert.match(
    publisher,
    /Repair action ledger artifacts were selected but no paths were imported\." >&2\s+exit 1/,
  );
  assert.match(publisher, /--message "chore: append repair action ledger"/);
});

test("repair mutation and Codex boundaries emit exact immutable receipts", () => {
  const ledger = readText("src/repair/repair-action-ledger.ts");
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
  assert.match(executor, /recordRepairCodexLifecycle\("started", "repair_review"/);
  assert.match(executor, /publishRepairCodexArtifacts\("repair_review"/);
  assert.match(executor, /recordRepairCodexLifecycle\("started", "repair_review_fix"/);
  assert.match(executor, /repair_execution_report/);
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
  assert.match(postFlight, /recordPostFlightWorkflowEventSafely\("started"\)/);
  assert.match(postFlight, /recordPostFlightWorkflowEventSafely\("failed", error\)/);
  assert.match(postFlight, /recordPostFlightWorkflowEventSafely\("finalized"\)/);
});

test("commit review and notification workflows publish their operation receipts", () => {
  const commit = readText(".github/workflows/commit-review.yml");
  const activity = readText(".github/workflows/github-activity.yml");
  const maintainer = readText(".github/workflows/maintainer-report-discord.yml");

  assert.match(commit, /setup-action-ledger/);
  assert.match(commit, /Finalize commit review action ledger/);
  assert.match(commit, /action-ledger-commit-review-/);
  assert.match(commit, /codex-logs-commit-review-/);
  assert.match(commit, /Publish immutable commit review action ledger/);
  assert.match(commit, /append commit review action ledger/);
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
  assert.match(workflow, /Publish immutable issue implementation intake action ledger/);
  assert.match(workflow, /repair:action-ledger -- publish/);
  assert.match(workflow, /jq -r '\.paths\[\]\?'/);
  assert.match(workflow, /append issue implementation intake action ledger/);
  assert.ok(
    workflow.indexOf("Publish immutable issue implementation intake action ledger") <
      workflow.indexOf("Dispatch repair worker"),
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
  assert.match(results, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=cluster-results/);
  assert.match(results, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=open-pr-finalizer/);
  assert.match(results, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=finalizer-results/);
  assert.match(finalizer, /append repair finalizer action ledger/);
});

test("the shared action ledger finalizer is operation-family agnostic", () => {
  const source = readText("src/repair/action-ledger-cli.ts");

  assert.match(source, /flushRepairActionEvents\(\)/);
  assert.doesNotMatch(source, /flushWorkflowActionEvents/);
  assert.doesNotMatch(source, /flushCommandActionEvents/);
});
