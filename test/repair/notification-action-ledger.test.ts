import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACTION_EVENT_TYPES } from "../../dist/action-ledger.js";
import { OpenClawHookHttpError, postOpenClawAgentHook } from "../../dist/repair/openclaw-hook.js";
import {
  deliverNotification,
  deliverNotificationAttempt,
  deliverRetriedNotification,
  recordNotificationPhase,
  recordNotificationPhaseSafely,
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
    name: "rejected",
    operation: async () => {
      throw new OpenClawHookHttpError(422, "invalid request");
    },
    error: /OpenClaw hook returned 422/,
    completionReason: "mutation_rejected",
    requestState: "mutation_rejected",
    retryable: false,
    mutation: false,
    terminalType: ACTION_EVENT_TYPES.notificationFailed,
  },
  {
    name: "unknown",
    operation: async () => {
      throw new Error("connection reset after delivery");
    },
    error: /connection reset/,
    completionReason: "mutation_outcome_unknown",
    requestState: "mutation_unknown",
    retryable: true,
    mutation: true,
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
        await assert.rejects(deliverNotification(input, scenario.operation), scenario.error);
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
      assert.equal(events.at(-1)?.action.mutation, scenario.mutation ?? true);
      assert.equal(events.at(-1)?.action.retryable, scenario.retryable ?? false);
      if (scenario.requestState) {
        assert.equal(events[2]?.attributes?.state, scenario.requestState);
      }
      assert.equal(events[1]?.idempotency_key_sha256, events[2]?.idempotency_key_sha256);
      assert.equal(events[2]?.idempotency_key_sha256, events.at(-1)?.idempotency_key_sha256);
    } finally {
      restoreEnv(previous);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
}

