import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";

const repoRoot = process.cwd();
const VALIDATED_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOVED_COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NO_ATOMIC_BASE_BINDING =
  "automerge disabled: GitHub merge APIs cannot atomically bind the reviewed base branch";

test("issue implementation post-flight waits for green PR checks without merging", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123,",
      "    state: 'open',",
      "    title: 'fix(ui): preserve source config',",
      "    draft: false,",
      "    labels: [],",
      "    base: { ref: 'main' },",
      "    merged_at: null,",
      "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main',",
      `    headRefOid: '${VALIDATED_COMMIT}',`,
      "    isDraft: false,",
      "    mergeable: 'MERGEABLE',",
      "    mergeStateStatus: 'CLEAN',",
      "    reviewDecision: null,",
      "    state: 'OPEN',",
      "    statusCheckRollup: [",
      "      {",
      "        name: 'Real behavior proof',",
      "        workflowName: 'Real behavior proof',",
      "        startedAt: '2026-05-24T00:39:28Z',",
      "        completedAt: '2026-05-24T00:40:30Z',",
      "        status: 'COMPLETED',",
      "        conclusion: 'CANCELLED',",
      "      },",
      "      {",
      "        name: 'Real behavior proof',",
      "        workflowName: 'Real behavior proof',",
      "        startedAt: '2026-05-24T00:39:44Z',",
      "        completedAt: '2026-05-24T00:39:56Z',",
      "        status: 'COMPLETED',",
      "        conclusion: 'SUCCESS',",
      "      },",
      "    ],",
      "    title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: issue-openclaw-openclaw-85831",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - label",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "canonical:",
      "  - '#85831'",
      "candidates:",
      "  - '#85831'",
      "cluster_refs:",
      "  - '#85831'",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "target_branch: clawsweeper/issue-openclaw-openclaw-85831",
      "source: issue_implementation",
      "---",
      "Issue implementation job.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "issue-openclaw-openclaw-85831",
        mode: "autonomous",
        actions: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, "fix-execution-report.json"),
    JSON.stringify(
      {
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/openclaw/openclaw/pull/123",
            branch: "clawsweeper/issue-openclaw-openclaw-85831",
            commit: VALIDATED_COMMIT,
          },
        ],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      stdio: "pipe",
    });

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.deepEqual(report.actions, [
      {
        action: "finalize_fix_pr",
        source_action: "open_fix_pr",
        source_status: "opened",
        target: "https://github.com/openclaw/openclaw/pull/123",
        pr: "#123",
        title: "fix(ui): preserve source config",
        status: "ready",
        reason:
          "issue implementation PR checks are green; merge intentionally blocked for this lane",
        mergeable: "MERGEABLE",
        merge_state_status: "CLEAN",
        review_decision: null,
        waited_ms: 0,
      },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("issue implementation post-flight waits for checks to be created", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const viewCountPath = path.join(tmp, "view-count.txt");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, state: 'open', title: 'fix(ui): preserve source config',",
      "    draft: false, labels: [], base: { ref: 'main' }, merged_at: null,",
      "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  const path = process.env.FAKE_GH_VIEW_COUNT_FILE;",
      "  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      "  fs.writeFileSync(path, String(count + 1));",
      "  const checks = count === 0",
      "    ? [{ name: 'label', workflowName: 'Labeler', startedAt: '2026-05-24T00:39:40Z', status: 'COMPLETED', conclusion: 'SUCCESS' }]",
      "    : [{ name: 'check', startedAt: '2026-05-24T00:39:44Z', status: 'COMPLETED', conclusion: 'SUCCESS' }];",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',",
      `    headRefOid: '${VALIDATED_COMMIT}',`,
      "    mergeStateStatus: 'CLEAN', reviewDecision: null, state: 'OPEN',",
      "    statusCheckRollup: checks, title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  writeIssueImplementationJob(jobPath);
  writeIssueImplementationReports(runDir, resultPath);

  try {
    execFileSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "10000",
        CLAWSWEEPER_POST_FLIGHT_POLL_MS: "1",
        FAKE_GH_VIEW_COUNT_FILE: viewCountPath,
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      stdio: "pipe",
    });

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "ready");
    assert.equal(fs.readFileSync(viewCountPath, "utf8"), "2");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("merge post-flight waits for real checks then refuses an unbound merge", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const mergeFlagPath = path.join(tmp, "merged.txt");
  const viewCountPath = path.join(tmp, "view-count.txt");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rules/branches/main?per_page=100') {",
      "  process.stdout.write(JSON.stringify([[{",
      "    type: 'required_status_checks', ruleset_id: 18588237,",
      "    parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'CI' }] },",
      "  }]]));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rulesets/18588237?includes_parents=true') {",
      "  process.stdout.write(JSON.stringify({",
      "    current_user_can_bypass: 'never', enforcement: 'active',",
      "    rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'CI' }] } }],",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rulesets?includes_parents=true&targets=branch&per_page=100') {",
      "  process.stdout.write(JSON.stringify([[{ id: 19600001, target: 'branch', enforcement: 'active' }]]));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rulesets/19600001?includes_parents=true') {",
      "  process.stdout.write(JSON.stringify({",
      "    target: 'branch', enforcement: 'active', current_user_can_bypass: 'never',",
      "    conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/main'] } },",
      "    rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }],",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  const merged = fs.existsSync(process.env.FAKE_GH_MERGED_FILE);",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, state: merged ? 'closed' : 'open', title: 'fix(ui): preserve source config',",
      "    draft: false, labels: [], base: { ref: 'main' },",
      "    merged_at: merged ? '2026-05-24T00:42:00Z' : null,",
      "    merge_commit_sha: merged ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' : null,",
      "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
      "  process.stdout.write('');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      "  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  const merged = fs.existsSync(process.env.FAKE_GH_MERGED_FILE);",
      "  const path = process.env.FAKE_GH_VIEW_COUNT_FILE;",
      "  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      "  fs.writeFileSync(path, String(count + 1));",
      "  const checks = count === 0",
      "    ? [{ name: 'label', workflowName: 'Labeler', startedAt: '2026-05-24T00:39:40Z', status: 'COMPLETED', conclusion: 'SUCCESS' }]",
      "    : [{ name: 'check', workflowName: 'CI', startedAt: '2026-05-24T00:39:44Z', status: 'COMPLETED', conclusion: 'SUCCESS' }];",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',",
      `    headRefOid: '${VALIDATED_COMMIT}',`,
      "    mergeStateStatus: 'CLEAN', reviewDecision: null, state: merged ? 'MERGED' : 'OPEN',",
      "    mergedAt: merged ? '2026-05-24T00:42:00Z' : null,",
      "    mergeCommit: merged ? { oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } : null,",
      "    statusCheckRollup: checks, title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'merge') {",
      "  fs.writeFileSync(process.env.FAKE_GH_MERGED_FILE, JSON.stringify(args));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  writeMergeJob(jobPath);
  writeMergeReports(runDir, resultPath);

  try {
    const run = spawnSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        CLAWSWEEPER_ALLOW_MERGE: "1",
        CLAWSWEEPER_APP_SLUG: "clawsweeper",
        CLAWSWEEPER_AUTHENTICATED_APP_ID: "3306130",
        CLAWSWEEPER_AUTHENTICATED_APP_SLUG: "clawsweeper",
        CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID: "987654",
        GH_TOKEN: "mutation-token",
        GITHUB_TOKEN: "mutation-token",
        CLAWSWEEPER_POST_FLIGHT_REQUIRE_PR_CHECKS: "1",
        CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "10000",
        CLAWSWEEPER_POST_FLIGHT_POLL_MS: "1",
        FAKE_GH_MERGED_FILE: mergeFlagPath,
        FAKE_GH_VIEW_COUNT_FILE: viewCountPath,
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      encoding: "utf8",
    });

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(run.status, 1, run.stderr);
    assert.equal(report.actions[0]?.status, "blocked");
    assert.equal(report.actions[0]?.reason, NO_ATOMIC_BASE_BINDING);
    assert.ok(Number(fs.readFileSync(viewCountPath, "utf8")) >= 2);
    assert.equal(fs.existsSync(mergeFlagPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("post-flight keeps no-timestamp pending duplicate checks visible", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const viewCountPath = path.join(tmp, "view-count.txt");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, state: 'open', title: 'fix(ui): preserve source config',",
      "    draft: false, labels: [], base: { ref: 'main' }, merged_at: null,",
      "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  const path = process.env.FAKE_GH_VIEW_COUNT_FILE;",
      "  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      "  fs.writeFileSync(path, String(count + 1));",
      "  const checks = count === 0",
      "    ? [",
      "        { name: 'check', workflowName: 'CI', startedAt: '2026-05-24T00:39:40Z', status: 'COMPLETED', conclusion: 'SUCCESS' },",
      "        { name: 'check', workflowName: 'CI', status: 'QUEUED', conclusion: null },",
      "      ]",
      "    : [{ name: 'check', workflowName: 'CI', startedAt: '2026-05-24T00:39:44Z', status: 'COMPLETED', conclusion: 'SUCCESS' }];",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',",
      `    headRefOid: '${VALIDATED_COMMIT}',`,
      "    mergeStateStatus: 'CLEAN', reviewDecision: null, state: 'OPEN',",
      "    statusCheckRollup: checks, title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  writeIssueImplementationJob(jobPath);
  writeIssueImplementationReports(runDir, resultPath);

  try {
    execFileSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
        CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "10000",
        CLAWSWEEPER_POST_FLIGHT_POLL_MS: "1",
        FAKE_GH_VIEW_COUNT_FILE: viewCountPath,
        ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
      },
      stdio: "pipe",
    });

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "ready");
    assert.equal(fs.readFileSync(viewCountPath, "utf8"), "2");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("post-flight writes a skipped report and exits nonzero without a fix report", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");

  fs.mkdirSync(runDir, { recursive: true });
  writeMergeJob(jobPath);
  writeMergeReports(runDir, resultPath);
  fs.rmSync(path.join(runDir, "fix-execution-report.json"));

  try {
    const run = spawnPostFlight(jobPath, resultPath);
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "skipped");
    assert.equal(report.actions[0]?.reason, "no fix-execution-report.json");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("issue implementation post-flight blocks a moved live head", () => {
  const outcome = runHeadGuardCase({ source: "issue", liveHead: MOVED_COMMIT });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(
    outcome.report.actions[0]?.reason,
    "pull request head does not match worker-validated repair commit",
  );
  assert.equal(outcome.mergeCalled, false);
});

test("merge post-flight blocks a moved live head without invoking merge", () => {
  const outcome = runHeadGuardCase({ source: "merge", liveHead: MOVED_COMMIT });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(
    outcome.report.actions[0]?.reason,
    "pull request head does not match worker-validated repair commit",
  );
  assert.equal(outcome.mergeCalled, false);
});

test("merge post-flight blocks an already-merged PR with a moved head", () => {
  const outcome = runHeadGuardCase({
    source: "merge",
    liveHead: MOVED_COMMIT,
    alreadyMerged: true,
  });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(
    outcome.report.actions[0]?.reason,
    "pull request head does not match worker-validated repair commit",
  );
  assert.equal(outcome.mergeCalled, false);
});

test("merge post-flight blocks an already-merged PR outside main", () => {
  const outcome = runHeadGuardCase({
    source: "merge",
    liveHead: VALIDATED_COMMIT,
    alreadyMerged: true,
    initialBase: "release",
  });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(outcome.report.actions[0]?.reason, "pull request base is not main");
  assert.equal(outcome.mergeCalled, false);
});

test("merge post-flight requeues when REST reports an already-merged PR before GraphQL", () => {
  const outcome = runHeadGuardCase({
    source: "merge",
    liveHead: VALIDATED_COMMIT,
    restAlreadyMerged: true,
    graphqlAlreadyMerged: false,
  });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions.length, 1);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(
    outcome.report.actions[0]?.reason,
    "merge state is not yet confirmed by both GitHub pull request views",
  );
  assert.equal(outcome.report.actions[0]?.retry_recommended, true);
  assert.equal(outcome.report.actions[0]?.requeue_required, true);
  assert.equal(outcome.mergeCalled, false);
});

test("merge post-flight requeues when GraphQL reports an already-merged PR before REST", () => {
  const outcome = runHeadGuardCase({
    source: "merge",
    liveHead: VALIDATED_COMMIT,
    restAlreadyMerged: false,
    graphqlAlreadyMerged: true,
  });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions.length, 1);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(
    outcome.report.actions[0]?.reason,
    "merge state is not yet confirmed by both GitHub pull request views",
  );
  assert.equal(outcome.report.actions[0]?.retry_recommended, true);
  assert.equal(outcome.report.actions[0]?.requeue_required, true);
  assert.equal(outcome.mergeCalled, false);
});

