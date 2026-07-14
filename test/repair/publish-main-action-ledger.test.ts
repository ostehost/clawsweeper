import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { repairPublicationContentDigest } from "../../dist/repair/repair-action-ledger.js";
import { readText } from "../helpers.ts";

test("publish-main receipts every mutable durable Git push", () => {
  const source = readText("src/repair/publish-main.ts");

  assert.match(source, /assertPublicationReceipt\(args\.paths, args\.receiptKind\)/);
  assert.match(source, /assertPublicationActionLedgerEnabled\(args\.receiptKind\)/);
  assert.match(source, /workflowActionEventsEnabled\(process\.env\)/);
  assert.match(source, /GITHUB_RUN_STARTED_AT/);
  assert.match(source, /if \(args\.receiptKind\)/);
  assert.match(source, /runRepairMutation\(/);
  assert.match(source, /operationName: "state_publication"/);
  assert.match(source, /component: "publish_main"/);
  assert.match(
    source,
    /workKey: `state-publication:\$\{args\.receiptKind\}:\$\{publicationContentSha256\}`/,
  );
  assert.match(source, /publicationContentSha256,/);
  assert.match(source, /operation: \(\) => publishMainCommit\(publishOptions\)/);
  assert.match(source, /result === "committed" \? "accepted" : "rejected"/);
  assert.match(source, /--receipt-kind/);
  assert.match(source, /--best-effort-refresh/);
  assert.match(source, /refreshFailureMode: args\.bestEffortRefresh \? "best-effort" : "strict"/);
});

test("publish-main rejects receipt-free mutable and mixed path sets before Git mutation", () => {
  for (const [paths, expectedError] of [
    [["results/status.json"], /only immutable ledger\/ paths/i],
    [["ledger/actions/event.json", "results/status.json"], /mixed ledger\/non-ledger/i],
    [["ledger/../results/status.json"], /only immutable ledger\/ paths/i],
    [["ledger2/actions/event.json"], /only immutable ledger\/ paths/i],
    [["/ledger/actions/event.json"], /only immutable ledger\/ paths/i],
    [["C:\\ledger\\actions\\event.json"], /only immutable ledger\/ paths/i],
    [["ledger\\..\\results\\status.json"], /only immutable ledger\/ paths/i],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/publish-main.js"),
        "--message",
        "chore: publish state",
        ...paths.flatMap((publishedPath) => ["--path", publishedPath]),
      ],
      { cwd: os.tmpdir(), encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
  }
});

test("publish-main rejects receipted state writes when action-ledger setup is unavailable", () => {
  const env = { ...process.env };
  delete env.CLAWSWEEPER_ACTION_LEDGER_FORCE;
  delete env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT;
  delete env.GITHUB_RUN_STARTED_AT;
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("dist/repair/publish-main.js"),
      "--message",
      "chore: publish state",
      "--path",
      "results/status.json",
      "--receipt-kind",
      "test_state_publication",
    ],
    { cwd: os.tmpdir(), encoding: "utf8", env },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires successful action-ledger setup/);
  assert.doesNotMatch(result.stderr, /not a git repository/);
});

