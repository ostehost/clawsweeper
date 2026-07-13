import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readValidatedActionEventShardBatch } from "../dist/action-ledger-runtime.js";
import { readText } from "./helpers.ts";

test("proof commands emit validated stage and report receipts for empty scans", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proof-ledger-")));
  const outputRoot = fs.realpathSync(fs.mkdtempSync(path.join(root, "output-")));
  const reportPath = path.join(root, "proof-report.json");
  const runId = `${process.pid}${Date.now()}`;
  try {
    const result = spawnSync(
      process.execPath,
      [
        "dist/clawsweeper.js",
        "proof-nudges",
        "--target-repo",
        "openclaw/openclaw",
        "--items-dir",
        path.join(root, "missing"),
        "--report-path",
        reportPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
          CLAWSWEEPER_ACTION_LEDGER_INVOCATION: path.basename(root).replaceAll(".", "-"),
          CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
          GITHUB_ACTION: "proof",
          GITHUB_JOB: "proof-nudges",
          GITHUB_REPOSITORY: "openclaw/clawsweeper",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: runId,
          GITHUB_RUN_STARTED_AT: "2026-07-13T20:00:00Z",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_WORKFLOW: "ClawSweeper Proof Nudges",
          GITHUB_WORKFLOW_REF:
            "openclaw/clawsweeper/.github/workflows/proof-nudges.yml@refs/heads/main",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);

    const events = readValidatedActionEventShardBatch(outputRoot).events.filter(
      (event) => event.producer.run_id === runId,
    );
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((event) => [event.event_type, event.action.status]),
      [
        ["proof.stage", "started"],
        ["review.log_publication", "completed"],
        ["proof.stage", "completed"],
      ],
    );
    assert.equal(
      events[1]?.evidence.some((entry) => entry.kind === "proof_nudge_report"),
      true,
    );
    assert.doesNotMatch(JSON.stringify(events), new RegExp(root.replaceAll("\\", "\\\\")));
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("proof mutations and cursor publication use observed immutable receipts", () => {
  const source = readText("src/clawsweeper.ts");
  const workflow = readText(".github/workflows/proof-nudges.yml");

  assert.match(source, /identity: `proof_nudge_comment:/);
  assert.match(source, /identity: `bot_proof_comment:/);
  assert.match(source, /runWithProofLaneMutationRunner/);
  assert.match(source, /ACTION_EVENT_TYPES\.proofBinding/);
  assert.match(source, /ACTION_EVENT_TYPES\.reviewCommentPublication/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(workflow, /--receipt-kind proof_cursor_publication/);
  assert.match(workflow, /repair:action-ledger -- finalize/);
  assert.match(
    workflow,
    /repair:action-ledger -- publish-workflow \\\n\s+--expected-producer-job proof-nudges/,
  );
  assert.match(workflow, /publish-action-event-paths/);
});
