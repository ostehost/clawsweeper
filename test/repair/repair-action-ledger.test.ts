import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../../dist/action-ledger.js";
import {
  flushRepairActionEvents,
  recordRepairLifecycleEvent,
  recordRepairLifecycleFailureSafely,
  recordRepairMutationObservedSafely,
  recordRepairWorkflowEvent,
  repairHttpMutationOutcome,
  repairMutationIdempotencyIdentity,
  repairSourceRevision,
  repairWorkflowTerminalPhase,
  recoverRepairMutationOutcomes,
  runRepairMutation,
  runRepairMutationAsync,
} from "../../dist/repair/repair-action-ledger.js";
import {
  finalizeRepairActionLedgerManifest,
  serializeRepairActionLedgerManifest,
} from "../../dist/repair/repair-action-ledger-manifest.js";

test("repair receipts preserve operation and mutation identity across workflow retries", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    recordRepairAttempt();
    await flushRepairActionEvents();

    process.env.GITHUB_RUN_ATTEMPT = "2";
    process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION = "retry";
    recordRepairAttempt();
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    const attempts = Map.groupBy(events, (event) => String(event.attempt_id));
    assert.equal(attempts.size, 2);
    assert.equal(new Set(events.map((event) => event.operation_id)).size, 1);

    for (const attemptEvents of attempts.values()) {
      const ordered = [...attemptEvents].sort((left, right) => left.phase_seq - right.phase_seq);
      assert.deepEqual(
        ordered.map((event) => event.phase_seq),
        [1, 2, 3],
      );
      assert.equal(ordered[0]?.parent_event_id, null);
      assert.equal(ordered[1]?.parent_event_id, ordered[0]?.event_id);
      assert.equal(ordered[2]?.parent_event_id, ordered[1]?.event_id);
    }

    const executions = events.filter(
      (event) => event.event_type === ACTION_EVENT_TYPES.repairExecute,
    );
    assert.equal(executions.length, 2);
    assert.equal(executions[0]?.idempotency_key_sha256, executions[1]?.idempotency_key_sha256);
    assert.notEqual(executions[0]?.attempt_id, executions[1]?.attempt_id);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair mutation receipts keep stable business identity and distinct request attempts", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-mutation-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = repairLifecycle();

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal(
        runRepairMutation(lifecycle, {
          kind: "branch_push",
          identity: { repo: "openclaw/openclaw", ref: "refs/heads/fix", sha: "a".repeat(40) },
          operation: () => "ok",
        }),
        "ok",
      );
    }
    await flushRepairActionEvents();

    const mutations = readEvents(outputRoot).filter(
      (event) => event.event_type === ACTION_EVENT_TYPES.repairMutation,
    );
    assert.deepEqual(
      mutations.map((event) => event.action.status),
      ["started", "executed", "started", "executed"],
    );
    assert.equal(new Set(mutations.map((event) => event.idempotency_key_sha256)).size, 1);
    assert.equal(new Set(mutations.map((event) => event.event_id)).size, 4);
    assert.deepEqual(
      mutations.map((event) => event.phase_seq),
      [1, 2, 3, 4],
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair mutation uncertainty survives later workflow failure", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-unknown-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = repairLifecycle();

  try {
    assert.throws(
      () =>
        runRepairMutation(lifecycle, {
          kind: "pull_request_create",
          identity: { repo: "openclaw/openclaw", branch: "fix" },
          operation: () => {
            throw new Error("connection reset after request");
          },
        }),
      /connection reset/,
    );
    recordRepairLifecycleFailureSafely(lifecycle, {
      component: "repair_worker",
      error: new Error("later verification failed"),
    });
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    const outcome = events.find(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.repairMutation &&
        event.attributes?.completion_reason === "mutation_outcome_unknown",
    );
    const failure = events.find((event) => event.event_type === ACTION_EVENT_TYPES.repairFailed);
    assert.equal(outcome?.action.mutation, true);
    assert.equal(outcome?.action.retryable, true);
    assert.equal(failure?.action.mutation, true);
    assert.equal(failure?.action.retryable, true);
    assert.equal(failure?.attributes?.completion_reason, "mutation_outcome_unknown");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("observed repair mutations resolve matching unknown outcomes", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-observed-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = repairLifecycle();
  const identity = {
    repo: "openclaw/openclaw",
    number: 123,
    headSha: "a".repeat(40),
    method: "squash",
  };

  try {
    assert.equal(
      runRepairMutation(lifecycle, {
        kind: "post_flight_merge",
        identity,
        operation: () => "queued",
        outcome: () => "unknown",
      }),
      "queued",
    );
    recordRepairMutationObservedSafely(lifecycle, {
      kind: "post_flight_merge",
      identity,
    });
    recordRepairLifecycleFailureSafely(lifecycle, {
      component: "post_flight",
      error: new Error("later reporting failed"),
    });
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    assert.deepEqual(
      events
        .filter((event) => event.event_type === ACTION_EVENT_TYPES.repairMutation)
        .map((event) => event.attributes?.completion_reason),
      ["mutation_attempted", "mutation_outcome_unknown", "mutation_observed"],
    );
    const failure = events.find((event) => event.event_type === ACTION_EVENT_TYPES.repairFailed);
    assert.equal(failure?.attributes?.completion_reason, "mutation_observed");
    assert.equal(failure?.action.mutation, true);
    assert.equal(failure?.action.retryable, false);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("observed repair mutation retries resolve the latest unknown request attempt", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-observed-retry-ledger-")),
  );
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = repairLifecycle();
  const identity = {
    repo: "openclaw/openclaw",
    number: 123,
    headSha: "a".repeat(40),
    method: "squash",
  };

  try {
    for (const result of ["first", "retry"]) {
      assert.equal(
        runRepairMutation(lifecycle, {
          kind: "post_flight_merge",
          identity,
          operation: () => result,
          outcome: () => "unknown",
        }),
        result,
      );
      recordRepairMutationObservedSafely(lifecycle, {
        kind: "post_flight_merge",
        identity,
      });
    }
    recordRepairLifecycleFailureSafely(lifecycle, {
      component: "post_flight",
      error: new Error("later reporting failed"),
    });
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    const mutations = events.filter(
      (event) => event.event_type === ACTION_EVENT_TYPES.repairMutation,
    );
    assert.deepEqual(
      mutations.map((event) => event.attributes?.completion_reason),
      [
        "mutation_attempted",
        "mutation_outcome_unknown",
        "mutation_observed",
        "mutation_attempted",
        "mutation_outcome_unknown",
        "mutation_observed",
      ],
    );
    assert.equal(
      new Set(
        mutations
          .filter((event) => event.attributes?.completion_reason === "mutation_observed")
          .map((event) => event.event_id),
      ).size,
      2,
    );
    const failure = events.find((event) => event.event_type === ACTION_EVENT_TYPES.repairFailed);
    assert.equal(failure?.attributes?.completion_reason, "mutation_observed");
    assert.equal(failure?.action.mutation, true);
    assert.equal(failure?.action.retryable, false);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("accepted repair retries do not erase prior unknown outcomes", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-retry-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = repairLifecycle();
  const identity = {
    repo: "openclaw/openclaw",
    number: 123,
    headSha: "a".repeat(40),
    method: "squash",
  };

  try {
    assert.equal(
      runRepairMutation(lifecycle, {
        kind: "post_flight_merge",
        identity,
        operation: () => "uncertain",
        outcome: () => "unknown",
      }),
      "uncertain",
    );
    assert.equal(
      runRepairMutation(lifecycle, {
        kind: "post_flight_merge",
        identity,
        operation: () => "accepted",
      }),
      "accepted",
    );
    recordRepairLifecycleFailureSafely(lifecycle, {
      component: "post_flight",
      error: new Error("later reporting failed"),
    });
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    assert.deepEqual(
      events
        .filter((event) => event.event_type === ACTION_EVENT_TYPES.repairMutation)
        .map((event) => event.attributes?.completion_reason),
      ["mutation_attempted", "mutation_outcome_unknown", "mutation_attempted", "mutation_accepted"],
    );
    const failure = events.find((event) => event.event_type === ACTION_EVENT_TYPES.repairFailed);
    assert.equal(failure?.attributes?.completion_reason, "mutation_outcome_unknown");
    assert.equal(failure?.action.mutation, true);
    assert.equal(failure?.action.retryable, true);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("async mutation receipts preserve their workflow context across environment drift", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-local-receipt-failure-")),
  );
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    assert.equal(
      await runRepairMutationAsync(repairLifecycle(), {
        kind: "branch_push",
        identity: { repo: "openclaw/openclaw", ref: "refs/heads/fix", sha: "a".repeat(40) },
        operation: async () => {
          process.env.GITHUB_REPOSITORY = "not a repository";
          return "accepted";
        },
      }),
      "accepted",
    );

    process.env.GITHUB_REPOSITORY = "openclaw/clawsweeper";
    await flushRepairActionEvents();
    const events = readEvents(outputRoot);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.attributes?.completion_reason, "mutation_attempted");
    assert.equal(events[1]?.attributes?.completion_reason, "mutation_accepted");
    assert.equal(
      events.some((event) => event.attributes?.completion_reason === "mutation_outcome_unknown"),
      false,
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test(
  "successful sync repair mutations defer receipt failures and recover only exact terminal identities",
  { skip: process.platform === "win32" ? "requires POSIX directory permissions" : false },
  async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "repair-successful-deferred-receipt-")),
    );
    const outputRoot = path.join(root, "output");
    fs.mkdirSync(outputRoot);
    const previous = { ...process.env };
    const originalConsoleError = console.error;
    const receiptErrors: string[] = [];
    Object.assign(process.env, workflowEnv(root, outputRoot));
    const lifecycle = repairLifecycle();
    const kind = "branch_push";
    const identity = {
      repo: "openclaw/openclaw",
      ref: "refs/heads/fix",
      sha: "a".repeat(40),
    };
    const idempotencyIdentity = repairMutationIdempotencyIdentity(lifecycle, {
      kind,
      identity,
    });
    let spoolDirectory = "";

    try {
      console.error = (message?: unknown) => receiptErrors.push(String(message));
      assert.equal(
        runRepairMutation(lifecycle, {
          kind,
          identity,
          operation: () => {
            const spoolFile = actionEventSpoolFile(root, outputRoot);
            assert.ok(spoolFile);
            spoolDirectory = path.dirname(spoolFile);
            fs.chmodSync(spoolDirectory, 0o500);
            return "accepted";
          },
        }),
        "accepted",
      );
      assert.match(
        receiptErrors.join("\n"),
        /after the successful operation; deferred for recovery/,
      );

      fs.chmodSync(spoolDirectory, 0o700);
      const attemptFile = actionEventSpoolFile(root, outputRoot);
      assert.ok(attemptFile);
      const attempt = JSON.parse(fs.readFileSync(attemptFile, "utf8"));

      recordRepairLifecycleEvent(lifecycle, {
        type: ACTION_EVENT_TYPES.repairMutation,
        status: ACTION_EVENT_STATUSES.started,
        reasonCode: ACTION_EVENT_REASON_CODES.selected,
        mutation: false,
        retryable: true,
        component: "repair_mutation",
        operation: "repair",
        parentEventId: attempt.event_id,
        state: "mutation_attempted",
        completionReason: "mutation_attempted",
        eventIdentity: { kind, requestAttempt: 99, outcome: "attempted" },
        idempotencyIdentity,
      });
      recordRepairLifecycleEvent(lifecycle, {
        type: ACTION_EVENT_TYPES.repairMutation,
        status: ACTION_EVENT_STATUSES.executed,
        reasonCode: ACTION_EVENT_REASON_CODES.completed,
        mutation: true,
        component: "repair_mutation",
        operation: "repair",
        parentEventId: attempt.event_id,
        state: "mutation_accepted",
        completionReason: "mutation_accepted",
        eventIdentity: { kind: "foreign_branch_push", requestAttempt: 1, outcome: "accepted" },
        idempotencyIdentity: { mutation: "foreign_branch_push", request: "other" },
      });
      recordRepairLifecycleEvent(lifecycle, {
        type: ACTION_EVENT_TYPES.repairMutation,
        status: ACTION_EVENT_STATUSES.failed,
        reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
        mutation: true,
        retryable: true,
        component: "repair_mutation",
        operation: "repair",
        parentEventId: attempt.event_id,
        state: "mutation_unknown",
        completionReason: "mutation_outcome_unknown",
        eventIdentity: { kind, requestAttempt: 1, outcome: "unknown" },
        idempotencyIdentity,
      });

      recoverRepairMutationOutcomes();
      await flushRepairActionEvents();

      const events = readEvents(outputRoot);
      const exactTerminal = events.filter(
        (event) =>
          event.parent_event_id === attempt.event_id &&
          event.idempotency_key_sha256 === attempt.idempotency_key_sha256 &&
          event.attributes?.completion_reason === "mutation_accepted",
      );
      assert.equal(exactTerminal.length, 1);
      assert.equal(exactTerminal[0]?.action.status, ACTION_EVENT_STATUSES.executed);
      assert.equal(
        events.filter(
          (event) =>
            event.parent_event_id === attempt.event_id &&
            event.idempotency_key_sha256 === attempt.idempotency_key_sha256 &&
            event.attributes?.completion_reason === "mutation_outcome_unknown",
        ).length,
        1,
      );
      assert.equal(
        walk(outputRoot).some((file) =>
          file.includes(`${path.sep}.mutation-recovery${path.sep}repair${path.sep}`),
        ),
        false,
      );
    } finally {
      if (spoolDirectory) fs.chmodSync(spoolDirectory, 0o700);
      console.error = originalConsoleError;
      restoreEnv(previous);
      fs.rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "repair receipt recovery survives a fresh finalizer process",
  { skip: process.platform === "win32" ? "requires POSIX directory permissions" : false },
  () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "repair-deferred-receipt-")),
    );
    const outputRoot = path.join(root, "output");
    fs.mkdirSync(outputRoot);
    const previous = { ...process.env };
    Object.assign(process.env, workflowEnv(root, outputRoot));
    let spoolDirectory = "";

    try {
      const repairModule = pathToFileURL(
        path.join(process.cwd(), "dist", "repair", "repair-action-ledger.js"),
      ).href;
      const lifecycle = repairLifecycle();
      const mutation = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import fs from "node:fs";
            import path from "node:path";
            const { runRepairMutationAsync } = await import(${JSON.stringify(repairModule)});
            const root = ${JSON.stringify(root)};
            const outputRoot = ${JSON.stringify(outputRoot)};
            const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
              const target = path.join(directory, entry.name);
              return entry.isDirectory() ? walk(target) : [target];
            });
            const result = await runRepairMutationAsync(${JSON.stringify(lifecycle)}, {
              kind: "branch_push",
              identity: {
                repo: "openclaw/openclaw",
                ref: "refs/heads/fix",
                sha: ${JSON.stringify("b".repeat(40))},
              },
              operation: async () => {
                const outputPrefix = path.resolve(outputRoot) + path.sep;
                const spoolFile = walk(root).find(
                  (file) => file.endsWith(".json") && !path.resolve(file).startsWith(outputPrefix),
                );
                if (!spoolFile) throw new Error("missing repair action spool");
                fs.chmodSync(path.dirname(spoolFile), 0o500);
                return "accepted";
              },
            });
            process.stdout.write(result);
          `,
        ],
        { cwd: process.cwd(), encoding: "utf8", env: { ...process.env } },
      );
      assert.equal(mutation.status, 0, mutation.stderr);
      assert.equal(mutation.stdout, "accepted");
      assert.match(
        mutation.stderr,
        /after the successful operation; deferred for recovery.*(?:EACCES|EPERM|permission)/is,
      );

      const spoolFile = actionEventSpoolFile(root, outputRoot);
      assert.ok(spoolFile);
      spoolDirectory = path.dirname(spoolFile);
      fs.chmodSync(spoolDirectory, 0o700);
      assert.ok(
        walk(outputRoot).some((file) =>
          file.includes(`${path.sep}.mutation-recovery${path.sep}repair${path.sep}`),
        ),
      );

      const finalizer = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            const { flushRepairActionEvents } = await import(${JSON.stringify(repairModule)});
            await flushRepairActionEvents();
          `,
        ],
        { cwd: process.cwd(), encoding: "utf8", env: { ...process.env } },
      );
      assert.equal(finalizer.status, 0, finalizer.stderr);

      const events = readEvents(outputRoot);
      assert.deepEqual(
        events.map((event) => event.attributes?.completion_reason),
        ["mutation_attempted", "mutation_accepted"],
      );
      assert.equal(events[1]?.parent_event_id, events[0]?.event_id);
      assert.equal(
        walk(outputRoot).some((file) => file.endsWith(".json")),
        false,
      );
    } finally {
      if (spoolDirectory) fs.chmodSync(spoolDirectory, 0o700);
      restoreEnv(previous);
      fs.rmSync(root, { force: true, recursive: true });
    }
  },
);