test("post-flight requires a lowercase full worker-validated commit", () => {
  const outcome = runHeadGuardCase({
    source: "issue",
    expectedCommit: VALIDATED_COMMIT.toUpperCase(),
    liveHead: VALIDATED_COMMIT,
  });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(outcome.report.actions[0]?.reason, "fix action commit is missing or malformed");
  assert.equal(outcome.mergeCalled, false);
});

test("merge post-flight blocks before a final base-retarget window", () => {
  const outcome = runHeadGuardCase({
    source: "merge",
    liveHead: VALIDATED_COMMIT,
    finalBase: "release",
  });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(outcome.report.actions[0]?.reason, NO_ATOMIC_BASE_BINDING);
  assert.equal(outcome.mergeCalled, false);
});

test("merge post-flight refuses before GitHub can queue an unbound merge", () => {
  const outcome = runHeadGuardCase({
    source: "merge",
    liveHead: VALIDATED_COMMIT,
    mergeConfirmed: false,
  });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(outcome.report.actions[0]?.reason, NO_ATOMIC_BASE_BINDING);
  assert.equal(outcome.mergeCalled, false);
});

test("merge post-flight blocks before a fetch-to-merge retarget window", () => {
  const outcome = runHeadGuardCase({
    source: "merge",
    liveHead: VALIDATED_COMMIT,
    postMergeBase: "release",
  });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.report.actions[0]?.status, "blocked");
  assert.equal(outcome.report.actions[0]?.reason, NO_ATOMIC_BASE_BINDING);
  assert.equal(outcome.mergeCalled, false);
});

