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
  registerActionSession,
  updateActionSession,
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

test("CrabFleet registration response loss records one unknown request outcome", async () => {
  const fixture = remoteSessionFixture("register");
  let requests = 0;
  try {
    await assert.rejects(
      registerActionSession(fixture.jobPath, {
        fetchImpl: async () => {
          requests += 1;
          throw new Error("connection reset after request submission");
        },
      }),
      /connection reset/,
    );
    assert.equal(requests, 1);
    assertUnknownMutation(fixture.outputRoot);
  } finally {
    fixture.cleanup();
  }
});

test("CrabFleet registration keeps ambiguous HTTP failures unknown", async () => {
  const fixture = remoteSessionFixture("register-503");
  try {
    await assert.rejects(
      registerActionSession(fixture.jobPath, {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 }),
      }),
      /registration failed \(503\)/,
    );
    assertUnknownMutation(fixture.outputRoot);
  } finally {
    fixture.cleanup();
  }
});

test("CrabFleet registration records definite request rejection", async () => {
  const fixture = remoteSessionFixture("register-422");
  try {
    await assert.rejects(
      registerActionSession(fixture.jobPath, {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "invalid request" }), { status: 422 }),
      }),
      /registration failed \(422\)/,
    );
    assertRejectedMutation(fixture.outputRoot);
  } finally {
    fixture.cleanup();
  }
});

test("CrabFleet update response loss records one unknown request outcome", async () => {
  const fixture = remoteSessionFixture("update");
  writeRemoteSessionMetadata(fixture.metadataPath);
  let requests = 0;
  try {
    await assert.rejects(
      updateActionSession(
        {
          state: "running",
          phase: "review",
          summary: "Reviewing",
          completionReason: "",
        },
        {
          fetchImpl: async () => {
            requests += 1;
            throw new Error("socket closed after request submission");
          },
        },
      ),
      /socket closed/,
    );
    assert.equal(requests, 1);
    assertUnknownMutation(fixture.outputRoot);
  } finally {
    fixture.cleanup();
  }
});

test("CrabFleet update identity binds the full semantic POST request", async () => {
  const fixture = remoteSessionFixture("update-identity");
  writeRemoteSessionMetadata(fixture.metadataPath);
  const base = {
    state: "running",
    phase: "review",
    summary: "Reviewing",
    completionReason: "",
  };
  try {
    const requests = [
      base,
      { ...base },
      { ...base, summary: "Review complete" },
      { ...base, completionReason: "review_complete" },
    ];
    for (const [index, request] of requests.entries()) {
      process.env.CLAWSWEEPER_ACTION_LEDGER_INVOCATION = `update-identity-${index}`;
      process.env.GITHUB_ACTION = `session_update_identity_${index}`;
      await updateActionSession(request, {
        fetchImpl: async () => new Response(null, { status: 204 }),
      });
    }

    const keys = mutationAttempts(fixture.outputRoot).map((event) => event.idempotency_key_sha256);
    assert.equal(keys.length, 4);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.notEqual(keys[0], keys[3]);
    assert.equal(new Set(keys).size, 3);
  } finally {
    fixture.cleanup();
  }
});

function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function remoteSessionFixture(name: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `action-session-${name}-`)));
  const outputRoot = path.join(root, "output");
  const metadataPath = path.join(root, "action-session.json");
  const githubEnvPath = path.join(root, "github.env");
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
  const previous = { ...process.env };
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: name,
    CLAWSWEEPER_ACTION_SESSION_METADATA: metadataPath,
    CLAWSWEEPER_ACTION_SESSION_REMOTE: "1",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "agent-secret",
    CLAWSWEEPER_CRABFLEET_OWNER: "@maintainer",
    CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: "service-secret",
    CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: "https://crabfleet.example/work-state",
    GITHUB_ACTION: `session_${name}`,
    GITHUB_ENV: githubEnvPath,
    GITHUB_JOB: "cluster",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "4242",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  });
  return {
    outputRoot,
    metadataPath,
    jobPath,
    cleanup() {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeRemoteSessionMetadata(metadataPath: string): void {
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify({
      remoteEnabled: true,
      repository: "openclaw/openclaw",
      workKey: "openclaw/openclaw:repair-pr-42",
      workKind: "pr_repair",
      clusterId: "repair-pr-42",
      sourceRevision: "b".repeat(40),
      sessionId: "session-42",
    })}\n`,
  );
}

function mutationAttempts(outputRoot: string): Array<Record<string, unknown>> {
  return walk(outputRoot)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
    .filter(
      (event) =>
        event.event_type === "repair.mutation" &&
        (event.action as Record<string, unknown>).status === "started",
    );
}

function assertUnknownMutation(outputRoot: string): void {
  assertMutationOutcome(outputRoot, [
    ["started", "mutation_attempted", true],
    ["failed", "mutation_outcome_unknown", true],
  ]);
}

function assertRejectedMutation(outputRoot: string): void {
  assertMutationOutcome(outputRoot, [
    ["started", "mutation_attempted", true],
    ["skipped", "mutation_rejected", false],
  ]);
}

function assertMutationOutcome(
  outputRoot: string,
  expected: Array<[string, string, boolean]>,
): void {
  const mutations = walk(outputRoot)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
    .filter((event) => event.event_type === "repair.mutation");
  assert.deepEqual(
    mutations.map((event) => [
      event.action.status,
      event.attributes.completion_reason,
      event.action.retryable,
    ]),
    expected,
  );
}
