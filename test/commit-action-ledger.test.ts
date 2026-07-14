import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ACTION_EVENT_TYPES } from "../dist/action-ledger.js";
import {
  flushWorkflowActionEvents,
  importActionEventShards,
} from "../dist/action-ledger-runtime.js";
import {
  commitReviewLifecycleSucceeded,
  flushCommitActionEvents,
  recordCommitArtifactPrepared,
  recordCommitLifecycleEvent,
  recordCommitWorkflowEvent,
  runCommitMutation,
} from "../dist/commit-action-ledger.js";
import { finalizeRepairActionLedgerManifest } from "../dist/repair/repair-action-ledger-manifest.js";
import { mockGhBinEnv, readText } from "./helpers.ts";

test("commit review terminal success requires requested check publication", () => {
  assert.equal(
    commitReviewLifecycleSucceeded({
      reviewOutcome: "success",
      checkOutcome: "skipped",
      checksRequested: false,
      reportResult: "nothing_found",
    }),
    true,
  );
  for (const checkOutcome of ["skipped", "failure", "cancelled"]) {
    assert.equal(
      commitReviewLifecycleSucceeded({
        reviewOutcome: "success",
        checkOutcome,
        checksRequested: true,
        reportResult: "nothing_found",
      }),
      false,
    );
  }
  assert.equal(
    commitReviewLifecycleSucceeded({
      reviewOutcome: "success",
      checkOutcome: "success",
      checksRequested: true,
      reportResult: "findings",
    }),
    true,
  );
  for (const reportResult of ["failed", "missing", "invalid", "unknown"]) {
    assert.equal(
      commitReviewLifecycleSucceeded({
        reviewOutcome: "success",
        checkOutcome: "success",
        checksRequested: true,
        reportResult,
      }),
      false,
    );
  }
  assert.equal(
    commitReviewLifecycleSucceeded({
      reviewOutcome: "success",
      checkOutcome: "skipped",
      checksRequested: false,
      reportResult: "inconclusive",
    }),
    true,
  );
});

