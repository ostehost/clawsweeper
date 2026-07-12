#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_DISPATCH_REPO = "openclaw/clawsweeper";
const DEFAULT_WORKFLOW = "sweep.yml";
const DEFAULT_REF = "main";
const DEFAULT_TARGET_REPO = "openclaw/clawsweeper";
const DEFAULT_RUN_LIMIT = 20;

const MODES = new Set([
  "audit",
  "hot-intake",
  "normal-review",
  "exact-review",
  "apply",
  "comment-sync",
  "status",
]);

export function parseArgs(argv) {
  const options = {
    mode: "audit",
    dispatchRepo: DEFAULT_DISPATCH_REPO,
    workflow: DEFAULT_WORKFLOW,
    ref: DEFAULT_REF,
    targetRepo: DEFAULT_TARGET_REPO,
    itemNumber: "",
    itemNumbers: "",
    batchSize: "",
    shardCount: "",
    applyLimit: "",
    gh: process.env.GH || "gh",
    dryRun: false,
    json: false,
    skipIfRunning: false,
    runLimit: DEFAULT_RUN_LIMIT,
    activeMaxAgeMinutes: 12 * 60,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--mode":
        options.mode = requireValue(argv, ++index, arg);
        break;
      case "--repo":
      case "--dispatch-repo":
        options.dispatchRepo = requireValue(argv, ++index, arg);
        break;
      case "--workflow":
        options.workflow = requireValue(argv, ++index, arg);
        break;
      case "--ref":
        options.ref = requireValue(argv, ++index, arg);
        break;
      case "--target-repo":
        options.targetRepo = requireValue(argv, ++index, arg);
        break;
      case "--item-number":
        options.itemNumber = requireValue(argv, ++index, arg);
        break;
      case "--item-numbers":
        options.itemNumbers = requireValue(argv, ++index, arg);
        break;
      case "--batch-size":
        options.batchSize = requireValue(argv, ++index, arg);
        break;
      case "--shard-count":
        options.shardCount = requireValue(argv, ++index, arg);
        break;
      case "--apply-limit":
        options.applyLimit = requireValue(argv, ++index, arg);
        break;
      case "--gh":
        options.gh = requireValue(argv, ++index, arg);
        break;
      case "--run-limit":
        options.runLimit = positiveInt(requireValue(argv, ++index, arg), "--run-limit");
        break;
      case "--active-max-age-minutes":
        options.activeMaxAgeMinutes = positiveInt(
          requireValue(argv, ++index, arg),
          "--active-max-age-minutes",
        );
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--skip-if-running":
        options.skipIfRunning = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  validateOptions(options);
  return options;
}

export function validateOptions(options) {
  if (options.help) return;
  if (!MODES.has(options.mode)) {
    throw new Error(`unknown mode: ${options.mode}`);
  }
  for (const [label, value] of [
    ["--repo", options.dispatchRepo],
    ["--workflow", options.workflow],
    ["--ref", options.ref],
    ["--target-repo", options.targetRepo],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${label} must not be empty`);
    }
  }
  if (options.mode === "exact-review" && !options.itemNumber && !options.itemNumbers) {
    throw new Error("exact-review requires --item-number or --item-numbers");
  }
  if (options.itemNumber && !/^\d+$/.test(options.itemNumber)) {
    throw new Error("--item-number must be an integer");
  }
  if (options.itemNumbers && !/^\d+(,\d+)*$/.test(options.itemNumbers)) {
    throw new Error("--item-numbers must be a comma-separated integer list");
  }
  if (options.batchSize && !/^\d+$/.test(options.batchSize)) {
    throw new Error("--batch-size must be an integer");
  }
  if (options.shardCount && !/^\d+$/.test(options.shardCount)) {
    throw new Error("--shard-count must be an integer");
  }
  if (options.applyLimit && !/^\d+$/.test(options.applyLimit)) {
    throw new Error("--apply-limit must be an integer");
  }
}

export function workflowFields(options) {
  const fields = { target_repo: options.targetRepo };
  switch (options.mode) {
    case "audit":
      fields.audit_dashboard = "true";
      break;
    case "hot-intake":
      fields.hot_intake = "true";
      break;
    case "normal-review":
      break;
    case "exact-review":
      if (options.itemNumber) fields.item_number = options.itemNumber;
      if (options.itemNumbers) fields.item_numbers = options.itemNumbers;
      break;
    case "apply":
      fields.apply_existing = "true";
      if (options.applyLimit) fields.apply_limit = options.applyLimit;
      break;
    case "comment-sync":
      fields.apply_existing = "true";
      fields.apply_sync_comments_only = "true";
      break;
    case "status":
      break;
    default:
      throw new Error(`unsupported mode: ${options.mode}`);
  }
  if (options.batchSize) fields.batch_size = options.batchSize;
  if (options.shardCount) fields.shard_count = options.shardCount;
  return fields;
}

export function workflowRunArgs(options) {
  const args = [
    "workflow",
    "run",
    options.workflow,
    "--repo",
    options.dispatchRepo,
    "--ref",
    options.ref,
  ];
  for (const [key, value] of Object.entries(workflowFields(options))) {
    args.push("-f", `${key}=${value}`);
  }
  return args;
}

export function runListArgs(options, status = null) {
  const args = [
    "run",
    "list",
    "--repo",
    options.dispatchRepo,
    "--workflow",
    options.workflow,
    "--limit",
    String(options.runLimit),
    "--json",
    "databaseId,workflowName,displayTitle,status,conclusion,createdAt,updatedAt,url,headBranch,event",
  ];
  if (status) args.push("--status", status);
  return args;
}

export function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function commandLine(binary, args) {
  return [binary, ...args].map(shellQuote).join(" ");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n" + usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.mode === "status") {
    const args = runListArgs(options);
    finish(options, {
      kind: "status",
      args,
      dryRun: options.dryRun,
      run: () => run(options.gh, args, { capture: options.json }),
    });
    return;
  }

  const args = workflowRunArgs(options);
  finish(options, {
    kind: "dispatch",
    args,
    dryRun: options.dryRun,
    run: () => {
      if (options.skipIfRunning) {
        const active = activeRuns(options);
        if (active.length > 0) {
          return {
            status: "skipped",
            code: 0,
            activeRuns: active,
            stdout: "",
            stderr: "",
          };
        }
      }
      return run(options.gh, args, { capture: options.json });
    },
  });
}

function finish(options, command) {
  const receipt = {
    ok: true,
    kind: command.kind,
    mode: options.mode,
    dispatchRepo: options.dispatchRepo,
    workflow: options.workflow,
    ref: options.ref,
    targetRepo: options.targetRepo,
    dryRun: command.dryRun,
    command: commandLine(options.gh, command.args),
    args: command.args,
    fields: options.mode === "status" ? undefined : workflowFields(options),
  };

  if (command.dryRun) {
    printReceipt(options, receipt);
    return;
  }

  const result = command.run();
  if (result.status === "skipped") {
    printReceipt(options, { ...receipt, ok: true, skipped: true, activeRuns: result.activeRuns });
    return;
  }
  if (result.code !== 0) {
    printReceipt(options, {
      ...receipt,
      ok: false,
      exitCode: result.code,
      stdout: result.stdout || undefined,
      stderr: result.stderr || undefined,
    });
    process.exitCode = result.code || 1;
    return;
  }
  printReceipt(options, {
    ...receipt,
    stdout: result.stdout || undefined,
    stderr: result.stderr || undefined,
  });
}

function activeRuns(options) {
  const cutoff = Date.now() - options.activeMaxAgeMinutes * 60 * 1000;
  return ["queued", "in_progress"].flatMap((status) => {
    const result = run(options.gh, runListArgs(options, status), { capture: true });
    if (result.code !== 0) {
      throw new Error(
        `could not check active ${options.workflow} runs: ${result.stderr || result.stdout}`,
      );
    }
    try {
      return recentActiveRuns(JSON.parse(result.stdout || "[]"), cutoff);
    } catch (error) {
      throw new Error(`could not parse gh run list output: ${error.message}`);
    }
  });
}

/**
 * Keeps fresh runs from gh's already workflow-scoped result. Do not compare workflowName:
 * gh reports the human display name, which cannot be derived from an arbitrary workflow file.
 */
export function recentActiveRuns(runs, cutoff) {
  if (!Array.isArray(runs)) throw new Error("gh run list output must be an array");
  return runs.filter((run) => {
    const createdAt = Date.parse(run.createdAt || "");
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });
}

function run(binary, args, { capture }) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function printReceipt(options, receipt) {
  if (options.json) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  if (receipt.skipped) {
    console.log(
      `Skipped ${receipt.workflow}: ${receipt.activeRuns.length} queued/in-progress run(s) already active.`,
    );
    return;
  }
  console.log(receipt.command);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInt(value, flag) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function usage() {
  return `Usage: node scripts/openclaw-dispatch.mjs [options]\n\nModes:\n  audit          Dispatch sweep.yml with audit_dashboard=true (default)\n  hot-intake     Dispatch hot intake for a target repo\n  normal-review  Dispatch normal review for a target repo\n  exact-review   Dispatch one or more exact item reviews\n  apply          Dispatch guarded apply_existing=true\n  comment-sync   Dispatch comment-only sync\n  status         List recent sweep.yml runs without dispatching\n\nExamples:\n  node scripts/openclaw-dispatch.mjs --dry-run --json\n  node scripts/openclaw-dispatch.mjs --mode exact-review --target-repo openclaw/openclaw --item-number 12345\n  node scripts/openclaw-dispatch.mjs --mode audit --target-repo openclaw/clawsweeper --skip-if-running\n\nOptions:\n  --repo, --dispatch-repo REPO  Repository that owns the workflow (default: ${DEFAULT_DISPATCH_REPO})\n  --workflow FILE              Workflow file (default: ${DEFAULT_WORKFLOW})\n  --ref REF                    Git ref to run (default: ${DEFAULT_REF})\n  --target-repo REPO           Repository ClawSweeper should review/audit (default: ${DEFAULT_TARGET_REPO})\n  --item-number N              Exact issue/PR number for exact-review\n  --item-numbers N,N           Exact issue/PR numbers for exact-review\n  --batch-size N               Override workflow batch_size\n  --shard-count N              Override workflow shard_count\n  --apply-limit N              Override apply_limit for apply mode\n  --skip-if-running            Skip dispatch if sweep.yml already has queued/in-progress runs\n  --dry-run                    Print receipt/command without running gh\n  --json                       Print JSON receipts\n  --gh PATH                    gh executable (default: GH env or gh)\n  --run-limit N                Active/status run query limit (default: ${DEFAULT_RUN_LIMIT})
  --active-max-age-minutes N   Ignore stale queued/in-progress runs older than N minutes (default: 720)`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
