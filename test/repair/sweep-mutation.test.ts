import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { actionIdempotencyKey, readSpooledActionEvents } from "../../dist/action-ledger.js";
import {
  importActionEventShards,
  readImportedRepairMutationEvents,
} from "../../dist/action-ledger-runtime.js";
import {
  executeSweepMutation,
  sweepMutationPayloadDigest,
  type SweepMutationRequest,
  type SweepWireRunner,
} from "../../dist/repair/sweep-mutation.js";
import {
  flushRepairActionEvents,
  repairMutationIdempotencyIdentity,
} from "../../dist/repair/repair-action-ledger.js";

test("sweep workflow dispatch records accepted receipts without persisting raw inputs", () => {
  withLedger((root) => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const request: SweepMutationRequest = {
      type: "workflow-dispatch",
      repository: "openclaw/clawsweeper",
      workflow: "sweep.yml",
      ref: "main",
      businessKey: "test-dispatch:7130",
      targetRepository: "openclaw/openclaw",
      itemNumber: 42,
      fields: {
        target_repo: "openclaw/openclaw",
        item_number: "42",
        additional_prompt: "private repair prompt",
      },
    };

    const result = executeSweepMutation(request, {
      runWire: (args) => {
        mutableCalls.push([...args]);
        return success();
      },
    });

    assert.deepEqual(result, { outcome: "accepted", attempts: 1 });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.includes("additional_prompt=private repair prompt"));
    const events = mutationEvents(root);
    assert.deepEqual(completionReasons(events), ["mutation_attempted", "mutation_accepted"]);
    assert.equal(events[0]?.idempotency_key_sha256, events[1]?.idempotency_key_sha256);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("private repair prompt"), false);
    assert.equal(serialized.includes("additional_prompt"), false);
  });
});

test("sweep mutations fail closed before the wire call when ledger setup is unavailable", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-disabled-")));
  const outputRoot = path.join(root, "output");
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(stateRoot);
  const previous = { ...process.env };
  let calls = 0;
  Object.assign(process.env, workflowEnv(root, outputRoot, stateRoot));
  delete process.env.CLAWSWEEPER_ACTION_LEDGER_FORCE;
  delete process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT;
  delete process.env.GITHUB_RUN_STARTED_AT;

  try {
    assert.throws(
      () =>
        executeSweepMutation(workflowDispatch(), {
          runWire: () => {
            calls += 1;
            return success();
          },
        }),
      /requires successful action-ledger setup/,
    );
    assert.equal(calls, 0);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sweep mutation classifies definite 4xx failures as rejected before write", () => {
  withLedger((root) => {
    assert.throws(
      () =>
        executeSweepMutation(workflowDispatch(), {
          runWire: () => failure("gh: Validation Failed (HTTP 422)"),
        }),
      /HTTP 422/,
    );

    const events = mutationEvents(root);
    assert.deepEqual(completionReasons(events), ["mutation_attempted", "mutation_rejected"]);
    assert.deepEqual(
      events.map((event) => event.action.mutation),
      [false, false],
    );
  });
});

for (const [name, wireFailure] of [
  ["5xx", () => failure("gh: Bad Gateway (HTTP 502)")],
  [
    "transport",
    () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    }),
  ],
] as const) {
  test(`sweep dispatch records ${name} ambiguity and blocks a duplicate request`, () => {
    withLedger((root) => {
      let calls = 0;
      const runWire: SweepWireRunner = () => {
        calls += 1;
        return wireFailure();
      };

      assert.throws(() => executeSweepMutation(workflowDispatch(), { runWire }));
      assert.throws(
        () => executeSweepMutation(workflowDispatch(), { runWire }),
        /refusing duplicate non-idempotent sweep dispatch/,
      );
      assert.equal(calls, 1);
      assert.deepEqual(completionReasons(mutationEvents(root)), [
        "mutation_attempted",
        "mutation_outcome_unknown",
      ]);
    });
  });
}

