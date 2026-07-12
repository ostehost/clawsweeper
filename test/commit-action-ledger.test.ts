import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACTION_EVENT_TYPES } from "../dist/action-ledger.js";
import { flushWorkflowActionEvents } from "../dist/action-ledger-runtime.js";
import { recordCommitWorkflowEvent, runCommitMutation } from "../dist/commit-action-ledger.js";

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
