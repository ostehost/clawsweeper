import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("requeue restores absent and empty execution gates without leaving them enabled", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-requeue-gates-"));
  try {
    const statePath = path.join(temp, "gates.json");
    const callsPath = path.join(temp, "calls.jsonl");
    const fakeGhPath = path.join(temp, "gh.cjs");
    const stateRoot = path.join(temp, "state");
    const sourceJobPath = "jobs/openclaw-example/inbox/requeue-gate-test.md";
    const jobPath = path.join(stateRoot, sourceJobPath);
    const headSha = spawnSync("git", ["rev-parse", "origin/main"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim();

    fs.writeFileSync(statePath, JSON.stringify({ CLAWSWEEPER_ALLOW_FIX_PR: "" }));
    const jobContents = [
      "---",
      "repo: openclaw/example",
      "cluster_id: requeue-gate-test",
      "mode: execute",
      "allowed_actions:",
      "  - fix",
      "candidates:",
      "  - '#1'",
      "allow_fix_pr: true",
      "---",
      "Restore the original gate state after dispatch.",
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, jobContents);
    execFileSync("git", ["init", "-q"], { cwd: stateRoot });
    execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: stateRoot });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: stateRoot });
    execFileSync("git", ["add", sourceJobPath], { cwd: stateRoot });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: stateRoot });
    const stateRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: stateRoot,
      encoding: "utf8",
    }).trim();
    const jobSha256 = createHash("sha256").update(jobContents).digest("hex");
    fs.writeFileSync(
      fakeGhPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.TEST_GATE_STATE_PATH;
const callsPath = process.env.TEST_GATE_CALLS_PATH;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
fs.appendFileSync(callsPath, JSON.stringify(args) + "\\n");
if (args[0] === "variable" && args[1] === "list") {
  process.stdout.write(JSON.stringify(Object.entries(state).map(([name, value]) => ({ name, value }))));
} else if (args[0] === "variable" && args[1] === "set") {
  state[args[2]] = args[args.indexOf("--body") + 1] ?? "";
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] === "variable" && args[1] === "delete") {
  delete state[args[2]];
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] === "api") {
  process.stdout.write("[]");
} else if (args[0] === "run" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{
    databaseId: 123456789,
    workflowName: "repair cluster worker",
    headSha: process.env.TEST_HEAD_SHA,
    status: "completed",
    conclusion: "success",
    createdAt: new Date().toISOString(),
    url: "https://github.com/openclaw/clawsweeper/actions/runs/123456789"
  }]));
}
`,
    );
    fs.chmodSync(fakeGhPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        "dist/repair/requeue-job.js",
        sourceJobPath,
        "--source-job-path",
        sourceJobPath,
        "--state-revision",
        stateRevision,
        "--job-sha256",
        jobSha256,
        "--mode",
        "execute",
        "--execute",
        "--open-execute-window",
        "--repo",
        "openclaw/clawsweeper",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
          CLAWSWEEPER_REPO: "openclaw/clawsweeper",
          CLAWSWEEPER_STATE_DIR: stateRoot,
          GH_BIN: fakeGhPath,
          GH_BIN_ARGS: "",
          TEST_GATE_CALLS_PATH: callsPath,
          TEST_GATE_STATE_PATH: statePath,
          TEST_HEAD_SHA: headSha,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), {
      CLAWSWEEPER_ALLOW_FIX_PR: "",
    });

    const calls = fs
      .readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "variable" &&
          args[1] === "set" &&
          args[2] === "CLAWSWEEPER_ALLOW_FIX_PR" &&
          args[args.indexOf("--body") + 1] === "",
      ),
    );
    assert.ok(
      calls.some(
        (args) =>
          args[0] === "variable" && args[1] === "delete" && args[2] === "CLAWSWEEPER_ALLOW_EXECUTE",
      ),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("run-id requeue selects one latest complete producer cohort", () => {
  const fixture = createFixture("complete", "910101");
  try {
    writeArtifactCohort(fixture, 1, {
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      mode: "plan",
    });
    writeArtifactCohort(fixture, 2, {
      stateRevision: fixture.replacementRevision,
      jobSha256: fixture.replacementDigest,
      mode: "autonomous",
    });

    const result = runRequeue(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.source_state_revision, fixture.replacementRevision);
    assert.equal(summary.source_job_sha256, fixture.replacementDigest);
    assert.equal(summary.mode, "autonomous");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue recovers early immutable inputs before worker results exist", () => {
  const fixture = createFixture("early-inputs", "910103");
  try {
    writeWorkflowInputs(fixture, 1, {
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      requestedMode: "autonomous",
      effectiveMode: "plan",
    });

    const result = runRequeue(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.source_state_revision, fixture.originalRevision);
    assert.equal(summary.source_job_sha256, fixture.originalDigest);
    assert.equal(summary.mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue prefers the newest early-input producer attempt", () => {
  const fixture = createFixture("latest-inputs", "910104");
  try {
    writeArtifactCohort(fixture, 1, {
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      mode: "plan",
    });
    writeWorkflowInputs(fixture, 2, {
      stateRevision: fixture.replacementRevision,
      jobSha256: fixture.replacementDigest,
      requestedMode: "autonomous",
      effectiveMode: "plan",
    });

    const result = runRequeue(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.source_state_revision, fixture.replacementRevision);
    assert.equal(summary.source_job_sha256, fixture.replacementDigest);
    assert.equal(summary.mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue prefers a newer plan attempt over complete older durable provenance", () => {
  const fixture = createFixture("published-downgrade", "910106");
  try {
    writeRunRecord(fixture, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.replacementRevision,
      source_job_sha256: fixture.replacementDigest,
      mode: "autonomous",
    });
    writeArtifactCohort(fixture, 1, {
      stateRevision: fixture.replacementRevision,
      jobSha256: fixture.replacementDigest,
      mode: "autonomous",
    });
    writeWorkflowInputs(fixture, 2, {
      stateRevision: fixture.replacementRevision,
      jobSha256: fixture.replacementDigest,
      requestedMode: "autonomous",
      effectiveMode: "plan",
    });

    const result = runRequeue(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.source_state_revision, fixture.replacementRevision);
    assert.equal(summary.source_job_sha256, fixture.replacementDigest);
    assert.equal(summary.mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue uses complete published provenance after Actions artifacts expire", () => {
  const fixture = createFixture("published-expired", "910107");
  try {
    writeRunRecord(fixture, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.replacementRevision,
      source_job_sha256: fixture.replacementDigest,
      mode: "autonomous",
    });

    const result = runRequeue(fixture, { GH_ARTIFACT_EXPIRED: "1" });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.source_state_revision, fixture.replacementRevision);
    assert.equal(summary.source_job_sha256, fixture.replacementDigest);
    assert.equal(summary.mode, "autonomous");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue does not mask artifact transport failures with durable provenance", () => {
  const fixture = createFixture("published-auth-failure", "910112");
  try {
    writeRunRecord(fixture, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.replacementRevision,
      source_job_sha256: fixture.replacementDigest,
      mode: "autonomous",
    });

    const result = runRequeue(fixture, { GH_ARTIFACT_FAILURE: "auth" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HTTP 401: Bad credentials/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue does not replace incomplete available artifacts with durable provenance", () => {
  const fixture = createFixture("published-incomplete", "910108");
  try {
    writeRunRecord(fixture, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.replacementRevision,
      source_job_sha256: fixture.replacementDigest,
      mode: "autonomous",
    });

    const result = runRequeue(fixture);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /did not publish immutable workflow inputs or one complete sealed repair artifact cohort/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue rejects published provenance whose digest does not match state bytes", () => {
  const fixture = createFixture("published-digest-mismatch", "910109");
  try {
    writeRunRecord(fixture, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.replacementRevision,
      source_job_sha256: "f".repeat(64),
      mode: "autonomous",
    });

    const result = runRequeue(fixture, { GH_ARTIFACT_EXPIRED: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /immutable job SHA-256 mismatch/);
    assert.doesNotMatch(result.stderr, /Actions artifacts expired/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue rejects published effective mode that conflicts with job bytes", () => {
  const fixture = createFixture("published-mode-mismatch", "910110");
  try {
    writeRunRecord(fixture, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "autonomous",
    });

    const result = runRequeue(fixture, { GH_ARTIFACT_EXPIRED: "1" });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /recovered effective mode autonomous conflicts with immutable job mode plan/,
    );
    assert.doesNotMatch(result.stderr, /Actions artifacts expired/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue fetches an exact historical revision from a depth-one state checkout", () => {
  const fixture = createFixture("published-shallow", "910111");
  try {
    replaceStateWithDepthOneClone(fixture);
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", `${fixture.originalRevision}^{commit}`], {
        cwd: fixture.stateRoot,
      }).status,
      0,
    );
    writeRunRecord(fixture, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
      mode: "plan",
    });

    const result = runRequeue(fixture, { GH_ARTIFACT_EXPIRED: "1" });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.source_state_revision, fixture.originalRevision);
    assert.equal(summary.source_job_sha256, fixture.originalDigest);
    assert.equal(summary.mode, "plan");
    assert.equal(
      spawnSync("git", ["cat-file", "-e", `${fixture.originalRevision}^{commit}`], {
        cwd: fixture.stateRoot,
      }).status,
      0,
    );
    assert.equal(fs.existsSync(path.join(fixture.stateRoot, ".git", "shallow")), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue rejects conflicting early and sealed provenance", () => {
  const fixture = createFixture("conflicting-inputs", "910105");
  try {
    writeWorkflowInputs(fixture, 1, {
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      requestedMode: "autonomous",
      effectiveMode: "plan",
    });
    writeArtifactCohort(fixture, 1, {
      stateRevision: fixture.replacementRevision,
      jobSha256: fixture.replacementDigest,
      mode: "autonomous",
    });

    const result = runRequeue(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ambiguous repair artifact cohort at attempt 1/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("run-id requeue rejects identity and mode from different producer attempts", () => {
  const fixture = createFixture("split", "910102");
  try {
    const firstRunDir = artifactRunDir(fixture, 1);
    fs.mkdirSync(firstRunDir, { recursive: true });
    writeSourceIdentity(firstRunDir, fixture.jobPath, {
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
    });
    fs.writeFileSync(path.join(firstRunDir, "result.json"), '{"mode":"plan"}\n');

    const secondRunDir = artifactRunDir(fixture, 2);
    fs.mkdirSync(secondRunDir, { recursive: true });
    writePlanAndResult(secondRunDir, fixture.jobPath, "autonomous");

    const result = runRequeue(fixture);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /did not publish immutable workflow inputs or one complete sealed repair artifact cohort/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture(label: string, runId: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawsweeper-requeue-${label}-`));
  const stateRoot = path.join(root, "state");
  const runsDir = path.join(root, "runs");
  const artifactFixture = path.join(root, "artifacts");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(artifactFixture, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: stateRoot });
  execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: stateRoot });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: stateRoot });
  const jobPath = `jobs/openclaw/inbox/cluster-requeue-${label}.md`;
  const original = repairJob("plan", `${label}-original`);
  const originalRevision = commitJob(stateRoot, jobPath, original, "original");
  const originalDigest = createHash("sha256").update(original).digest("hex");
  const replacement = repairJob("autonomous", `${label}-replacement`);
  const replacementRevision = commitJob(stateRoot, jobPath, replacement, "replacement");
  const replacementDigest = createHash("sha256").update(replacement).digest("hex");
  writeFakeGh(binDir);
  return {
    root,
    stateRoot,
    runsDir,
    artifactFixture,
    binDir,
    jobPath,
    runId,
    originalRevision,
    originalDigest,
    replacementRevision,
    replacementDigest,
  };
}