test("repair failure mutation truth is scoped to the supplied operation", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-operation-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = repairLifecycle();

  try {
    runRepairMutation(lifecycle, {
      kind: "issue_status_comment_update",
      identity: { repo: "openclaw/openclaw", number: 42 },
      operationName: "status",
      operation: () => "accepted",
    });
    recordRepairLifecycleFailureSafely(lifecycle, {
      component: "issue_implementation_status",
      operation: "dashboard",
      error: new Error("dashboard failed before request"),
    });
    await flushRepairActionEvents();

    const failure = readEvents(outputRoot).find(
      (event) => event.event_type === ACTION_EVENT_TYPES.repairFailed,
    );
    assert.equal(failure?.action.mutation, false);
    assert.equal(failure?.action.retryable, false);
    assert.equal(failure?.attributes?.completion_reason, "failed");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair finalization turns interrupted request boundaries into unknown outcomes", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-interrupted-ledger-")),
  );
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = repairLifecycle();

  try {
    recordRepairLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.repairMutation,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      mutation: false,
      retryable: true,
      component: "repair_worker",
      state: "mutation_attempted",
      completionReason: "mutation_attempted",
      eventIdentity: { kind: "branch_push", requestAttempt: 1, outcome: "attempted" },
      idempotencyIdentity: { mutation: "branch_push", request: "stable" },
    });
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.event_type, ACTION_EVENT_TYPES.repairMutation);
    assert.equal(events[1]?.action.status, ACTION_EVENT_STATUSES.failed);
    assert.equal(events[1]?.action.mutation, true);
    assert.equal(events[1]?.attributes?.completion_reason, "mutation_outcome_unknown");
    assert.equal(events[1]?.phase_seq, events[0]!.phase_seq + 1);
    assert.equal(events[1]?.parent_event_id, events[0]?.event_id);
    assert.equal(events[1]?.idempotency_key_sha256, events[0]?.idempotency_key_sha256);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair receipts reconstruct one causal chain across workflow processes and retry safely", async () => {
  const queueRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-queue-")),
  );
  const planRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-plan-")),
  );
  const retryRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-retry-")),
  );
  const queueOutput = path.join(queueRoot, "output");
  const planOutput = path.join(planRoot, "output");
  const retryOutput = path.join(retryRoot, "output");
  for (const output of [queueOutput, planOutput, retryOutput]) fs.mkdirSync(output);
  const previous = { ...process.env };
  const lifecycle = {
    repository: "openclaw/openclaw",
    workKey: "openclaw/openclaw:repair-pr-42",
    clusterId: "repair-pr-42",
    number: 42,
    sourceRevision: "source-head-42",
  };

  try {
    Object.assign(process.env, workflowEnv(queueRoot, queueOutput), {
      GITHUB_ACTION: "register_lifecycle",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "queue",
    });
    recordRepairLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.repairQueue,
      status: ACTION_EVENT_STATUSES.queued,
      reasonCode: ACTION_EVENT_REASON_CODES.accepted,
      mutation: false,
      component: "action_session",
      state: "queued",
      phase: "queue",
    });
    await flushRepairActionEvents();
    await writeCausalManifest(queueOutput);
    const queue = readEvents(queueOutput)[0]!;

    Object.assign(process.env, workflowEnv(planRoot, planOutput), {
      GITHUB_ACTION: "record_planning_completion",
      CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS: [queueOutput, queueOutput].join(path.delimiter),
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "plan",
    });
    assert.throws(
      () =>
        recordRepairLifecycleEvent(lifecycle, {
          type: ACTION_EVENT_TYPES.repairPlan,
          status: ACTION_EVENT_STATUSES.completed,
          reasonCode: ACTION_EVENT_REASON_CODES.completed,
          mutation: false,
          component: "action_session",
          state: "planned",
          phase: "planned",
        }),
      /duplicate event/,
    );
    process.env.CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS = queueOutput;
    recordRepairLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.repairPlan,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      mutation: false,
      component: "action_session",
      state: "planned",
      phase: "planned",
    });
    await flushRepairActionEvents();
    await writeCausalManifest(planOutput);
    const plan = readEvents(planOutput)[0]!;

    assert.equal(plan.operation_id, queue.operation_id);
    assert.equal(plan.attempt_id, queue.attempt_id);
    assert.equal(queue.phase_seq, 1);
    assert.equal(plan.phase_seq, 2);
    assert.equal(plan.parent_event_id, queue.event_id);

    recordRepairLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.repairPlan,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      mutation: false,
      component: "action_session",
      state: "planned",
      phase: "planned",
    });
    await flushRepairActionEvents();
    assert.equal(readEvents(planOutput).length, 1);

    Object.assign(process.env, workflowEnv(retryRoot, retryOutput), {
      GITHUB_ACTION: "register_lifecycle_retry",
      GITHUB_RUN_ATTEMPT: "2",
      CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS: [queueOutput, planOutput].join(path.delimiter),
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "retry",
    });
    recordRepairLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.repairQueue,
      status: ACTION_EVENT_STATUSES.queued,
      reasonCode: ACTION_EVENT_REASON_CODES.accepted,
      mutation: false,
      component: "action_session",
      state: "queued",
      phase: "queue",
    });
    await flushRepairActionEvents();
    const retry = readEvents(retryOutput)[0]!;
    assert.equal(retry.operation_id, queue.operation_id);
    assert.notEqual(retry.attempt_id, queue.attempt_id);
    assert.equal(retry.phase_seq, 1);
    assert.equal(retry.parent_event_id, null);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    for (const root of [queueRoot, planRoot, retryRoot]) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  }
});

