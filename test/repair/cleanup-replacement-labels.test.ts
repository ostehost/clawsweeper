import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";

test("replacement label cleanup records accepted, rejected, and unknown wire outcomes", () => {
  const fixture = createFixture();
  try {
    const first = runCleanup(fixture, {
      invocation: "cleanup-labels",
      removeFailure: "gh: Bad Gateway (HTTP 502)",
    });
    assert.equal(first.status, 0, first.stderr);
    const firstReport = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(firstReport.totals.labels_removed, 1);
    assert.equal(firstReport.totals.remove_failures, 1);
    assert.match(firstReport.prs[0].remove_failures[0].error, /HTTP 502/);

    const second = runCleanup(fixture, { invocation: "cleanup-labels" });
    assert.equal(second.status, 0, second.stderr);
    const secondReport = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(secondReport.totals.labels_removed, 2);
    assert.equal(secondReport.totals.remove_failures, 0);

    finalizeLedger(fixture, "cleanup-labels");
    const mutations = readEvents(fixture.outputRoot).filter(
      (event) => event.event_type === "repair.mutation",
    );
    const byIdempotency = Map.groupBy(mutations, (event) => event.idempotency_key_sha256);
    assert.deepEqual(
      [...byIdempotency.values()]
        .map((events) => events.map((event) => event.attributes.completion_reason))
        .sort((left, right) => left.join().localeCompare(right.join())),
      [
        ["mutation_attempted", "mutation_accepted", "mutation_attempted", "mutation_accepted"],
        [
          "mutation_attempted",
          "mutation_outcome_unknown",
          "mutation_attempted",
          "mutation_accepted",
        ],
      ],
    );
    assert.ok(mutations.every((event) => event.subject.source_revision === undefined));
    assert.ok(mutations.every((event) => event.subject.number === 42));
    assert.equal(JSON.stringify(mutations).includes("private replacement title"), false);
    assert.equal(JSON.stringify(mutations).includes("close:duplicate"), false);
  } finally {
    fs.rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("definite remove-label rejection remains a per-label report failure", () => {
  const fixture = createFixture(["stale"]);
  try {
    const result = runCleanup(fixture, {
      invocation: "cleanup-rejected",
      removeFailure: "gh: Validation Failed (HTTP 422)",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.totals.labels_removed, 0);
    assert.equal(report.totals.remove_failures, 1);
    assert.match(report.prs[0].remove_failures[0].error, /HTTP 422/);

    finalizeLedger(fixture, "cleanup-rejected");
    const mutations = readEvents(fixture.outputRoot).filter(
      (event) => event.event_type === "repair.mutation",
    );
    assert.deepEqual(
      mutations.map((event) => [
        event.attributes.completion_reason,
        event.action.status,
        event.action.mutation,
        event.action.retryable,
      ]),
      [
        ["mutation_attempted", "started", false, true],
        ["mutation_rejected", "skipped", false, false],
      ],
    );
  } finally {
    fs.rmSync(fixture.root, { force: true, recursive: true });
  }
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture(labels = ["stale", "close:duplicate"]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-label-receipts-")));
  const binDir = path.join(root, "bin");
  const ledgerRoot = path.join(root, "ledger");
  const outputRoot = path.join(root, "output");
  const reportPath = path.join(root, "report.json");
  const statePath = path.join(root, "gh-state.json");
  fs.mkdirSync(binDir);
  fs.mkdirSync(ledgerRoot);
  fs.mkdirSync(outputRoot);
  writeFakeGh(binDir, labels);
  return { root, binDir, ledgerRoot, outputRoot, reportPath, statePath };
}

function runCleanup(
  fixture: Fixture,
  options: {
    invocation: string;
    removeFailure?: string;
  },
) {
  const state = fs.existsSync(fixture.statePath)
    ? JSON.parse(fs.readFileSync(fixture.statePath, "utf8"))
    : {};
  state.config = { removeFailure: options.removeFailure ?? "" };
  fs.writeFileSync(fixture.statePath, JSON.stringify(state));
  return spawnSync(
    process.execPath,
    ["dist/repair/cleanup-replacement-labels.js", "--execute", "--report", fixture.reportPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...mockGhBinEnv(path.join(fixture.binDir, "gh"), fixture.binDir),
        CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
        CLAWSWEEPER_ACTION_LEDGER_ROOT: fixture.ledgerRoot,
        CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: fixture.outputRoot,
        CLAWSWEEPER_ACTION_LEDGER_INVOCATION: options.invocation,
        CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
        CLAWSWEEPER_ALLOW_EXECUTE: "1",
        CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
        FAKE_GH_STATE: fixture.statePath,
        GITHUB_ACTION: "cleanup-labels",
        GITHUB_JOB: "cluster",
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "4242",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_WORKFLOW: "repair cluster worker",
        GITHUB_WORKFLOW_REF:
          "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
      },
    },
  );
}

function finalizeLedger(fixture: Fixture, invocation: string) {
  execFileSync(process.execPath, ["dist/repair/action-ledger-cli.js", "finalize"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_ROOT: fixture.ledgerRoot,
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: fixture.outputRoot,
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: invocation,
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
      GITHUB_ACTION: "cleanup-labels",
      GITHUB_JOB: "cluster",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "4242",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKFLOW: "repair cluster worker",
      GITHUB_WORKFLOW_REF:
        "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
    },
  });
}

function writeFakeGh(binDir: string, labels: string[]) {
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const config = state.config || {};
const key = args.join("\\u0000");
state[key] = Number(state[key] || 0) + 1;
state.removeCount = Number(state.removeCount || 0);
if (args[0] === "pr" && args[1] === "edit") state.removeCount += 1;
fs.writeFileSync(statePath, JSON.stringify(state));

if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{
    number: 42,
    title: "private replacement title",
    url: "https://github.com/openclaw/openclaw/pull/42",
    author: { login: "app/clawsweeper" },
    headRefName: "clawsweeper/fix",
    labels: ${JSON.stringify(labels)}.map((name) => ({ name })),
  }]));
} else if (args[0] === "pr" && args[1] === "edit") {
  if (config.removeFailure && state.removeCount === 1) {
    process.stderr.write(config.removeFailure + "\\n");
    process.exit(1);
  }
} else {
  process.stderr.write("unexpected gh args: " + JSON.stringify(args) + "\\n");
  process.exit(2);
}
`,
  );
  fs.chmodSync(ghPath, 0o755);
}

function readEvents(root: string): Record<string, any>[] {
  return walk(root)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
}

function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
