import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const clusterWorkflowPath = ".github/workflows/repair-cluster-worker.yml";
const commitFindingWorkflowPath = ".github/workflows/repair-commit-finding-intake.yml";

test("repair worker accepts legacy payloads but keeps v2 identities mandatory", () => {
  const workflow = readWorkflow(clusterWorkflowPath);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.payload_version, {
    description: "Dispatch payload contract; new producers send 2",
    required: false,
    default: "",
    type: "string",
  });
  for (const name of ["state_revision", "job_sha256"]) {
    assert.equal(inputs[name].required, false);
    assert.equal(inputs[name].default, "");
  }

  const contract = workflowStep(workflow, "cluster", "Validate job handoff contract");
  const exact = runStep(contract.run, {
    JOB_PATH: "jobs/openclaw/inbox/cluster-exact.md",
    PAYLOAD_VERSION: "2",
    STATE_REVISION: "a".repeat(40),
    JOB_SHA256: "b".repeat(64),
  });
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.outputs, /^payload_version=2$/m);
  assert.match(exact.outputs, /^legacy_unsealed=false$/m);

  const legacy = runStep(contract.run, {
    JOB_PATH: "jobs/openclaw/inbox/cluster-legacy.md",
    PAYLOAD_VERSION: "",
    STATE_REVISION: "",
    JOB_SHA256: "",
  });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.outputs, /^payload_version=1$/m);
  assert.match(legacy.outputs, /^legacy_unsealed=true$/m);

  const missingV2 = runStep(contract.run, {
    JOB_PATH: "jobs/openclaw/inbox/cluster-missing.md",
    PAYLOAD_VERSION: "2",
    STATE_REVISION: "",
    JOB_SHA256: "",
  });
  assert.notEqual(missingV2.status, 0);
  assert.match(missingV2.stderr, /payload version 2 requires state_revision and job_sha256/);

  const partialLegacy = runStep(contract.run, {
    JOB_PATH: "jobs/openclaw/inbox/cluster-partial.md",
    PAYLOAD_VERSION: "",
    STATE_REVISION: "c".repeat(40),
    JOB_SHA256: "",
  });
  assert.notEqual(partialLegacy.status, 0);
  assert.match(partialLegacy.stderr, /must be provided together/);
});

