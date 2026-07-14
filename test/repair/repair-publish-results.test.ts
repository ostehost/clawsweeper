import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { readText } from "../helpers.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFixture(
  repo: string,
  contents: string,
  message: string,
  capabilities: { sealed_source: boolean; action_ledger: boolean } | null,
): string {
  const workflow = path.join(repo, ".github", "workflows", "repair-cluster-worker.yml");
  const marker = path.join(repo, ".github", "repair-worker-capabilities.json");
  mkdirSync(path.dirname(workflow), { recursive: true });
  writeFileSync(workflow, contents);
  if (capabilities) {
    writeFileSync(
      marker,
      `${JSON.stringify(
        {
          action_ledger: capabilities.action_ledger,
          schema: "clawsweeper.repair-worker-capabilities",
          schema_version: 1,
          sealed_source: capabilities.sealed_source,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    rmSync(marker, { force: true });
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function classifyWorker(
  repo: string,
  script: string,
  workerHeadSha: string,
  env: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const output = path.join(repo, `classification-${workerHeadSha}.txt`);
  writeFileSync(output, "");
  execFileSync("bash", ["-c", script], {
    cwd: repo,
    env: {
      ...process.env,
      ...env,
      DEFAULT_BRANCH: "main",
      WORKER_HEAD_SHA: workerHeadSha,
      CAPABILITIES_PATH: ".github/repair-worker-capabilities.json",
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: repo,
    },
    stdio: "pipe",
  });
  return Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

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

test("repair result publication keeps results current while resolving prior producer attempts", () => {
  const worker = readText(".github/workflows/repair-cluster-worker.yml");
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const current = workflow.slice(
    workflow.indexOf("- name: Resolve current worker result artifact"),
    workflow.indexOf("- name: Download exact current worker result artifact"),
  );
  const verify = workflow.slice(
    workflow.indexOf("- name: Verify current worker result artifact"),
    workflow.indexOf("- name: Publish result ledger"),
  );

  assert.match(current, /for \(\(attempt = 1; attempt <= RUN_ATTEMPT; attempt \+= 1\)\)/);
  assert.match(current, /resolveWorkerPublicationCohort/);
  assert.match(current, /currentAttempt: runAttempt/);
  assert.match(current, /artifact_found: cohort\.resultArtifact \? "1" : "0"/);
  assert.match(current, /cluster_job_attempt: String\(clusterJob\.attempt\)/);
  assert.match(current, /execute_job_attempt: String\(executeJob\.attempt\)/);
  assert.match(current, /publish_job_attempt: String\(publishJob\.attempt\)/);
  assert.match(current, /publish_ledger_found: cohort\.publishLedger \? "1" : "0"/);
  assert.match(
    workflow,
    /name: Download publication action ledger[\s\S]*artifact-ids: \$\{\{ steps\.result-artifact\.outputs\.publish_ledger_id \}\}[\s\S]*action-ledgers\/publish/,
  );
  assert.match(
    workflow,
    /verify_lane publish publish "\$PUBLISH_JOB_RESULT" "\$PUBLISH_LEDGER_FOUND" "\$PUBLISH_JOB_ATTEMPT" true/,
  );
  assert.match(
    workflow,
    /import_worker_lane publish publish "\$PUBLISH_JOB_RESULT" "\$PUBLISH_JOB_ATTEMPT" true/,
  );
  assert.match(verify, /if \[ "\$ARTIFACT_FOUND" != "1" \]; then/);
  assert.match(verify, /echo "has_artifacts=0" >> "\$GITHUB_OUTPUT"/);
  assert.match(verify, /exit 0/);
  assert.match(workflow, /artifact-ids: \$\{\{ steps\.result-artifact\.outputs\.artifact_id \}\}/);
  assert.match(verify, /findResultPaths\(process\.env\.RESULT_ARTIFACT_ROOT\)/);
  assert.match(verify, /pnpm run repair:review-results -- "\$\{result_paths\[@\]\}"/);
  assert.match(worker, /Resolve latest worker transfer artifact/);
  assert.match(worker, /selectLatestAttemptArtifact/);
  assert.match(
    worker,
    /artifact-ids: \$\{\{ steps\.worker-transfer-artifact\.outputs\.artifact_id \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /run-artifact\.js|Resolve verified prior worker result cohort|allowPriorAttempts/,
  );
});

test("repair result publication rejects untrusted worker heads before minting write credentials", () => {
  const workflow = readText(".github/workflows/repair-publish-results.yml");
  const classification = workflow.slice(
    workflow.indexOf("- name: Classify trusted worker capabilities"),
    workflow.indexOf("- name: Create GitHub App token"),
  );

  assert.match(workflow, /permissions:\n  contents: read/);
  assert.ok(
    workflow.indexOf("- name: Classify trusted worker capabilities") <
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
    assert.match(
      block[1] ?? "",
      /path: \$\{\{ runner\.temp \}\}\/clawsweeper-repair-worker-artifacts\//,
    );
  }
  assert.doesNotMatch(workflow, /path: (?:artifacts|\.clawsweeper-repair\/action-ledger-download)/);
  assert.match(workflow, /pnpm run repair:publish-result -- "\$RESULT_ARTIFACT_ROOT"/);
  assert.match(
    classification,
    /if \[\[ ! "\$WORKER_HEAD_SHA" =~ \^\[a-f0-9\]\{40\}\$ \]\]; then[\s\S]*exit 1/,
  );
  assert.match(classification, /! git merge-base --is-ancestor "\$WORKER_HEAD_SHA"[\s\S]*exit 1/);
  assert.match(
    classification,
    /git ls-tree --full-tree "\$WORKER_HEAD_SHA" -- "\$CAPABILITIES_PATH"/,
  );
  assert.match(classification, /if ! git cat-file blob "\$marker_oid"/);
  assert.match(classification, /Unreadable worker capabilities/);
  assert.match(
    classification,
    /git log -1 --format=%H "\$WORKER_HEAD_SHA" -- "\$CAPABILITIES_PATH"/,
  );
  assert.match(classification, /Removed worker capabilities/);
  assert.match(classification, /\.schema == "clawsweeper\.repair-worker-capabilities"/);
  assert.match(
    classification,
    /\.sealed_source == true and \.action_ledger == true[\s\S]*Unsupported worker capabilities/,
  );
  assert.match(classification, /worker_ledgers_required=0/);
  assert.match(classification, /worker_ledgers_required=1/);
  assert.doesNotMatch(classification, /classify_contract|CONTRACT_SHA|git show|grep -F/);
  const capabilities = JSON.parse(readText(".github/repair-worker-capabilities.json"));
  assert.deepEqual(capabilities, {
    action_ledger: true,
    schema: "clawsweeper.repair-worker-capabilities",
    schema_version: 1,
    sealed_source: true,
  });
});

test("repair result publication requires ledgers for every post-contract worker", () => {
  const publisher = parse(readText(".github/workflows/repair-publish-results.yml"));
  const classify = publisher.jobs.publish.steps.find(
    (step: { name?: string }) => step.name === "Classify trusted worker capabilities",
  );
  assert.equal(typeof classify?.run, "string");

  const root = mkdtempSync(path.join(os.tmpdir(), "clawsweeper-worker-contract-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  try {
    git(root, "init", "--bare", origin);
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "ClawSweeper Test");
    git(repo, "config", "user.email", "clawsweeper@example.invalid");
    git(repo, "remote", "add", "origin", origin);

    const legacyHead = commitFixture(repo, "name: repair cluster worker\n", "legacy worker", null);
    const sealedSourceContract = commitFixture(
      repo,
      "name: repair cluster worker\n# sealed source contract\n",
      "sealed source contract",
      { sealed_source: true, action_ledger: false },
    );
    const actionLedgerContract = commitFixture(
      repo,
      "name: repair cluster worker\n# sealed source contract\n# action ledger contract\n",
      "action ledger contract",
      { sealed_source: true, action_ledger: true },
    );
    const regressedHead = commitFixture(
      repo,
      "name: repair cluster worker\n# ledger steps accidentally removed\n",
      "regress worker contents",
      { sealed_source: true, action_ledger: true },
    );
    const removedContract = commitFixture(
      repo,
      "name: repair cluster worker\n# capability marker accidentally removed\n",
      "remove worker capabilities",
      null,
    );
    git(repo, "switch", "-c", "squash-landing", legacyHead);
    const squashLanding = commitFixture(
      repo,
      "name: repair cluster worker\n# all capabilities landed together\n",
      "squashed worker capabilities",
      { sealed_source: true, action_ledger: true },
    );
    git(repo, "switch", "main");
    git(repo, "merge", "--no-ff", "-s", "ours", "squash-landing", "-m", "merge squash fixture");
    git(repo, "push", "-u", "origin", "main");

    assert.deepEqual(classifyWorker(repo, classify.run, legacyHead), {
      trusted_legacy_worker_head: legacyHead,
      worker_ledgers_required: "0",
    });
    assert.throws(
      () => classifyWorker(repo, classify.run, sealedSourceContract),
      (error: unknown) => {
        const output = error as { stderr?: string; stdout?: string };
        assert.match(
          `${String(output.stdout ?? "")}\n${String(output.stderr ?? "")}`,
          /Unsupported worker capabilities/,
        );
        return true;
      },
    );
    assert.deepEqual(classifyWorker(repo, classify.run, actionLedgerContract), {
      trusted_legacy_worker_head: "",
      worker_ledgers_required: "1",
    });
    assert.deepEqual(classifyWorker(repo, classify.run, regressedHead), {
      trusted_legacy_worker_head: "",
      worker_ledgers_required: "1",
    });
    assert.throws(
      () => classifyWorker(repo, classify.run, removedContract),
      (error: unknown) => {
        const output = error as { stderr?: string; stdout?: string };
        assert.match(
          `${String(output.stdout ?? "")}\n${String(output.stderr ?? "")}`,
          /Removed worker capabilities/,
        );
        return true;
      },
    );
    assert.deepEqual(classifyWorker(repo, classify.run, squashLanding), {
      trusted_legacy_worker_head: "",
      worker_ledgers_required: "1",
    });

    const bin = path.join(root, "bin");
    const gitBinary = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "git"),
      `#!/usr/bin/env bash
if [ "$1" = "cat-file" ] && [ "$2" = "blob" ]; then
  exit 71
fi
exec "$REAL_GIT" "$@"
`,
    );
    chmodSync(path.join(bin, "git"), 0o755);
    assert.throws(
      () =>
        classifyWorker(repo, classify.run, actionLedgerContract, {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          REAL_GIT: gitBinary,
        }),
      (error: unknown) => {
        const output = error as { stderr?: string; stdout?: string };
        assert.match(
          `${String(output.stdout ?? "")}\n${String(output.stderr ?? "")}`,
          /Unreadable worker capabilities/,
        );
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    /if: \$\{\{ always\(\) && steps\.download\.outputs\.has_artifacts == '1' && steps\.publish-worker-action-ledgers\.outputs\.ready == '1' && steps\.app_token\.outcome == 'success' \}\}/,
  );
  assert.doesNotMatch(receipt, /--best-effort-refresh/);
  assert.doesNotMatch(result, /--path notifications/);
  assert.doesNotMatch(result, /--best-effort-refresh/);
  assert.match(
    result,
    /if: \$\{\{ always\(\) && steps\.download\.outputs\.has_artifacts == '1' && steps\.publish-worker-action-ledgers\.outputs\.ready == '1' && steps\.publish-result-ledger\.outcome == 'success' && steps\.app_token\.outcome == 'success' \}\}/,
  );
});
