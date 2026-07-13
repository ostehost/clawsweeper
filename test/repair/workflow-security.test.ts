import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const intakeWorkflows = [
  ".github/workflows/repair-commit-finding-intake.yml",
  ".github/workflows/repair-issue-implementation-intake.yml",
];

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

  assert.equal(directAttemptLines.length, 2);
  for (const line of directAttemptLines) {
    assert.match(line, /^\s*ROUTER_ATTEMPT_ID:/, line);
  }
  assert.equal(workflow.match(/attempt_id="\$ROUTER_ATTEMPT_ID"/g)?.length, 2);
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
