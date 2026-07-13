import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeRepairJobGenerations,
  fetchRecentWorkflowRuns,
} from "../../dist/repair/live-worker-capacity.js";

const JOB = "jobs/openclaw/inbox/cluster-self-heal.md";

test("self-heal indexes active immutable generations beyond 200 workflow runs", () => {
  const digest = "a".repeat(64);
  const calls = [];
  const active = activeRepairJobGenerations({
    repo: "openclaw/clawsweeper",
    workflow: "repair-cluster-worker.yml",
    fetchWorkflowRuns: (options) =>
      fetchRecentWorkflowRuns({
        ...options,
        fetchPage: (args) => {
          const query = new URL(`https://github.test/${args[3]}`).searchParams;
          const status = query.get("status");
          const page = Number(query.get("page"));
          calls.push({ status, page });
          if (status !== "in_progress") return [];
          if (page <= 2) {
            return Array.from({ length: 100 }, (_, index) => ({
              id: (page - 1) * 100 + index + 1,
              status,
              display_title: `repair cluster jobs/openclaw/inbox/other-${page}-${index}.md (${digest})`,
            }));
          }
          return [
            {
              id: 201,
              status,
              display_title: `repair cluster ${JOB} (${digest})`,
            },
          ];
        },
      }),
  });

  assert.deepEqual(active.get(`${JOB}:${digest}`), ["201"]);
  assert.deepEqual(
    calls.filter((call) => call.status === "in_progress"),
    [
      { status: "in_progress", page: 1 },
      { status: "in_progress", page: 2 },
      { status: "in_progress", page: 3 },
    ],
  );
});

test("self-heal excludes stale queued immutable generations", () => {
  const digest = "b".repeat(64);
  const active = activeRepairJobGenerations({
    nowMs: Date.parse("2026-07-13T12:00:00.000Z"),
    staleQueuedMs: 60 * 60 * 1000,
    fetchWorkflowRuns: () => [
      {
        id: 1,
        status: "queued",
        display_title: `repair cluster ${JOB} (${digest})`,
        created_at: "2026-07-13T00:00:00.000Z",
        updated_at: "2026-07-13T00:00:00.000Z",
      },
    ],
  });

  assert.equal(active.has(`${JOB}:${digest}`), false);
});

test("self-heal matches active immutable generations by exact job digest", () => {
  const oldDigest = "c".repeat(64);
  const newDigest = "d".repeat(64);
  const active = activeRepairJobGenerations({
    fetchWorkflowRuns: () => [
      {
        id: 7,
        status: "in_progress",
        display_title: `repair cluster ${JOB} (${oldDigest})`,
      },
    ],
  });

  assert.deepEqual(active.get(`${JOB}:${oldDigest}`), ["7"]);
  assert.equal(active.has(`${JOB}:${newDigest}`), false);
});

test("self-heal indexes digestless active workers as a conservative job lock", () => {
  const active = activeRepairJobGenerations({
    fetchWorkflowRuns: () => [
      {
        id: 8,
        status: "in_progress",
        display_title: `repair cluster ${JOB}`,
      },
    ],
  });

  assert.deepEqual(active.get(JOB), ["8"]);
});

test("execute-mode self-heal fails closed when active generation discovery fails", () => {
  assert.throws(
    () =>
      activeRepairJobGenerations({
        fetchWorkflowRuns: () => {
          throw new Error("GitHub unavailable");
        },
      }),
    /GitHub unavailable/,
  );

  const source = fs.readFileSync("src/repair/self-heal-failed-runs.ts", "utf8");
  const discovery = source.slice(
    source.indexOf("function activeRepairJobGenerations()"),
    source.indexOf("function dispatchCandidate"),
  );
  assert.match(discovery, /cannot verify active repair generations; refusing dispatch/);
  assert.doesNotMatch(discovery, /return new Map/);
});