function runRequeue(fixture: ReturnType<typeof createFixture>, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [path.resolve("dist/repair/requeue-job.js"), fixture.runId, "--runs-dir", fixture.runsDir],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        CLAWSWEEPER_STATE_DIR: fixture.stateRoot,
        GH_BIN: path.join(fixture.binDir, "gh"),
        GH_BIN_ARGS: "",
        GH_ARTIFACT_FIXTURE: fixture.artifactFixture,
        GH_ARTIFACT_EXPIRED: "0",
        GH_ARTIFACT_FAILURE: "",
        ...extraEnv,
      },
    },
  );
}

function replaceStateWithDepthOneClone(fixture: ReturnType<typeof createFixture>): void {
  const sourceRoot = path.join(fixture.root, "state-source");
  const remoteRoot = path.join(fixture.root, "state-origin.git");
  fs.renameSync(fixture.stateRoot, sourceRoot);
  execFileSync("git", ["clone", "-q", "--bare", sourceRoot, remoteRoot]);
  execFileSync("git", ["clone", "-q", "--depth=1", `file://${remoteRoot}`, fixture.stateRoot]);
}

function writeRunRecord(
  fixture: ReturnType<typeof createFixture>,
  provenance: Record<string, string>,
): void {
  fs.writeFileSync(
    path.join(fixture.runsDir, `${fixture.runId}.json`),
    `${JSON.stringify({ run_id: fixture.runId, ...provenance }, null, 2)}\n`,
  );
}

