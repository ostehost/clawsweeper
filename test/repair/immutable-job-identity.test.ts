import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  immutableJobIdentityKey,
  resolveCurrentStateJobIdentity,
  resolveStateJobIdentity,
} from "../../dist/repair/immutable-job-handoff.js";

test("immutable job identity resolves current and historical state bytes exactly", () => {
  const root = createStateRepo();
  const jobPath = "jobs/openclaw/inbox/cluster-immutable-fixture.md";
  const firstBytes = repairJob("plan", "first");
  const firstRevision = commitJob(root, jobPath, firstBytes, "first");
  const firstDigest = sha256(firstBytes);
  const secondBytes = repairJob("autonomous", "second");
  const secondRevision = commitJob(root, jobPath, secondBytes, "second");

  try {
    const current = resolveCurrentStateJobIdentity(jobPath, { stateRoot: root });
    assert.equal(current.stateRevision, secondRevision);
    assert.equal(current.jobSha256, sha256(secondBytes));
    assert.equal(current.job.frontmatter.mode, "autonomous");

    const historical = resolveStateJobIdentity({
      jobPath,
      stateRevision: firstRevision,
      jobSha256: firstDigest,
      stateRoot: root,
    });
    assert.equal(historical.job.frontmatter.mode, "plan");
    assert.equal(
      historical.identityKey,
      immutableJobIdentityKey({
        jobPath,
        stateRevision: firstRevision,
        jobSha256: firstDigest,
      }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("immutable job identity fails closed on malformed or unavailable handoffs", () => {
  const root = createStateRepo();
  const jobPath = "jobs/openclaw/inbox/cluster-invalid-fixture.md";
  const bytes = repairJob("plan", "fixture");
  const revision = commitJob(root, jobPath, bytes, "fixture");

  try {
    assert.throws(
      () =>
        resolveStateJobIdentity({
          jobPath: "../jobs/openclaw/inbox/cluster-invalid-fixture.md",
          stateRevision: revision,
          stateRoot: root,
        }),
      /immutable job path/,
    );
    assert.throws(
      () =>
        resolveStateJobIdentity({
          jobPath,
          stateRevision: "not-a-revision",
          stateRoot: root,
        }),
      /state revision is malformed/,
    );
    assert.throws(
      () =>
        resolveStateJobIdentity({
          jobPath,
          stateRevision: revision,
          jobSha256: "ABC",
          stateRoot: root,
        }),
      /job SHA-256 is malformed/,
    );
    assert.throws(
      () =>
        resolveStateJobIdentity({
          jobPath,
          stateRevision: "f".repeat(40),
          stateRoot: root,
        }),
      /missing historical clawsweeper-state commit/,
    );
    assert.throws(
      () =>
        resolveStateJobIdentity({
          jobPath,
          stateRevision: revision,
          jobSha256: "0".repeat(64),
          stateRoot: root,
        }),
      /immutable job SHA-256 mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("report-only requeue preserves the original worker job generation", () => {
  const root = createStateRepo();
  const jobPath = "jobs/openclaw/inbox/cluster-requeue-fixture.md";
  const originalBytes = repairJob("plan", "original");
  const originalRevision = commitJob(root, jobPath, originalBytes, "original");
  const originalDigest = sha256(originalBytes);
  commitJob(root, jobPath, repairJob("autonomous", "replacement"), "replacement");

  try {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/requeue-job.js"),
        jobPath,
        "--state-revision",
        originalRevision,
        "--job-sha256",
        originalDigest,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_STATE_DIR: root,
          CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, "plan");
    assert.equal(summary.source_state_revision, originalRevision);
    assert.equal(summary.source_job_sha256, originalDigest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createStateRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-state-identity-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  return root;
}

function commitJob(root: string, jobPath: string, contents: string, message: string): string {
  const absolute = path.join(root, jobPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
  execFileSync("git", ["add", jobPath], { cwd: root });
  execFileSync("git", ["commit", "-qm", message], { cwd: root });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function repairJob(mode: "plan" | "autonomous", label: string): string {
  return `---
repo: openclaw/openclaw
cluster_id: immutable-${label}
mode: ${mode}
allowed_actions:
  - fix
candidates:
  - "#1"
---

# ${label}
`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