test("repair causal context rejects noncanonical shard paths before sequencing", async () => {
  const queueRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-canonical-")),
  );
  const nextRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-next-")),
  );
  const queueOutput = path.join(queueRoot, "output");
  const nextOutput = path.join(nextRoot, "output");
  fs.mkdirSync(queueOutput);
  fs.mkdirSync(nextOutput);
  const previous = { ...process.env };
  const lifecycle = {
    repository: "openclaw/openclaw",
    workKey: "openclaw/openclaw:repair-pr-42",
    clusterId: "repair-pr-42",
    number: 42,
    sourceRevision: "source-head-42",
  };

  try {
    Object.assign(process.env, workflowEnv(queueRoot, queueOutput));
    recordRepairLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.repairQueue,
      status: ACTION_EVENT_STATUSES.queued,
      reasonCode: ACTION_EVENT_REASON_CODES.accepted,
      mutation: false,
      component: "action_session",
      state: "queued",
    });
    await flushRepairActionEvents();
    await writeCausalManifest(queueOutput);
    const shardPath = walk(queueOutput).find((file) => file.endsWith(".jsonl"));
    assert.ok(shardPath);
    fs.renameSync(shardPath, path.join(path.dirname(shardPath), "forged.jsonl"));

    Object.assign(process.env, workflowEnv(nextRoot, nextOutput), {
      CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS: queueOutput,
    });
    assert.throws(
      () =>
        recordRepairLifecycleEvent(lifecycle, {
          type: ACTION_EVENT_TYPES.repairPlan,
          status: ACTION_EVENT_STATUSES.completed,
          reasonCode: ACTION_EVENT_REASON_CODES.completed,
          mutation: false,
          component: "action_session",
          state: "planned",
        }),
      /action event shard|canonical/,
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    for (const root of [queueRoot, nextRoot]) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  }
});