test("legacy repair payloads are rebound to one state commit and forced plan-only", () => {
  const workflow = readWorkflow(clusterWorkflowPath);
  const resolve = workflowStep(workflow, "cluster", "Resolve immutable job handoff");
  const persist = workflowStep(workflow, "cluster", "Persist immutable recovery inputs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-legacy-worker-"));
  const stateRoot = path.join(root, "state");
  const jobPath = "jobs/openclaw/inbox/cluster-legacy.md";
  const jobBytes = "legacy job bytes\n";
  fs.mkdirSync(path.join(stateRoot, path.dirname(jobPath)), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, jobPath), jobBytes);
  const revision = commitFixture(stateRoot);
  const digest = createHash("sha256").update(jobBytes).digest("hex");

  try {
    const resolved = runStep(
      resolve.run,
      {
        JOB_PATH: jobPath,
        STATE_REVISION: "",
        JOB_SHA256: "",
        LEGACY_UNSEALED: "true",
        CLAWSWEEPER_STATE_DIR: stateRoot,
      },
      root,
    );
    assert.equal(resolved.status, 0, resolved.stderr);
    const resolvedOutputs = parseOutputs(resolved.outputs);
    assert.equal(resolvedOutputs.state_revision, revision);
    assert.equal(resolvedOutputs.job_sha256, digest);
    assert.equal(resolvedOutputs.legacy_unsealed, "true");

    const persisted = runStep(
      persist.run,
      {
        JOB_PATH: jobPath,
        STATE_REVISION: revision,
        JOB_SHA256: digest,
        LEGACY_UNSEALED: "true",
        REQUESTED_MODE: "autonomous",
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
      },
      root,
    );
    assert.equal(persisted.status, 0, persisted.stderr);
    assert.match(persisted.outputs, /^effective_mode=plan$/m);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(root, ".clawsweeper-repair/recovery-inputs/workflow-inputs.json"),
          "utf8",
        ),
      ),
      {
        schema_version: 1,
        source_job: jobPath,
        state_revision: revision,
        job_sha256: digest,
        requested_mode: "autonomous",
        effective_mode: "plan",
      },
    );
    assert.match(String(workflow.jobs.execute.if), /needs\.cluster\.outputs\.effective_mode/);
    assert.equal(
      workflow.jobs.execute.steps.find(
        (step: { name?: string }) => step.name === "Checkout immutable execution job",
      ).with.ref,
      "${{ needs.cluster.outputs.state_revision }}",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("commit finding intake keeps legacy reports audit-only", () => {
  const workflow = readWorkflow(commitFindingWorkflowPath);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.dispatch_key, {
    description: "Stable commit finding dispatch idempotency key",
    required: false,
    default: "",
    type: "string",
  });
  assert.equal(inputs.report_revision.required, false);
  assert.equal(inputs.report_sha256.required, false);
  assert.equal(inputs.report_revision.default, "");
  assert.equal(inputs.report_sha256.default, "");
  const resolve = workflowStep(workflow, "intake", "Resolve commit finding report handoff");
  const prepare = workflowStep(workflow, "intake", "Prepare commit finding intake");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-legacy-finding-"));
  const stateRoot = path.join(root, "state");
  const targetRepo = "openclaw/openclaw";
  const sha = "d".repeat(40);
  const reportPath = `records/openclaw-openclaw/commits/${sha}.md`;
  const reportBytes = `---\nresult: findings\nsha: ${sha}\nrepository: ${targetRepo}\n---\n`;
  fs.mkdirSync(path.join(stateRoot, path.dirname(reportPath)), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, reportPath), reportBytes);
  commitFixture(stateRoot);

  try {
    const rebound = runStep(
      resolve.run,
      {
        PAYLOAD_VERSION: "",
        TARGET_REPO: targetRepo,
        COMMIT_SHA: sha,
        REPORT_REPO: "openclaw/clawsweeper",
        REPORT_PATH: reportPath,
        REPORT_REVISION: "",
        REPORT_SHA256: "",
        REPORT_URL: `https://github.com/openclaw/clawsweeper/blob/main/${reportPath}`,
        CLAWSWEEPER_STATE_DIR: stateRoot,
      },
      root,
    );
    assert.equal(rebound.status, 0, rebound.stderr);
    assert.deepEqual(parseOutputs(rebound.outputs), {
      payload_version: "1",
      processable: "false",
      legacy_unsealed: "true",
      target_repo: targetRepo,
      report_repo: "openclaw/clawsweeper-state",
      report_path: reportPath,
      report_revision: "",
      report_sha256: "",
      report_url: "",
    });

    fs.rmSync(path.join(stateRoot, reportPath));
    const skipped = runStep(
      resolve.run,
      {
        PAYLOAD_VERSION: "",
        TARGET_REPO: targetRepo,
        COMMIT_SHA: sha,
        REPORT_REPO: "openclaw/clawsweeper",
        REPORT_PATH: reportPath,
        REPORT_REVISION: "",
        REPORT_SHA256: "",
        REPORT_URL: "",
        CLAWSWEEPER_STATE_DIR: stateRoot,
      },
      root,
    );
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(parseOutputs(skipped.outputs).processable, "false");

    const safeSkip = runStep(
      prepare.run,
      {
        TARGET_REPO: targetRepo,
        COMMIT_SHA: sha,
        REPORT_PROCESSABLE: "false",
        REPORT_REPO: "openclaw/clawsweeper-state",
        REPORT_PATH: reportPath,
        REPORT_REVISION: "",
        REPORT_SHA256: "",
        REPORT_URL: "",
      },
      root,
    );
    assert.equal(safeSkip.status, 0, safeSkip.stderr);
    assert.equal(parseOutputs(safeSkip.outputs).status, "legacy_report_unsealed");
    assert.match(
      fs.readFileSync(
        path.join(root, "results/commit-findings/openclaw-openclaw", `${sha}.md`),
        "utf8",
      ),
      /decision: legacy_report_unsealed/,
    );

    const missingV2 = runStep(
      resolve.run,
      {
        PAYLOAD_VERSION: "2",
        TARGET_REPO: targetRepo,
        COMMIT_SHA: sha,
        REPORT_REPO: "openclaw/clawsweeper-state",
        REPORT_PATH: reportPath,
        REPORT_REVISION: "",
        REPORT_SHA256: "",
        REPORT_URL: "",
        CLAWSWEEPER_STATE_DIR: stateRoot,
      },
      root,
    );
    assert.notEqual(missingV2.status, 0);
    assert.match(missingV2.stderr, /payload version 2 requires report_revision and report_sha256/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("commit finding intake owns stable dispatch receipts before processing", () => {
  const workflow = readWorkflow(commitFindingWorkflowPath);
  const receipt = workflowStep(workflow, "receipt", undefined);
  const complete = workflowStep(workflow, "intake", "Complete commit finding dispatch receipt");
  const targetRepo = "openclaw/openclaw";
  const sha = "a".repeat(40);
  const dispatchKey = `commit-finding-${"b".repeat(24)}`;
  const expectedTitle = `Commit finding ${targetRepo}@${sha} [${dispatchKey}]`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-commit-finding-receipt-"));
  const binDir = path.join(root, "bin");
  const scriptsDir = path.join(root, "scripts");

  assert.match(String(workflow["run-name"]), /Commit finding \{0\}@\{1\} \[\{2\}\]/);
  assert.equal(workflow.jobs.receipt.name, "Deduplicate commit finding dispatch receipt");
  assert.equal(workflow.jobs.intake.name, "Intake commit finding");
  assert.equal(workflow.jobs.intake.needs, "receipt");
  assert.match(String(workflow.jobs.intake.if), /needs\.receipt\.outputs\.proceed == 'true'/);
  assert.equal(
    receipt.env?.DISPATCH_KEY,
    "${{ github.event.inputs.dispatch_key || github.event.client_payload.dispatch_key || '' }}",
  );
  assert.match(
    receipt.run,
    /repair-commit-finding-intake\.yml "\$expected_title" "\$GITHUB_RUN_ID" \\\n\s+"Intake commit finding" "Complete commit finding dispatch receipt"/,
  );
  assert.equal(
    complete.if,
    "${{ success() && (github.event.inputs.dispatch_key || github.event.client_payload.dispatch_key) }}",
  );

  try {
    fs.mkdirSync(binDir);
    fs.mkdirSync(scriptsDir);
    fs.symlinkSync(
      path.resolve("scripts/dispatch-receipt-owner.sh"),
      path.join(scriptsDir, "dispatch-receipt-owner.sh"),
    );
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh
case "$*" in
  *actions/workflows/repair-commit-finding-intake.yml/runs*)
    printf '%s\\n' "$FAKE_RUNS_JSON"
    ;;
  *actions/runs/101/jobs*)
    printf '%s\\n' "$FAKE_JOBS_JSON"
    ;;
  *)
    echo "unexpected gh args: $*" >&2
    exit 9
    ;;
esac
`,
      { mode: 0o755 },
    );
    const duplicate = runStep(
      receipt.run,
      {
        DISPATCH_KEY: dispatchKey,
        TARGET_REPO: targetRepo,
        COMMIT_SHA: sha,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_RUN_ID: "200",
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_RUNS_JSON: JSON.stringify([
          {
            workflow_runs: [{ id: 101, display_title: expectedTitle, status: "completed" }],
          },
        ]),
        FAKE_JOBS_JSON: JSON.stringify([
          {
            jobs: [
              {
                name: "Intake commit finding",
                conclusion: "success",
                steps: [
                  {
                    name: "Complete commit finding dispatch receipt",
                    conclusion: "success",
                  },
                ],
              },
            ],
          },
        ]),
      },
      root,
    );
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(parseOutputs(duplicate.outputs).proceed, "false");

    const legacy = runStep(
      receipt.run,
      {
        DISPATCH_KEY: "",
        TARGET_REPO: targetRepo,
        COMMIT_SHA: sha,
        GITHUB_RUN_ID: "201",
      },
      root,
    );
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(parseOutputs(legacy.outputs).proceed, "true");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("commit finding intake canonicalizes mixed-case target repositories", () => {
  const workflow = readWorkflow(commitFindingWorkflowPath);
  const resolve = workflowStep(workflow, "intake", "Resolve commit finding report handoff");
  const prepare = workflowStep(workflow, "intake", "Prepare commit finding intake");
  const sha = "e".repeat(40);
  const canonicalRepo = "openclaw/openclaw";
  const canonicalPath = `records/openclaw-openclaw/commits/${sha}.md`;
  const env = {
    PAYLOAD_VERSION: "2",
    TARGET_REPO: "OpenClaw/OpenClaw",
    COMMIT_SHA: sha,
    REPORT_REPO: "openclaw/clawsweeper-state",
    REPORT_PATH: canonicalPath,
    REPORT_REVISION: "f".repeat(40),
    REPORT_SHA256: "a".repeat(64),
    REPORT_URL: "",
  };

  const resolved = runStep(resolve.run, env);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(parseOutputs(resolved.outputs).target_repo, canonicalRepo);
  assert.equal(parseOutputs(resolved.outputs).report_path, canonicalPath);
  assert.equal(prepare.env?.TARGET_REPO, "${{ steps.report-handoff.outputs.target_repo }}");

  const noncanonical = runStep(resolve.run, {
    ...env,
    REPORT_PATH: `records/OpenClaw-OpenClaw/commits/${sha}.md`,
  });
  assert.notEqual(noncanonical.status, 0);
  assert.match(
    noncanonical.stderr,
    new RegExp(`Commit finding report path must be ${canonicalPath}`),
  );
});

test("current repair and commit finding producers identify payload version 2", () => {
  const dispatcher = fs.readFileSync("src/repair/dispatch-jobs.ts", "utf8");
  const immutableHandoff = fs.readFileSync("src/repair/immutable-job-handoff.ts", "utf8");
  const commitSweeper = fs.readFileSync("src/commit-sweeper.ts", "utf8");
  assert.match(dispatcher, /"payload_version=2"/);
  assert.match(immutableHandoff, /"payload_version=2"/);
  assert.match(commitSweeper, /payload_version: 2/);
  assert.match(commitSweeper, /"payload_version=2"/);
});

function readWorkflow(file: string): any {
  return parse(fs.readFileSync(file, "utf8"));
}

function workflowStep(
  workflow: any,
  job: string,
  name?: string,
): { env?: Record<string, string>; run: string } {
  const step = workflow.jobs[job].steps.find((candidate: { id?: string; name?: string }) =>
    name === undefined ? candidate.id === "receipt" : candidate.name === name,
  );
  assert.equal(typeof step?.run, "string", `${job} is missing ${name ?? "receipt step"}`);
  return step;
}

function runStep(run: string, env: Record<string, string>, cwd?: string) {
  const root = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-workflow-step-"));
  const outputPath = path.join(root, `output-${Date.now()}-${Math.random()}.txt`);
  const child = spawnSync("bash", ["-c", run], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      GITHUB_OUTPUT: outputPath,
    },
  });
  const outputs = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (!cwd) fs.rmSync(root, { recursive: true, force: true });
  return { ...child, outputs };
}

function parseOutputs(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function commitFixture(root: string): string {
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  const commit = spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(revision.status, 0, revision.stderr);
  return revision.stdout.trim();
}
