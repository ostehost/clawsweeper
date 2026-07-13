import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

const intakeWorkflows = [
  ".github/workflows/repair-commit-finding-intake.yml",
  ".github/workflows/repair-issue-implementation-intake.yml",
];

function workflowRunScripts(workflowPath: string): { label: string; run: string }[] {
  const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as {
    jobs?: Record<string, { steps?: { name?: string; run?: string }[] }>;
  };
  const scripts: { label: string; run: string }[] = [];
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (typeof step.run !== "string") continue;
      scripts.push({ label: `${jobName}/${step.name ?? index}`, run: step.run });
    }
  }
  return scripts;
}

test("repository dispatch payloads cannot select repair runners", () => {
  for (const path of intakeWorkflows) {
    const workflow = fs.readFileSync(path, "utf8");
    assert.doesNotMatch(
      workflow,
      /github\.event\.client_payload\.(?:intake_runner|runner|execution_runner)/,
      path,
    );
  }
});

test("repair worker passes the job input to shell scripts through the environment", () => {
  const path = ".github/workflows/repair-cluster-worker.yml";
  const workflow = fs.readFileSync(path, "utf8");
  const directJobInputLines = workflow
    .split("\n")
    .filter((line) => line.includes("${{ inputs.job }}"));

  assert.ok(directJobInputLines.length > 0);
  for (const line of directJobInputLines) {
    assert.match(line, /^\s*(?:run-name:|group:|JOB_PATH:)/, line);
  }
  assert.match(workflow, /args=\("\$JOB_PATH" --mode "\$worker_mode"\)/);
  assert.match(workflow, /--source-job-path "\$JOB_PATH"/);
});

test("comment router passes replay attempt identities through the environment", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-comment-router.yml", "utf8");
  const directAttemptLines = workflow
    .split("\n")
    .filter(
      (line) => line.includes("inputs.attempt_id") || line.includes("client_payload.attempt_id"),
    );

  assert.equal(directAttemptLines.length, 1);
  for (const line of directAttemptLines) {
    assert.match(line, /^\s*ROUTER_ATTEMPT_ID:/, line);
  }
  assert.equal(workflow.match(/attempt_id="\$ROUTER_ATTEMPT_ID"/g)?.length, 2);
});

test("write-capable workflows never compile event data into shell source", () => {
  for (const workflowPath of [
    ".github/workflows/repair-cluster-worker.yml",
    ".github/workflows/repair-comment-router.yml",
    ".github/workflows/repair-commit-finding-intake.yml",
    ".github/workflows/repair-issue-implementation-intake.yml",
    ".github/workflows/sweep.yml",
  ]) {
    for (const { label, run } of workflowRunScripts(workflowPath)) {
      const expressions = run.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
      for (const expression of expressions) {
        assert.doesNotMatch(
          expression,
          /\b(?:github\.event(?:\.|_name)|inputs\.)/,
          `${workflowPath}:${label}: ${expression}`,
        );
      }
    }
  }
});

test("comment router shell bodies consume only environment-bound workflow values", () => {
  const workflowPath = ".github/workflows/repair-comment-router.yml";
  const workflow = fs.readFileSync(workflowPath, "utf8");

  for (const { label, run } of workflowRunScripts(workflowPath)) {
    assert.doesNotMatch(run, /\$\{\{/, `${label} still contains an expression`);
  }
  assert.equal(
    workflow.match(/ROUTER_TARGET_REPO: \$\{\{ steps\.target\.outputs\.target_repo \}\}/g)?.length,
    2,
  );
  assert.equal(workflow.match(/target_branch="\$ROUTER_TARGET_BRANCH"/g)?.length, 2);
  assert.equal(workflow.match(/force_reprocess="\$ROUTER_FORCE_REPROCESS"/g)?.length, 2);
});

test("workflow output validators reject multiline repositories and branches", () => {
  let repositoryOutputs = 0;
  let branchOutputs = 0;
  for (const workflowPath of [
    ".github/workflows/repair-comment-router.yml",
    ".github/workflows/sweep.yml",
  ]) {
    for (const { label, run } of workflowRunScripts(workflowPath)) {
      if (run.includes('echo "target_repo=$target_repo"')) {
        repositoryOutputs += 1;
        assert.ok(
          run.includes('if ! [[ "$target_repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then'),
          `${workflowPath}:${label} must validate the complete repository string`,
        );
      }
      if (run.includes('echo "target_branch=$target_branch"')) {
        branchOutputs += 1;
        assert.ok(
          run.includes('if ! [[ "$target_branch" =~ ^[A-Za-z0-9_./-]+$ ]]; then'),
          `${workflowPath}:${label} must validate the complete branch string`,
        );
      }
    }
  }
  assert.equal(repositoryOutputs, 5);
  assert.equal(branchOutputs, 2);

  for (const value of [
    "openclaw/openclaw\ntarget_repo=attacker/repo",
    "main\ntarget_branch=evil",
  ]) {
    const pattern = value.startsWith("openclaw/")
      ? "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
      : "^[A-Za-z0-9_./-]+$";
    const probe = spawnSync("bash", ["-c", '[[ "$VALUE" =~ $PATTERN ]]'], {
      env: { ...process.env, PATTERN: pattern, VALUE: value },
      encoding: "utf8",
    });
    assert.notEqual(probe.status, 0, value);
  }
});

test("exact-review lease outputs reject multiline dispatch identities", () => {
  const claim = workflowRunScripts(".github/workflows/sweep.yml").find(
    ({ label }) => label === "event-review-apply/Claim exact-review queue lease",
  );
  assert.ok(claim);
  assert.ok(
    claim.run.includes('if ! [[ "$QUEUE_LEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then'),
  );
  assert.match(claim.run, /`lease_id=\$\{process\.env\.QUEUE_LEASE_ID\}`/);

  for (const value of ["lease-123\nspoofed_output=value", "lease-123\rspoofed=value"]) {
    const probe = spawnSync(
      "bash",
      ["-c", '[[ "$VALUE" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]'],
      { env: { ...process.env, VALUE: value }, encoding: "utf8" },
    );
    assert.notEqual(probe.status, 0, value);
  }
});

test("repair job restoration rejects shell metacharacters and path traversal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-restore-job-"));
  const restore = path.resolve("scripts/restore-repair-job.sh");
  const invalidPaths = [
    'jobs/openclaw/inbox/automerge-openclaw-openclaw-1"; id; #.md',
    "jobs/../inbox/automerge-openclaw-openclaw-1.md",
    "jobs/openclaw/../../outside/inbox/automerge-openclaw-openclaw-1.md",
  ];

  try {
    for (const jobPath of invalidPaths) {
      const result = spawnSync("bash", [restore, jobPath], { cwd: root, encoding: "utf8" });
      assert.notEqual(result.status, 0, jobPath);
      assert.match(result.stderr, /Invalid job path:/);
    }

    const restorablePath = "jobs/openclaw/inbox/automerge-openclaw-openclaw-1.md";
    const restored = spawnSync("bash", [restore, restorablePath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(fs.existsSync(path.join(root, restorablePath)), true);

    const customPath = "jobs/openclaw/cluster-001.md";
    fs.mkdirSync(path.dirname(path.join(root, customPath)), { recursive: true });
    fs.writeFileSync(path.join(root, customPath), "existing job\n");
    const custom = spawnSync("bash", [restore, customPath], { cwd: root, encoding: "utf8" });
    assert.equal(custom.status, 0, custom.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
