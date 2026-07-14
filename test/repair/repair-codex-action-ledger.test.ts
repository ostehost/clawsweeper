import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACTION_EVENT_TYPES } from "../../dist/action-ledger.js";
import {
  beginRepairCodexAction,
  repairCodexAttempt,
  repairCodexAttemptLabel,
} from "../../dist/repair/repair-codex-action-ledger.js";
import { flushRepairActionEvents } from "../../dist/repair/repair-action-ledger.js";

test("typed final repair Codex attempts publish lifecycle and artifact digests", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-codex-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const paths = {
    jsonl: path.join(root, "review-fix.jsonl"),
    stderr: path.join(root, "review-fix.stderr.log"),
    report: path.join(root, "review-fix.md"),
  };
  fs.writeFileSync(paths.jsonl, '{"type":"done"}\n');
  fs.writeFileSync(paths.stderr, "");
  fs.writeFileSync(paths.report, "fixed\n");

  try {
    const attempt = repairCodexAttempt(4, "final");
    assert.equal(repairCodexAttemptLabel(attempt), "4-final");
    const action = beginRepairCodexAction(
      {
        repository: "openclaw/openclaw",
        workKey: "execute-fix:test",
        sourceRevision: "b".repeat(40),
      },
      {
        action: "repair_review_fix",
        mode: "repair",
        attempt,
        paths,
      },
    );
    action.complete();
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    assert.deepEqual(
      events.map((event) => event.event_type),
      [
        ACTION_EVENT_TYPES.reviewStarted,
        ACTION_EVENT_TYPES.reviewLogPublication,
        ACTION_EVENT_TYPES.reviewLogPublication,
        ACTION_EVENT_TYPES.reviewLogPublication,
        ACTION_EVENT_TYPES.reviewCompleted,
      ],
    );
    assert.equal(events.filter((event) => event.evidence?.[0]?.sha256).length, 3);
    assert.ok(events.every((event) => event.attributes?.review_mode === "repair_review_fix"));
    assert.ok(
      events
        .filter((event) => event.event_type === ACTION_EVENT_TYPES.reviewLogPublication)
        .every(
          (event) => event.action.status === "completed" && event.attributes?.state === "prepared",
        ),
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair Codex attempt identities reject lossy numeric values", () => {
  assert.throws(() => repairCodexAttempt(Number.NaN), /positive integer/);
  assert.throws(
    () => repairCodexAttempt(1, "standard", Number.POSITIVE_INFINITY),
    /positive integer/,
  );
});

test("same-attempt repair Codex actions keep distinct operation and receipt identities", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-codex-actions-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const input = {
    repository: "openclaw/openclaw",
    workKey: "execute-fix:test",
    sourceRevision: "b".repeat(40),
  };
  const actions = [
    "repair_edit",
    "repair_base_reconcile",
    "repair_review",
    "repair_review_fix",
    "repair_validation_fix",
  ] as const;
  const receiptErrors: string[] = [];

  try {
    for (const action of actions) {
      beginRepairCodexAction(input, {
        action,
        mode: "repair",
        attempt: repairCodexAttempt(1),
        paths: {},
        report: (message) => receiptErrors.push(message),
      }).complete();
    }
    await flushRepairActionEvents();

    assert.deepEqual(receiptErrors, []);
    const events = readEvents(outputRoot);
    assert.equal(events.length, actions.length * 2);
    for (const action of actions) {
      const actionEvents = events.filter((event) => event.attributes?.review_mode === action);
      assert.deepEqual(
        actionEvents.map((event) => event.event_type),
        [ACTION_EVENT_TYPES.reviewStarted, ACTION_EVENT_TYPES.reviewCompleted],
      );
      assert.equal(new Set(actionEvents.map((event) => event.operation_id)).size, 1);
      assert.equal(new Set(actionEvents.map((event) => event.idempotency_key_sha256)).size, 1);
    }
    assert.equal(new Set(events.map((event) => event.operation_id)).size, actions.length);
    assert.equal(new Set(events.map((event) => event.idempotency_key_sha256)).size, actions.length);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function workflowEnv(root: string, outputRoot: string) {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "repair-codex-test",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
    GITHUB_ACTION: "execute_fix",
    GITHUB_JOB: "execute",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "5252",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  };
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

function restoreEnv(previous: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}