test("repair causal context requires an authenticated manifest from the expected producer", async () => {
  const sourceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-authenticated-")),
  );
  const consumerRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-consumer-")),
  );
  const sourceOutput = path.join(sourceRoot, "output");
  const consumerOutput = path.join(consumerRoot, "output");
  fs.mkdirSync(sourceOutput);
  fs.mkdirSync(consumerOutput);
  const previous = { ...process.env };
  const lifecycle = repairLifecycle();

  try {
    Object.assign(process.env, workflowEnv(sourceRoot, sourceOutput));
    recordRepairLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.repairQueue,
      status: ACTION_EVENT_STATUSES.queued,
      reasonCode: ACTION_EVENT_REASON_CODES.accepted,
      mutation: false,
      component: "action_session",
      state: "queued",
    });
    await flushRepairActionEvents();

    Object.assign(process.env, workflowEnv(consumerRoot, consumerOutput), {
      CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS: sourceOutput,
    });
    assert.throws(() => recordRepairPlan(lifecycle), /causal action ledger manifest/);

    Object.assign(process.env, workflowEnv(sourceRoot, sourceOutput));
    await writeCausalManifest(sourceOutput);
    const manifestPath = path.join(sourceOutput, "repair-action-ledger-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.manifest_sha256 = "0".repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    Object.assign(process.env, workflowEnv(consumerRoot, consumerOutput), {
      CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS: sourceOutput,
    });
    assert.throws(() => recordRepairPlan(lifecycle), /manifest digest is invalid/);

    Object.assign(process.env, workflowEnv(sourceRoot, sourceOutput), {
      CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS: "",
      GITHUB_RUN_ID: "9999",
    });
    fs.rmSync(sourceRoot, { force: true, recursive: true });
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(sourceOutput);
    recordRepairLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.repairQueue,
      status: ACTION_EVENT_STATUSES.queued,
      reasonCode: ACTION_EVENT_REASON_CODES.accepted,
      mutation: false,
      component: "action_session",
      state: "queued",
    });
    await flushRepairActionEvents();
    await writeCausalManifest(sourceOutput);

    Object.assign(process.env, workflowEnv(consumerRoot, consumerOutput), {
      CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS: sourceOutput,
    });
    assert.throws(() => recordRepairPlan(lifecycle), /identity mismatch for run_id/);
  } finally {
    restoreEnv(previous);
    fs.rmSync(sourceRoot, { force: true, recursive: true });
    fs.rmSync(consumerRoot, { force: true, recursive: true });
  }
});