function writeArtifactCohort(
  fixture: ReturnType<typeof createFixture>,
  attempt: number,
  input: {
    stateRevision: string;
    jobSha256: string;
    mode: "plan" | "autonomous";
  },
): void {
  const runDir = artifactRunDir(fixture, attempt);
  fs.mkdirSync(runDir, { recursive: true });
  writeSourceIdentity(runDir, fixture.jobPath, input);
  writePlanAndResult(runDir, fixture.jobPath, input.mode);
}

function writeWorkflowInputs(
  fixture: ReturnType<typeof createFixture>,
  attempt: number,
  input: {
    stateRevision: string;
    jobSha256: string;
    requestedMode: "plan" | "execute" | "autonomous";
    effectiveMode: "plan" | "execute" | "autonomous";
  },
): void {
  const inputDir = path.join(
    fixture.artifactFixture,
    `clawsweeper-repair-inputs-${fixture.runId}-${attempt}`,
    "recovery-inputs",
  );
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, "workflow-inputs.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        source_job: fixture.jobPath,
        state_revision: input.stateRevision,
        job_sha256: input.jobSha256,
        requested_mode: input.requestedMode,
        effective_mode: input.effectiveMode,
      },
      null,
      2,
    )}\n`,
  );
}

function artifactRunDir(fixture: ReturnType<typeof createFixture>, attempt: number): string {
  return path.join(
    fixture.artifactFixture,
    `clawsweeper-repair-worker-${fixture.runId}-${attempt}`,
    "runs",
    "fixture",
  );
}

function writeSourceIdentity(
  runDir: string,
  jobPath: string,
  input: { stateRevision: string; jobSha256: string },
): void {
  fs.writeFileSync(
    path.join(runDir, "source-job.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        source_job: jobPath,
        state_revision: input.stateRevision,
        job_sha256: input.jobSha256,
      },
      null,
      2,
    )}\n`,
  );
}