test("post-flight leaves a successful replacement PR open when merge is not base-bound", () => {
  const outcome = runHeadGuardCase({
    source: "merge",
    liveHead: VALIDATED_COMMIT,
    fallbackSourceStatus: "failed",
  });

  assert.equal(outcome.status, 1, outcome.stderr);
  assert.deepEqual(
    outcome.report.actions.map((action: { source_action: string; status: string }) => ({
      source_action: action.source_action,
      status: action.status,
    })),
    [
      { source_action: "repair_contributor_branch", status: "skipped" },
      { source_action: "open_fix_pr", status: "blocked" },
    ],
  );
  assert.equal(outcome.report.actions[1]?.reason, NO_ATOMIC_BASE_BINDING);
  assert.equal(outcome.mergeCalled, false);
});

test("commit finding post-flight finishes ready without attempting a merge", () => {
  const outcome = runHeadGuardCase({ source: "commit", liveHead: VALIDATED_COMMIT });

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(outcome.report.actions[0]?.status, "ready");
  assert.equal(
    outcome.report.actions[0]?.reason,
    "commit finding repair PR checks are green; merge intentionally blocked for this lane",
  );
  assert.equal(outcome.mergeCalled, false);
});

test("audited commit finding no-diff post-flight succeeds without a PR", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const sourceReason =
    "Codex produced no target repo changes; treating this allow_no_pr artifact as an audited no-PR outcome";

  fs.mkdirSync(runDir, { recursive: true });
  writeCommitFindingJob(jobPath);
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "issue-openclaw-openclaw-85831",
        mode: "autonomous",
        actions: [],
        fix_artifact: { allow_no_pr: true },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, "fix-execution-report.json"),
    JSON.stringify(
      {
        actions: [
          {
            action: "open_fix_pr",
            status: "skipped",
            repair_strategy: "new_fix_pr",
            reason: sourceReason,
          },
        ],
      },
      null,
      2,
    ),
  );

  try {
    const run = spawnPostFlight(jobPath, resultPath);
    assert.equal(run.status, 0, run.stderr);

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.job_intent, "commit_finding");
    assert.equal(report.source, "clawsweeper_commit");
    assert.equal(report.commit_sha, VALIDATED_COMMIT);
    assert.equal(report.allow_no_pr, true);
    assert.deepEqual(report.actions, [
      {
        action: "finalize_fix_pr",
        source_action: "open_fix_pr",
        source_status: "skipped",
        source_reason: sourceReason,
        target: null,
        status: "skipped",
        reason: "fix PR action status is skipped",
      },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("dry-run post-flight plans without labels, policy calls, or merge mutation", () => {
  const outcome = runHeadGuardCase({
    source: "merge",
    liveHead: VALIDATED_COMMIT,
    dryRun: true,
    allowMerge: false,
  });

  assert.equal(outcome.status, 0, outcome.stderr);
  assert.equal(outcome.report.dry_run, true);
  assert.equal(outcome.report.actions[0]?.status, "planned");
  assert.equal(outcome.report.actions[0]?.reason, "dry run");
  assert.equal(outcome.mergeCalled, false);
});

function writeIssueImplementationJob(jobPath: string) {
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: issue-openclaw-openclaw-85831",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - label",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "canonical:",
      "  - '#85831'",
      "candidates:",
      "  - '#85831'",
      "cluster_refs:",
      "  - '#85831'",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "target_branch: clawsweeper/issue-openclaw-openclaw-85831",
      "source: issue_implementation",
      "---",
      "Issue implementation job.",
      "",
    ].join("\n"),
  );
}