test("repair causal context rejects a manifest-bound event for another subject", async () => {
  const sourceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-subject-")),
  );
  const consumerRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-action-ledger-subject-consumer-")),
  );
  const sourceOutput = path.join(sourceRoot, "output");
  const consumerOutput = path.join(consumerRoot, "output");
  fs.mkdirSync(sourceOutput);
  fs.mkdirSync(consumerOutput);
  const previous = { ...process.env };
  const lifecycle = repairLifecycle();

  try {
    Object.assign(process.env, workflowEnv(sourceRoot, sourceOutput));
    recordRepairLifecycleEvent(
      { ...lifecycle, subjectId: "forged-subject" },
      {
        type: ACTION_EVENT_TYPES.repairQueue,
        status: ACTION_EVENT_STATUSES.queued,
        reasonCode: ACTION_EVENT_REASON_CODES.accepted,
        mutation: false,
        component: "action_session",
        state: "queued",
      },
    );
    await flushRepairActionEvents();
    await writeCausalManifest(sourceOutput);

    Object.assign(process.env, workflowEnv(consumerRoot, consumerOutput), {
      CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS: sourceOutput,
    });
    assert.throws(() => recordRepairPlan(lifecycle), /causal context subject mismatch/);
  } finally {
    restoreEnv(previous);
    fs.rmSync(sourceRoot, { force: true, recursive: true });
    fs.rmSync(consumerRoot, { force: true, recursive: true });
  }
});

