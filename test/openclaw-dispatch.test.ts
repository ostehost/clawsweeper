import assert from "node:assert/strict";
import test from "node:test";

import {
  commandLine,
  parseArgs,
  runListArgs,
  workflowFields,
  workflowRunArgs,
} from "../scripts/openclaw-dispatch.mjs";

test("OpenClaw dispatcher defaults to a safe ClawSweeper audit dry run", () => {
  const options = parseArgs(["--dry-run", "--json"]);

  assert.equal(options.mode, "audit");
  assert.equal(options.dispatchRepo, "openclaw/clawsweeper");
  assert.equal(options.targetRepo, "openclaw/clawsweeper");
  assert.equal(options.activeMaxAgeMinutes, 720);
  assert.deepEqual(workflowFields(options), {
    target_repo: "openclaw/clawsweeper",
    audit_dashboard: "true",
  });
  assert.deepEqual(workflowRunArgs(options), [
    "workflow",
    "run",
    "sweep.yml",
    "--repo",
    "openclaw/clawsweeper",
    "--ref",
    "main",
    "-f",
    "target_repo=openclaw/clawsweeper",
    "-f",
    "audit_dashboard=true",
  ]);
});

test("OpenClaw dispatcher builds exact-review workflow_dispatch inputs", () => {
  const options = parseArgs([
    "--mode",
    "exact-review",
    "--target-repo",
    "openclaw/openclaw",
    "--item-number",
    "12345",
    "--batch-size",
    "1",
    "--shard-count",
    "1",
  ]);

  assert.deepEqual(workflowFields(options), {
    target_repo: "openclaw/openclaw",
    item_number: "12345",
    batch_size: "1",
    shard_count: "1",
  });
});

test("OpenClaw dispatcher tolerates npm/pnpm argument separator", () => {
  const options = parseArgs(["--", "--mode", "status"]);

  assert.equal(options.mode, "status");
});

test("OpenClaw dispatcher rejects exact-review without an item", () => {
  assert.throws(
    () => parseArgs(["--mode", "exact-review", "--target-repo", "openclaw/openclaw"]),
    /requires --item-number or --item-numbers/,
  );
});

test("OpenClaw dispatcher exposes status as a read-only gh run list", () => {
  const options = parseArgs(["--mode", "status", "--run-limit", "7", "--active-max-age-minutes", "30"]);

  assert.equal(options.activeMaxAgeMinutes, 30);

  assert.deepEqual(runListArgs(options), [
    "run",
    "list",
    "--repo",
    "openclaw/clawsweeper",
    "--workflow",
    "sweep.yml",
    "--limit",
    "7",
    "--json",
    "databaseId,displayTitle,status,conclusion,createdAt,updatedAt,url,headBranch,event",
  ]);
});

test("OpenClaw dispatcher shell-quotes receipt commands", () => {
  assert.equal(
    commandLine("gh", ["workflow", "run", "sweep.yml", "-f", "target_repo=openclaw/openclaw"]),
    "gh workflow run sweep.yml -f target_repo=openclaw/openclaw",
  );
  assert.equal(commandLine("gh", ["run", "list", "--json", "databaseId,url"]), "gh run list --json databaseId,url");
});
