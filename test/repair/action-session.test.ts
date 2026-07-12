import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  actionRunUrl,
  actionSessionRemoteEnabled,
  actionSessionOwner,
  actionSourceUrl,
  actionWorkKey,
  actionWorkKind,
  withActionSessionReceiptFinalization,
} from "../../dist/repair/action-session.js";

test("action session classifies issue implementation and PR repair work", () => {
  assert.equal(
    actionWorkKind({ job_intent: "implement_issue", source: "issue_implementation" }),
    "issue_to_pr",
  );
  assert.equal(actionWorkKind({ job_intent: "automerge_pr" }), "pr_repair");
  assert.equal(actionWorkKind({ job_intent: "pr_repair" }), "pr_repair");
  assert.equal(actionWorkKind({ cluster_id: "automerge-openclaw-openclaw-123" }), "pr_repair");
  assert.equal(actionWorkKind({ cluster_id: "repair-pr-openclaw-clawsweeper-290" }), "pr_repair");
  assert.equal(actionWorkKind({ job_intent: "repair_cluster" }), "repair_cluster");
});

test("action session builds stable work and run identifiers", () => {
  assert.equal(
    actionWorkKey({ repo: "openclaw/openclaw", cluster_id: "issue-openclaw-openclaw-123" }),
    "openclaw/openclaw:issue-openclaw-openclaw-123",
  );
  assert.equal(
    actionRunUrl({
      GITHUB_SERVER_URL: "https://github.example/",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ID: "456",
    }),
    "https://github.example/openclaw/clawsweeper/actions/runs/456",
  );
});

test("action session reads the configured CrabFleet owner principal", () => {
  assert.equal(actionSessionOwner({ CLAWSWEEPER_CRABFLEET_OWNER: "@steipete" }), "@steipete");
  assert.throws(
    () => actionSessionOwner({}),
    /action session requires a configured CrabFleet owner/,
  );
});

test("action session prefers the full source URL from the job body", () => {
  assert.equal(
    actionSourceUrl({
      raw: "Source issue: https://github.com/openclaw/openclaw/issues/123\n",
      frontmatter: {
        repo: "openclaw/openclaw",
        canonical: ["#456"],
      },
    } as never),
    "https://github.com/openclaw/openclaw/issues/123",
  );
});

test("action session remote behavior requires the explicit or steerable gate", () => {
  assert.equal(actionSessionRemoteEnabled({}), false);
  assert.equal(actionSessionRemoteEnabled({ CLAWSWEEPER_STEERABLE_CODEX: "1" }), true);
  assert.equal(
    actionSessionRemoteEnabled({
      CLAWSWEEPER_ACTION_SESSION_REMOTE: "0",
      CLAWSWEEPER_STEERABLE_CODEX: "1",
    }),
    false,
  );
});

test("action session finalization preserves the primary failure", async () => {
  const primary = new Error("primary session failure");
  const secondary = new Error("secondary receipt failure");
  const reports: string[] = [];

  await assert.rejects(
    withActionSessionReceiptFinalization(
      async () => {
        throw primary;
      },
      {
        flush: async () => {
          throw secondary;
        },
        report: (message) => reports.push(message),
      },
    ),
    (error) => error === primary,
  );
  assert.deepEqual(reports, [
    "[action-ledger] failed to finalize action session receipts after the primary failure: secondary receipt failure",
  ]);

  await assert.rejects(
    withActionSessionReceiptFinalization(async () => "ok", {
      flush: async () => {
        throw secondary;
      },
    }),
    (error) => error === secondary,
  );
});

test("normal repair sessions emit queue and plan receipts without CrabFleet credentials", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "action-session-local-")));
  const outputRoot = path.join(root, "output");
  const metadataPath = path.join(root, "action-session.json");
  const jobPath = path.join(root, "job.md");
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: repair-pr-42",
      "mode: execute",
      "job_intent: pr_repair",
      `expected_head_sha: ${"b".repeat(40)}`,
      "allowed_actions: [fix]",
      "candidates: [#42]",
      "---",
      "Repair pull request 42.",
      "",
    ].join("\n"),
  );
  const baseEnv = {
    ...process.env,
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
    CLAWSWEEPER_ACTION_SESSION_METADATA: metadataPath,
    CLAWSWEEPER_ACTION_SESSION_REMOTE: "0",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
    GITHUB_JOB: "cluster",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "4242",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  };

  try {
    execFileSync(
      process.execPath,
      [path.join(process.cwd(), "dist/repair/action-session.js"), "register", jobPath],
      {
        env: {
          ...baseEnv,
          GITHUB_ACTION: "register_lifecycle",
          CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "queue",
        },
      },
    );
    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "dist/repair/action-session.js"),
        "update",
        "--state",
        "running",
        "--phase",
        "planned",
        "--summary",
        "Planning completed",
      ],
      {
        env: {
          ...baseEnv,
          GITHUB_ACTION: "record_planning_completion",
          CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "plan",
        },
      },
    );

    const events = walk(outputRoot)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) =>
        fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
      .sort((left, right) => left.phase_seq - right.phase_seq);
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["repair.queue", "repair.plan"],
    );
    assert.deepEqual(
      events.map((event) => event.phase_seq),
      [1, 2],
    );
    assert.equal(events[1]?.parent_event_id, events[0]?.event_id);
    assert.ok(events.every((event) => event.subject.source_revision === "b".repeat(40)));
    assert.ok(events.every((event) => event.subject.source_revision !== baseEnv.GITHUB_SHA));
    assert.equal(
      events.some((event) => event.event_type === "session.registered"),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
