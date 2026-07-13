import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("action-ledger CLI accepts the package-manager argument separator", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/repair/action-ledger-cli.js"), "--", "finalize", "--lane", "INVALID"],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid command action ledger lane: INVALID/);
  assert.doesNotMatch(result.stderr, /unknown argument: finalize/);
});

test("action-ledger CLI accepts an explicitly empty finalization", () => {
  const outputRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "command-action-ledger-empty-")),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/action-ledger-cli.js"),
        "finalize",
        "--lane",
        "comment-router",
        "--allow-empty",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
          CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(outputRoot, { force: true, recursive: true });
  }
});

test("action-ledger CLI publishes an authenticated empty repair manifest as a no-op", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-empty-")),
  );
  const outputRoot = path.join(root, "output");
  const stateRoot = path.join(root, "state");
  const manifestPath = path.join(root, "manifest.json");
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(stateRoot);
  const env = {
    ...process.env,
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    GITHUB_ACTION: "report_status",
    GITHUB_JOB: "report",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "4242",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  };

  try {
    const finalize = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/action-ledger-cli.js"),
        "finalize",
        "--repair-lane",
        "report-status",
        "--allow-empty",
      ],
      { encoding: "utf8", env },
    );
    assert.equal(finalize.status, 0, finalize.stderr);
    fs.writeFileSync(manifestPath, finalize.stdout);

    const publisherEnv = {
      ...env,
      GITHUB_JOB: "publish",
      GITHUB_RUN_ID: "9001",
      GITHUB_SHA: "b".repeat(40),
      GITHUB_WORKFLOW: "repair publish cluster results",
      GITHUB_WORKFLOW_REF:
        "openclaw/clawsweeper/.github/workflows/repair-publish-results.yml@refs/heads/main",
    };
    const rejected = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/action-ledger-cli.js"),
        "publish",
        "--repair-lane",
        "report-status",
        "--allow-empty",
        "--manifest",
        manifestPath,
        "--source-root",
        outputRoot,
        "--state-root",
        stateRoot,
      ],
      { encoding: "utf8", env: publisherEnv },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /manifest identity mismatch/);

    const publish = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/action-ledger-cli.js"),
        "publish",
        "--repair-lane",
        "report-status",
        "--allow-empty",
        "--manifest",
        manifestPath,
        "--expected-repository",
        "openclaw/clawsweeper",
        "--expected-sha",
        "a".repeat(40),
        "--expected-workflow",
        "repair-cluster-worker.yml",
        "--expected-job",
        "report",
        "--expected-run-id",
        "4242",
        "--expected-run-attempt",
        "1",
        "--source-root",
        outputRoot,
        "--state-root",
        stateRoot,
      ],
      { encoding: "utf8", env: publisherEnv },
    );
    assert.equal(publish.status, 0, publish.stderr);
    assert.deepEqual(JSON.parse(publish.stdout), {
      created: 0,
      unchanged: 0,
      eventPaths: [],
      reservationPaths: [],
      completionPaths: [],
      paths: [],
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
