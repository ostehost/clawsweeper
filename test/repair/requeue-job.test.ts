import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    const jobPath = path.join(temp, "job.md");
    const headSha = spawnSync("git", ["rev-parse", "origin/main"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim();

    fs.writeFileSync(statePath, JSON.stringify({ CLAWSWEEPER_ALLOW_FIX_PR: "" }));
    fs.writeFileSync(
      jobPath,
      [
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
      ].join("\n"),
    );
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
        jobPath,
        "--source-job-path",
        "jobs/openclaw-example/inbox/requeue-gate-test.md",
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