test("repair publication replay identity distinguishes workflow runs", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-publication-run-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = {
    repository: "openclaw/openclaw",
    workKey: "openclaw/openclaw:cluster-42",
    clusterId: "cluster-42",
    sourceRevision: "source-head-42",
  };

  try {
    for (const runId of ["100", "101"]) {
      recordRepairLifecycleEvent(lifecycle, {
        type: ACTION_EVENT_TYPES.repairPublish,
        status: ACTION_EVENT_STATUSES.completed,
        reasonCode: ACTION_EVENT_REASON_CODES.published,
        mutation: true,
        component: "publish_result",
        operation: "publication",
        state: "published",
        publicationKind: "cluster_result",
        eventIdentity: { publicationKind: "cluster_result", runId },
        idempotencySlot: `cluster_result:${runId}`,
      });
    }
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    assert.equal(events.length, 2);
    assert.equal(new Set(events.map((event) => event.event_id)).size, 2);
    assert.equal(new Set(events.map((event) => event.idempotency_key_sha256)).size, 2);
    assert.deepEqual(
      events.map((event) => event.phase_seq).sort((left, right) => left - right),
      [1, 2],
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair failure receipt recording never masks the primary failure", () => {
  const previous = { ...process.env };
  const reports: string[] = [];
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: "relative-ledger-root",
  });

  try {
    assert.doesNotThrow(() =>
      recordRepairLifecycleFailureSafely(
        {
          repository: "openclaw/openclaw",
          workKey: "openclaw/openclaw:repair-pr-42",
          sourceRevision: "source-head-42",
        },
        {
          component: "repair_worker",
          error: new Error("primary failure"),
        },
        (message) => reports.push(message),
      ),
    );
    assert.equal(reports.length, 1);
    assert.match(reports[0]!, /failed to record repair failure receipt after the primary failure/);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});

