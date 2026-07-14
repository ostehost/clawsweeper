import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";

test("label tagging uses retrying GitHub helpers", () => {
  const source = readFileSync("src/repair/tag-clawsweeper-targets.ts", "utf8");

  assert.match(
    source,
    /import \{ ghErrorText, ghJsonWithRetry, ghText \} from "\.\/github-cli\.js"/,
  );
  assert.doesNotMatch(source, /import \{ ghJson, ghText \} from "\.\/github-cli\.js"/);
  assert.match(source, /const labels = ghJsonWithRetry\(\[/);
  assert.match(
    source,
    /return ghJsonWithRetry\(\["api", `repos\/\$\{repo\}\/issues\/\$\{number\}`]\)/,
  );
  assert.match(source, /runLabelMutationWithRetry\([\s\S]*kind: "target_label_add"/);
  assert.match(source, /runLabelMutationWithRetry\([\s\S]*kind: "repository_label_create"/);
  assert.match(source, /for \(let attempt = 1; attempt <= attempts; attempt \+= 1\)/);
  assert.match(source, /return runRepairMutation\(lifecycle,/);
  assert.match(source, /if \(attempt >= attempts \|\| retryKind === "none"\) throw error;/);
  assert.doesNotMatch(source, /ghTextWithRetry/);
});

test("isolated repair workers do not recursively tag targets", () => {
  const workflow = readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  assert.doesNotMatch(workflow, /- name: Tag ClawSweeper targets/);
  assert.doesNotMatch(workflow, /repair:tag-targets|tag-clawsweeper-targets\.js/);
});

test("label creation and add-label requests emit exact privacy-safe receipts", () => {
  const fixture = createFixture();
  try {
    const create = runTag(fixture, {
      invocation: "create-label",
      labelExists: false,
      itemHasLabel: true,
    });
    assert.equal(create.status, 0, create.stderr);

    const firstAdd = runTag(fixture, {
      invocation: "add-label",
      labelExists: true,
      addFailure: "gh: Bad Gateway (HTTP 502)",
    });
    assert.equal(firstAdd.status, 0, firstAdd.stderr);
    const secondAdd = runTag(fixture, {
      invocation: "add-label",
      labelExists: true,
    });
    assert.equal(secondAdd.status, 0, secondAdd.stderr);

    finalizeLedger(fixture, "add-label");
    const mutations = readEvents(fixture.outputRoot).filter(
      (event) => event.event_type === "repair.mutation",
    );
    const creation = mutations.filter(
      (event) =>
        event.subject.kind === "workflow" && event.producer.component.endsWith(".create-label"),
    );
    assert.deepEqual(
      creation.map((event) => event.attributes.completion_reason),
      ["mutation_attempted", "mutation_accepted"],
    );
    assert.equal(creation[0]?.subject.source_revision, undefined);

    const additions = mutations.filter(
      (event) =>
        event.subject.kind === "pull_request" && event.producer.component.endsWith(".add-label"),
    );
    assert.deepEqual(
      additions.map((event) => event.attributes.completion_reason),
      ["mutation_attempted", "mutation_outcome_unknown", "mutation_attempted", "mutation_accepted"],
    );
    assert.equal(new Set(additions.map((event) => event.idempotency_key_sha256)).size, 1);
    assert.equal(new Set(additions.map((event) => event.event_key)).size, 4);
    assert.deepEqual(
      additions.slice(1).map((event, index) => event.phase_seq - additions[index].phase_seq),
      [1, 1, 1],
    );
    assert.equal(additions[0]?.subject.source_revision, "2026-07-13T12:34:56Z");
    assert.equal(
      JSON.stringify(mutations).includes("fixture title must not enter receipt evidence"),
      false,
    );
    assert.equal(JSON.stringify(mutations).includes("ClawSweeper Repair"), false);
  } finally {
    fs.rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("definite add-label rejection is recorded without claiming a mutation", () => {
  const fixture = createFixture();
  try {
    const result = runTag(fixture, {
      invocation: "rejected-label",
      labelExists: true,
      addFailure: "gh: Validation Failed (HTTP 422)",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.targets[0].status, "failed");
    assert.match(report.targets[0].reason, /HTTP 422/);

    finalizeLedger(fixture, "rejected-label");
    const mutations = readEvents(fixture.outputRoot).filter(
      (event) =>
        event.event_type === "repair.mutation" &&
        event.producer.component.startsWith("tag_clawsweeper_targets.") &&
        event.subject.kind === "pull_request",
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

test("secondary-rate-limit rejection records no mutation before retrying successfully", () => {
  const fixture = createFixture();
  try {
    const result = runTag(fixture, {
      invocation: "secondary-rate-limit",
      labelExists: true,
      addFailure: "gh: You have exceeded a secondary rate limit. (HTTP 403)",
      retryAttempts: 2,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
    assert.equal(report.targets[0].status, "labeled");

    finalizeLedger(fixture, "secondary-rate-limit");
    const mutations = readEvents(fixture.outputRoot).filter(
      (event) =>
        event.event_type === "repair.mutation" &&
        event.producer.component.startsWith("tag_clawsweeper_targets.") &&
        event.subject.kind === "pull_request",
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
        ["mutation_attempted", "started", false, true],
        ["mutation_accepted", "executed", true, false],
      ],
    );
    assert.equal(new Set(mutations.map((event) => event.idempotency_key_sha256)).size, 1);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.addCount, 2);
  } finally {
    fs.rmSync(fixture.root, { force: true, recursive: true });
  }
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tag-label-receipts-")));
  const binDir = path.join(root, "bin");
  const ledgerRoot = path.join(root, "ledger");
  const outputRoot = path.join(root, "output");
  const inputPath = path.join(root, "run.json");
  const reportPath = path.join(root, "report.json");
  const statePath = path.join(root, "gh-state.json");
  fs.mkdirSync(binDir);
  fs.mkdirSync(ledgerRoot);
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      repo: "openclaw/openclaw",
      cluster_id: "cluster-42",
      run_id: "run-123",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/123",
      apply_actions: [{ action: "merge_candidate", status: "executed", target: "#42" }],
    }),
  );
  writeFakeGh(binDir);
  return { root, binDir, ledgerRoot, outputRoot, inputPath, reportPath, statePath };
}

function runTag(
  fixture: Fixture,
  options: {
    invocation: string;
    labelExists: boolean;
    itemHasLabel?: boolean;
    addFailure?: string;
    retryAttempts?: number;
  },
) {
  const state = fs.existsSync(fixture.statePath)
    ? JSON.parse(fs.readFileSync(fixture.statePath, "utf8"))
    : {};
  state.addCount = 0;
  fs.writeFileSync(fixture.statePath, JSON.stringify(state));
  writeFakeGh(fixture.binDir, options);
  return spawnSync(
    process.execPath,
    [
      "dist/repair/tag-clawsweeper-targets.js",
      "--apply",
      "--open-branches",
      "false",
      "--report",
      fixture.reportPath,
      fixture.inputPath,
    ],
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
        CLAWSWEEPER_GH_RETRY_ATTEMPTS: String(options.retryAttempts ?? 1),
        FAKE_GH_STATE: fixture.statePath,
        GITHUB_ACTION: "tag-labels",
        GITHUB_JOB: "cluster",
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "4242",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_WORKFLOW: "repair cluster worker",
        GITHUB_WORKFLOW_REF:
          "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
        ...(options.retryAttempts && options.retryAttempts > 1
          ? { NODE_OPTIONS: `--require=${writeNoWaitPreload(fixture.root)}` }
          : {}),
      },
    },
  );
}

function writeNoWaitPreload(root: string): string {
  const preloadPath = path.join(root, "no-wait.cjs");
  fs.writeFileSync(preloadPath, `Atomics.wait = () => "timed-out";\n`);
  return preloadPath;
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
      GITHUB_ACTION: "tag-labels",
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

function writeFakeGh(
  binDir: string,
  options: {
    labelExists?: boolean;
    itemHasLabel?: boolean;
    addFailure?: string;
  } = {},
) {
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const config = ${JSON.stringify({
      addFailure: options.addFailure ?? "",
      itemHasLabel: Boolean(options.itemHasLabel),
      labelExists: Boolean(options.labelExists),
    })};
const key = args.join("\\u0000");
state[key] = Number(state[key] || 0) + 1;
if (args[0] === "issue" && args[1] === "edit") state.addCount = Number(state.addCount || 0) + 1;
fs.writeFileSync(statePath, JSON.stringify(state));

if (args[0] === "label" && args[1] === "list") {
  process.stdout.write(JSON.stringify(config.labelExists ? [{ name: "ClawSweeper Repair" }] : []));
} else if (args[0] === "label" && args[1] === "create") {
  process.stdout.write("");
} else if (args[0] === "api" && /\\/issues\\/42$/.test(args[1] || "")) {
  process.stdout.write(JSON.stringify({
    number: 42,
    title: "fixture title must not enter receipt evidence",
    state: "open",
    html_url: "https://github.com/openclaw/openclaw/pull/42",
    pull_request: {},
    updated_at: "2026-07-13T12:34:56Z",
    labels: config.itemHasLabel ? [{ name: "ClawSweeper Repair" }] : [],
  }));
} else if (args[0] === "issue" && args[1] === "edit") {
  if (config.addFailure && state.addCount === 1) {
    process.stderr.write(config.addFailure + "\\n");
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
