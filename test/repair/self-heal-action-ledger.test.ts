import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function readText(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("failed-run self-heal budgets retries by immutable generation", () => {
  const source = readText("src/repair/self-heal-failed-runs.ts");

  assert.match(source, /attemptCountsByGeneration/);
  assert.match(source, /attemptCountsByGeneration\.get\(generation\)[\s\S]*maxAttemptsPerJob/);
  assert.match(source, /isMissingImmutableJobError\(error\)[\s\S]*"missing_job_file"/);
  assert.match(source, /const latestByGeneration = new Map/);
  assert.match(source, /resolveRunRecordJob\(record, sourceJob\)/);
  assert.match(source, /activeJobGenerationKey\(record\.source_job, record\.source_job_sha256\)/);
  assert.match(source, /fetchWorkflowRunHistory/);
});

test("self-heal mutations emit durable action receipts", () => {
  const failedRuns = readText("src/repair/self-heal-failed-runs.ts");
  const conflicts = readText("src/repair/conflict-self-heal.ts");

  assert.match(
    failedRuns,
    /runRepairMutation\(selfHealDispatchLifecycle\(candidate\),[\s\S]*kind: "repair_dispatch"/,
  );
  assert.match(
    failedRuns,
    /runRepairMutation\(selfHealGateLifecycle\(name, normalizedValue\),[\s\S]*kind: "repository_variable_update"/,
  );
  assert.match(failedRuns, /return path\.join\(repoRoot\(\), "results", "self-heal\.json"\)/);
  assert.doesNotMatch(
    failedRuns,
    /CLAWSWEEPER_SELF_HEAL_TEST_LEDGER_PATH|args\["ledger-path"\]|args\.ledger_path/,
  );
  assert.match(failedRuns, /cannot list live repair runs; refusing dispatch/);
  assert.match(failedRuns, /cannot verify active repair generations; refusing dispatch/);
  assert.match(failedRuns, /restoreGateSequence\(/);
  assert.match(failedRuns, /restoreGateWithFallback\(/);
  assert.match(
    failedRuns,
    /if \(!\/\\bHTTP 404\\b\|not found\/i\.test\(ghErrorText\(error\)\)\) throw error;\s+if \(readMutableGateState\(name\)\.exists\) throw error;/,
  );
  assert.match(
    conflicts,
    /runRepairMutation\(conflictPublicationLifecycle\(publicationContentSha256\),[\s\S]*kind: "conflict_self_heal_job_state"/,
  );
  assert.match(
    conflicts,
    /runRepairMutation\(conflictCandidateLifecycle\(candidate, `status:\$\{status\}`\),[\s\S]*kind: "conflict_self_heal_status"/,
  );
  assert.ok(
    conflicts.indexOf("const existing = findSelfHealStatusComment(candidate.number)") <
      conflicts.indexOf(
        "runRepairMutation(conflictCandidateLifecycle(candidate, `status:${status}`)",
      ),
  );
  assert.match(conflicts, /method: existing\?\.id \? "PATCH" : "POST"/);
  assert.match(conflicts, /operation: \(\) => ghText\(commandArgs\)/);
  assert.match(
    conflicts,
    /runRepairMutation\(conflictCandidateLifecycle\(candidate, "dispatch"\),[\s\S]*kind: "repair_dispatch"/,
  );
  const candidateLifecycle = conflicts.slice(
    conflicts.indexOf("function conflictCandidateLifecycle"),
    conflicts.indexOf("function conflictPublicationLifecycle"),
  );
  assert.match(candidateLifecycle, /sourceRevision: String\(candidate\.head_sha \?\? ""\)/);
  assert.doesNotMatch(candidateLifecycle, /candidate\.state_revision/);
});

test("conflict self-heal reports zero-dispatch outcomes without claiming dispatch", () => {
  const conflicts = readText("src/repair/conflict-self-heal.ts");
  const finalStatus = conflicts.slice(
    conflicts.indexOf("currentLedger.updated_at = new Date().toISOString();"),
    conflicts.indexOf("function publishSelfHealJobs"),
  );

  assert.match(
    finalStatus,
    /ready\.length > 0[\s\S]*\? "dispatched"[\s\S]*attempt\.status === "waiting"[\s\S]*\? "waiting"[\s\S]*: "skipped"/,
  );
  assert.doesNotMatch(finalStatus, /summary\.status = "dispatched"/);
});

test("self-heal workflows publish immutable action-ledger shards", () => {
  const workflows = [
    {
      path: ".github/workflows/repair-self-heal.yml",
      setup: "Setup failed-run self-heal action ledger",
      finalize: "Finalize failed-run self-heal action ledger",
      publish: "Publish immutable failed-run self-heal action ledger",
      lane: "failed-run-self-heal",
      receipt: "failed_run_self_heal_state",
    },
    {
      path: ".github/workflows/repair-conflict-self-heal.yml",
      setup: "Setup conflict self-heal action ledger",
      finalize: "Finalize conflict self-heal action ledger",
      publish: "Publish immutable conflict self-heal action ledger",
      lane: "conflict-self-heal",
      receipt: "conflict_self_heal_state",
    },
  ] as const;

  for (const expected of workflows) {
    const workflow = readText(expected.path);
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
    assert.match(workflow, new RegExp(expected.setup));
    assert.match(workflow, new RegExp(expected.finalize));
    assert.match(workflow, new RegExp(expected.publish));
    assert.match(workflow, new RegExp(`--repair-lane ${expected.lane}`));
    assert.match(workflow, new RegExp(`--receipt-kind ${expected.receipt}`));
    assert.match(workflow, /repair:action-ledger -- finalize/);
    assert.match(workflow, /repair:action-ledger -- publish/);
    assert.match(workflow, /\.eventPaths == \$manifest\[0\]\.event_paths/);
    assert.match(workflow, /jq -r '\.paths\[\]\?'/);
    assert.ok(workflow.indexOf(expected.setup) < workflow.indexOf(expected.finalize));
    assert.ok(workflow.indexOf(expected.finalize) < workflow.indexOf(expected.publish));
  }
});
