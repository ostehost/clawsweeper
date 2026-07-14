import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const SCRIPT = join(process.cwd(), "scripts", "dispatch-receipt-owner.sh");
const EXPECTED_TITLE = "Assist openclaw/openclaw#42 [router-proof]";

function fixtureEnv(options: {
  jobs101?: unknown[];
  jobs102?: unknown[];
  runs: unknown[];
  runPages?: unknown[][];
  failJobs?: boolean;
}) {
  const binDir = mkdtempSync(join(tmpdir(), "dispatch-receipt-owner-"));
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
case "$*" in
  *actions/workflows/*) printf '%s\\n' "$FAKE_RUNS_JSON" ;;
  *actions/runs/101/jobs*)
    [ "\${FAKE_FAIL_JOBS:-0}" = 1 ] && exit 7
    printf '%s\\n' "$FAKE_JOBS_101_JSON"
    ;;
  *actions/runs/102/jobs*)
    [ "\${FAKE_FAIL_JOBS:-0}" = 1 ] && exit 7
    printf '%s\\n' "$FAKE_JOBS_102_JSON"
    ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  return {
    binDir,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      FAKE_RUNS_JSON: JSON.stringify(
        (options.runPages ?? [options.runs]).map((runs) => ({ workflow_runs: runs })),
      ),
      FAKE_JOBS_101_JSON: JSON.stringify([{ jobs: options.jobs101 ?? [] }]),
      FAKE_JOBS_102_JSON: JSON.stringify([{ jobs: options.jobs102 ?? [] }]),
      FAKE_FAIL_JOBS: options.failJobs ? "1" : "0",
    },
  };
}

function runGate(
  options: Parameters<typeof fixtureEnv>[0],
  requiredJobName = "assist",
  requiredStepName = "",
) {
  const fixture = fixtureEnv(options);
  try {
    return execFileSync(
      "bash",
      [SCRIPT, "assist.yml", EXPECTED_TITLE, "200", requiredJobName, requiredStepName],
      {
        encoding: "utf8",
        env: fixture.env,
      },
    ).trim();
  } finally {
    rmSync(fixture.binDir, { recursive: true, force: true });
  }
}

test("dispatch receipt gate keeps an older active run as owner", () => {
  assert.equal(
    runGate({
      runs: [{ id: 101, display_title: EXPECTED_TITLE, status: "in_progress" }],
    }),
    "owner",
  );
});

test("dispatch receipt gate allows retry after failed owner and receipt-only success", () => {
  for (const requiredJobName of ["assist", "Plan and review cluster"]) {
    assert.equal(
      runGate(
        {
          runs: [
            { id: 101, display_title: EXPECTED_TITLE, status: "completed", conclusion: "failure" },
            { id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "success" },
          ],
          jobs102: [
            { name: "Deduplicate command dispatch receipt", conclusion: "success" },
            { name: requiredJobName, conclusion: "skipped" },
          ],
        },
        requiredJobName,
      ),
      "none",
    );
  }
});

test("dispatch receipt gate keeps a successfully executed worker as owner", () => {
  assert.equal(
    runGate({
      runs: [
        { id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "success" },
      ],
      jobs102: [{ name: "assist", conclusion: "success" }],
    }),
    "owner",
  );
});

test("dispatch receipt gate retries assist when comment publication fails", () => {
  assert.equal(
    runGate(
      {
        runs: [
          { id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "failure" },
        ],
        jobs102: [
          {
            name: "Publish trusted assist comment",
            conclusion: "failure",
            steps: [{ name: "Revalidate and publish assist comment", conclusion: "failure" }],
          },
        ],
      },
      "Publish trusted assist comment",
      "Revalidate and publish assist comment",
    ),
    "none",
  );
});

test("dispatch receipt gate retains assist ownership after comment publication", () => {
  assert.equal(
    runGate(
      {
        runs: [
          { id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "failure" },
        ],
        jobs102: [
          {
            name: "Publish trusted assist comment",
            conclusion: "failure",
            steps: [
              { name: "Revalidate and publish assist comment", conclusion: "success" },
              { name: "Finalize assist publication action ledger", conclusion: "failure" },
            ],
          },
        ],
      },
      "Publish trusted assist comment",
      "Revalidate and publish assist comment",
    ),
    "owner",
  );
});

test("dispatch receipt gate retains ownership when later finalization fails", () => {
  assert.equal(
    runGate(
      {
        runs: [
          { id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "failure" },
        ],
        jobs102: [
          {
            name: "Intake commit finding",
            conclusion: "failure",
            steps: [
              { name: "Dispatch sealed repair worker", conclusion: "success" },
              { name: "Finalize commit finding intake action ledger", conclusion: "failure" },
            ],
          },
        ],
      },
      "Intake commit finding",
      "Dispatch sealed repair worker",
    ),
    "owner",
  );
});

test("dispatch receipt gate retains ownership from an earlier successful job attempt", () => {
  assert.match(readFileSync(SCRIPT, "utf8"), /jobs\?filter=all&per_page=100/);
  assert.equal(
    runGate(
      {
        runs: [
          { id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "failure" },
        ],
        jobs102: [
          {
            name: "Intake commit finding",
            run_attempt: 2,
            conclusion: "failure",
            steps: [{ name: "Dispatch sealed repair worker", conclusion: "skipped" }],
          },
          {
            name: "Intake commit finding",
            run_attempt: 1,
            conclusion: "failure",
            steps: [{ name: "Dispatch sealed repair worker", conclusion: "success" }],
          },
        ],
      },
      "Intake commit finding",
      "Dispatch sealed repair worker",
    ),
    "owner",
  );
});

test("dispatch receipt gate finds successful owners beyond the first run page", () => {
  assert.equal(
    runGate({
      runs: [],
      runPages: [
        Array.from({ length: 100 }, (_, index) => ({
          id: 1000 + index,
          display_title: `unrelated-${index}`,
          status: "completed",
          conclusion: "success",
        })),
        [
          {
            id: 102,
            display_title: EXPECTED_TITLE,
            status: "completed",
            conclusion: "success",
          },
        ],
      ],
      jobs102: [{ name: "assist", conclusion: "success" }],
    }),
    "owner",
  );
});

test("dispatch receipt gate fails closed when worker job verification fails", () => {
  const fixture = fixtureEnv({
    runs: [{ id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "success" }],
    failJobs: true,
  });
  try {
    const result = spawnSync("bash", [SCRIPT, "assist.yml", EXPECTED_TITLE, "200", "assist"], {
      encoding: "utf8",
      env: fixture.env,
    });
    assert.equal(result.status, 7);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(fixture.binDir, { recursive: true, force: true });
  }
});