function writeCommitFindingJob(jobPath: string) {
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: issue-openclaw-openclaw-85831",
      "mode: autonomous",
      "job_intent: commit_finding",
      "allowed_actions:",
      "  - comment",
      "  - label",
      "  - fix",
      "  - raise_pr",
      "blocked_actions:",
      "  - close",
      "  - merge",
      "canonical: []",
      "candidates: []",
      "cluster_refs: []",
      "allow_fix_pr: true",
      "allow_merge: false",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "target_branch: clawsweeper/commit-finding",
      "source: clawsweeper_commit",
      `commit_sha: ${VALIDATED_COMMIT}`,
      "---",
      "Commit finding job.",
      "",
    ].join("\n"),
  );
}

function writeMergeJob(jobPath: string) {
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: automerge-openclaw-openclaw-123",
      "mode: autonomous",
      "allowed_actions:",
      "  - comment",
      "  - label",
      "  - fix",
      "  - raise_pr",
      "  - merge",
      "blocked_actions: []",
      "canonical:",
      "  - '#123'",
      "candidates:",
      "  - '#123'",
      "cluster_refs:",
      "  - '#123'",
      "allow_fix_pr: true",
      "allow_merge: true",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "target_branch: clawsweeper/automerge-openclaw-openclaw-123",
      "source: pr_automerge",
      "---",
      "Automerge job.",
      "",
    ].join("\n"),
  );
}