test("idempotent reaction retries use stable business identity and distinct wire receipts", () => {
  withLedger((root) => {
    let calls = 0;
    const result = executeSweepMutation(
      {
        type: "reaction-add",
        repository: "openclaw/openclaw",
        itemNumber: 42,
        content: "eyes",
        maxAttempts: 2,
      },
      {
        sleep: () => undefined,
        runWire: () => {
          calls += 1;
          return calls === 1 ? failure("gh: Bad Gateway (HTTP 502)") : success();
        },
      },
    );

    assert.deepEqual(result, { outcome: "accepted", attempts: 2 });
    const events = mutationEvents(root);
    assert.deepEqual(completionReasons(events), [
      "mutation_attempted",
      "mutation_outcome_unknown",
      "mutation_attempted",
      "mutation_accepted",
    ]);
    assert.equal(new Set(events.map((event) => event.idempotency_key_sha256)).size, 1);
    assert.equal(new Set(events.map((event) => event.event_key)).size, 4);
  });
});

test("workflow dispatch identity is stable across field order after a definite rejection", () => {
  withLedger((root) => {
    let calls = 0;
    const first = workflowDispatch({
      target_repo: "openclaw/openclaw",
      item_number: "42",
      hot_intake: "false",
    });
    const second = workflowDispatch({
      hot_intake: "false",
      item_number: "42",
      target_repo: "openclaw/openclaw",
    });

    assert.throws(() =>
      executeSweepMutation(first, {
        runWire: () => {
          calls += 1;
          return failure("gh: Validation Failed (HTTP 422)");
        },
      }),
    );
    executeSweepMutation(second, {
      runWire: () => {
        calls += 1;
        return success();
      },
    });

    assert.equal(calls, 2);
    const events = mutationEvents(root);
    assert.deepEqual(completionReasons(events), [
      "mutation_attempted",
      "mutation_rejected",
      "mutation_attempted",
      "mutation_accepted",
    ]);
    assert.equal(new Set(events.map((event) => event.idempotency_key_sha256)).size, 1);
    assert.equal(
      sweepMutationPayloadDigest(first.fields),
      sweepMutationPayloadDigest(second.fields),
    );
  });
});