test("failed-run self-heal replays the recorded sealed job generation", () => {
  const fixture = createSelfHealFixture("sealed");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.status, "dry_run");
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_state_revision, fixture.originalRevision);
    assert.equal(summary.candidates[0].source_job_sha256, fixture.originalDigest);
    assert.equal(summary.candidates[0].mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed-run self-heal fetches an exact historical revision from a depth-one state checkout", () => {
  const fixture = createSelfHealFixture("shallow");
  try {
    replaceStateWithDepthOneClone(fixture);
    assert.notEqual(
      spawnSync("git", ["cat-file", "-e", `${fixture.originalRevision}^{commit}`], {
        cwd: fixture.stateRoot,
      }).status,
      0,
    );
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_state_revision, fixture.originalRevision);
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

test("failed-run self-heal skips an unavailable historical revision without dropping valid jobs", () => {
  const fixture = createSelfHealFixture("bounded");
  try {
    replaceStateWithDepthOneClone(fixture);
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
      source_state_revision: fixture.originalRevision,
      source_job_sha256: fixture.originalDigest,
    });
    writeRunRecord(fixture.runsDir, "910002", {
      source_job: "jobs/openclaw/inbox/missing-history.md",
      source_state_revision: "f".repeat(40),
      source_job_sha256: "e".repeat(64),
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_job, fixture.jobPath);
    assert.equal(summary.skipped_candidates.length, 1);
    assert.equal(summary.skipped_candidates[0].reason, "immutable_provenance_unavailable");
    assert.match(summary.skipped_candidates[0].detail, /could not fetch historical/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy self-heal records recover one complete sealed producer cohort", () => {
  const fixture = createSelfHealFixture("legacy");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
    });
    writeArtifactCohort(fixture.artifactFixture, fixture.runId, 1, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
      mode: "plan",
    });

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 1);
    assert.equal(summary.candidates[0].source_state_revision, fixture.originalRevision);
    assert.equal(summary.candidates[0].source_job_sha256, fixture.originalDigest);
    assert.equal(summary.candidates[0].mode, "plan");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("legacy self-heal records reject identity and plan split across attempts", () => {
  const fixture = createSelfHealFixture("split");
  try {
    writeRunRecord(fixture.runsDir, fixture.runId, {
      source_job: fixture.jobPath,
    });
    const firstRunDir = artifactRunDir(fixture.artifactFixture, fixture.runId, 1);
    fs.mkdirSync(firstRunDir, { recursive: true });
    writeSourceIdentity(firstRunDir, {
      sourceJob: fixture.jobPath,
      stateRevision: fixture.originalRevision,
      jobSha256: fixture.originalDigest,
    });
    const secondRunDir = artifactRunDir(fixture.artifactFixture, fixture.runId, 2);
    fs.mkdirSync(secondRunDir, { recursive: true });
    writePlanAndResult(secondRunDir, fixture.jobPath, "autonomous");

    const summary = runSelfHeal(fixture);
    assert.equal(summary.candidates.length, 0);
    assert.equal(summary.skipped_candidates.length, 1);
    assert.equal(summary.skipped_candidates[0].reason, "immutable_provenance_unavailable");
    assert.match(
      summary.skipped_candidates[0].detail,
      /did not publish one complete sealed repair artifact cohort/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createSelfHealFixture(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawsweeper-self-heal-${label}-`));
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
  const jobPath = `jobs/openclaw/inbox/cluster-${label}.md`;
  const original = repairJob("plan", `${label}-original`);
  const originalRevision = commitJob(stateRoot, jobPath, original, "original");
  const originalDigest = createHash("sha256").update(original).digest("hex");
  commitJob(stateRoot, jobPath, repairJob("autonomous", `${label}-replacement`), "replacement");
  writeFakeGh(binDir);
  return {
    root,
    stateRoot,
    runsDir,
    artifactFixture,
    binDir,
    jobPath,
    originalRevision,
    originalDigest,
    runId: "910001",
  };
}

function runSelfHeal(fixture: ReturnType<typeof createSelfHealFixture>) {
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("dist/repair/self-heal-failed-runs.js"),
      "--runs-dir",
      fixture.runsDir,
      "--max-age-hours",
      "24",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        CLAWSWEEPER_STATE_DIR: fixture.stateRoot,
        GH_ARTIFACT_FIXTURE: fixture.artifactFixture,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function replaceStateWithDepthOneClone(fixture: ReturnType<typeof createSelfHealFixture>): void {
  const sourceRoot = path.join(fixture.root, "state-source");
  const remoteRoot = path.join(fixture.root, "state-origin.git");
  fs.renameSync(fixture.stateRoot, sourceRoot);
  execFileSync("git", ["clone", "-q", "--bare", sourceRoot, remoteRoot]);
  execFileSync("git", ["clone", "-q", "--depth=1", `file://${remoteRoot}`, fixture.stateRoot]);
}

function writeRunRecord(runsDir: string, runId: string, provenance: Record<string, string>): void {
  fs.writeFileSync(
    path.join(runsDir, `${runId}.json`),
    `${JSON.stringify(
      {
        run_id: runId,
        workflow_conclusion: "failure",
        workflow_updated_at: new Date().toISOString(),
        ...provenance,
      },
      null,
      2,
    )}\n`,
  );
}

function writeArtifactCohort(
  root: string,
  runId: string,
  attempt: number,
  input: {
    sourceJob: string;
    stateRevision: string;
    jobSha256: string;
    mode: "plan" | "autonomous";
  },
): void {
  const runDir = artifactRunDir(root, runId, attempt);
  fs.mkdirSync(runDir, { recursive: true });
  writeSourceIdentity(runDir, input);
  writePlanAndResult(runDir, input.sourceJob, input.mode);
}

function artifactRunDir(root: string, runId: string, attempt: number): string {
  return path.join(root, `clawsweeper-repair-worker-${runId}-${attempt}`, "runs", "fixture");
}

function writeSourceIdentity(
  runDir: string,
  input: { sourceJob: string; stateRevision: string; jobSha256: string },
): void {
  fs.writeFileSync(
    path.join(runDir, "source-job.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        source_job: input.sourceJob,
        state_revision: input.stateRevision,
        job_sha256: input.jobSha256,
      },
      null,
      2,
    )}\n`,
  );
}

function writePlanAndResult(runDir: string, sourceJob: string, mode: "plan" | "autonomous"): void {
  fs.writeFileSync(
    path.join(runDir, "cluster-plan.json"),
    `${JSON.stringify({ source_job: sourceJob, mode })}\n`,
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
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
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
