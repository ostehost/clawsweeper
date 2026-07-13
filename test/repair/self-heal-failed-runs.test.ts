import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("failed-run self-heal paginates before accepting an older failed run", () => {
  const fixture = createFixture("pagination");
  const now = new Date().toISOString();
  const oldCreatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  try {
    writeRunRecord(fixture, "910001", {
      source_job: fixture.jobPath,
      workflow_conclusion: "failure",
      workflow_updated_at: now,
      published_at: now,
      mode: "plan",
    });
    writeRunPages(fixture, {
      1: Array.from({ length: 100 }, (_, index) => ({
        id: 920_000 + index,
        display_title: `unrelated maintenance run ${index}`,
        status: "completed",
        conclusion: "failure",
        created_at: oldCreatedAt,
        updated_at: now,
      })),
      2: [
        {
          id: 910_002,
          display_title: `repair cluster ${fixture.jobPath} (${fixture.jobSha256})`,
          status: "completed",
          conclusion: "success",
          created_at: oldCreatedAt,
          updated_at: now,
          html_url: "https://github.test/actions/runs/910002",
        },
      ],
    });

    const result = runSelfHeal(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "no_candidates");
    assert.deepEqual(summary.candidates, []);
    assert.match(fs.readFileSync(fixture.commandLog, "utf8"), /[?&]page=2(?:\s|$)/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("execute-mode self-heal fails closed when live history discovery fails", () => {
  const fixture = createFixture("live-failure");
  try {
    writeRunRecord(fixture, "910001", {
      source_job: fixture.jobPath,
      workflow_conclusion: "failure",
      workflow_updated_at: new Date().toISOString(),
      mode: "plan",
    });

    const result = runSelfHeal(fixture, {
      args: ["--execute"],
      env: { GH_LIVE_RUN_LIST_FAIL: "1" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot list live repair runs; refusing dispatch/);
    assert.doesNotMatch(fs.readFileSync(fixture.commandLog, "utf8"), /workflow run/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("execute-mode self-heal fails closed when active-run discovery fails", () => {
  const fixture = createFixture("active-failure");
  try {
    writeRunRecord(fixture, "910001", {
      source_job: fixture.jobPath,
      workflow_conclusion: "failure",
      workflow_updated_at: new Date().toISOString(),
      mode: "plan",
    });

    const result = runSelfHeal(fixture, {
      args: ["--execute"],
      env: { GH_ACTIVE_RUN_LIST_FAIL: "1" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot verify active repair generations; refusing dispatch/);
    assert.doesNotMatch(fs.readFileSync(fixture.commandLog, "utf8"), /workflow run/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("failed-run self-heal exposes exact immutable generation provenance", () => {
  const fixture = createFixture("immutable-generation");
  try {
    writeRunRecord(fixture, "910001", {
      source_job: fixture.jobPath,
      workflow_conclusion: "failure",
      workflow_updated_at: new Date().toISOString(),
      mode: "plan",
    });

    const result = runSelfHeal(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, "dry_run");
    assert.deepEqual(summary.candidates, [
      {
        source_run_id: "910001",
        source_job: fixture.jobPath,
        source_state_revision: fixture.stateRevision,
        source_job_sha256: fixture.jobSha256,
        mode: "plan",
      },
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("failed-run self-heal restricts unsealed legacy records to plan mode", () => {
  const fixture = createFixture("legacy-unsealed");
  try {
    writeRunRecord(fixture, "910001", {
      source_job: fixture.jobPath,
      source_state_revision: undefined,
      source_job_sha256: undefined,
      workflow_conclusion: "failure",
      workflow_updated_at: new Date().toISOString(),
      mode: "autonomous",
    });

    const result = runSelfHeal(fixture, { args: ["--mode", "autonomous"] });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.candidates, [
      {
        source_run_id: "910001",
        source_job: fixture.jobPath,
        source_state_revision: fixture.stateRevision,
        source_job_sha256: fixture.jobSha256,
        legacy_unsealed: true,
        mode: "plan",
      },
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("failed-run self-heal recovers live sealed provenance from the inputs artifact", () => {
  const fixture = createFixture("live-artifact");
  const now = new Date().toISOString();
  try {
    fs.writeFileSync(
      fixture.recoveryInputsFile,
      `${JSON.stringify({
        schema_version: 1,
        source_job: fixture.jobPath,
        state_revision: fixture.stateRevision,
        job_sha256: fixture.jobSha256,
        requested_mode: "autonomous",
        effective_mode: "autonomous",
      })}\n`,
    );
    writeRunPages(fixture, {
      1: [
        {
          id: 910_003,
          display_title: `repair cluster ${fixture.jobPath} (${fixture.jobSha256})`,
          status: "completed",
          conclusion: "failure",
          created_at: now,
          updated_at: now,
          html_url: "https://github.test/actions/runs/910003",
        },
      ],
    });

    const result = runSelfHeal(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.candidates, [
      {
        source_run_id: "910003",
        source_job: fixture.jobPath,
        source_state_revision: fixture.stateRevision,
        source_job_sha256: fixture.jobSha256,
        mode: "plan",
        run_url: "https://github.test/actions/runs/910003",
      },
    ]);
    assert.match(
      fs.readFileSync(fixture.commandLog, "utf8"),
      /run download 910003 .*--pattern clawsweeper-repair-inputs-910003-\*/,
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("failed-run self-heal uses paginated history and receipts real mutations", () => {
  const source = fs.readFileSync("src/repair/self-heal-failed-runs.ts", "utf8");

  assert.match(source, /fetchWorkflowRunHistory\(\{ repo, workflow, cutoffMs \}\)/);
  assert.match(source, /cannot list live repair runs; refusing dispatch/);
  assert.match(source, /cannot verify active repair generations; refusing dispatch/);
  assert.match(
    source,
    /runRepairMutation\(selfHealDispatchLifecycle\(candidate\),[\s\S]*kind: "repair_dispatch"/,
  );
  assert.match(
    source,
    /runRepairMutation\(selfHealGateLifecycle\(name, normalizedValue\),[\s\S]*kind: "repository_variable_update"/,
  );
  assert.doesNotMatch(source, /"--limit",\s*"200"/);
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `clawsweeper-self-heal-${label}-`));
  const runsDir = path.join(root, "runs");
  const binDir = path.join(root, "bin");
  const pagesFile = path.join(root, "run-pages.json");
  const commandLog = path.join(root, "gh-commands.log");
  const variablesFile = path.join(root, "variables.json");
  const recoveryInputsFile = path.join(root, "workflow-inputs.json");
  const stateRoot = path.join(root, "state");
  const jobPath = `jobs/test/inbox/self-heal-${process.pid}-${path.basename(root)}.md`;
  const jobBytes = `---
repo: openclaw/openclaw
cluster_id: ${label}
mode: plan
allowed_actions:
  - fix
candidates:
  - "#1"
---

# fixture
`;
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(stateRoot, path.dirname(jobPath)), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: stateRoot });
  execFileSync("git", ["config", "user.name", "ClawSweeper Test"], { cwd: stateRoot });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: stateRoot });
  fs.writeFileSync(path.join(stateRoot, jobPath), jobBytes);
  execFileSync("git", ["add", jobPath], { cwd: stateRoot });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: stateRoot });
  const stateRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: stateRoot,
    encoding: "utf8",
  }).trim();
  const jobSha256 = createHash("sha256").update(jobBytes).digest("hex");
  fs.writeFileSync(pagesFile, "{}\n");
  fs.writeFileSync(commandLog, "");
  fs.writeFileSync(
    variablesFile,
    `${JSON.stringify([
      { name: "CLAWSWEEPER_ALLOW_EXECUTE", value: "1" },
      { name: "CLAWSWEEPER_ALLOW_FIX_PR", value: "1" },
    ])}\n`,
  );
  writeFakeGh(binDir);
  return {
    root,
    runsDir,
    binDir,
    pagesFile,
    commandLog,
    variablesFile,
    recoveryInputsFile,
    stateRoot,
    stateRevision,
    jobPath,
    jobSha256,
  };
}

function cleanupFixture(fixture: Fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function writeRunRecord(fixture: Fixture, runId: string, record: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(fixture.runsDir, `${runId}.json`),
    `${JSON.stringify({
      run_id: runId,
      source_state_revision: fixture.stateRevision,
      source_job_sha256: fixture.jobSha256,
      ...record,
    })}\n`,
  );
}

function writeRunPages(fixture: Fixture, pages: Record<number, Array<Record<string, unknown>>>) {
  fs.writeFileSync(fixture.pagesFile, `${JSON.stringify(pages)}\n`);
}

function runSelfHeal(fixture: Fixture, options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(
    process.execPath,
    [
      path.resolve("dist/repair/self-heal-failed-runs.js"),
      "--runs-dir",
      fixture.runsDir,
      "--max-age-hours",
      "24",
      ...(options.args ?? []),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        CLAWSWEEPER_STATE_DIR: fixture.stateRoot,
        GH_COMMAND_LOG: fixture.commandLog,
        GH_RUN_PAGES_FIXTURE: fixture.pagesFile,
        GH_VARIABLES_FIXTURE: fixture.variablesFile,
        GH_RECOVERY_INPUTS_FIXTURE: fixture.recoveryInputsFile,
        ...options.env,
      },
    },
  );
}

function writeFakeGh(binDir: string) {
  const file = path.join(binDir, "gh");
  fs.writeFileSync(
    file,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$GH_COMMAND_LOG"
if [ "$1" = "variable" ] && [ "$2" = "list" ]; then
  cat "$GH_VARIABLES_FIXTURE"
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "download" ]; then
  if [ ! -f "$GH_RECOVERY_INPUTS_FIXTURE" ]; then
    echo "no artifacts found" >&2
    exit 1
  fi
  output_dir=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--dir" ]; then
      output_dir="$argument"
      break
    fi
    previous="$argument"
  done
  mkdir -p "$output_dir/recovery-inputs"
  cp "$GH_RECOVERY_INPUTS_FIXTURE" "$output_dir/recovery-inputs/workflow-inputs.json"
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *"/actions/workflows/"*"status="*)
      if [ "\${GH_ACTIVE_RUN_LIST_FAIL:-}" = "1" ]; then
        echo "active run discovery unavailable" >&2
        exit 1
      fi
      printf '[]\\n'
      exit 0
      ;;
    *"/actions/workflows/"*)
      if [ "\${GH_LIVE_RUN_LIST_FAIL:-}" = "1" ]; then
        echo "workflow run discovery unavailable" >&2
        exit 1
      fi
      page=$(printf '%s\\n' "$*" | sed -n 's/.*[?&]page=\\([0-9][0-9]*\\).*/\\1/p')
      node -e 'const fs = require("node:fs"); const pages = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(JSON.stringify(pages[process.argv[2]] ?? []) + "\\n");' "$GH_RUN_PAGES_FIXTURE" "$page"
      exit 0
      ;;
  esac
fi
echo "unsupported gh invocation: $*" >&2
exit 1
`,
  );
  fs.chmodSync(file, 0o755);
}