function writeIssueImplementationReports(
  runDir: string,
  resultPath: string,
  commit = VALIDATED_COMMIT,
) {
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "issue-openclaw-openclaw-85831",
        mode: "autonomous",
        actions: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, "fix-execution-report.json"),
    JSON.stringify(
      {
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/openclaw/openclaw/pull/123",
            branch: "clawsweeper/issue-openclaw-openclaw-85831",
            commit,
          },
        ],
      },
      null,
      2,
    ),
  );
}

function writeMergeReports(runDir: string, resultPath: string, commit = VALIDATED_COMMIT) {
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        repo: "openclaw/openclaw",
        cluster_id: "automerge-openclaw-openclaw-123",
        mode: "autonomous",
        actions: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(runDir, "fix-execution-report.json"),
    JSON.stringify(
      {
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/openclaw/openclaw/pull/123",
            branch: "clawsweeper/automerge-openclaw-openclaw-123",
            commit,
            merge_preflight: {
              security_status: "cleared",
              security_evidence: ["no security signal"],
              comments_status: "resolved",
              comments_evidence: ["no unresolved review comments"],
              bot_comments_status: "resolved",
              bot_comments_evidence: ["no unresolved bot comments"],
              validation_commands: ["pnpm test"],
              codex_review: {
                command: "/review",
                status: "passed",
                findings_addressed: true,
                evidence: ["Codex review passed"],
              },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
}

function spawnPostFlight(
  jobPath: string,
  resultPath: string,
  fakeBin?: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAWSWEEPER_ALLOW_EXECUTE: "1",
      CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
      ...(fakeBin ? mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin) : {}),
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function runHeadGuardCase({
  source,
  expectedCommit = VALIDATED_COMMIT,
  liveHead,
  alreadyMerged = false,
  restAlreadyMerged = alreadyMerged,
  graphqlAlreadyMerged = alreadyMerged,
  initialBase = "main",
  finalBase = "main",
  postMergeBase = "main",
  mergeConfirmed = true,
  dryRun = false,
  allowMerge = source === "merge",
  fallbackSourceStatus,
}: {
  source: "commit" | "issue" | "merge";
  expectedCommit?: string;
  liveHead: string;
  alreadyMerged?: boolean;
  restAlreadyMerged?: boolean;
  graphqlAlreadyMerged?: boolean;
  initialBase?: string;
  finalBase?: string;
  postMergeBase?: string;
  mergeConfirmed?: boolean;
  dryRun?: boolean;
  allowMerge?: boolean;
  fallbackSourceStatus?: "blocked" | "failed" | "skipped";
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const mergeFlagPath = path.join(tmp, "merge-called.txt");
  const viewCountPath = path.join(tmp, "view-count.txt");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  writeHeadGuardGh(fakeBin);
  if (source === "commit") {
    writeCommitFindingJob(jobPath);
    writeIssueImplementationReports(runDir, resultPath, expectedCommit);
  } else if (source === "issue") {
    writeIssueImplementationJob(jobPath);
    writeIssueImplementationReports(runDir, resultPath, expectedCommit);
  } else {
    writeMergeJob(jobPath);
    writeMergeReports(runDir, resultPath, expectedCommit);
  }
  if (fallbackSourceStatus) {
    const fixReportPath = path.join(runDir, "fix-execution-report.json");
    const fixReport = JSON.parse(fs.readFileSync(fixReportPath, "utf8"));
    fixReport.actions.unshift({
      action: "repair_contributor_branch",
      status: fallbackSourceStatus,
      target: "https://github.com/openclaw/openclaw/pull/123",
      fallback: "open_fix_pr",
    });
    fs.writeFileSync(fixReportPath, `${JSON.stringify(fixReport, null, 2)}\n`);
  }

  try {
    const run = spawnPostFlight(jobPath, resultPath, fakeBin, {
      CLAWSWEEPER_ALLOW_MERGE: allowMerge ? "1" : "0",
      CLAWSWEEPER_POST_FLIGHT_DRY_RUN: dryRun ? "1" : "0",
      CLAWSWEEPER_APP_SLUG: "clawsweeper",
      CLAWSWEEPER_AUTHENTICATED_APP_ID: "3306130",
      CLAWSWEEPER_AUTHENTICATED_APP_SLUG: "clawsweeper",
      CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID: "987654",
      GH_TOKEN: "mutation-token",
      GITHUB_TOKEN: "mutation-token",
      CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "0",
      FAKE_GH_REST_ALREADY_MERGED: restAlreadyMerged ? "1" : "0",
      FAKE_GH_GRAPHQL_ALREADY_MERGED: graphqlAlreadyMerged ? "1" : "0",
      FAKE_GH_INITIAL_BASE: initialBase,
      FAKE_GH_FINAL_BASE: finalBase,
      FAKE_GH_POST_MERGE_BASE: postMergeBase,
      FAKE_GH_HEAD: liveHead,
      FAKE_GH_MERGE_CONFIRMED: mergeConfirmed ? "1" : "0",
      FAKE_GH_MERGE_CALLED_FILE: mergeFlagPath,
      FAKE_GH_VIEW_COUNT_FILE: viewCountPath,
    });
    return {
      status: run.status,
      stderr: run.stderr,
      report: JSON.parse(fs.readFileSync(reportPath, "utf8")),
      mergeCalled: fs.existsSync(mergeFlagPath),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeHeadGuardGh(fakeBin: string) {
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const head = process.env.FAKE_GH_HEAD;",
      "const mergeCalled = fs.existsSync(process.env.FAKE_GH_MERGE_CALLED_FILE);",
      "const postMergeConfirmed = mergeCalled && process.env.FAKE_GH_MERGE_CONFIRMED === '1';",
      "const restMerged = process.env.FAKE_GH_REST_ALREADY_MERGED === '1' || postMergeConfirmed;",
      "const graphqlMerged = process.env.FAKE_GH_GRAPHQL_ALREADY_MERGED === '1' || postMergeConfirmed;",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rules/branches/main?per_page=100') {",
      "  process.stdout.write(JSON.stringify([[{",
      "    type: 'required_status_checks', ruleset_id: 18588237,",
      "    parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'CI' }] },",
      "  }]]));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rulesets/18588237?includes_parents=true') {",
      "  process.stdout.write(JSON.stringify({",
      "    current_user_can_bypass: 'never', enforcement: 'active',",
      "    rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'CI' }] } }],",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rulesets?includes_parents=true&targets=branch&per_page=100') {",
      "  process.stdout.write(JSON.stringify([[{ id: 19600001, target: 'branch', enforcement: 'active' }]]));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rulesets/19600001?includes_parents=true') {",
      "  process.stdout.write(JSON.stringify({",
      "    target: 'branch', enforcement: 'active', current_user_can_bypass: 'never',",
      "    conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/main'] } },",
      "    rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }],",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      "  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  const base = mergeCalled ? process.env.FAKE_GH_POST_MERGE_BASE : process.env.FAKE_GH_INITIAL_BASE;",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, state: restMerged ? 'closed' : 'open',",
      "    title: 'fix(ui): preserve source config', draft: false, labels: [],",
      "    base: { ref: base }, merged_at: restMerged ? '2026-05-24T00:42:00Z' : null,",
      "    merge_commit_sha: restMerged ? 'cccccccccccccccccccccccccccccccccccccccc' : null,",
      "    head: { sha: head },",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  const viewCount = fs.existsSync(process.env.FAKE_GH_VIEW_COUNT_FILE)",
      "    ? Number(fs.readFileSync(process.env.FAKE_GH_VIEW_COUNT_FILE, 'utf8')) + 1",
      "    : 1;",
      "  fs.writeFileSync(process.env.FAKE_GH_VIEW_COUNT_FILE, String(viewCount));",
      "  const base = mergeCalled",
      "    ? process.env.FAKE_GH_POST_MERGE_BASE",
      "    : viewCount > 1 ? process.env.FAKE_GH_FINAL_BASE : process.env.FAKE_GH_INITIAL_BASE;",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: base, headRefOid: head, isDraft: false, mergeable: 'MERGEABLE',",
      "    mergeStateStatus: 'CLEAN', mergedAt: graphqlMerged ? '2026-05-24T00:42:00Z' : null,",
      "    mergeCommit: graphqlMerged ? { oid: 'cccccccccccccccccccccccccccccccccccccccc' } : null,",
      "    reviewDecision: null, state: graphqlMerged ? 'MERGED' : 'OPEN',",
      "    statusCheckRollup: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }],",
      "    title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'merge') {",
      "  fs.writeFileSync(process.env.FAKE_GH_MERGE_CALLED_FILE, JSON.stringify(args));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );
}