test("indexed durable action history blocks duplicate dispatch without scanning history", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-durable-")));
  const firstRoot = path.join(root, "first-spool");
  const firstOutput = path.join(root, "first-output");
  const secondRoot = path.join(root, "second-spool");
  const secondOutput = path.join(root, "second-output");
  const stateRoot = path.join(root, "state");
  for (const directory of [firstRoot, firstOutput, secondRoot, secondOutput, stateRoot]) {
    fs.mkdirSync(directory);
  }
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(firstRoot, firstOutput, stateRoot));
  let calls = 0;

  try {
    assert.throws(() =>
      executeSweepMutation(workflowDispatch(), {
        runWire: () => {
          calls += 1;
          return failure("gh: Bad Gateway (HTTP 502)");
        },
      }),
    );
    await flushRepairActionEvents();
    importActionEventShards(firstOutput, stateRoot);
    const firstIdempotencyKey = mutationEvents(firstRoot)[0]?.idempotency_key_sha256;
    assert.ok(firstIdempotencyKey);
    assert.ok(
      readImportedRepairMutationEvents(stateRoot, "openclaw/clawsweeper", firstIdempotencyKey),
    );
    poisonLegacyScan(stateRoot);

    Object.assign(process.env, workflowEnv(secondRoot, secondOutput, stateRoot), {
      GITHUB_RUN_ATTEMPT: "2",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "sweep-mutation-test-rerun",
    });
    assert.throws(
      () =>
        executeSweepMutation(workflowDispatch(), {
          runWire: () => {
            calls += 1;
            return success();
          },
        }),
      /refusing duplicate non-idempotent sweep dispatch/,
    );
    assert.equal(calls, 1);
    assert.equal(mutationEvents(secondRoot).length, 0);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("indexed accepted dispatches become no-ops without blocking later work", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-accepted-")));
  const firstRoot = path.join(root, "first-spool");
  const firstOutput = path.join(root, "first-output");
  const secondRoot = path.join(root, "second-spool");
  const secondOutput = path.join(root, "second-output");
  const stateRoot = path.join(root, "state");
  for (const directory of [firstRoot, firstOutput, secondRoot, secondOutput, stateRoot]) {
    fs.mkdirSync(directory);
  }
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(firstRoot, firstOutput, stateRoot));
  let calls = 0;
  const acceptedRequest = workflowDispatch();

  try {
    assert.deepEqual(
      executeSweepMutation(acceptedRequest, {
        runWire: () => {
          calls += 1;
          return success();
        },
      }),
      { outcome: "accepted", attempts: 1 },
    );
    await flushRepairActionEvents();
    importActionEventShards(firstOutput, stateRoot);
    const payloadSha256 = sweepMutationPayloadDigest(acceptedRequest.fields);
    const expectedIdempotencyKey = actionIdempotencyKey(
      repairMutationIdempotencyIdentity(
        {
          repository: acceptedRequest.targetRepository ?? acceptedRequest.repository,
          workKey: `sweep-caller:${acceptedRequest.type}:${payloadSha256}`,
          number: acceptedRequest.itemNumber,
          subjectKind: "issue",
        },
        {
          kind: "sweep_workflow_dispatch",
          operationName: "sweep_caller_mutation",
          identity: {
            repository: acceptedRequest.repository,
            workflow: acceptedRequest.workflow,
            ref: acceptedRequest.ref,
            targetRepository: acceptedRequest.targetRepository ?? null,
            itemNumber: acceptedRequest.itemNumber ?? null,
            businessKey: acceptedRequest.businessKey,
            payloadSha256,
          },
        },
      ),
    );
    assert.equal(mutationEvents(firstRoot)[0]?.idempotency_key_sha256, expectedIdempotencyKey);
    assert.ok(
      readImportedRepairMutationEvents(stateRoot, "openclaw/clawsweeper", expectedIdempotencyKey),
    );
    poisonLegacyScan(stateRoot);

    Object.assign(process.env, workflowEnv(secondRoot, secondOutput, stateRoot), {
      GITHUB_RUN_ATTEMPT: "2",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "sweep-mutation-test-rerun",
    });
    assert.deepEqual(
      executeSweepMutation(acceptedRequest, {
        runWire: () => {
          calls += 1;
          return success();
        },
      }),
      { outcome: "accepted", attempts: 0 },
    );
    clearPoisonLegacyScan(stateRoot);
    assert.deepEqual(
      executeSweepMutation(
        {
          ...workflowDispatch({ target_repo: "openclaw/openclaw", item_number: "43" }),
          itemNumber: 43,
          businessKey: "test-dispatch:7130:43",
        },
        {
          runWire: () => {
            calls += 1;
            return success();
          },
        },
      ),
      { outcome: "accepted", attempts: 1 },
    );
    assert.equal(calls, 2);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("indexed rejected history permits a later workflow attempt without scanning history", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-index-miss-")));
  const firstRoot = path.join(root, "first-spool");
  const firstOutput = path.join(root, "first-output");
  const secondRoot = path.join(root, "second-spool");
  const secondOutput = path.join(root, "second-output");
  const stateRoot = path.join(root, "state");
  for (const directory of [firstRoot, firstOutput, secondRoot, secondOutput, stateRoot]) {
    fs.mkdirSync(directory);
  }
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(firstRoot, firstOutput, stateRoot));
  let calls = 0;

  try {
    assert.throws(
      () =>
        executeSweepMutation(workflowDispatch(), {
          runWire: () => {
            calls += 1;
            return failure("gh: Validation Failed (HTTP 422)");
          },
        }),
      /HTTP 422/,
    );
    await flushRepairActionEvents();
    importActionEventShards(firstOutput, stateRoot);
    poisonLegacyScan(stateRoot);

    Object.assign(process.env, workflowEnv(secondRoot, secondOutput, stateRoot), {
      GITHUB_RUN_ATTEMPT: "2",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "sweep-mutation-test-rerun",
    });
    assert.deepEqual(
      executeSweepMutation(workflowDispatch(), {
        runWire: () => {
          calls += 1;
          return success();
        },
      }),
      { outcome: "accepted", attempts: 1 },
    );
    assert.equal(calls, 2);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("first workflow attempts check only the local spool", () => {
  withLedger((root) => {
    poisonLegacyScan(path.join(root, "state"));
    assert.deepEqual(executeSweepMutation(workflowDispatch(), { runWire: () => success() }), {
      outcome: "accepted",
      attempts: 1,
    });
  });
});

test("reruns fall back to bounded legacy history when the key has no index", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-legacy-")));
  const firstRoot = path.join(root, "first-spool");
  const firstOutput = path.join(root, "first-output");
  const secondRoot = path.join(root, "second-spool");
  const secondOutput = path.join(root, "second-output");
  const stateRoot = path.join(root, "state");
  for (const directory of [firstRoot, firstOutput, secondRoot, secondOutput, stateRoot]) {
    fs.mkdirSync(directory);
  }
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(firstRoot, firstOutput, stateRoot));
  let calls = 0;

  try {
    assert.throws(() =>
      executeSweepMutation(workflowDispatch(), {
        runWire: () => {
          calls += 1;
          return failure("gh: Bad Gateway (HTTP 502)");
        },
      }),
    );
    await flushRepairActionEvents();
    importActionEventShards(firstOutput, stateRoot);
    for (const directory of [
      "repair-mutation-idempotency",
      "repair-mutation-idempotency-reservations",
    ]) {
      fs.rmSync(path.join(stateRoot, "ledger", "v1", "import-bindings", directory), {
        recursive: true,
      });
    }

    Object.assign(process.env, workflowEnv(secondRoot, secondOutput, stateRoot), {
      GITHUB_RUN_ATTEMPT: "2",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "sweep-mutation-test-rerun",
    });
    assert.throws(
      () => executeSweepMutation(workflowDispatch(), { runWire: () => success() }),
      /refusing duplicate non-idempotent sweep dispatch/,
    );
    assert.equal(calls, 1);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reruns fail closed when the key index is malformed", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-index-invalid-")));
  const firstRoot = path.join(root, "first-spool");
  const firstOutput = path.join(root, "first-output");
  const secondRoot = path.join(root, "second-spool");
  const secondOutput = path.join(root, "second-output");
  const stateRoot = path.join(root, "state");
  for (const directory of [firstRoot, firstOutput, secondRoot, secondOutput, stateRoot]) {
    fs.mkdirSync(directory);
  }
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(firstRoot, firstOutput, stateRoot));
  let calls = 0;

  try {
    assert.throws(() =>
      executeSweepMutation(workflowDispatch(), {
        runWire: () => {
          calls += 1;
          return failure("gh: Bad Gateway (HTTP 502)");
        },
      }),
    );
    await flushRepairActionEvents();
    const imported = importActionEventShards(firstOutput, stateRoot);
    const indexPaths = imported.completionPaths.filter((relativePath) =>
      relativePath.includes("repair-mutation-idempotency"),
    );
    assert.equal(indexPaths.length, 1);
    fs.writeFileSync(path.join(stateRoot, indexPaths[0]!), "{}\n", "utf8");
    poisonLegacyScan(stateRoot);

    Object.assign(process.env, workflowEnv(secondRoot, secondOutput, stateRoot), {
      GITHUB_RUN_ATTEMPT: "2",
      CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "sweep-mutation-test-rerun",
    });
    assert.throws(
      () => executeSweepMutation(workflowDispatch(), { runWire: () => success() }),
      /invalid repair mutation idempotency index/,
    );
    assert.equal(calls, 1);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("non-idempotent business keys require the current run id as a colon segment", () => {
  withLedger(() => {
    assert.throws(
      () =>
        executeSweepMutation(
          { ...workflowDispatch(), businessKey: "test-dispatch-7130" },
          { runWire: () => success() },
        ),
      /colon-delimited segment/,
    );
  });
});

test("sweep mutation CLI rejects unknown options and duplicate workflow fields", () => {
  for (const args of [
    [
      "workflow",
      "dispatch",
      "--repo",
      "openclaw/clawsweeper",
      "--workflow",
      "sweep.yml",
      "--ref",
      "main",
      "--business-key",
      "test-dispatch:7130",
      "--unknown",
      "value",
    ],
    [
      "workflow",
      "dispatch",
      "--repo",
      "openclaw/clawsweeper",
      "--workflow",
      "sweep.yml",
      "--ref",
      "main",
      "--business-key",
      "test-dispatch:7130",
      "--field",
      "target_repo=openclaw/openclaw",
      "--field",
      "target_repo=openclaw/clawhub",
    ],
  ]) {
    const result = spawnSync(process.execPath, ["dist/repair/sweep-mutation-cli.js", ...args], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
  }
});

test("repository dispatch payloads are bounded, no-follow, and event-type matched", () => {
  withLedger((root) => {
    const payload = path.join(root, "dispatch.json");
    const symlink = path.join(root, "dispatch-link.json");
    fs.writeFileSync(
      payload,
      JSON.stringify({ event_type: "clawsweeper_target_sweep", client_payload: {} }),
    );
    fs.symlinkSync(payload, symlink);

    assert.throws(
      () =>
        executeSweepMutation(
          {
            type: "repository-dispatch",
            repository: "openclaw/clawsweeper",
            eventType: "clawsweeper_target_sweep",
            payloadPath: symlink,
            targetRepository: "openclaw/openclaw",
            itemNumber: 42,
            businessKey: "repository-dispatch:7130",
          },
          { runWire: () => success() },
        ),
      /symbolic link|unsafe|ELOOP/i,
    );

    assert.throws(
      () =>
        executeSweepMutation(
          {
            type: "repository-dispatch",
            repository: "openclaw/clawsweeper",
            eventType: "different_event",
            payloadPath: payload,
            targetRepository: "openclaw/openclaw",
            itemNumber: 42,
            businessKey: "repository-dispatch:7130",
          },
          { runWire: () => success() },
        ),
      /event_type does not match/,
    );
  });
});

function workflowDispatch(
  fields: Readonly<Record<string, string>> = {
    target_repo: "openclaw/openclaw",
    item_number: "42",
  },
): SweepMutationRequest {
  return {
    type: "workflow-dispatch",
    repository: "openclaw/clawsweeper",
    workflow: "sweep.yml",
    ref: "main",
    businessKey: "test-dispatch:7130",
    targetRepository: "openclaw/openclaw",
    itemNumber: 42,
    fields,
  };
}

function withLedger(run: (root: string) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-mutation-")));
  const outputRoot = path.join(root, "output");
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(stateRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot, stateRoot));
  try {
    run(root);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function workflowEnv(root: string, outputRoot: string, stateRoot: string) {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "sweep-mutation-test",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
    CLAWSWEEPER_STATE_DIR: stateRoot,
    GITHUB_ACTION: "sweep_mutation",
    GITHUB_JOB: "publish",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "7130",
    GITHUB_RUN_STARTED_AT: "2026-07-13T10:00:00Z",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "sweep",
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/sweep.yml@refs/heads/main",
  };
}

function mutationEvents(root: string) {
  return readSpooledActionEvents(root, "openclaw/openclaw")
    .filter((event) => event.event_type === "repair.mutation")
    .sort((left, right) => left.phase_seq - right.phase_seq);
}

function completionReasons(events: ReturnType<typeof mutationEvents>) {
  return events.map((event) => event.attributes?.completion_reason);
}

function success() {
  return { status: 0, stdout: "", stderr: "" };
}

function failure(stderr: string) {
  return { status: 1, stdout: "", stderr: "" + stderr };
}

function poisonLegacyScan(stateRoot: string): void {
  const eventRoot = path.join(stateRoot, "ledger", "v1", "events");
  fs.mkdirSync(eventRoot, { recursive: true });
  for (let index = 0; index < 513; index += 1) {
    fs.writeFileSync(path.join(eventRoot, `unrelated-${String(index).padStart(3, "0")}`), "");
  }
}

function clearPoisonLegacyScan(stateRoot: string): void {
  const eventRoot = path.join(stateRoot, "ledger", "v1", "events");
  for (let index = 0; index < 513; index += 1) {
    fs.rmSync(path.join(eventRoot, `unrelated-${String(index).padStart(3, "0")}`), {
      force: true,
    });
  }
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}