test("repair source revision selects the sealed repaired source", () => {
  assert.equal(
    repairSourceRevision({
      source_issue_revision_sha256: "a".repeat(64),
      expected_head_sha: "b".repeat(40),
    }),
    "a".repeat(64),
  );
  assert.equal(repairSourceRevision({ expected_head_sha: "b".repeat(40) }), "b".repeat(40));
  assert.equal(repairSourceRevision({ commit_sha: "c".repeat(40) }), "c".repeat(40));
  assert.equal(repairSourceRevision({}), null);
});

test("HTTP mutation outcomes reject only definite no-mutation responses", () => {
  assert.equal(repairHttpMutationOutcome({ ok: true, status: 200 }), "accepted");
  for (const status of [400, 401, 403, 404, 405, 415, 422]) {
    assert.equal(repairHttpMutationOutcome({ ok: false, status }), "rejected", String(status));
  }
  for (const status of [302, 408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.equal(repairHttpMutationOutcome({ ok: false, status }), "unknown", String(status));
  }
});

test("repair workflow reports map to matching terminal lifecycle phases", async () => {
  assert.equal(repairWorkflowTerminalPhase({ status: "opened", actions: [] }), "completed");
  assert.equal(repairWorkflowTerminalPhase({ status: "blocked", actions: [] }), "blocked");
  assert.equal(repairWorkflowTerminalPhase({ status: "needs_human", actions: [] }), "blocked");
  assert.equal(repairWorkflowTerminalPhase({ status: "failed", actions: [] }), "failed");
  assert.equal(
    repairWorkflowTerminalPhase({
      status: "blocked",
      actions: [{ status: "blocked", requeue_required: true }],
    }),
    "requeued",
  );
  assert.equal(repairWorkflowTerminalPhase({ outcome: "requeue", actions: [] }), "requeued");
  assert.equal(repairWorkflowTerminalPhase(null), "failed");

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-terminal-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    for (const phase of ["blocked", "requeued", "failed"] as const) {
      recordRepairWorkflowEvent(
        { ...repairLifecycle(), workKey: `openclaw/openclaw:${phase}` },
        { component: "repair_worker", phase },
      );
    }
    await flushRepairActionEvents();
    const terminal = readEvents(outputRoot)
      .filter((event) => event.event_type === ACTION_EVENT_TYPES.workflowAttempt)
      .sort((left, right) =>
        String(left.attributes?.state).localeCompare(String(right.attributes?.state)),
      );
    assert.deepEqual(
      terminal.map((event) => [
        event.attributes?.state,
        event.action.status,
        event.action.reason_code,
        event.action.retryable,
      ]),
      [
        ["blocked", "blocked", "policy_blocked", false],
        ["failed", "failed", "exception", false],
        ["requeued", "requeued", "retry_scheduled", true],
      ],
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("hard workflow blocks stay terminal after an unknown mutation", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "repair-terminal-unknown-ledger-")),
  );
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = repairLifecycle();

  try {
    runRepairMutation(lifecycle, {
      kind: "post_flight_merge",
      identity: { repo: "openclaw/openclaw", number: 42, headSha: "a".repeat(40) },
      operation: () => "queued",
      outcome: () => "unknown",
    });
    recordRepairWorkflowEvent(lifecycle, {
      component: "post_flight",
      phase: "blocked",
    });
    await flushRepairActionEvents();

    const events = readEvents(outputRoot);
    const mutation = events.find(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.repairMutation &&
        event.attributes?.completion_reason === "mutation_outcome_unknown",
    );
    const blocked = events.find(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
        event.attributes?.workflow_phase === "blocked",
    );
    assert.equal(mutation?.action.retryable, true);
    assert.equal(blocked?.action.mutation, true);
    assert.equal(blocked?.action.retryable, false);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repair action ledger CLI finalizes the configured ledger root", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repair-cli-root-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    recordRepairLifecycleEvent(
      {
        repository: "openclaw/openclaw",
        workKey: "openclaw/openclaw:repair-pr-42",
        sourceRevision: "source-head-42",
      },
      {
        type: ACTION_EVENT_TYPES.repairQueue,
        status: ACTION_EVENT_STATUSES.queued,
        reasonCode: ACTION_EVENT_REASON_CODES.accepted,
        mutation: false,
        component: "repair_worker",
        state: "queued",
      },
    );
    recordRepairLifecycleEvent(repairLifecycle(), {
      type: ACTION_EVENT_TYPES.repairMutation,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      mutation: false,
      retryable: true,
      component: "repair_worker",
      state: "mutation_attempted",
      completionReason: "mutation_attempted",
      eventIdentity: { kind: "branch_push", requestAttempt: 1, outcome: "attempted" },
      idempotencyIdentity: { mutation: "branch_push", request: "cli-stable" },
    });
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(process.cwd(), "dist", "repair", "action-ledger-cli.js"), "finalize"],
        { encoding: "utf8", env: { ...process.env } },
      ),
    );
    assert.equal(result.paths.length, 1);
    const events = readEvents(outputRoot);
    assert.equal(events.length, 3);
    assert.equal(events.at(-1)?.attributes?.completion_reason, "mutation_outcome_unknown");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function recordRepairAttempt() {
  const lifecycle = repairLifecycle();
  recordRepairLifecycleEvent(lifecycle, {
    type: ACTION_EVENT_TYPES.repairQueue,
    status: ACTION_EVENT_STATUSES.queued,
    reasonCode: ACTION_EVENT_REASON_CODES.accepted,
    mutation: false,
    component: "repair_worker",
    operation: "repair",
    state: "queued",
  });
  recordRepairLifecycleEvent(lifecycle, {
    type: ACTION_EVENT_TYPES.repairPlan,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    mutation: false,
    component: "repair_worker",
    operation: "repair",
    state: "planned",
  });
  recordRepairLifecycleEvent(lifecycle, {
    type: ACTION_EVENT_TYPES.repairExecute,
    status: ACTION_EVENT_STATUSES.executed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    mutation: true,
    component: "repair_worker",
    operation: "repair",
    state: "executed",
    idempotencySlot: "publish_branch:repair-pr-42",
  });
}