function writePlanAndResult(runDir: string, jobPath: string, mode: "plan" | "autonomous"): void {
  fs.writeFileSync(
    path.join(runDir, "cluster-plan.json"),
    `${JSON.stringify({ source_job: jobPath, mode })}\n`,
  );
  fs.writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify({ mode })}\n`);
}

function commitJob(stateRoot: string, jobPath: string, contents: string, message: string): string {
  const absolute = path.join(stateRoot, jobPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
  execFileSync("git", ["add", jobPath], { cwd: stateRoot });
  execFileSync("git", ["commit", "-qm", message], { cwd: stateRoot });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: stateRoot,
    encoding: "utf8",
  }).trim();
}

function repairJob(mode: "plan" | "autonomous", clusterId: string): string {
  return `---
repo: openclaw/openclaw
cluster_id: ${clusterId}
mode: ${mode}
allowed_actions:
  - fix
candidates:
  - "#1"
---

# fixture
`;
}

function writeFakeGh(binDir: string): void {
  const file = path.join(binDir, "gh");
  fs.writeFileSync(
    file,
    `#!/bin/sh
set -eu
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  if [ "$GH_ARTIFACT_FAILURE" = "auth" ]; then
    echo "HTTP 401: Bad credentials" >&2
    exit 1
  fi
  if [ "$GH_ARTIFACT_EXPIRED" = "1" ]; then
    echo "Actions artifacts expired" >&2
    exit 1
  fi
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--dir" ]; then
      shift
      cp -R "$GH_ARTIFACT_FIXTURE"/. "$1"/
      exit 0
    fi
    shift
  done
fi
echo "unsupported gh invocation: $*" >&2
exit 1
`,
  );
  fs.chmodSync(file, 0o755);
}
