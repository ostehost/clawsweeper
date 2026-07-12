import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACTION_EVENT_TYPES } from "../../dist/action-ledger.js";
import {
  deliverNotification,
  type NotificationLedgerInput,
} from "../../dist/repair/notification-action-ledger.js";
import { flushRepairActionEvents } from "../../dist/repair/repair-action-ledger.js";

for (const scenario of [
  {
    name: "accepted",
    operation: async () => "sent",
    completionReason: "mutation_observed",
    terminalType: ACTION_EVENT_TYPES.notificationSent,
  },
  {
    name: "unknown",
    operation: async () => {
      throw new Error("connection reset after delivery");
    },
    completionReason: "mutation_outcome_unknown",
    terminalType: ACTION_EVENT_TYPES.notificationFailed,
  },
] as const) {
  test(`notification delivery keeps one causal operation for ${scenario.name} outcomes`, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notification-ledger-")));
    const outputRoot = path.join(root, "output");
    fs.mkdirSync(outputRoot);
    const previous = { ...process.env };
    Object.assign(process.env, workflowEnv(root, outputRoot));
    const input: NotificationLedgerInput = {
      repository: "openclaw/clawsweeper",
      key: "notification:test:42",
      number: 42,
    };

    try {
      if (scenario.name === "accepted") {
        assert.equal(await deliverNotification(input, scenario.operation), "sent");
      } else {
        await assert.rejects(deliverNotification(input, scenario.operation), /connection reset/);
      }
      await flushRepairActionEvents();

      const events = readEvents(outputRoot);
      assert.deepEqual(
        events.map((event) => event.event_type),
        [
          ACTION_EVENT_TYPES.notificationPlanned,
          ACTION_EVENT_TYPES.repairMutation,
          ACTION_EVENT_TYPES.repairMutation,
          scenario.terminalType,
        ],
      );
      assert.equal(new Set(events.map((event) => event.operation_id)).size, 1);
      assert.deepEqual(
        events.map((event) => event.phase_seq),
        [1, 2, 3, 4],
      );
      assert.equal(events.at(-1)?.attributes?.completion_reason, scenario.completionReason);
      assert.equal(events.at(-1)?.action.mutation, true);
    } finally {
      restoreEnv(previous);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
}

function workflowEnv(root: string, outputRoot: string) {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "notification-test",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
    GITHUB_ACTION: "notify",
    GITHUB_JOB: "notification",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "5252",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "notification",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/github-activity.yml@refs/heads/main",
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
