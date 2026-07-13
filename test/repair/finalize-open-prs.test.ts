import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("finalizer skips archived jobs without an inbox generation and keeps the batch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-finalizer-"));
  try {
    fs.cpSync(path.resolve("dist"), path.join(root, "dist"), { recursive: true });
    fs.cpSync(path.resolve("config"), path.join(root, "config"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');

    const archivedPath = "jobs/openclaw/outbox/finalized/archived.md";
    const livePath = "jobs/openclaw/inbox/live.md";
    const archivedJob = repairJob("archived");
    const liveJob = repairJob("live");
    writeFile(root, archivedPath, archivedJob);
    writeFile(root, livePath, liveJob);

    const stateRoot = path.join(root, "state");
    fs.mkdirSync(stateRoot);
    execFileSync("git", ["init", "-q"], { cwd: stateRoot });
    execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: stateRoot });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: stateRoot });
    writeFile(stateRoot, archivedPath, archivedJob);
    writeFile(stateRoot, livePath, liveJob);
    execFileSync("git", ["add", "."], { cwd: stateRoot });
    execFileSync("git", ["commit", "-qm", "state"], { cwd: stateRoot });

    const fakeGh = path.join(root, "gh");
    fs.writeFileSync(fakeGh, fakeGhScript(), { mode: 0o755 });
    const result = spawnSync(
      process.execPath,
      [path.join(root, "dist", "repair", "finalize-open-prs.js"), "--dispatch-repairs"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_REPO: "openclaw/clawsweeper",
          CLAWSWEEPER_STATE_DIR: stateRoot,
          GH_BIN: fakeGh,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.dispatch.candidates.map((candidate: { pr: number }) => candidate.pr),
      [2],
    );
    assert.equal(report.dispatch.candidates[0].job_path, livePath);
    assert.equal(report.dispatch.skipped_candidates.length, 1);
    assert.equal(report.dispatch.skipped_candidates[0].pr, 1);
    assert.equal(report.dispatch.skipped_candidates[0].job_path, archivedPath);
    assert.equal(report.dispatch.skipped_candidates[0].reason, "immutable_job_unavailable");
    assert.match(
      report.dispatch.skipped_candidates[0].detail,
      /immutable job is missing at [a-f0-9]{40}:jobs\/openclaw\/inbox\/archived\.md/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeFile(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function repairJob(clusterId: string): string {
  return `---
repo: openclaw/openclaw
cluster_id: ${clusterId}
mode: autonomous
allowed_actions:
  - fix
candidates:
  - "#1"
---

# fixture
`;
}

function fakeGhScript(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([
    { number: 1, title: "archived", url: "https://github.com/openclaw/openclaw/pull/1", headRefName: "clawsweeper/archived", updatedAt: "2026-07-13T00:00:00Z" },
    { number: 2, title: "live", url: "https://github.com/openclaw/openclaw/pull/2", headRefName: "clawsweeper/live", updatedAt: "2026-07-13T00:00:00Z" }
  ]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const number = Number(args[2]);
  const cluster = number === 1 ? "archived" : "live";
  process.stdout.write(JSON.stringify({
    number,
    title: cluster,
    url: "https://github.com/openclaw/openclaw/pull/" + number,
    baseRefName: "main",
    body: "",
    comments: [],
    headRefName: "clawsweeper/" + cluster,
    headRefOid: String(number).repeat(40),
    isDraft: false,
    labels: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    reviews: [],
    state: "OPEN",
    statusCheckRollup: [{ name: "check", status: "COMPLETED", conclusion: "FAILURE" }],
    updatedAt: "2026-07-13T00:00:00Z"
  }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "graphql") {
  process.stdout.write(JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } }
  }));
  process.exit(0);
}
process.stderr.write("unsupported gh invocation: " + args.join(" ") + "\\n");
process.exit(1);
`;
}
