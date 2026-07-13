import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";
import {
  buildStagedProofPlan,
  executeStagedProofPlan,
  stagedProofBundle,
  stagedProofPlanArtifact,
} from "../../dist/repair/staged-proof-gates.js";
import {
  prepareExecutionAuthorization,
  sealExecutionHandoff,
} from "../../dist/repair/execution-handoff.js";
import {
  createPreparedPublication,
  digestJson,
  publicationReceipt,
} from "../../dist/repair/prepared-publication.js";

const repoRoot = process.cwd();
const MERGE_HEAD_SHA = "a".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

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
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main',",
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
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
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

test("merge post-flight requires exact proof and server-enforced strict base binding", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-"));
  const fakeBin = path.join(tmp, "bin");
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const mergeFlagPath = path.join(tmp, "merged.txt");
  const viewCountPath = path.join(tmp, "view-count.txt");
  const commentsCountPath = path.join(tmp, "comments-count.txt");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') {",
      "  const merged = fs.existsSync(process.env.FAKE_GH_MERGED_FILE);",
      "  process.stdout.write(JSON.stringify({",
      "    number: 123, state: merged ? 'closed' : 'open', title: 'fix(ui): preserve source config',",
      `    draft: false, labels: [], base: { ref: 'main', sha: '${MERGE_BASE_SHA}' },`,
      "    merged_at: merged ? '2026-05-24T00:42:00Z' : null,",
      "    merge_commit_sha: merged ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' : null,",
      `    head: { sha: '${MERGE_HEAD_SHA}' },`,
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
      "  const path = process.env.FAKE_GH_COMMENTS_COUNT_FILE;",
      "  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      "  fs.writeFileSync(path, String(count + 1));",
      "  if (process.env.FAKE_GH_LATE_SECURITY === '1' && count >= 2) {",
      "    process.stdout.write('<!-- clawsweeper-security:security-sensitive item=123 sha=abc -->');",
      "  }",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rules/branches/main') {",
      "  const rules = process.env.FAKE_GH_STRICT_BASE === '1'",
      "    ? [{ type: 'required_status_checks', ruleset_id: 18588237, ruleset_source: 'openclaw/openclaw', ruleset_source_type: 'Repository', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'required-ci/exact-merge' }] } }]",
      "    : [];",
      "  process.stdout.write(JSON.stringify(rules));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rulesets/18588237') {",
      "  process.stdout.write(JSON.stringify({",
      "    enforcement: 'active',",
      "    bypass_actors: [],",
      "    rules: [{",
      "      type: 'required_status_checks',",
      "      parameters: {",
      "        strict_required_status_checks_policy: true,",
      "        required_status_checks: [{ context: 'required-ci/exact-merge' }],",
      "      },",
      "    }],",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/branches/main/protection') {",
      "  process.stdout.write(JSON.stringify({ required_status_checks: null }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      "  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      "  const path = process.env.FAKE_GH_VIEW_COUNT_FILE;",
      "  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      "  fs.writeFileSync(path, String(count + 1));",
      "  const checks = count === 0",
      "    ? [{ name: 'label', workflowName: 'Labeler', startedAt: '2026-05-24T00:39:40Z', status: 'COMPLETED', conclusion: 'SUCCESS' }]",
      "    : [{ name: 'check', workflowName: 'CI', startedAt: '2026-05-24T00:39:44Z', status: 'COMPLETED', conclusion: 'SUCCESS' }];",
      "  process.stdout.write(JSON.stringify({",
      "    baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',",
      "    mergeStateStatus: 'CLEAN', reviewDecision: null, state: 'OPEN',",
      "    statusCheckRollup: checks, title: 'fix(ui): preserve source config',",
      "    url: 'https://github.com/openclaw/openclaw/pull/123',",
      "  }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'pr' && args[1] === 'merge') {",
      "  if (process.env.FAKE_GH_MERGE_RACE === '1') {",
      "    process.stderr.write('base branch was modified; review and try the merge again\\n');",
      "    process.exit(1);",
      "  }",
      "  fs.writeFileSync(process.env.FAKE_GH_MERGED_FILE, '1');",
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
    const staleHead = "d".repeat(40);
    const fixReportPath = path.join(runDir, "fix-execution-report.json");
    const staleReport = JSON.parse(fs.readFileSync(fixReportPath, "utf8"));
    staleReport.actions[0].commit = staleHead;
    staleReport.actions[0].merge_preflight.validation_proof = passedValidationProof(
      staleHead,
      MERGE_BASE_SHA,
    );
    staleReport.actions[0].merge_preflight.validated_head_sha = staleHead;
    fs.writeFileSync(fixReportPath, JSON.stringify(staleReport, null, 2));
    const env = {
      ...process.env,
      CLAWSWEEPER_ALLOW_EXECUTE: "1",
      CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
      CLAWSWEEPER_ALLOW_MERGE: "1",
      CLAWSWEEPER_APP_SLUG: "openclaw-clawsweeper",
      CLAWSWEEPER_AUTHENTICATED_APP_ID: "3306130",
      CLAWSWEEPER_AUTHENTICATED_APP_SLUG: "openclaw-clawsweeper",
      CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID: "987654",
      CLAWSWEEPER_RULESET_APP_ID: "3306130",
      CLAWSWEEPER_RULESET_APP_SLUG: "openclaw-clawsweeper",
      CLAWSWEEPER_RULESET_INSTALLATION_ID: "987654",
      CLAWSWEEPER_RULESET_GH_TOKEN: "ruleset-verifier",
      CLAWSWEEPER_POST_FLIGHT_REQUIRE_PR_CHECKS: "1",
      CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "10000",
      CLAWSWEEPER_POST_FLIGHT_POLL_MS: "1",
      FAKE_GH_MERGED_FILE: mergeFlagPath,
      FAKE_GH_VIEW_COUNT_FILE: viewCountPath,
      FAKE_GH_COMMENTS_COUNT_FILE: commentsCountPath,
      ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
    };
    writeMergeReports(runDir, resultPath);
    fs.writeFileSync(mergeFlagPath, "1");
    const alreadyMergedPath = path.join(runDir, "fix-execution-report.json");
    const alreadyMergedReport = JSON.parse(fs.readFileSync(alreadyMergedPath, "utf8"));
    alreadyMergedReport.actions[0].commit = "d".repeat(40);
    fs.writeFileSync(alreadyMergedPath, JSON.stringify(alreadyMergedReport, null, 2));
    runPostFlight(jobPath, resultPath, env, 1);
    const alreadyMerged = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(alreadyMerged.actions[0]?.status, "blocked");
    assert.equal(
      alreadyMerged.actions[0]?.reason,
      "merged pull request head does not match the authorized repair commit",
    );
    fs.rmSync(mergeFlagPath, { force: true });
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    const staleAfterMerged = JSON.parse(fs.readFileSync(fixReportPath, "utf8"));
    staleAfterMerged.actions[0].commit = staleHead;
    staleAfterMerged.actions[0].merge_preflight.validation_proof = passedValidationProof(
      staleHead,
      MERGE_BASE_SHA,
    );
    staleAfterMerged.actions[0].merge_preflight.validated_head_sha = staleHead;
    fs.writeFileSync(fixReportPath, JSON.stringify(staleAfterMerged, null, 2));

    runPostFlight(jobPath, resultPath, env, 1);
    const stalePostFlight = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(stalePostFlight.actions[0]?.status, "blocked");
    assert.equal(
      stalePostFlight.actions[0]?.reason,
      "staged validation proof does not match the live pull request head",
    );
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    const staleBase = "e".repeat(40);
    const staleBaseReport = JSON.parse(fs.readFileSync(fixReportPath, "utf8"));
    staleBaseReport.actions[0].merge_preflight.validation_proof = passedValidationProof(
      MERGE_HEAD_SHA,
      staleBase,
    );
    staleBaseReport.actions[0].merge_preflight.validated_base_sha = staleBase;
    fs.writeFileSync(fixReportPath, JSON.stringify(staleBaseReport, null, 2));
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    runPostFlight(jobPath, resultPath, env, 1);
    const staleBasePostFlight = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(staleBasePostFlight.actions[0]?.status, "blocked");
    assert.equal(
      staleBasePostFlight.actions[0]?.reason,
      "staged validation proof does not match the live pull request base",
    );
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    runPostFlight(jobPath, resultPath, env, 1);
    const unboundReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(unboundReport.actions[0]?.status, "blocked");
    assert.equal(
      unboundReport.actions[0]?.reason,
      "automerge disabled: main lacks server-enforced strict base binding",
    );
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    fs.rmSync(commentsCountPath, { force: true });
    runPostFlight(
      jobPath,
      resultPath,
      { ...env, FAKE_GH_STRICT_BASE: "1", FAKE_GH_LATE_SECURITY: "1" },
      1,
    );
    const lateSecurityReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(lateSecurityReport.actions[0]?.status, "blocked");
    assert.equal(
      lateSecurityReport.actions[0]?.reason,
      "security-sensitive target requires central security triage",
    );
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    fs.rmSync(commentsCountPath, { force: true });
    runPostFlight(
      jobPath,
      resultPath,
      { ...env, FAKE_GH_STRICT_BASE: "1", FAKE_GH_MERGE_RACE: "1" },
      1,
    );
    const mergeRaceReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(mergeRaceReport.outcome, "blocked");
    assert.equal(mergeRaceReport.actions[0]?.status, "blocked");
    assert.equal(mergeRaceReport.actions[0]?.retry_recommended, undefined);
    assert.match(mergeRaceReport.actions[0]?.reason, /requires a verified publication checkpoint/);
    assert.equal(fs.existsSync(mergeFlagPath), false);

    writeMergeReports(runDir, resultPath);
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(viewCountPath, { force: true });
    fs.rmSync(commentsCountPath, { force: true });
    runPostFlight(jobPath, resultPath, { ...env, FAKE_GH_STRICT_BASE: "1" }, 1);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "blocked");
    assert.match(report.actions[0]?.reason, /requires a verified publication checkpoint/);
    assert.equal(fs.existsSync(mergeFlagPath), false);
    assert.equal(fs.readFileSync(viewCountPath, "utf8"), "2");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("post-flight rechecks live security immediately before privileged mutations", () => {
  const source = fs.readFileSync("src/repair/post-flight.ts", "utf8");
  const finalizeFixPr = source.slice(
    source.indexOf("function finalizeFixPr"),
    source.indexOf("function publishedFixAction"),
  );
  assert.match(
    finalizeFixPr,
    /liveSecurityBlockReason\([\s\S]*fetchPullRequest[\s\S]*runVerifiedPostFlightPullMutation\(parsed\.number, \(\) => \{[\s\S]*postFlightMergeRetryBlock\([\s\S]*ghText\(mergeArgs\)/,
  );
  assert.match(
    finalizeFixPr,
    /runVerifiedPostFlightPullMutation\(parsed\.number, \(\) =>[\s\S]*labelForClawSweeperReview/,
  );
  assert.match(
    finalizeFixPr,
    /runVerifiedPostFlightPullMutation\(parsed\.number, \(\) => \{[\s\S]*fetchPullRequest\([\s\S]*fetchPullRequestView\([\s\S]*postFlightMergeRetryBlock\([\s\S]*ghText\(mergeArgs\)/,
  );
  assert.match(
    finalizeFixPr,
    /catch \(error\)[\s\S]*reconcileMergeState\(parsed\.number, action\.commit\)[\s\S]*ghRetryKind\(error\)[\s\S]*postFlightMergeRetryWaitMs\([\s\S]*sleepMs\([\s\S]*continue/,
  );
  assert.match(
    finalizeFixPr,
    /kind: "post_flight_merge"[\s\S]*ghText\(mergeArgs\)[\s\S]*reconcileMergeState\(parsed\.number, action\.commit\)[\s\S]*outcome:[\s\S]*confirmation\.mergedAt[\s\S]*"accepted"[\s\S]*"unknown"/,
  );
  assert.match(
    finalizeFixPr,
    /mergeAttempt\.policyBlock[\s\S]*const confirmation = mergeAttempt\.confirmation[\s\S]*!confirmation\.mergedAt[\s\S]*retry_recommended: true/,
  );
  assert.match(
    finalizeFixPr,
    /if \(mergedAt\)[\s\S]*recordPostFlightMergeObserved\(parsed\.number, action\.commit\)[\s\S]*if \(reconciliation\.mergedAt\)[\s\S]*recordPostFlightMergeObserved\(parsed\.number, action\.commit\)/,
  );
  assert.match(
    source,
    /function reconcileMergeState[\s\S]*fetchPullRequest\([\s\S]*fetchPullRequestView\([\s\S]*mergedHead !== expectedHeadSha/,
  );
  assert.match(
    source,
    /function postFlightMergeRetryBlock[\s\S]*liveSecurityBlockReason\([\s\S]*validateMergePolicy\([\s\S]*validateMergeableFixPr\([\s\S]*runtimeStrictBaseBindingBlock\(/,
  );
  const mutationWrapper = source.slice(
    source.indexOf("function runVerifiedPostFlightPullMutation"),
    source.indexOf("function rulesetPolicyReader"),
  );
  assert.match(mutationWrapper, /runVerifiedPublishedPullMutation\(/);
  assert.match(mutationWrapper, /receipt\.target_pr_number !== number/);

  const closeout = source.slice(
    source.indexOf("function finalizePostMergeCloseout"),
    source.indexOf("function validateMergePolicy"),
  );
  assert.ok(
    [...closeout.matchAll(/SecurityBlock = (?:freshL|l)iveSecurityBlockReason/g)].length >= 3,
  );
  const commentMutationIndex = /"issue",\s+"comment"/.exec(closeout)?.index ?? -1;
  assert.notEqual(commentMutationIndex, -1);
  assert.ok(closeout.indexOf("beforeCommentSecurityBlock") < commentMutationIndex);
  assert.ok(closeout.indexOf("beforeCloseSecurityBlock") < closeout.indexOf('["pr", "close"'));
});

test("post-flight reconciles ambiguous merges and retries only after fresh safety checks", () => {
  const fixture = createVerifiedMergeFixture();
  try {
    const commonEnv = {
      ...process.env,
      CLAWSWEEPER_ALLOW_EXECUTE: "1",
      CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
      CLAWSWEEPER_ALLOW_MERGE: "1",
      CLAWSWEEPER_APP_SLUG: "openclaw-clawsweeper",
      CLAWSWEEPER_AUTHENTICATED_APP_ID: "3306130",
      CLAWSWEEPER_AUTHENTICATED_APP_SLUG: "openclaw-clawsweeper",
      CLAWSWEEPER_AUTHENTICATED_INSTALLATION_ID: "987654",
      CLAWSWEEPER_RULESET_APP_ID: "3306130",
      CLAWSWEEPER_RULESET_APP_SLUG: "openclaw-clawsweeper",
      CLAWSWEEPER_RULESET_INSTALLATION_ID: "987654",
      CLAWSWEEPER_RULESET_GH_TOKEN: "ruleset-verifier",
      CLAWSWEEPER_POST_FLIGHT_MERGE_ATTEMPTS: "3",
      CLAWSWEEPER_POST_FLIGHT_MERGE_RETRY_MAX_WAIT_MS: "0",
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_ROOT: fixture.ledgerRoot,
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: fixture.ledgerOutputRoot,
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "post-flight-verified",
      FAKE_GH_PULL_FILE: fixture.pullPath,
      FAKE_GH_MERGED_FILE: fixture.mergedPath,
      FAKE_GH_MERGE_COUNT_FILE: fixture.mergeCountPath,
      FAKE_GH_COMMENTS_COUNT_FILE: fixture.commentsCountPath,
      FAKE_GH_FAILURE_COMMENTS_FILE: fixture.failureCommentsPath,
      FAKE_GH_DELAYED_MERGE_FILE: fixture.delayedMergePath,
      FAKE_GH_CONFIRMATION_COUNT_FILE: fixture.confirmationCountPath,
      GITHUB_ACTION: "post_flight",
      GITHUB_JOB: "mutate",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "521123",
      GITHUB_SHA: "f".repeat(40),
      GITHUB_WORKFLOW: "repair cluster worker",
      GITHUB_WORKFLOW_REF:
        "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
      ...mockGhBinEnv(fixture.ghPath, fixture.fakeBin),
    };

    runVerifiedPostFlight(fixture, { ...commonEnv, FAKE_GH_MERGE_MODE: "ambiguous" }, 0);
    let report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "executed");
    assert.equal(report.actions[0]?.reason, "merge confirmed after ambiguous response");
    assert.equal(report.actions[0]?.merge_attempts, 1);
    assert.equal(fs.readFileSync(fixture.mergeCountPath, "utf8"), "1");
    assert.deepEqual(mutationReceiptStates(finalizeVerifiedActionLedger(fixture, commonEnv)), [
      ["started", "mutation_attempted"],
      ["executed", "mutation_accepted"],
    ]);

    fixture.reset();
    runVerifiedPostFlight(fixture, { ...commonEnv, FAKE_GH_MERGE_MODE: "delayed_ambiguous" }, 0);
    report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "executed");
    assert.equal(report.actions[0]?.reason, "merge confirmed after ambiguous response");
    assert.equal(fs.readFileSync(fixture.mergeCountPath, "utf8"), "1");
    assert.deepEqual(mutationReceiptStates(finalizeVerifiedActionLedger(fixture, commonEnv)), [
      ["started", "mutation_attempted"],
      ["failed", "mutation_outcome_unknown"],
      ["executed", "mutation_observed"],
    ]);

    fixture.reset();
    runVerifiedPostFlight(fixture, { ...commonEnv, FAKE_GH_MERGE_MODE: "transient" }, 0);
    report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "executed");
    assert.equal(report.actions[0]?.merge_attempts, 2);
    assert.equal(fs.readFileSync(fixture.mergeCountPath, "utf8"), "2");

    fixture.reset();
    const backoffRun = runVerifiedPostFlight(
      fixture,
      {
        ...commonEnv,
        CLAWSWEEPER_POST_FLIGHT_MERGE_RETRY_MAX_WAIT_MS: "50",
        FAKE_GH_MERGE_MODE: "transient",
        FAKE_GH_SECURITY_AFTER_BACKOFF: "1",
      },
      1,
    );
    assert.equal(fs.existsSync(fixture.reportPath), true, backoffRun.stderr || backoffRun.stdout);
    report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "blocked");
    assert.match(
      report.actions[0]?.reason,
      /^security-sensitive (?:PR|target) requires central security triage$/,
    );
    assert.equal(report.actions[0]?.merge_attempts, 2);
    assert.equal(fs.readFileSync(fixture.mergeCountPath, "utf8"), "1");

    fixture.reset();
    runVerifiedPostFlight(fixture, { ...commonEnv, FAKE_GH_MERGE_MODE: "queue" }, 1);
    report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.outcome, "requeue");
    assert.equal(report.actions[0]?.status, "blocked");
    assert.equal(
      report.actions[0]?.reason,
      "merge command completed but GitHub has not confirmed the pull request as merged",
    );
    assert.equal(report.actions[0]?.retry_recommended, true);
    assert.equal(report.actions[0]?.merge_attempts, 1);
    assert.equal(fs.readFileSync(fixture.mergeCountPath, "utf8"), "1");
    assert.equal(fs.existsSync(fixture.mergedPath), false);
    let queueEvents = finalizeVerifiedActionLedger(fixture, commonEnv);
    assert.deepEqual(mutationReceiptStates(queueEvents), [
      ["started", "mutation_attempted"],
      ["failed", "mutation_outcome_unknown"],
    ]);
    fs.writeFileSync(fixture.mergedPath, "1");
    fs.rmSync(fixture.reportPath, { force: true });
    const observedEnv = {
      ...commonEnv,
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "post-flight-observe",
      GITHUB_RUN_ATTEMPT: "2",
    };
    runVerifiedPostFlight(fixture, observedEnv, 0);
    report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "executed");
    assert.equal(report.actions[0]?.reason, "already merged");
    queueEvents = finalizeVerifiedActionLedger(fixture, observedEnv);
    assert.ok(
      queueEvents.some(
        (event) =>
          event.event_type === "repair.mutation" &&
          event.action.status === "executed" &&
          event.attributes?.completion_reason === "mutation_observed",
      ),
    );

    fixture.reset();
    runVerifiedPostFlight(
      fixture,
      {
        ...commonEnv,
        FAKE_GH_MERGE_MODE: "transient",
        FAKE_GH_SECURITY_AFTER_FAILURE: "1",
      },
      1,
    );
    report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.actions[0]?.status, "blocked");
    assert.equal(
      report.actions[0]?.reason,
      "security-sensitive target requires central security triage",
    );
    assert.equal(report.actions[0]?.merge_attempts, 1);
    assert.equal(fs.readFileSync(fixture.mergeCountPath, "utf8"), "1");
  } finally {
    fixture.cleanup();
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
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
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

for (const checkState of [
  "missing",
  "pending",
  "completed_without_conclusion",
  "malformed",
] as const) {
  const expectedOutcome =
    checkState === "malformed" ? "blocks malformed" : "requeues deadline-expired";
  const checkDescription = checkState === "malformed" ? "check records" : `${checkState} checks`;
  test(`issue implementation post-flight ${expectedOutcome} ${checkDescription}`, () => {
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
        "    number: 123, state: 'open', title: 'fix(ui): preserve source config',",
        "    draft: false, labels: [], base: { ref: 'main' }, merged_at: null,",
        "    head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },",
        "  }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123/comments?per_page=100') {",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'pr' && args[1] === 'view') {",
        `  const checks = ${
          checkState === "missing"
            ? "[]"
            : checkState === "pending"
              ? "[{ name: 'check', workflowName: 'CI', status: 'QUEUED', conclusion: null }]"
              : checkState === "completed_without_conclusion"
                ? "[{ name: 'check', workflowName: 'CI', status: 'COMPLETED', conclusion: null }]"
                : "[{ name: 'check', workflowName: 'CI' }]"
        };`,
        "  process.stdout.write(JSON.stringify({",
        "    baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',",
        "    mergeStateStatus: 'UNSTABLE', reviewDecision: null, state: 'OPEN',",
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
      runPostFlight(
        jobPath,
        resultPath,
        {
          ...process.env,
          CLAWSWEEPER_ALLOW_EXECUTE: "1",
          CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
          CLAWSWEEPER_POST_FLIGHT_WAIT_MS: "0",
          CLAWSWEEPER_POST_FLIGHT_POLL_MS: "0",
          ...mockGhBinEnv(path.join(fakeBin, "gh"), fakeBin),
        },
        1,
      );

      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      assert.equal(report.outcome, checkState === "malformed" ? "blocked" : "requeue");
      assert.equal(report.actions[0]?.status, "blocked");
      assert.equal(
        report.actions[0]?.retry_recommended,
        checkState === "malformed" ? undefined : true,
      );
      assert.match(
        report.actions[0]?.reason,
        checkState === "missing" ? /no PR checks found/i : /checks are not clean/i,
      );
      if (checkState === "completed_without_conclusion") {
        assert.match(report.actions[0]?.reason, /UNKNOWN \(COMPLETED without conclusion\)/);
      }
      if (checkState === "malformed") {
        assert.match(report.actions[0]?.reason, /check: UNKNOWN/);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("issue implementation post-flight checks the publication receipt head before readiness", () => {
  const source = fs.readFileSync("src/repair/post-flight.ts", "utf8");
  const issueFinalizer = source.slice(
    source.indexOf("function finalizeIssueImplementationPr"),
    source.indexOf("function finalizePostMergeCloseouts"),
  );
  assert.match(
    source,
    /expectedPublishedHeadSha:\s*publicationReceipt\?\.published_head_sha\s*\?\?\s*null/,
  );
  assert.ok(
    issueFinalizer.indexOf("issueImplementationPublishedHeadBlock") <
      issueFinalizer.indexOf('status: "ready"'),
  );
});

test("post-flight exports a blocked report before exiting unsuccessfully", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-")));
  const jobPath = path.join(tmp, "job.md");
  const runDir = path.join(tmp, "run");
  const resultPath = path.join(runDir, "result.json");
  const reportPath = path.join(runDir, "post-flight-report.json");
  const outputPath = path.join(tmp, "github-output.txt");
  const ledgerOutputRoot = path.join(tmp, "ledger-output");
  const sourceRevision = "b".repeat(64);

  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(ledgerOutputRoot);
  writeIssueImplementationJob(jobPath, sourceRevision);
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

  try {
    const env = {
      ...process.env,
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_ROOT: tmp,
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: ledgerOutputRoot,
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "post-flight",
      CLAWSWEEPER_ALLOW_EXECUTE: "1",
      CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
      GITHUB_ACTION: "post_flight",
      GITHUB_JOB: "mutate",
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "4242",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW: "repair cluster worker",
      GITHUB_WORKFLOW_REF:
        "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
    };
    runPostFlight(jobPath, resultPath, env, 1);
    execFileSync(
      process.execPath,
      [path.join(repoRoot, "dist/repair/action-ledger-cli.js"), "finalize"],
      { env, stdio: "pipe" },
    );

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.outcome, "blocked");
    assert.match(report.detail, /no fix-execution-report/);
    assert.match(fs.readFileSync(outputPath, "utf8"), /^report_outcome=blocked$/m);
    const events = readActionEvents(ledgerOutputRoot);
    assert.ok(events.every((event) => event.subject?.source_revision === sourceRevision));
    assert.deepEqual(
      events
        .filter((event) => event.event_type === "workflow.attempt")
        .sort((left, right) => left.phase_seq - right.phase_seq)
        .map((event) => [event.attributes?.state, event.action.status]),
      [
        ["started", "started"],
        ["blocked", "blocked"],
        ["finalized", "completed"],
      ],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function readActionEvents(root: string): Record<string, any>[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return readActionEvents(target);
    if (!target.endsWith(".jsonl")) return [];
    return fs
      .readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  });
}

function runPostFlight(
  jobPath: string,
  resultPath: string,
  env: NodeJS.ProcessEnv,
  expectedStatus: number,
) {
  const child = spawnSync(process.execPath, ["dist/repair/post-flight.js", jobPath, resultPath], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(child.status, expectedStatus, child.stderr || child.stdout);
  return child;
}

function runVerifiedPostFlight(
  fixture: ReturnType<typeof createVerifiedMergeFixture>,
  env: NodeJS.ProcessEnv,
  expectedStatus: number,
) {
  const child = spawnSync(
    process.execPath,
    [
      "dist/repair/post-flight.js",
      fixture.jobPath,
      fixture.resultPath,
      "--handoff-root",
      fixture.handoffRoot,
      "--publication-receipt",
      fixture.publicationReceiptPath,
      "--validation-receipt",
      fixture.validationReceiptPath,
      "--authorization-sha256",
      fixture.authorizationSha256,
      "--validation-receipt-sha256",
      fixture.validationReceiptSha256,
      "--publication-receipt-sha256",
      fixture.publicationReceiptSha256,
    ],
    {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  assert.equal(child.status, expectedStatus, child.stderr || child.stdout);
  return child;
}

function finalizeVerifiedActionLedger(
  fixture: ReturnType<typeof createVerifiedMergeFixture>,
  env: NodeJS.ProcessEnv,
) {
  execFileSync(
    process.execPath,
    [path.join(repoRoot, "dist/repair/action-ledger-cli.js"), "finalize"],
    { cwd: repoRoot, env, stdio: "pipe" },
  );
  return readActionEvents(fixture.ledgerOutputRoot);
}

function mutationReceiptStates(events: Record<string, any>[]) {
  return events
    .filter((event) => event.event_type === "repair.mutation")
    .sort((left, right) => left.phase_seq - right.phase_seq)
    .map((event) => [event.action.status, event.attributes?.completion_reason]);
}

function createVerifiedMergeFixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-post-flight-verified-")),
  );
  const sourceJobPath = path.join(
    repoRoot,
    "jobs",
    "openclaw",
    "inbox",
    `post-flight-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const sourceRunsRoot = path.join(root, "source-runs");
  const sourceRunDir = path.join(sourceRunsRoot, "run");
  const handoffRoot = path.join(root, "handoff");
  const targetDir = path.join(root, "target");
  const fakeBin = path.join(root, "bin");
  const ghPath = path.join(fakeBin, "gh");
  const validationReceiptPath = path.join(root, "validation-receipt.json");
  const publicationReceiptPath = path.join(root, "publication-receipt.json");
  const pullPath = path.join(root, "pull.json");
  const mergedPath = path.join(root, "merged.txt");
  const mergeCountPath = path.join(root, "merge-count.txt");
  const commentsCountPath = path.join(root, "comments-count.txt");
  const failureCommentsPath = path.join(root, "failure-comments.txt");
  const delayedMergePath = path.join(root, "delayed-merge.txt");
  const confirmationCountPath = path.join(root, "confirmation-count.txt");
  const ledgerRoot = path.join(root, "ledger");
  const ledgerOutputRoot = path.join(root, "ledger-output");
  const clusterId = "automerge-openclaw-openclaw-123";
  const outputBranch = "clawsweeper/automerge-openclaw-openclaw-123";

  fs.mkdirSync(path.dirname(sourceJobPath), { recursive: true });
  fs.mkdirSync(sourceRunDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(ledgerRoot);
  fs.mkdirSync(ledgerOutputRoot);
  writeMergeJob(sourceJobPath, 122);

  git(targetDir, "init");
  git(targetDir, "config", "user.name", "ClawSweeper Test");
  git(targetDir, "config", "user.email", "clawsweeper@example.invalid");
  fs.writeFileSync(path.join(targetDir, "fixture.txt"), "base\n");
  git(targetDir, "add", ".");
  git(targetDir, "-c", "commit.gpgsign=false", "commit", "-m", "base");
  const baseSha = git(targetDir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(targetDir, "fixture.txt"), "prepared\n");
  git(targetDir, "add", ".");
  git(targetDir, "-c", "commit.gpgsign=false", "commit", "-m", "fix: prepared");
  const headSha = git(targetDir, "rev-parse", "HEAD");
  const treeSha = git(targetDir, "rev-parse", "HEAD^{tree}");
  const fixArtifact = {
    repair_strategy: "new_fix_pr",
    source_prs: ["https://github.com/openclaw/openclaw/pull/122"],
    supersede_source_prs: [],
    pr_title: "fix: verified post-flight merge",
    pr_body: "Verified post-flight merge.",
    validation_commands: ["git diff --check"],
  };
  const sourceResult = {
    repo: "openclaw/openclaw",
    cluster_id: clusterId,
    mode: "autonomous",
    canonical_pr: "https://github.com/openclaw/openclaw/pull/122",
    reviewed_sha: baseSha,
    actions: [
      {
        action: "open_fix_pr",
        status: "planned",
        target: "https://github.com/openclaw/openclaw/pull/123",
      },
    ],
    fix_artifact: fixArtifact,
  };
  fs.writeFileSync(
    path.join(sourceRunDir, "result.json"),
    `${JSON.stringify(sourceResult, null, 2)}\n`,
  );

  let executionIntent: Record<string, any> | null = null;
  const authorization = prepareExecutionAuthorization({
    jobPath: sourceJobPath,
    runsRoot: sourceRunsRoot,
    outputRoot: handoffRoot,
    workflowRunId: "123456",
    workflowRunAttempt: "1",
    workflowRepository: "openclaw/clawsweeper",
    workflowSha: "f".repeat(40),
    allowedOwner: "openclaw",
    resolveIntent: ({ actionIdentitySha256 }) => {
      const identity = {
        schema_version: 2,
        target_repo: "openclaw/openclaw",
        source: {
          kind: "pull_request" as const,
          repo: "openclaw/openclaw",
          number: 122,
          url: "https://github.com/openclaw/openclaw/pull/122",
          expected_state: "open",
          expected_revision_sha256: null,
          expected_head_repo: "openclaw/openclaw",
          expected_head_ref: "source-122",
          expected_head_sha: baseSha,
          expected_base_ref: "main",
          expected_base_sha: baseSha,
        },
        target_base_ref: "main",
        target_base_sha: baseSha,
        operation: "open_pull_request" as const,
        output_repo: "openclaw/openclaw",
        output_branch: outputBranch,
        expected_output_sha: null,
        expected_target_pr_number: null,
        action_name: "open_fix_pr" as const,
        repair_strategy: "new_fix_pr",
        action_identity_sha256: actionIdentitySha256,
        source_prs: ["https://github.com/openclaw/openclaw/pull/122"],
        source_pull_revisions: [
          {
            url: "https://github.com/openclaw/openclaw/pull/122",
            repo: "openclaw/openclaw",
            number: 122,
            expected_state: "open",
            expected_head_repo: "openclaw/openclaw",
            expected_head_ref: "source-122",
            expected_head_sha: baseSha,
            expected_base_ref: "main",
            expected_base_sha: baseSha,
          },
        ],
        source_closing_references: [],
        contributor_credits: [],
        superseded_source_prs: [],
        close_superseded_source_prs: false,
        required_labels: [],
      };
      executionIntent = { ...identity, identity_sha256: digestJson(identity) };
      return executionIntent as any;
    },
  });
  assert.ok(executionIntent);
  const publication = createPreparedPublication({
    outputDir: path.join(handoffRoot, "run"),
    targetDir,
    authorizationSha256: authorization.identity_sha256,
    executionIntent: executionIntent as any,
    fixArtifact,
    repairDeltaBaseSha: baseSha,
    preparedHeadSha: headSha,
    preparedTreeSha: treeSha,
  });
  const proof = passedValidationProofFixture(headSha, baseSha);
  fs.writeFileSync(
    path.join(handoffRoot, "run", "fix-execution-report.json"),
    `${JSON.stringify(
      {
        validation_proof_plan: proof.plan,
        actions: [
          {
            action: "open_fix_pr",
            status: "prepared",
            pr_url: "https://github.com/openclaw/openclaw/pull/123",
            branch: outputBranch,
            commit: headSha,
            merge_preflight: {
              security_status: "cleared",
              security_evidence: ["no security signal"],
              comments_status: "resolved",
              comments_evidence: ["no unresolved review comments"],
              bot_comments_status: "resolved",
              bot_comments_evidence: ["no unresolved bot comments"],
              validation_commands: ["git diff --check"],
              validation_proof: proof.bundle,
              validated_head_sha: headSha,
              validated_base_sha: baseSha,
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
    )}\n`,
  );
  const manifest = sealExecutionHandoff({
    root: handoffRoot,
    expectedAuthorizationSha256: authorization.identity_sha256,
    executeOutcome: "success",
  });
  const validationIdentity = {
    schema_version: 3,
    authorization_sha256: authorization.identity_sha256,
    execution_manifest_sha256: manifest.identity_sha256,
    execution_intent_sha256: executionIntent.identity_sha256,
    action_identity_sha256: executionIntent.action_identity_sha256,
    prepared_publication_sha256: publication.identity_sha256,
    target_repo: authorization.target_repo,
    operation: executionIntent.operation,
    output_repo: executionIntent.output_repo,
    output_branch: executionIntent.output_branch,
    source: executionIntent.source,
    repair_delta_base_sha: publication.repair_delta_base_sha,
    validated_head_sha: publication.prepared_head_sha,
    validated_tree_sha: publication.prepared_tree_sha,
    validated_base_sha: publication.target_base_sha,
    validation_proof_plan: proof.plan,
    validation_proof: proof.bundle,
  };
  const validationReceipt = {
    ...validationIdentity,
    identity_sha256: digestJson(validationIdentity),
  };
  fs.writeFileSync(validationReceiptPath, `${JSON.stringify(validationReceipt, null, 2)}\n`);
  const receipt = publicationReceipt({
    validationReceiptSha256: validationReceipt.identity_sha256,
    publication,
    targetPrNumber: 123,
    mutations: [],
  });
  fs.writeFileSync(publicationReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.writeFileSync(
    pullPath,
    `${JSON.stringify(
      {
        target: {
          number: 123,
          state: "open",
          title: publication.pr_title,
          body: publication.pr_body,
          draft: false,
          labels: [],
          base: { ref: "main", sha: baseSha },
          merged_at: null,
          merge_commit_sha: null,
          head: {
            repo: { full_name: "openclaw/openclaw" },
            ref: outputBranch,
            sha: headSha,
          },
        },
        source: {
          number: 122,
          state: "open",
          title: "source pull",
          body: "source",
          draft: false,
          labels: [],
          base: { ref: "main", sha: baseSha },
          merged_at: null,
          merge_commit_sha: null,
          head: {
            repo: { full_name: "openclaw/openclaw" },
            ref: "source-122",
            sha: baseSha,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_GH_PULL_FILE, 'utf8'));",
      "const pull = fixture.target;",
      "const sourcePull = fixture.source;",
      "const delayedMerge = fs.existsSync(process.env.FAKE_GH_DELAYED_MERGE_FILE);",
      "let confirmationCount = fs.existsSync(process.env.FAKE_GH_CONFIRMATION_COUNT_FILE) ? Number(fs.readFileSync(process.env.FAKE_GH_CONFIRMATION_COUNT_FILE, 'utf8')) : 0;",
      "if (delayedMerge && args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') { confirmationCount += 1; fs.writeFileSync(process.env.FAKE_GH_CONFIRMATION_COUNT_FILE, String(confirmationCount)); }",
      "const merged = fs.existsSync(process.env.FAKE_GH_MERGED_FILE) || (delayedMerge && confirmationCount >= 2);",
      "const mergeCount = () => fs.existsSync(process.env.FAKE_GH_MERGE_COUNT_FILE) ? Number(fs.readFileSync(process.env.FAKE_GH_MERGE_COUNT_FILE, 'utf8')) : 0;",
      "if (merged) { pull.state = 'closed'; pull.merged_at = '2026-07-13T08:00:00Z'; pull.merge_commit_sha = 'b'.repeat(40); }",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/123') { process.stdout.write(JSON.stringify(pull)); process.exit(0); }",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/pulls/122') { process.stdout.write(JSON.stringify(sourcePull)); process.exit(0); }",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/123') { process.stdout.write(JSON.stringify({ labels: pull.labels })); process.exit(0); }",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/issues/122') { process.stdout.write(JSON.stringify({ labels: sourcePull.labels })); process.exit(0); }",
      "if (args[0] === 'api' && args.includes('repos/openclaw/openclaw/issues/122/comments?per_page=100')) { if (args.includes('--slurp')) process.stdout.write('[[]]'); process.exit(0); }",
      "if (args[0] === 'api' && args.includes('repos/openclaw/openclaw/issues/123/comments?per_page=100')) {",
      "  const count = fs.existsSync(process.env.FAKE_GH_COMMENTS_COUNT_FILE) ? Number(fs.readFileSync(process.env.FAKE_GH_COMMENTS_COUNT_FILE, 'utf8')) : 0;",
      "  fs.writeFileSync(process.env.FAKE_GH_COMMENTS_COUNT_FILE, String(count + 1));",
      "  const failedComments = fs.existsSync(process.env.FAKE_GH_FAILURE_COMMENTS_FILE) ? Number(fs.readFileSync(process.env.FAKE_GH_FAILURE_COMMENTS_FILE, 'utf8')) : -1;",
      "  const securityAfterFailure = process.env.FAKE_GH_SECURITY_AFTER_FAILURE === '1' && mergeCount() >= 1;",
      "  const securityAfterBackoff = process.env.FAKE_GH_SECURITY_AFTER_BACKOFF === '1' && failedComments >= 0 && count > failedComments + 1;",
      "  const security = securityAfterFailure || securityAfterBackoff;",
      "  if (args.includes('--slurp')) process.stdout.write(security ? '[[{\"body\":\"<!-- clawsweeper-security:security-sensitive item=123 sha=abc -->\"}]]' : '[[]]');",
      "  else if (security) process.stdout.write('<!-- clawsweeper-security:security-sensitive item=123 sha=abc -->');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rules/branches/main') { process.stdout.write(JSON.stringify([{ type: 'required_status_checks', ruleset_id: 18588237, ruleset_source: 'openclaw/openclaw', ruleset_source_type: 'Repository', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'required-ci/exact-merge' }] } }])); process.exit(0); }",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/rulesets/18588237') { process.stdout.write(JSON.stringify({ enforcement: 'active', bypass_actors: [], rules: [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'required-ci/exact-merge' }] } }] })); process.exit(0); }",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/branches/main/protection') { process.stdout.write(JSON.stringify({ required_status_checks: null })); process.exit(0); }",
      "if (args[0] === 'api' && args[1] === 'graphql') { process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } })); process.exit(0); }",
      "if (args[0] === 'pr' && args[1] === 'view') { process.stdout.write(JSON.stringify({ baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeCommit: merged ? { oid: 'b'.repeat(40) } : null, mergeStateStatus: 'CLEAN', mergedAt: merged ? '2026-07-13T08:00:00Z' : null, reviewDecision: null, state: merged ? 'MERGED' : 'OPEN', statusCheckRollup: [], title: pull.title, url: 'https://github.com/openclaw/openclaw/pull/123' })); process.exit(0); }",
      "if (args[0] === 'pr' && args[1] === 'merge') {",
      "  const count = mergeCount() + 1;",
      "  fs.writeFileSync(process.env.FAKE_GH_MERGE_COUNT_FILE, String(count));",
      "  if (process.env.FAKE_GH_MERGE_MODE === 'ambiguous') { fs.writeFileSync(process.env.FAKE_GH_MERGED_FILE, '1'); process.stderr.write('gh: HTTP 502: Bad Gateway\\n'); process.exit(1); }",
      "  if (process.env.FAKE_GH_MERGE_MODE === 'delayed_ambiguous') { fs.writeFileSync(process.env.FAKE_GH_DELAYED_MERGE_FILE, '1'); process.stderr.write('gh: HTTP 502: Bad Gateway\\n'); process.exit(1); }",
      "  if (process.env.FAKE_GH_MERGE_MODE === 'transient' && count === 1) { const comments = fs.existsSync(process.env.FAKE_GH_COMMENTS_COUNT_FILE) ? Number(fs.readFileSync(process.env.FAKE_GH_COMMENTS_COUNT_FILE, 'utf8')) : 0; fs.writeFileSync(process.env.FAKE_GH_FAILURE_COMMENTS_FILE, String(comments)); process.stderr.write('gh: HTTP 502: Bad Gateway\\n'); process.exit(1); }",
      "  if (process.env.FAKE_GH_MERGE_MODE === 'queue') process.exit(0);",
      "  fs.writeFileSync(process.env.FAKE_GH_MERGED_FILE, '1');",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    fakeBin,
    ghPath,
    handoffRoot,
    jobPath: path.join(handoffRoot, "job.md"),
    resultPath: path.join(handoffRoot, "run", "result.json"),
    reportPath: path.join(handoffRoot, "run", "post-flight-report.json"),
    validationReceiptPath,
    publicationReceiptPath,
    authorizationSha256: authorization.identity_sha256,
    validationReceiptSha256: validationReceipt.identity_sha256,
    publicationReceiptSha256: receipt.identity_sha256,
    pullPath,
    mergedPath,
    mergeCountPath,
    commentsCountPath,
    failureCommentsPath,
    delayedMergePath,
    confirmationCountPath,
    ledgerRoot,
    ledgerOutputRoot,
    reset() {
      fs.rmSync(mergedPath, { force: true });
      fs.rmSync(mergeCountPath, { force: true });
      fs.rmSync(commentsCountPath, { force: true });
      fs.rmSync(failureCommentsPath, { force: true });
      fs.rmSync(delayedMergePath, { force: true });
      fs.rmSync(confirmationCountPath, { force: true });
      fs.rmSync(ledgerRoot, { recursive: true, force: true });
      fs.rmSync(ledgerOutputRoot, { recursive: true, force: true });
      fs.mkdirSync(ledgerRoot);
      fs.mkdirSync(ledgerOutputRoot);
      fs.rmSync(path.join(handoffRoot, "run", "post-flight-report.json"), { force: true });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(sourceJobPath, { force: true });
    },
  };
}

function writeIssueImplementationJob(jobPath: string, sourceRevision?: string) {
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
      ...(sourceRevision ? [`source_issue_revision_sha256: "${sourceRevision}"`] : []),
      "---",
      "Issue implementation job.",
      "",
    ].join("\n"),
  );
}

function writeMergeJob(jobPath: string, sourceNumber = 123) {
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
      `  - '#${sourceNumber}'`,
      "candidates:",
      `  - '#${sourceNumber}'`,
      "cluster_refs:",
      `  - '#${sourceNumber}'`,
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

function writeIssueImplementationReports(runDir: string, resultPath: string) {
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
          },
        ],
      },
      null,
      2,
    ),
  );
}

function writeMergeReports(runDir: string, resultPath: string) {
  const proof = passedValidationProofFixture(MERGE_HEAD_SHA, MERGE_BASE_SHA);
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
        validation_proof_plan: proof.plan,
        actions: [
          {
            action: "open_fix_pr",
            status: "opened",
            pr_url: "https://github.com/openclaw/openclaw/pull/123",
            branch: "clawsweeper/automerge-openclaw-openclaw-123",
            commit: MERGE_HEAD_SHA,
            merge_preflight: {
              security_status: "cleared",
              security_evidence: ["no security signal"],
              comments_status: "resolved",
              comments_evidence: ["no unresolved review comments"],
              bot_comments_status: "resolved",
              bot_comments_evidence: ["no unresolved bot comments"],
              validation_commands: ["pnpm test"],
              validation_proof: proof.bundle,
              validated_head_sha: MERGE_HEAD_SHA,
              validated_base_sha: MERGE_BASE_SHA,
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

function passedValidationProof(headSha: string, baseSha: string) {
  return passedValidationProofFixture(headSha, baseSha).bundle;
}

function passedValidationProofFixture(headSha: string, baseSha: string) {
  const plan = buildStagedProofPlan({
    commands: [
      {
        parts: ["git", "diff", "--check"],
        source: "configured",
        canonical: false,
        required: true,
        originalIndex: 0,
      },
    ],
    changedFiles: ["src/example.ts"],
  });
  const trace = executeStagedProofPlan(plan, {
    commandTimeoutMs: 1000,
    budgetMs: 1000,
    validatedHeadSha: headSha,
    validatedBaseSha: baseSha,
    nowMs: () => 10,
    runCommand: () => ({ executedCommands: ["git diff --check"], reason: "passed" }),
  }).trace;
  return {
    plan: stagedProofPlanArtifact(plan),
    bundle: stagedProofBundle([trace]),
  };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