test("workflow state publications declare receipts before finalizing immutable action ledgers", () => {
  const defaultPublicationKinds = new Set([
    "comment_router_state_publication",
    "comment_router_retry_state_publication",
    "spam_scanner_state_publication",
    "event_comment_router_state_publication",
    "sweep_planning_status_publication",
    "sweep_review_records_publication",
    "sweep_review_status_publication",
    "selected_review_records_publication",
    "selected_review_status_publication",
    "failed_review_retry_state_publication",
    "sweep_audit_records_publication",
    "sweep_audit_status_publication",
    "sweep_apply_status_publication",
  ]);
  const workflowDir = path.resolve(".github/workflows");
  for (const filename of fs.readdirSync(workflowDir).filter((name) => name.endsWith(".yml"))) {
    const workflow = parse(fs.readFileSync(path.join(workflowDir, filename), "utf8"));
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {}) as Array<
      [
        string,
        {
          steps?: Array<{
            env?: Record<string, string>;
            if?: string;
            name?: string;
            run?: string;
            uses?: string;
          }>;
        },
      ]
    >) {
      const steps = job.steps ?? [];
      const receiptedPublicationIndexes: number[] = [];
      for (const [index, step] of steps.entries()) {
        const run = String(step.run ?? "");
        const publicationCount = [...run.matchAll(/pnpm run repair:publish-main/g)].length;
        if (publicationCount === 0) continue;
        const receiptKinds = [
          ...run.matchAll(/--receipt-kind\s+([a-z0-9][a-z0-9._-]{0,127})/g),
        ].map((match) => match[1]);
        if (receiptKinds.some((kind) => defaultPublicationKinds.has(kind))) {
          assert.equal(
            step.env?.CLAWSWEEPER_ACTION_LEDGER_INVOCATION,
            undefined,
            `${filename}:${jobId}:${step.name ?? index} must use publish_main.default`,
          );
          assert.doesNotMatch(
            run,
            /CLAWSWEEPER_ACTION_LEDGER_INVOCATION=/,
            `${filename}:${jobId}:${step.name ?? index} must use publish_main.default`,
          );
        }
        if (receiptKinds.length !== publicationCount) {
          assert.equal(
            receiptKinds.length,
            0,
            `${filename}:${jobId}:${step.name ?? index} partially receipts state publications`,
          );
          assert.match(
            step.name ?? "",
            /action ledger/i,
            `${filename}:${jobId}:${step.name ?? index} publishes mutable state without a receipt`,
          );
          assert.doesNotMatch(
            run,
            /--path\s+["']?(?!ledger(?:\/|["'\s\\]))[a-z0-9_.-]+/i,
            `${filename}:${jobId}:${step.name ?? index} has a receipt-free non-ledger literal path`,
          );
          continue;
        }
        receiptedPublicationIndexes.push(index);
      }

      if (receiptedPublicationIndexes.length > 0) {
        const firstPublicationIndex = receiptedPublicationIndexes[0];
        const lastPublicationIndex = receiptedPublicationIndexes.at(-1) ?? -1;
        const setupIndex = steps.findIndex((candidate) =>
          String(candidate.uses ?? "").includes("setup-action-ledger"),
        );
        const finalizeIndex = steps.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex > lastPublicationIndex &&
            /(?:repair:action-ledger -- finalize|finalize-action-events)/.test(
              String(candidate.run ?? ""),
            ),
        );
        const immutablePublishIndex = steps.findIndex((candidate, candidateIndex) => {
          if (candidateIndex <= finalizeIndex) return false;
          const run = String(candidate.run ?? "");
          return (
            run.includes("publish-action-event-paths") ||
            (run.includes("pnpm run repair:publish-main") && !run.includes("--receipt-kind"))
          );
        });
        assert.ok(
          setupIndex >= 0 && setupIndex < firstPublicationIndex,
          `${filename}:${jobId} must initialize the action ledger before state publication`,
        );
        assert.ok(
          finalizeIndex > lastPublicationIndex,
          `${filename}:${jobId} must finalize publish_main.default after its last mutable write`,
        );
        assert.match(
          String(steps[finalizeIndex]?.if ?? ""),
          /always\(\)/,
          `${filename}:${jobId} must finalize receipts after timeout or continued errors`,
        );
        assert.ok(
          immutablePublishIndex > finalizeIndex,
          `${filename}:${jobId} must publish publish_main.default after finalization`,
        );
      }
    }
  }

  const helperScripts = fs
    .readdirSync(path.resolve("scripts"), { recursive: true })
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => path.join("scripts", entry))
    .filter((entry) => fs.statSync(entry).isFile())
    .map((entry) => [entry, fs.readFileSync(entry, "utf8")] as const)
    .filter(([, source]) => source.includes("repair:publish-main"));
  assert.ok(helperScripts.length > 0);
  for (const [filename, source] of helperScripts) {
    assert.equal(
      [...source.matchAll(/repair:publish-main/g)].length,
      [...source.matchAll(/--receipt-kind(?:\s|=)/g)].length,
      `${filename} must receipt every publish-main call`,
    );
  }
  assert.match(
    readText("scripts/apply-workflow-helpers.sh"),
    /CLAWSWEEPER_ACTION_LEDGER_INVOCATION="\$action_ledger_invocation"/,
  );
});

test("apply publication helpers rotate producers across interleaved ledger flushes", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
        source scripts/apply-workflow-helpers.sh
        pnpm() {
          printf '%s|%s\n' "$CLAWSWEEPER_ACTION_LEDGER_INVOCATION" "$*"
        }
        publish_changes_with_strategy apply-records "chore: first" results/status.json
        publish_changes_with_strategy reconcile-records "chore: second" records/example
      `,
    ],
    { cwd: path.resolve("."), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "publish-main-1|run repair:publish-main -- --message chore: first --receipt-kind sweep_apply_state_publication --rebase-strategy apply-records --path results/status.json",
    "publish-main-2|run repair:publish-main -- --message chore: second --receipt-kind sweep_apply_records_publication --rebase-strategy reconcile-records --path records/example",
  ]);
});

test("publication identity binds deterministic selected content before mutation", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "publication-identity-")));
  const nested = path.join(root, "records", "openclaw");
  fs.mkdirSync(nested, { recursive: true });
  const first = path.join(nested, "first.json");
  const second = path.join(nested, "second.json");
  fs.writeFileSync(first, '{"state":"ready"}\n');
  fs.writeFileSync(second, '{"state":"waiting"}\n');

  try {
    const initial = repairPublicationContentDigest(["records", "records"], root);
    assert.equal(initial, repairPublicationContentDigest(["records"], root));
    assert.equal(
      repairPublicationContentDigest(
        ["records/openclaw/second.json", "records/openclaw/first.json"],
        root,
      ),
      repairPublicationContentDigest(
        ["records/openclaw/first.json", "records/openclaw/second.json"],
        root,
      ),
    );

    fs.utimesSync(first, new Date(1_000), new Date(2_000));
    assert.equal(repairPublicationContentDigest(["records"], root), initial);

    fs.writeFileSync(second, '{"state":"complete"}\n');
    const changedBytes = repairPublicationContentDigest(["records"], root);
    assert.notEqual(changedBytes, initial);

    if (process.platform !== "win32") {
      fs.chmodSync(first, 0o755);
      assert.notEqual(repairPublicationContentDigest(["records"], root), changedBytes);
    }

    fs.rmSync(second);
    assert.notEqual(repairPublicationContentDigest(["records"], root), changedBytes);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