function recordRepairPlan(lifecycle: ReturnType<typeof repairLifecycle>) {
  return recordRepairLifecycleEvent(lifecycle, {
    type: ACTION_EVENT_TYPES.repairPlan,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    mutation: false,
    component: "action_session",
    state: "planned",
  });
}

async function writeCausalManifest(outputRoot: string): Promise<void> {
  const manifest = await finalizeRepairActionLedgerManifest("cluster");
  fs.writeFileSync(
    path.join(outputRoot, "repair-action-ledger-manifest.json"),
    serializeRepairActionLedgerManifest(manifest),
  );
}

function repairLifecycle() {
  return {
    repository: "openclaw/openclaw",
    workKey: "openclaw/openclaw:repair-pr-42",
    clusterId: "repair-pr-42",
    number: 42,
    sourceRevision: "source-head-42",
  };
}

function restoreEnv(previous: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}

function workflowEnv(root: string, outputRoot: string) {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "initial",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
    GITHUB_ACTION: "repair",
    GITHUB_JOB: "cluster",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "4242",
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

function actionEventSpoolFile(root: string, outputRoot: string): string | undefined {
  const outputPrefix = `${path.resolve(outputRoot)}${path.sep}`;
  return walk(root).find(
    (file) => file.endsWith(".json") && !path.resolve(file).startsWith(outputPrefix),
  );
}