test("commit review artifacts are prepared locally before external publication", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-artifact-ledger-")));
  const outputRoot = path.join(root, "output");
  const artifactPath = path.join(root, "review.md");
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(artifactPath, "review\n");
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    recordCommitArtifactPrepared(
      { repository: "openclaw/openclaw", sha: "b".repeat(40) },
      { path: artifactPath, kind: "commit_review_report" },
    );
    await flushCommitActionEvents();

    const [event] = readEvents(outputRoot);
    assert.equal(event?.event_type, ACTION_EVENT_TYPES.reviewLogPublication);
    assert.equal(event?.action.status, "completed");
    assert.equal(event?.attributes?.state, "prepared");
    assert.equal(event?.attributes?.publication_kind, "commit_review_report");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit review finalization preserves a completed producer lifecycle", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "commit-completed-finalizer-")),
  );
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = { repository: "openclaw/openclaw", sha: "b".repeat(40) };

  try {
    recordCommitWorkflowEvent(lifecycle, "started");
    recordCommitWorkflowEvent(lifecycle, "completed");
    recordCommitWorkflowEvent(lifecycle, "finalized");
    await finalizeRepairActionLedgerManifest("commit-review");

    const workflowEvents = readEvents(outputRoot)
      .filter((event) => event.event_type === ACTION_EVENT_TYPES.workflowAttempt)
      .sort((left, right) => left.phase_seq - right.phase_seq);
    assert.deepEqual(
      workflowEvents.map((event) => event.attributes?.state),
      ["started", "completed", "finalized"],
    );
    assert.doesNotMatch(
      JSON.stringify(workflowEvents),
      /workflow_interrupted|workflow_failed|"reason_code":"timeout"/,
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit review handoff finalization preserves its open producer lifecycle", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-open-finalizer-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = { repository: "openclaw/openclaw", sha: "b".repeat(40) };

  try {
    recordCommitWorkflowEvent(lifecycle, "started");
    await finalizeRepairActionLedgerManifest("commit-review", {
      preserveOpenWorkflows: true,
    });

    const workflowEvents = readEvents(outputRoot)
      .filter((event) => event.event_type === ACTION_EVENT_TYPES.workflowAttempt)
      .sort((left, right) => left.phase_seq - right.phase_seq);
    assert.deepEqual(
      workflowEvents.map((event) => event.attributes?.state),
      ["started"],
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("failed commit review reports cannot complete the workflow lifecycle", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-failed-report-")));
  const outputRoot = path.join(root, "output");
  const reportPath = path.join(root, `${"b".repeat(40)}.md`);
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(reportPath, "---\nresult: failed\n---\n\nReview failed.\n");
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));

  try {
    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "dist/commit-sweeper.js"),
        "finish-review",
        "--target-repo",
        "openclaw/openclaw",
        "--commit-sha",
        "b".repeat(40),
        "--report-path",
        reportPath,
        "--review-outcome",
        "success",
        "--check-outcome",
        "skipped",
        "--checks-requested",
        "false",
      ],
      { env: { ...process.env }, stdio: "pipe" },
    );
    await flushWorkflowActionEvents(root);

    const workflowStates = readEvents(outputRoot)
      .filter((event) => event.event_type === ACTION_EVENT_TYPES.workflowAttempt)
      .sort((left, right) => left.phase_seq - right.phase_seq)
      .map((event) => event.attributes?.state);
    assert.deepEqual(workflowStates, ["failed", "finalized"]);
    assert.doesNotMatch(workflowStates.join(","), /completed/);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit publication uncertainty is preserved by terminal workflow receipts", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-action-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = {
    repository: "openclaw/openclaw",
    sha: "b".repeat(40),
  };

  try {
    assert.throws(
      () =>
        runCommitMutation(lifecycle, {
          kind: "commit_check_publication",
          identity: { repo: "openclaw/openclaw", sha: lifecycle.sha },
          operation: () => {
            throw new Error("connection reset after check request");
          },
        }),
      /connection reset/,
    );
    recordCommitWorkflowEvent(lifecycle, "failed", new Error("later publication failed"));
    recordCommitWorkflowEvent(lifecycle, "finalized");
    await flushWorkflowActionEvents(root);

    const events = readEvents(outputRoot);
    const unknown = events.find(
      (event) => event.attributes?.completion_reason === "mutation_outcome_unknown",
    );
    const failed = events.find(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
        event.attributes?.state === "failed",
    );
    assert.equal(unknown?.action.mutation, true);
    assert.equal(failed?.action.mutation, true);
    assert.equal(failed?.action.retryable, true);
    assert.equal(failed?.attributes?.completion_reason, "mutation_outcome_unknown");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit mutation retry preserves prior uncertainty for the same receipt key", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-retry-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = {
    repository: "openclaw/openclaw",
    sha: "b".repeat(40),
  };
  const identity = { repo: lifecycle.repository, sha: lifecycle.sha };

  try {
    assert.throws(
      () =>
        runCommitMutation(lifecycle, {
          kind: "commit_check_publication",
          identity,
          operation: () => {
            throw new Error("response lost after publication");
          },
        }),
      /response lost/,
    );
    assert.equal(
      runCommitMutation(lifecycle, {
        kind: "commit_check_publication",
        identity,
        operation: () => "accepted",
      }),
      "accepted",
    );
    recordCommitWorkflowEvent(lifecycle, "failed", new Error("later workflow failure"));
    await flushWorkflowActionEvents(root);

    const events = readEvents(outputRoot).sort((left, right) => left.phase_seq - right.phase_seq);
    assert.deepEqual(
      events
        .filter((event) => event.event_type === ACTION_EVENT_TYPES.publicationLifecycle)
        .map((event) => event.attributes?.completion_reason),
      ["mutation_attempted", "mutation_outcome_unknown", "mutation_attempted", "mutation_accepted"],
    );
    const failed = events.find(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
        event.attributes?.state === "failed",
    );
    assert.equal(failed?.action.mutation, true);
    assert.equal(failed?.action.retryable, true);
    assert.equal(failed?.attributes?.completion_reason, "mutation_outcome_unknown");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit mutation observation resolves prior uncertainty for the same receipt key", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-observed-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = {
    repository: "openclaw/openclaw",
    sha: "b".repeat(40),
  };
  const kind = "commit_check_publication";
  const identity = { repo: lifecycle.repository, sha: lifecycle.sha };
  const requestSha256 = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const idempotencyIdentity = {
    operation: lifecycle,
    mutation: kind,
    requestSha256,
  };

  try {
    assert.throws(
      () =>
        runCommitMutation(lifecycle, {
          kind,
          identity,
          operation: () => {
            throw new Error("response lost after publication");
          },
        }),
      /response lost/,
    );
    recordCommitLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.publicationLifecycle,
      status: "executed",
      reasonCode: "already_complete",
      mutation: true,
      retryable: false,
      component: "commit_review",
      state: "mutation_observed",
      completionReason: "mutation_observed",
      publicationKind: kind,
      eventIdentity: { kind, requestSha256, outcome: "observed" },
      idempotencyIdentity,
    });
    recordCommitWorkflowEvent(lifecycle, "failed", new Error("later workflow failure"));
    await flushWorkflowActionEvents(root);

    const failed = readEvents(outputRoot).find(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
        event.attributes?.state === "failed",
    );
    assert.equal(failed?.action.mutation, true);
    assert.equal(failed?.action.retryable, false);
    assert.equal(failed?.attributes?.completion_reason, "mutation_observed");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit mutation confirmation does not resolve an unrelated receipt key", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-key-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = {
    repository: "openclaw/openclaw",
    sha: "b".repeat(40),
  };

  try {
    assert.throws(
      () =>
        runCommitMutation(lifecycle, {
          kind: "commit_check_publication",
          identity: { repo: lifecycle.repository, sha: lifecycle.sha, channel: "check" },
          operation: () => {
            throw new Error("response lost after check publication");
          },
        }),
      /response lost/,
    );
    runCommitMutation(lifecycle, {
      kind: "commit_check_publication",
      identity: { repo: lifecycle.repository, sha: lifecycle.sha, channel: "summary" },
      operation: () => undefined,
    });
    recordCommitWorkflowEvent(lifecycle, "failed", new Error("later workflow failure"));
    await flushWorkflowActionEvents(root);

    const failed = readEvents(outputRoot).find(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.workflowAttempt &&
        event.attributes?.state === "failed",
    );
    assert.equal(failed?.action.mutation, true);
    assert.equal(failed?.action.retryable, true);
    assert.equal(failed?.attributes?.completion_reason, "mutation_outcome_unknown");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit publication preserves its primary failure when receipt recording also fails", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-primary-error-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  const originalConsoleError = console.error;
  const receiptErrors: string[] = [];
  Object.assign(process.env, workflowEnv(root, outputRoot));
  let spoolDirectory = "";

  try {
    console.error = (message?: unknown) => receiptErrors.push(String(message));
    const primary = new Error("primary publication failure");
    assert.throws(
      () =>
        runCommitMutation(
          { repository: "openclaw/openclaw", sha: "b".repeat(40) },
          {
            kind: "commit_check_publication",
            identity: { sha: "b".repeat(40) },
            operation: () => {
              const spoolFile = actionEventSpoolFile(root, outputRoot);
              assert.ok(spoolFile);
              spoolDirectory = path.dirname(spoolFile);
              fs.chmodSync(spoolDirectory, 0o500);
              throw primary;
            },
          },
        ),
      (error) => error === primary,
    );
    assert.match(receiptErrors.join("\n"), /after the primary failure/);
  } finally {
    if (spoolDirectory) fs.chmodSync(spoolDirectory, 0o700);
    console.error = originalConsoleError;
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit mutation receipts preserve their workflow context across environment drift", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-context-ledger-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = { repository: "openclaw/openclaw", sha: "b".repeat(40) };

  try {
    assert.equal(
      runCommitMutation(lifecycle, {
        kind: "commit_check_publication",
        identity: { sha: lifecycle.sha },
        operation: () => {
          process.env.GITHUB_REPOSITORY = "not a repository";
          return "accepted";
        },
      }),
      "accepted",
    );

    process.env.GITHUB_REPOSITORY = "openclaw/clawsweeper";
    await flushCommitActionEvents();
    const events = readEvents(outputRoot);
    assert.deepEqual(
      events.map((event) => event.attributes?.completion_reason),
      ["mutation_attempted", "mutation_accepted"],
    );
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
  "commit receipt recovery survives a fresh repair finalizer process",
  { skip: process.platform === "win32" ? "requires POSIX directory permissions" : false },
  () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "commit-deferred-receipt-")),
    );
    const outputRoot = path.join(root, "output");
    fs.mkdirSync(outputRoot);
    const previous = { ...process.env };
    Object.assign(process.env, workflowEnv(root, outputRoot));
    const lifecycle = { repository: "openclaw/openclaw", sha: "b".repeat(40) };
    let spoolDirectory = "";

    try {
      const commitModule = pathToFileURL(
        path.join(process.cwd(), "dist", "commit-action-ledger.js"),
      ).href;
      const mutation = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import fs from "node:fs";
            import path from "node:path";
            const { runCommitMutation } = await import(${JSON.stringify(commitModule)});
            const root = ${JSON.stringify(root)};
            const outputRoot = ${JSON.stringify(outputRoot)};
            const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
              const target = path.join(directory, entry.name);
              return entry.isDirectory() ? walk(target) : [target];
            });
            const result = runCommitMutation(${JSON.stringify(lifecycle)}, {
              kind: "commit_check_publication",
              identity: { sha: ${JSON.stringify(lifecycle.sha)} },
              operation: () => {
                const outputPrefix = path.resolve(outputRoot) + path.sep;
                const spoolFile = walk(root).find(
                  (file) => file.endsWith(".json") && !path.resolve(file).startsWith(outputPrefix),
                );
                if (!spoolFile) throw new Error("missing commit action spool");
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
      const attempt = JSON.parse(fs.readFileSync(spoolFile, "utf8"));
      const kind = "commit_check_publication";
      const identity = { sha: lifecycle.sha };
      const idempotencyIdentity = {
        operation: lifecycle,
        mutation: kind,
        requestSha256: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
      };
      recordCommitLifecycleEvent(lifecycle, {
        type: ACTION_EVENT_TYPES.publicationLifecycle,
        status: "started",
        reasonCode: "selected",
        mutation: false,
        retryable: true,
        component: "commit_review",
        state: "mutation_attempted",
        completionReason: "mutation_attempted",
        publicationKind: kind,
        parentEventId: attempt.event_id,
        eventIdentity: { kind, requestAttempt: 99, outcome: "attempted" },
        idempotencyIdentity,
        requestAttempt: 99,
      });
      recordCommitLifecycleEvent(lifecycle, {
        type: ACTION_EVENT_TYPES.publicationLifecycle,
        status: "published",
        reasonCode: "published",
        mutation: true,
        component: "commit_review",
        state: "mutation_accepted",
        completionReason: "mutation_accepted",
        publicationKind: kind,
        parentEventId: attempt.event_id,
        eventIdentity: { kind: "foreign_publication", requestAttempt: 1, outcome: "accepted" },
        idempotencyIdentity: { mutation: "foreign_publication", request: "other" },
        requestAttempt: 1,
      });
      assert.ok(
        walk(outputRoot).some((file) =>
          file.includes(`${path.sep}.mutation-recovery${path.sep}commit${path.sep}`),
        ),
      );
      const recoveryFile = walk(outputRoot).find((file) => file.endsWith(".json"));
      assert.ok(recoveryFile);
      const recoveryKey = path.basename(recoveryFile, ".json");
      assert.ok(Number.isSafeInteger(mutation.pid) && mutation.pid > 0);
      fs.writeFileSync(
        path.join(path.dirname(recoveryFile), `.${recoveryKey}.${mutation.pid}.123.tmp`),
        "partial",
      );

      const manifestModule = pathToFileURL(
        path.join(process.cwd(), "dist", "repair", "repair-action-ledger-manifest.js"),
      ).href;
      const finalizer = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            const { finalizeRepairActionLedgerManifest } = await import(${JSON.stringify(manifestModule)});
            await finalizeRepairActionLedgerManifest("commit-review");
          `,
        ],
        { cwd: process.cwd(), encoding: "utf8", env: { ...process.env } },
      );
      assert.equal(finalizer.status, 0, finalizer.stderr);

      const events = readEvents(outputRoot);
      const exactTerminal = events.filter(
        (event) =>
          event.parent_event_id === attempt.event_id &&
          event.idempotency_key_sha256 === attempt.idempotency_key_sha256 &&
          event.attributes?.completion_reason === "mutation_accepted",
      );
      assert.equal(exactTerminal.length, 1);
      assert.equal(exactTerminal[0]?.action.status, "published");
      assert.equal(
        walk(outputRoot).some((file) => file.endsWith(".json") || file.endsWith(".tmp")),
        false,
      );
    } finally {
      if (spoolDirectory) fs.chmodSync(spoolDirectory, 0o700);
      restoreEnv(previous);
      fs.rmSync(root, { force: true, recursive: true });
    }
  },
);

test("commit review matrix invocations publish distinct importable shard paths", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-matrix-ledger-")));
  const outputRoot = path.join(root, "output");
  const destination = path.join(root, "destination");
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(destination);
  const previous = { ...process.env };
  const paths: string[] = [];
  const commits = ["b".repeat(40), "c".repeat(40)];

  try {
    for (const sha of commits) {
      const spoolRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "commit-matrix-spool-")),
      );
      Object.assign(process.env, workflowEnv(spoolRoot, outputRoot), {
        CLAWSWEEPER_ACTION_LEDGER_INVOCATION: `commit-${sha}`,
      });
      const lifecycle = { repository: "openclaw/openclaw", sha };
      recordCommitWorkflowEvent(lifecycle, "started");
      recordCommitWorkflowEvent(lifecycle, "completed");
      recordCommitWorkflowEvent(lifecycle, "finalized");
      paths.push(...(await flushWorkflowActionEvents(spoolRoot)));
      fs.rmSync(spoolRoot, { force: true, recursive: true });
    }

    assert.equal(new Set(paths).size, commits.length);
    assert.ok(paths.every((entry, index) => entry.includes(`commit-${commits[index]}`)));
    const imported = importActionEventShards(outputRoot, destination);
    assert.equal(imported.created, commits.length);
    const subjects = new Set(
      readEvents(destination).map((event) => String(event.subject?.source_revision)),
    );
    assert.deepEqual(subjects, new Set(commits));
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("trusted commit review attestation binds the immutable report before publication", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-attestor-")));
  const outputRoot = path.join(root, "output");
  const sha = "b".repeat(40);
  const reportPath = path.join(root, `${sha}.md`);
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(
    reportPath,
    `---\nresult: nothing_found\nsha: ${sha}\nrepository: openclaw/openclaw\n---\n\nNo findings.\n`,
  );
  const previous = { ...process.env };
  const env = { ...process.env, ...workflowEnv(root, outputRoot), GITHUB_JOB: "attest" };
  Object.assign(process.env, env);

  try {
    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "dist/commit-sweeper.js"),
        "attest-review",
        "--target-repo",
        "openclaw/openclaw",
        "--commit-sha",
        sha,
        "--report-path",
        reportPath,
      ],
      { env, stdio: "pipe" },
    );
    await flushWorkflowActionEvents(root);

    const events = readEvents(outputRoot).sort((left, right) => left.phase_seq - right.phase_seq);
    assert.equal(
      events.filter(
        (event) =>
          event.attributes?.publication_kind === "commit_review_report" &&
          event.attributes?.state === "prepared",
      ).length,
      1,
    );
    assert.deepEqual(
      events
        .filter((event) => event.event_type === ACTION_EVENT_TYPES.workflowAttempt)
        .map((event) => event.attributes?.state),
      [],
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit review check publication completes before the workflow is finalized", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-lifecycle-order-")));
  const outputRoot = path.join(root, "output");
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  Object.assign(process.env, workflowEnv(root, outputRoot));
  const lifecycle = { repository: "openclaw/openclaw", sha: "b".repeat(40) };

  try {
    recordCommitWorkflowEvent(lifecycle, "started");
    runCommitMutation(lifecycle, {
      kind: "commit_check_publication",
      identity: { sha: lifecycle.sha },
      operation: () => undefined,
    });
    recordCommitWorkflowEvent(lifecycle, "completed");
    recordCommitWorkflowEvent(lifecycle, "finalized");
    await flushWorkflowActionEvents(root);

    const events = readEvents(outputRoot).sort((left, right) => left.phase_seq - right.phase_seq);
    assert.deepEqual(
      events
        .filter((event) => event.event_type === ACTION_EVENT_TYPES.workflowAttempt)
        .map((event) => event.attributes?.state),
      ["started", "completed", "finalized"],
    );
    assert.equal(events.at(-1)?.attributes?.state, "finalized");
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit check publisher owns every privileged check write and installs attested causality", () => {
  const workflow = readText(".github/workflows/commit-review.yml");
  const review = workflow.slice(workflow.indexOf("\n  review:"), workflow.indexOf("\n  publish:"));
  const publisher = workflow.slice(workflow.indexOf("\n  publish:"));

  assert.match(review, /setup-action-ledger/);
  assert.doesNotMatch(review, /permission-checks: write|publish-check|create-state-token/);
  assert.match(publisher, /Attest current-attempt commit review reports/);
  assert.match(publisher, /attest-review/);
  assert.match(publisher, /commit-review-action-ledger-causality\.json/);
  assert.match(publisher, /CLAWSWEEPER_COMMIT_ACTION_LEDGER_PRIOR_CONTEXT=/);
  assert.match(publisher, /--expected-job review/);
  assert.doesNotMatch(
    publisher,
    /accepted-commit-review-check-shas|skipping duplicate write|completion_reason == "mutation_accepted"/,
  );
  assert.match(
    publisher,
    /find commit-artifacts[\s\S]*node dist\/commit-sweeper\.js publish-check/,
  );
  assert.match(publisher, /--report-repo openclaw\/clawsweeper-state/);
  assert.match(
    publisher,
    /--report-revision "\$\{\{ steps\.publish-reports\.outputs\.state_revision \}\}"/,
  );
  assert.match(
    publisher,
    /Publish commit checks[\s\S]*id: publish-checks[\s\S]*publish-check[\s\S]*--continue-workflow/,
  );
  assert.match(
    publisher,
    /Finalize commit review lifecycles[\s\S]*always\(\)[\s\S]*steps\.verify-review-bundles\.outcome == 'success'[\s\S]*ATTEST_OUTCOME:[\s\S]*PUBLISH_CHECKS_OUTCOME:[\s\S]*PUBLISH_REPORTS_OUTCOME:[\s\S]*finish-review[\s\S]*--review-outcome "\$review_outcome"[\s\S]*--check-outcome "\$check_outcome"[\s\S]*--checks-requested "\$CHECKS_REQUESTED"/,
  );
  assert.doesNotMatch(publisher, /finish-review[\s\S]{0,400}--start-workflow/);
  assert.ok(
    publisher.indexOf("repair:action-ledger -- verify") <
      publisher.indexOf("CLAWSWEEPER_COMMIT_ACTION_LEDGER_PRIOR_CONTEXT="),
  );
});

test("commit checks link to the exact immutable report revision", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-check-report-url-")));
  const reportPath = path.join(root, "report.md");
  const sha = "b".repeat(40);
  const reportRevision = "f".repeat(40);
  const relativePath = `records/openclaw-openclaw/commits/${sha}.md`;
  const ghLog = path.join(root, "gh.log");
  const ghPath = mockGh(root, ghLog);
  fs.writeFileSync(
    reportPath,
    `---\nresult: findings\nsha: ${sha}\nrepository: openclaw/openclaw\nhighest_severity: high\n---\n`,
  );

  try {
    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "dist", "commit-sweeper.js"),
        "publish-check",
        "--target-repo",
        "openclaw/openclaw",
        "--commit-sha",
        sha,
        "--report-path",
        reportPath,
        "--report-relative-path",
        relativePath,
        "--report-repo",
        "openclaw/clawsweeper-state",
        "--report-revision",
        reportRevision,
      ],
      {
        env: {
          ...process.env,
          ...mockGhBinEnv(ghPath, path.dirname(ghPath)),
        },
        stdio: "pipe",
      },
    );

    const payload = JSON.parse(fs.readFileSync(path.join(root, "report.check-run.json"), "utf8"));
    const expectedUrl = `https://github.com/openclaw/clawsweeper-state/blob/${reportRevision}/${relativePath}`;
    assert.equal(payload.details_url, expectedUrl);
    assert.equal(payload.output.text, `Report: ${expectedUrl}`);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit check retries continue authenticated shard causality", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-check-causality-")));
  const reviewRoot = path.join(root, "review-spool");
  const reviewOutput = path.join(root, "review-output");
  const publishRoot = path.join(root, "publish-spool");
  const publishOutput = path.join(root, "publish-output");
  const contextPath = path.join(root, "prior-context.json");
  for (const directory of [reviewRoot, reviewOutput, publishRoot, publishOutput]) {
    fs.mkdirSync(directory);
  }
  const previous = { ...process.env };
  const lifecycle = { repository: "openclaw/openclaw", sha: "b".repeat(40) };
  const identity = { sha: lifecycle.sha, reportSha256: "c".repeat(64) };

  try {
    Object.assign(process.env, workflowEnv(reviewRoot, reviewOutput), {
      GITHUB_JOB: "review",
    });
    runCommitMutation(lifecycle, {
      kind: "commit_check_publication",
      identity,
      operation: () => "first",
    });
    const eventPaths = await flushCommitActionEvents();
    const reviewEvents = readEvents(reviewOutput);
    const priorAccepted = reviewEvents.at(-1);
    assert.ok(priorAccepted);
    const recordedProducer = reviewEvents[0]?.producer;
    assert.ok(recordedProducer);
    assert.equal(recordedProducer.job, "review");
    const producer = {
      repository: recordedProducer.repository,
      sha: recordedProducer.sha,
      workflow: recordedProducer.workflow,
      job: recordedProducer.job,
      run_id: recordedProducer.run_id,
      run_attempt: recordedProducer.run_attempt,
    };
    fs.writeFileSync(
      contextPath,
      `${JSON.stringify([
        {
          source_root: reviewOutput,
          event_paths: eventPaths,
          producer,
          subject: lifecycle,
        },
      ])}\n`,
    );

    Object.assign(process.env, workflowEnv(publishRoot, publishOutput), {
      CLAWSWEEPER_COMMIT_ACTION_LEDGER_PRIOR_CONTEXT: contextPath,
      GITHUB_JOB: "publish",
    });
    assert.equal(
      runCommitMutation(lifecycle, {
        kind: "commit_check_publication",
        identity,
        operation: () => "second",
      }),
      "second",
    );
    await flushCommitActionEvents();

    const publishEvents = readEvents(publishOutput);
    assert.deepEqual(
      reviewEvents.map((event) => event.attributes?.attempt),
      [1, 1],
    );
    assert.deepEqual(
      publishEvents.map((event) => event.attributes?.attempt),
      [2, 2],
    );
    assert.deepEqual(
      publishEvents.map((event) => event.phase_seq),
      [3, 4],
    );
    assert.equal(publishEvents[0]?.parent_event_id, priorAccepted.event_id);
    assert.equal(
      new Set([...reviewEvents, ...publishEvents].map((event) => event.idempotency_key_sha256))
        .size,
      1,
    );
    assert.equal(
      new Set([...reviewEvents, ...publishEvents].map((event) => event.attempt_id)).size,
      1,
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit check causality rejects unauthenticated prior shards before the wire request", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "commit-check-causality-auth-")),
  );
  const reviewRoot = path.join(root, "review-spool");
  const reviewOutput = path.join(root, "review-output");
  const publishRoot = path.join(root, "publish-spool");
  const publishOutput = path.join(root, "publish-output");
  const contextPath = path.join(root, "prior-context.json");
  for (const directory of [reviewRoot, reviewOutput, publishRoot, publishOutput]) {
    fs.mkdirSync(directory);
  }
  const previous = { ...process.env };
  const lifecycle = { repository: "openclaw/openclaw", sha: "b".repeat(40) };
  let wireRequests = 0;

  try {
    Object.assign(process.env, workflowEnv(reviewRoot, reviewOutput));
    runCommitMutation(lifecycle, {
      kind: "commit_check_publication",
      identity: { sha: lifecycle.sha },
      operation: () => undefined,
    });
    const eventPaths = await flushCommitActionEvents();
    const recordedProducer = readEvents(reviewOutput)[0]?.producer;
    assert.ok(recordedProducer);
    const producer = {
      repository: recordedProducer.repository,
      sha: recordedProducer.sha,
      workflow: recordedProducer.workflow,
      job: "attest",
      run_id: recordedProducer.run_id,
      run_attempt: recordedProducer.run_attempt,
    };
    fs.writeFileSync(
      contextPath,
      `${JSON.stringify([
        {
          source_root: reviewOutput,
          event_paths: eventPaths,
          producer,
          subject: lifecycle,
        },
      ])}\n`,
    );

    Object.assign(process.env, workflowEnv(publishRoot, publishOutput), {
      CLAWSWEEPER_COMMIT_ACTION_LEDGER_PRIOR_CONTEXT: contextPath,
      GITHUB_JOB: "publish",
    });
    assert.throws(
      () =>
        runCommitMutation(lifecycle, {
          kind: "commit_check_publication",
          identity: { sha: lifecycle.sha },
          operation: () => {
            wireRequests += 1;
          },
        }),
      /prior context producer is not authenticated/,
    );
    assert.equal(wireRequests, 0);
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit finding dispatch records the concrete request before publication finalization", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-dispatch-ledger-")));
  const outputRoot = path.join(root, "output");
  const artifactDir = path.join(root, "commit-artifacts", "openclaw-openclaw", "commits");
  const sha = "b".repeat(40);
  const reportRevision = "f".repeat(40);
  const reportPath = path.join(artifactDir, `${sha}.md`);
  const githubOutput = path.join(root, "github-output.txt");
  const ghLog = path.join(root, "gh.log");
  const ghPath = mockGh(root, ghLog);
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    reportPath,
    `---\nresult: findings\nsha: ${sha}\nrepository: openclaw/openclaw\nhighest_severity: P1\ncheck_conclusion: failure\n---\n`,
  );
  const previous = { ...process.env };
  const env = {
    ...process.env,
    ...workflowEnv(root, outputRoot),
    ...mockGhBinEnv(ghPath, path.dirname(ghPath)),
    GITHUB_ACTION: "dispatch_findings",
    GITHUB_JOB: "publish",
    GITHUB_OUTPUT: githubOutput,
    MOCK_GH_LOG: ghLog,
  };
  Object.assign(process.env, env);

  try {
    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "dist", "commit-sweeper.js"),
        "dispatch-findings",
        "--artifact-dir",
        path.join(root, "commit-artifacts"),
        "--repair-repo",
        "openclaw/clawsweeper",
        "--repair-workflow",
        "repair-commit-finding-intake.yml",
        "--dispatch-mode",
        "workflow_dispatch",
        "--report-repo",
        "openclaw/clawsweeper-state",
        "--report-revision",
        reportRevision,
      ],
      { env, stdio: "pipe" },
    );
    await flushWorkflowActionEvents(root);

    assert.match(fs.readFileSync(githubOutput, "utf8"), /^dispatch_count=1$/m);
    const ghInvocations = fs.readFileSync(ghLog, "utf8").trim().split("\n");
    assert.equal(ghInvocations.length, 1);
    const ghArgs = JSON.parse(ghInvocations[0]!) as string[];
    assert.match(
      ghArgs.find((arg) => arg.startsWith("dispatch_key=")) ?? "",
      /^dispatch_key=commit-finding-[a-f0-9]{24}$/,
    );
    assert.ok(ghArgs.includes("payload_version=2"));
    assert.ok(ghArgs.includes(`report_revision=${reportRevision}`));
    assert.match(
      ghArgs.find((arg) => arg.startsWith("report_sha256=")) ?? "",
      /^report_sha256=[a-f0-9]{64}$/,
    );
    const events = readEvents(outputRoot).filter(
      (event) => event.attributes?.publication_kind === "commit_finding_dispatch",
    );
    assert.deepEqual(
      events.map((event) => event.action.status),
      ["started", "published"],
    );
    assert.ok(events.every((event) => event.subject?.source_revision === sha));
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("repository and workflow commit finding dispatches share one stable receipt key", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-dispatch-key-")));
  const artifactDir = path.join(root, "commit-artifacts", "openclaw-openclaw", "commits");
  const sha = "e".repeat(40);
  const reportRevision = "a".repeat(40);
  const reportPath = path.join(artifactDir, `${sha}.md`);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    reportPath,
    `---\nresult: findings\nsha: ${sha}\nrepository: openclaw/openclaw\nhighest_severity: P1\ncheck_conclusion: failure\n---\n`,
  );

  try {
    const common = [
      path.join(process.cwd(), "dist", "commit-sweeper.js"),
      "dispatch-findings",
      "--artifact-dir",
      path.join(root, "commit-artifacts"),
      "--repair-repo",
      "openclaw/clawsweeper",
      "--repair-workflow",
      "repair-commit-finding-intake.yml",
      "--report-repo",
      "openclaw/clawsweeper-state",
      "--report-revision",
      reportRevision,
      "--dry-run",
    ];
    const repositoryPayload = JSON.parse(
      execFileSync(process.execPath, [...common, "--dispatch-mode", "repository_dispatch"], {
        encoding: "utf8",
      }),
    );
    const workflowCommand = execFileSync(
      process.execPath,
      [...common, "--dispatch-mode", "workflow_dispatch"],
      { encoding: "utf8" },
    );
    const dispatchKey = String(repositoryPayload.client_payload.dispatch_key);

    assert.match(dispatchKey, /^commit-finding-[a-f0-9]{24}$/);
    assert.match(workflowCommand, new RegExp(`dispatch_key=${dispatchKey}`));
    assert.equal(repositoryPayload.client_payload.payload_version, 2);
    assert.match(workflowCommand, /payload_version=2/);
    assert.equal(repositoryPayload.client_payload.report_revision, reportRevision);
    assert.match(repositoryPayload.client_payload.report_sha256, /^[a-f0-9]{64}$/);

    const alternateRevisionArgs = [...common];
    alternateRevisionArgs[alternateRevisionArgs.indexOf(reportRevision)] = "f".repeat(40);
    const alternateRevisionPayload = JSON.parse(
      execFileSync(
        process.execPath,
        [...alternateRevisionArgs, "--dispatch-mode", "repository_dispatch"],
        { encoding: "utf8" },
      ),
    );
    assert.equal(alternateRevisionPayload.client_payload.dispatch_key, dispatchKey);

    fs.appendFileSync(reportPath, "\nchanged\n");
    const changedPayload = JSON.parse(
      execFileSync(process.execPath, [...common, "--dispatch-mode", "repository_dispatch"], {
        encoding: "utf8",
      }),
    );
    assert.notEqual(changedPayload.client_payload.dispatch_key, dispatchKey);
    assert.notEqual(
      changedPayload.client_payload.report_sha256,
      repositoryPayload.client_payload.report_sha256,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("ambiguous commit finding dispatch failures are not retried", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "commit-dispatch-ambiguous-")),
  );
  const outputRoot = path.join(root, "output");
  const artifactDir = path.join(root, "commit-artifacts", "openclaw-openclaw", "commits");
  const sha = "d".repeat(40);
  const reportRevision = "c".repeat(40);
  const reportPath = path.join(artifactDir, `${sha}.md`);
  const ghLog = path.join(root, "gh.log");
  const ghPath = mockGh(root, ghLog, {
    exitCode: 1,
    stderr: "HTTP 502: upstream response lost",
  });
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    reportPath,
    `---\nresult: findings\nsha: ${sha}\nrepository: openclaw/openclaw\nhighest_severity: P1\ncheck_conclusion: failure\n---\n`,
  );
  const previous = { ...process.env };
  const env = {
    ...process.env,
    ...workflowEnv(root, outputRoot),
    ...mockGhBinEnv(ghPath, path.dirname(ghPath)),
    GITHUB_ACTION: "dispatch_findings",
    GITHUB_JOB: "publish",
    MOCK_GH_LOG: ghLog,
  };
  Object.assign(process.env, env);

  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            path.join(process.cwd(), "dist", "commit-sweeper.js"),
            "dispatch-findings",
            "--artifact-dir",
            path.join(root, "commit-artifacts"),
            "--repair-repo",
            "openclaw/clawsweeper",
            "--repair-workflow",
            "repair-commit-finding-intake.yml",
            "--dispatch-mode",
            "workflow_dispatch",
            "--report-repo",
            "openclaw/clawsweeper-state",
            "--report-revision",
            reportRevision,
          ],
          { env, stdio: "pipe" },
        ),
      /failed to dispatch/,
    );
    await flushWorkflowActionEvents(root);

    assert.equal(fs.readFileSync(ghLog, "utf8").trim().split("\n").length, 1);
    const events = readEvents(outputRoot).filter(
      (event) => event.attributes?.publication_kind === "commit_finding_dispatch",
    );
    assert.deepEqual(
      events.map((event) => [
        event.action.status,
        event.action.mutation,
        event.attributes?.completion_reason,
      ]),
      [
        ["started", false, "mutation_attempted"],
        ["failed", true, "mutation_outcome_unknown"],
      ],
    );
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit range continuation dispatch records its own request and outcome", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "commit-continuation-ledger-")),
  );
  const outputRoot = path.join(root, "output");
  const ghLog = path.join(root, "gh.log");
  const ghPath = mockGh(root, ghLog);
  const sha = "c".repeat(40);
  fs.mkdirSync(outputRoot);
  const previous = { ...process.env };
  const env = {
    ...process.env,
    ...workflowEnv(root, outputRoot),
    ...mockGhBinEnv(ghPath, path.dirname(ghPath)),
    COMMIT_SWEEPER_ADDITIONAL_PROMPT: "--commit-offset",
    GITHUB_ACTION: "continue_commit_review",
    GITHUB_JOB: "publish",
    MOCK_GH_LOG: ghLog,
  };
  Object.assign(process.env, env);

  try {
    execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), "dist", "commit-sweeper.js"),
        "dispatch-continuation",
        "--repository",
        "openclaw/clawsweeper",
        "--target-repo",
        "openclaw/openclaw",
        "--after-sha",
        sha,
        "--commit-offset",
        "20",
        "--create-checks",
        "true",
      ],
      { env, stdio: "pipe" },
    );
    await flushWorkflowActionEvents(root);

    const ghArgs = JSON.parse(fs.readFileSync(ghLog, "utf8").trim());
    assert.deepEqual(ghArgs.slice(0, 4), ["workflow", "run", "commit-review.yml", "--repo"]);
    assert.match(
      ghArgs.find((arg: string) => arg.startsWith("continuation_key=")) ?? "",
      /^continuation_key=commit-review-continuation-[a-f0-9]{24}$/,
    );
    assert.ok(ghArgs.includes("commit_offset=20"));
    assert.ok(ghArgs.includes("additional_prompt=--commit-offset"));
    const events = readEvents(outputRoot).filter(
      (event) => event.attributes?.publication_kind === "commit_review_continuation_dispatch",
    );
    assert.deepEqual(
      events.map((event) => event.action.status),
      ["started", "published"],
    );
    assert.ok(events.every((event) => event.subject?.source_revision === sha));
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("commit range continuation dispatch keys are replay-stable and offset-bound", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-continuation-key-")));
  const ghLog = path.join(root, "gh.log");
  const ghPath = mockGh(root, ghLog);
  const sha = "9".repeat(40);
  const env = {
    ...process.env,
    ...mockGhBinEnv(ghPath, path.dirname(ghPath)),
    MOCK_GH_LOG: ghLog,
  };
  const command = [
    path.join(process.cwd(), "dist", "commit-sweeper.js"),
    "dispatch-continuation",
    "--repository",
    "openclaw/clawsweeper",
    "--target-repo",
    "openclaw/openclaw",
    "--after-sha",
    sha,
    "--commit-offset",
    "20",
    "--create-checks",
    "true",
  ];

  try {
    execFileSync(process.execPath, command, { env, stdio: "pipe" });
    execFileSync(process.execPath, command, { env, stdio: "pipe" });
    execFileSync(
      process.execPath,
      command.map((arg) => (arg === "20" ? "21" : arg)),
      { env, stdio: "pipe" },
    );

    const invocations = fs
      .readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const keys = invocations.map(
      (invocation) =>
        invocation.find((arg) => arg.startsWith("continuation_key="))?.split("=")[1] ?? "",
    );
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[1], keys[2]);
    assert.ok(keys.every((key) => /^commit-review-continuation-[a-f0-9]{24}$/.test(key)));
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function workflowEnv(root: string, outputRoot: string) {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-12",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
    GITHUB_ACTION: "commit_review",
    GITHUB_JOB: "review",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "5252",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "commit review",
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/commit-review.yml@refs/heads/main",
    GITHUB_RUN_STARTED_AT: "2026-07-12T00:00:00Z",
  };
}

function mockGh(
  root: string,
  logPath: string,
  options: { exitCode?: number; stderr?: string } = {},
): string {
  const binDir = path.join(root, "bin");
  const ghPath = path.join(binDir, "gh");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env node",
      `require("node:fs").appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      ...(options.stderr ? [`process.stderr.write(${JSON.stringify(options.stderr)});`] : []),
      ...(options.exitCode ? [`process.exitCode = ${options.exitCode};`] : []),
      "",
    ].join("\n"),
  );
  fs.chmodSync(ghPath, 0o755);
  return ghPath;
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

function restoreEnv(previous: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}
