import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACTION_EVENT_TYPES } from "../../dist/action-ledger.js";
import {
  commitGeneratedCheckpointIfNeeded,
  compactGeneratedBranchHistory,
} from "../../dist/repair/compact-generated-branch.js";
import {
  flushRepairActionEvents,
  runRepairMutation,
} from "../../dist/repair/repair-action-ledger.js";
import { readText } from "../helpers.ts";

test("execute-fix checkpoints receipt edit, fix, final-review, sync, and final lineage", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "execute-fix-checkpoint-ledger-")),
  );
  const outputRoot = path.join(root, "output");
  const targetDir = path.join(root, "target");
  const previousEnv = { ...process.env };
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(targetDir);
  Object.assign(process.env, workflowEnv(root, outputRoot, "checkpoint"));
  initRepository(targetDir);
  const lifecycle = repairLifecycle("checkpoint");

  try {
    for (const [index, checkpoint] of [
      "edit",
      "validation-fix:1",
      "review-fix:1",
      "final-review-fix:4",
      "final-sync:1",
      "final",
    ].entries()) {
      fs.writeFileSync(path.join(targetDir, "runtime.ts"), `export const value = ${index + 2};\n`);
      const options = {
        targetDir,
        message: `fix: ${checkpoint}`,
        checkpoint,
        lifecycle,
      };
      if (checkpoint === "validation-fix:1") {
        assert.throws(
          () =>
            commitGeneratedCheckpointIfNeeded({
              ...options,
              commitCommand: (args) => {
                git(targetDir, ...args);
                throw new Error("checkpoint response lost after commit");
              },
            }),
          /checkpoint response lost after commit/,
        );
      } else {
        assert.match(commitGeneratedCheckpointIfNeeded(options), /^[0-9a-f]{40}$/);
      }
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal(
        commitGeneratedCheckpointIfNeeded({
          targetDir,
          message: "fix: final",
          checkpoint: "final",
          lifecycle,
        }),
        "",
      );
    }

    runRepairMutation(lifecycle, {
      kind: "branch_push",
      identity: {
        repo: "openclaw/openclaw",
        branch: "clawsweeper/test",
        head: git(targetDir, "rev-parse", "HEAD").trim(),
      },
      component: "execute_fix",
      operation: () => "pushed",
    });
    await flushRepairActionEvents();

    const mutations = readEvents(outputRoot).filter(
      (event) => event.event_type === ACTION_EVENT_TYPES.repairMutation,
    );
    const groups = Map.groupBy(mutations, (event) => String(event.operation_id));
    assert.equal(groups.size, 2, "local lineage and branch publication stay separate");
    const local = [...groups.values()].find((events) => events.length === 16);
    const push = [...groups.values()].find((events) => events.length === 2);
    assert.ok(local);
    assert.ok(push);

    const localTerminal = local
      .filter((event) => event.attributes?.completion_reason !== "mutation_attempted")
      .sort((left, right) => Number(left.phase_seq) - Number(right.phase_seq));
    assert.deepEqual(
      localTerminal.map((event) => event.attributes?.completion_reason),
      [
        "mutation_accepted",
        "mutation_accepted",
        "mutation_accepted",
        "mutation_accepted",
        "mutation_accepted",
        "mutation_accepted",
        "mutation_rejected",
        "mutation_rejected",
      ],
    );
    assert.equal(
      new Set(localTerminal.slice(0, 6).map((event) => event.idempotency_key_sha256)).size,
      6,
      "each committed tree has a distinct digest-bound identity",
    );
    assert.equal(
      localTerminal.at(-1)?.idempotency_key_sha256,
      localTerminal.at(-2)?.idempotency_key_sha256,
      "repeated no-op attempts retain stable business identity",
    );
    assert.deepEqual(
      push.map((event) => event.attributes?.completion_reason),
      ["mutation_attempted", "mutation_accepted"],
    );
  } finally {
    restoreEnv(previousEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated history compaction receipts accepted, rejected, and unknown truth", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "execute-fix-compaction-ledger-")),
  );
  const outputRoot = path.join(root, "output");
  const previousEnv = { ...process.env };
  fs.mkdirSync(outputRoot);
  Object.assign(process.env, workflowEnv(root, outputRoot, "compaction"));

  try {
    const acceptedDir = createCheckpointRepository(root, "accepted");
    const reviewedTree = git(acceptedDir, "rev-parse", "HEAD^{tree}").trim();
    const accepted = compactGeneratedBranchHistory({
      targetDir: acceptedDir,
      baseRef: "origin/main",
      message: "fix: compact accepted",
      lifecycle: repairLifecycle("compaction-accepted"),
    });
    assert.equal(accepted.status, "compacted");
    assert.equal(git(acceptedDir, "rev-parse", "HEAD^{tree}").trim(), reviewedTree);
    assert.equal(
      compactGeneratedBranchHistory({
        targetDir: acceptedDir,
        baseRef: "origin/main",
        message: "fix: compact accepted",
        lifecycle: repairLifecycle("compaction-accepted"),
      }).status,
      "unchanged",
    );

    const acceptedErrorDir = createCheckpointRepository(root, "accepted-error");
    assert.throws(
      () =>
        compactGeneratedBranchHistory({
          targetDir: acceptedErrorDir,
          baseRef: "origin/main",
          message: "fix: compact despite lost response",
          lifecycle: repairLifecycle("compaction-accepted-error"),
          commitCommand: (args) => {
            git(acceptedErrorDir, ...args);
            throw new Error("compaction response lost after commit");
          },
        }),
      /compaction response lost after commit/,
    );
    assert.equal(git(acceptedErrorDir, "rev-list", "--count", "origin/main..HEAD").trim(), "1");

    const unknownDir = createCheckpointRepository(root, "unknown");
    assert.throws(
      () =>
        compactGeneratedBranchHistory({
          targetDir: unknownDir,
          baseRef: "origin/main",
          message: "fix: partial compaction",
          lifecycle: repairLifecycle("compaction-unknown"),
          commitCommand: () => {
            throw new Error("commit failed after soft reset");
          },
        }),
      /commit failed after soft reset/,
    );
    await flushRepairActionEvents();

    const terminal = readEvents(outputRoot)
      .filter(
        (event) =>
          event.event_type === ACTION_EVENT_TYPES.repairMutation &&
          event.attributes?.completion_reason !== "mutation_attempted",
      )
      .map((event) => event.attributes?.completion_reason)
      .sort();
    assert.deepEqual(terminal, [
      "mutation_accepted",
      "mutation_accepted",
      "mutation_outcome_unknown",
      "mutation_rejected",
    ]);
  } finally {
    restoreEnv(previousEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("execute-fix stops checkpointing after review and keeps push receipts separate", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));

  assert.match(source, /checkpoint: "edit"/);
  assert.match(source, /checkpoint: repairReviewCheckpoint\(reviewAttempt\)/);
  assert.ok(source.includes('return `validation-fix:${attempt.slice("validation-".length)}`;'));
  assert.ok(source.includes('return `final-review-fix:${attempt.slice(0, -"-final".length)}`;'));
  assert.ok(source.includes("return `review-fix:${attempt}`;"));
  assert.doesNotMatch(source, /checkpoint: "final-sync:1"/);
  assert.doesNotMatch(source, /checkpoint: "final"/);
  assert.match(source, /const reviewedCommit = reviewedTree\.receipt\.headSha/);
  assert.match(source, /const reviewedTreeSha = reviewedTree\.receipt\.headTreeSha/);
  assert.match(
    source,
    /assertCommitTree\(\{ targetDir, commit, expectedTree: reviewedTreeSha \}\)/,
  );
  assert.match(source, /lifecycle: directRepairLifecycle\(null\)/);
  assert.match(source, /runDirectRepairMutation\(\s*"branch_push"/);
});

function initRepository(targetDir: string) {
  git(targetDir, "init", "-b", "main");
  git(targetDir, "config", "user.name", "ClawSweeper");
  git(targetDir, "config", "user.email", "clawsweeper@example.com");
  fs.writeFileSync(path.join(targetDir, "runtime.ts"), "export const value = 1;\n");
  git(targetDir, "add", "--all");
  git(targetDir, "commit", "-m", "initial");
  git(targetDir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(targetDir, "checkout", "-b", "clawsweeper/test");
}

function createCheckpointRepository(root: string, name: string) {
  const targetDir = path.join(root, name);
  fs.mkdirSync(targetDir);
  initRepository(targetDir);
  for (const value of [2, 3]) {
    fs.writeFileSync(path.join(targetDir, "runtime.ts"), `export const value = ${value};\n`);
    git(targetDir, "add", "--all");
    git(targetDir, "commit", "-m", `checkpoint ${value}`);
  }
  return targetDir;
}

function repairLifecycle(clusterId: string) {
  return {
    repository: "openclaw/openclaw",
    workKey: `execute-fix:openclaw/openclaw:${clusterId}`,
    clusterId,
    sourceRevision: "source-revision",
    subjectKind: "workflow" as const,
  };
}

function workflowEnv(root: string, outputRoot: string, invocation: string) {
  return {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: invocation,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
    CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: "",
    CLAWSWEEPER_CRABFLEET_SESSION_ID: "",
    GITHUB_ACTION: "execute_fix",
    GITHUB_JOB: "execute",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "521",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  };
}

function readEvents(root: string): Record<string, any>[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return readEvents(target);
    if (!target.endsWith(".jsonl")) return [];
    return fs
      .readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  });
}

function restoreEnv(previous: NodeJS.ProcessEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) delete process.env[key];
  }
  Object.assign(process.env, previous);
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
