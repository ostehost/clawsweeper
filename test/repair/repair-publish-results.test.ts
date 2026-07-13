import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";

import { readText } from "../helpers.ts";

test("repair result publication serializes every completed worker generation", () => {
  const worker = parse(readText(".github/workflows/repair-cluster-worker.yml"));
  const publisher = parse(readText(".github/workflows/repair-publish-results.yml"));

  assert.equal(worker.concurrency?.["cancel-in-progress"], false);
  assert.equal(worker.concurrency?.queue, "max");
  assert.equal(publisher.concurrency?.group, "clawsweeper-repair-publish-results");
  assert.equal(publisher.concurrency?.["cancel-in-progress"], false);
  assert.equal(publisher.concurrency?.queue, "max");
});

test("repair result publication binds canonical replacement to immutable producer order", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const publish = workflow.slice(
    workflow.indexOf("- name: Publish result ledger"),
    workflow.indexOf("- name: Prepare durable notification claims"),
  );

  assert.match(publish, /WORKFLOW_CREATED_AT: \$\{\{ github\.event\.workflow_run\.created_at \}\}/);
  assert.match(
    publish,
    /PRODUCER_ATTEMPT: \$\{\{ steps\.result-artifact\.outputs\.producer_attempt \}\}/,
  );
  assert.equal((publish.match(/--workflow-created-at "\$WORKFLOW_CREATED_AT"/g) ?? []).length, 2);
  assert.equal((publish.match(/--producer-attempt "\$PRODUCER_ATTEMPT"/g) ?? []).length, 2);
});

test("repair result publication treats a missing current artifact as an explicit empty outcome", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const current = workflow.slice(
    workflow.indexOf("- name: Resolve current worker result artifact"),
    workflow.indexOf("- name: Download exact current worker result artifact"),
  );
  const verify = workflow.slice(
    workflow.indexOf("- name: Verify current worker result artifact"),
    workflow.indexOf("- name: Publish result ledger"),
  );

  assert.match(current, /finalName = `clawsweeper-repair-\$\{runId\}-\$\{runAttempt\}`/);
  assert.match(current, /workerName = `clawsweeper-repair-worker-\$\{runId\}-\$\{runAttempt\}`/);
  assert.match(current, /current worker result artifact is ambiguous/);
  assert.match(current, /artifact_found: "0"/);
  assert.match(verify, /if \[ "\$ARTIFACT_FOUND" != "1" \]; then/);
  assert.match(verify, /echo "has_artifacts=0" >> "\$GITHUB_OUTPUT"/);
  assert.match(verify, /exit 0/);
  assert.match(workflow, /artifact-ids: \$\{\{ steps\.result-artifact\.outputs\.artifact_id \}\}/);
  assert.match(verify, /findResultPaths\("artifacts"\)/);
  assert.match(verify, /pnpm run repair:review-results -- "\$\{result_paths\[@\]\}"/);
  assert.doesNotMatch(
    workflow,
    /run-artifact\.js|Resolve verified prior worker result cohort|allowPriorAttempts|prior-attempt/,
  );
});

test("repair result publication rejects untrusted worker heads before minting write credentials", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const classification = workflow.slice(
    workflow.indexOf("- name: Classify trusted worker artifact contract"),
    workflow.indexOf("- name: Create GitHub App token"),
  );

  assert.match(workflow, /permissions:\n  contents: read/);
  assert.ok(
    workflow.indexOf("- name: Classify trusted worker artifact contract") <
      workflow.indexOf("- name: Create GitHub App token"),
  );
  assert.match(
    workflow,
    /uses: \.\/\.github\/actions\/setup-state[\s\S]*?token: \$\{\{ steps\.state-token\.outputs\.token \}\}[\s\S]*?fetch-depth: 0/,
  );
  for (const block of workflow.matchAll(
    /uses: actions\/download-artifact@v8\n\s+with:\n([\s\S]*?)(?=\n\s{6}- (?:name|uses):|\n\n)/g,
  )) {
    assert.match(block[1] ?? "", /github-token: \$\{\{ github\.token \}\}/);
    assert.doesNotMatch(block[1] ?? "", /steps\.app_token\.outputs\.token/);
  }
  assert.match(
    classification,
    /if \[\[ ! "\$WORKER_HEAD_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]; then[\s\S]*exit 1/,
  );
  assert.match(classification, /! git merge-base --is-ancestor "\$WORKER_HEAD_SHA"[\s\S]*exit 1/);
});

test("repair event notifications publish durable claims before delivery and receipts", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const prepareIndex = workflow.indexOf("- name: Prepare durable notification claims");
  const claimIndex = workflow.indexOf("- name: Commit notification claims");
  const notifyIndex = workflow.indexOf("- name: Notify OpenClaw about ClawSweeper events");
  const receiptIndex = workflow.indexOf("- name: Commit notification receipts");
  const resultIndex = workflow.indexOf("- name: Commit result ledger");
  const prepare = workflow.slice(prepareIndex, claimIndex);
  const claim = workflow.slice(claimIndex, notifyIndex);
  const notify = workflow.slice(notifyIndex, receiptIndex);
  const receipt = workflow.slice(receiptIndex, resultIndex);
  const result = workflow.slice(
    resultIndex,
    workflow.indexOf("- name: Finalize repair publication"),
  );

  assert.ok(prepareIndex >= 0);
  assert.ok(prepareIndex < claimIndex);
  assert.ok(claimIndex < notifyIndex);
  assert.ok(notifyIndex < receiptIndex);
  assert.ok(receiptIndex < resultIndex);
  assert.match(prepare, /GH_TOKEN: \$\{\{ steps\.app_token\.outputs\.token \}\}/);
  assert.match(prepare, /--prepare-only/);
  assert.match(claim, /--path notifications/);
  assert.match(claim, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=notification-claims/);
  assert.match(claim, /--best-effort-refresh/);
  assert.match(notify, /GH_TOKEN: \$\{\{ steps\.app_token\.outputs\.token \}\}/);
  assert.match(notify, /CLAWSWEEPER_EVENT_NOTIFY_REQUIRE_DURABLE_CLAIM: "1"/);
  assert.match(receipt, /--path notifications/);
  assert.match(receipt, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=notification-receipts/);
  assert.match(
    receipt,
    /if: \$\{\{ always\(\) && steps\.download\.outputs\.has_artifacts == '1' && steps\.app_token\.outcome == 'success' \}\}/,
  );
  assert.doesNotMatch(receipt, /--best-effort-refresh/);
  assert.doesNotMatch(result, /--path notifications/);
  assert.doesNotMatch(result, /--best-effort-refresh/);
});