test("hook and status dashboard deliveries keep separate exact attempt outcomes", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notification-targets-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const input: NotificationLedgerInput = {
    repository: "openclaw/clawsweeper",
    key: "notification:test:dashboard",
    number: 43,
  };

  try {
    await deliverNotificationAttempt(input, {
      kind: "notification_delivery",
      destination: "openclaw_hook",
      operation: async () => "hook-accepted",
    });
    await assert.rejects(
      deliverNotificationAttempt(input, {
        kind: "status_dashboard_delivery",
        destination: "status_dashboard",
        operation: async () => {
          throw new Error("dashboard rejected request");
        },
        knownNoMutation: () => true,
      }),
      /dashboard rejected/,
    );
    await assert.rejects(
      deliverNotificationAttempt(input, {
        kind: "status_dashboard_delivery",
        destination: "status_dashboard",
        operation: async () => {
          throw new Error("dashboard outcome unknown");
        },
      }),
      /dashboard outcome unknown/,
    );
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    assert.deepEqual(
      events.map((event) => event.attributes?.state),
      [
        "mutation_attempted",
        "mutation_accepted",
        "mutation_attempted",
        "mutation_rejected",
        "mutation_attempted",
        "mutation_unknown",
      ],
    );
    assert.deepEqual(
      events.map((event) => event.action.mutation),
      [false, true, false, false, false, true],
    );
    const idempotencyKeys = events.map((event) => event.idempotency_key_sha256);
    assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
    assert.equal(idempotencyKeys[2], idempotencyKeys[3]);
    assert.equal(idempotencyKeys[2], idempotencyKeys[4]);
    assert.equal(idempotencyKeys[4], idempotencyKeys[5]);
    assert.notEqual(idempotencyKeys[0], idempotencyKeys[2]);
    assert.notEqual(events[2]?.event_id, events[4]?.event_id);
    assert.equal(events[5]?.action.retryable, true);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("terminal dashboard failures retain the dashboard delivery identity", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notification-terminal-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const input: NotificationLedgerInput = {
    repository: "openclaw/clawsweeper",
    key: "notification:test:terminal-dashboard",
    number: 45,
  };

  try {
    await deliverNotificationAttempt(input, {
      kind: "notification_delivery",
      destination: "openclaw_hook",
      operation: async () => "hook-accepted",
    });
    await assert.rejects(
      deliverNotificationAttempt(input, {
        kind: "status_dashboard_delivery",
        destination: "status_dashboard",
        operation: async () => {
          throw new Error("dashboard outcome unknown");
        },
      }),
      /dashboard outcome unknown/,
    );
    recordNotificationPhase(input, "failed", "dashboard", "mutation_outcome_unknown", {
      kind: "status_dashboard_delivery",
      destination: "status_dashboard",
    });
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    const hookAccepted = events.find((event) => event.attributes?.state === "mutation_accepted");
    const dashboardUnknown = events.find((event) => event.attributes?.state === "mutation_unknown");
    const terminal = events.find(
      (event) => event.event_type === ACTION_EVENT_TYPES.notificationFailed,
    );
    assert.equal(terminal?.idempotency_key_sha256, dashboardUnknown?.idempotency_key_sha256);
    assert.notEqual(terminal?.idempotency_key_sha256, hookAccepted?.idempotency_key_sha256);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("retrying hook delivery records every wire request as its own attempt", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notification-retries-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const input: NotificationLedgerInput = {
    repository: "openclaw/clawsweeper",
    key: "notification:test:retries",
    number: 44,
  };
  let requests = 0;

  try {
    const result = await deliverRetriedNotification(input, (attemptRunner) =>
      postOpenClawAgentHook({
        config: {
          hookUrl: "https://claw.example/hooks/agent",
          token: "secret",
          agentId: "clawsweeper",
          channel: "discord",
          discordTarget: "channel:123",
          thinking: "low",
          timeoutSeconds: 1,
          retryAttempts: 3,
        },
        fetcher: async () => {
          requests += 1;
          if (requests === 1) return new Response("bad gateway", { status: 502 });
          if (requests === 2) throw new Error("read ECONNRESET");
          return Response.json({ runId: "hook-run-3" });
        },
        post: {
          name: "Retry test",
          message: "hello",
          idempotencyKey: input.key,
          deliver: true,
        },
        attemptRunner,
        retryDelaysMs: [0, 0],
      }),
    );
    assert.equal(result.runId, "hook-run-3");
    assert.equal(requests, 3);
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    assert.deepEqual(
      events.map((event) => event.attributes?.state),
      [
        "planned",
        "mutation_attempted",
        "mutation_unknown",
        "mutation_attempted",
        "mutation_unknown",
        "mutation_attempted",
        "mutation_accepted",
        "sent",
      ],
    );
    const attempts = events.filter((event) => event.attributes?.state === "mutation_attempted");
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map((event) => event.event_id)).size, 3);
    assert.equal(new Set(events.slice(1).map((event) => event.idempotency_key_sha256)).size, 1);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("retried delivery remains unknown after an ambiguous attempt precedes rejection", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "notification-ambiguous-retry-")),
  );
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const input: NotificationLedgerInput = {
    repository: "openclaw/clawsweeper",
    key: "notification:test:ambiguous-retry",
    number: 47,
  };

  try {
    await assert.rejects(
      deliverRetriedNotification(input, async (attemptRunner) => {
        await assert.rejects(
          attemptRunner(async () => {
            throw new Error("connection reset after delivery");
          }),
          /connection reset/,
        );
        return attemptRunner(async () => {
          throw new OpenClawHookHttpError(422, "invalid request");
        });
      }),
      /OpenClaw hook returned 422/,
    );
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    assert.deepEqual(
      events
        .filter((event) => event.event_type === ACTION_EVENT_TYPES.repairMutation)
        .map((event) => event.attributes?.completion_reason),
      ["mutation_attempted", "mutation_outcome_unknown", "mutation_attempted", "mutation_rejected"],
    );
    const terminal = events.find(
      (event) => event.event_type === ACTION_EVENT_TYPES.notificationFailed,
    );
    assert.equal(terminal?.attributes?.completion_reason, "mutation_outcome_unknown");
    assert.equal(terminal?.action.mutation, true);
    assert.equal(terminal?.action.retryable, true);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("all shared OpenClaw notification callers use per-wire attempt runners", () => {
  for (const file of [
    "src/repair/notify-events.ts",
    "src/repair/notify-github-activity.ts",
    "src/repair/notify-maintainer-report.ts",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /postOpenClawAgentHook\(\{[\s\S]*?attemptRunner[\s\S]*?\}\)/);
  }
});

test("accepted notification delivery is not reversed by a terminal receipt failure", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notification-receipt-")));
  const invalidLedgerRoot = path.join(root, "not-a-directory");
  fs.writeFileSync(invalidLedgerRoot, "occupied");
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(invalidLedgerRoot, path.join(root, "output")));
  const reports: string[] = [];

  try {
    assert.doesNotThrow(() =>
      recordNotificationPhaseSafely(
        {
          repository: "openclaw/clawsweeper",
          key: "notification:test:receipt-failure",
          number: 46,
        },
        "sent",
        "sent",
        "mutation_outcome_unknown",
        { kind: "notification_delivery", destination: "openclaw_hook" },
        (message) => reports.push(message),
      ),
    );
    assert.equal(reports.length, 1);
    assert.match(reports[0], /failed to record notification sent/);

    const ledgerSource = fs.readFileSync("src/repair/notification-action-ledger.ts", "utf8");
    const notifierSource = fs.readFileSync("src/repair/notify-events.ts", "utf8");
    assert.doesNotMatch(ledgerSource, /recordNotificationPhase\(input, "sent"\)/);
    assert.doesNotMatch(notifierSource, /recordNotificationPhase\(ledgerInput, "sent"\)/);
    assert.equal(
      (ledgerSource.match(/recordNotificationPhaseSafely\(input, "sent"\)/g) ?? []).length,
      2,
    );
    assert.match(notifierSource, /recordNotificationPhaseSafely\(ledgerInput, "sent"\)/);
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
