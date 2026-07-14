#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertLiveWorkerCapacity,
  currentProjectRepo,
  listActiveWorkflowRuns,
  parseArgs,
  parseJob,
  readMaxLiveWorkers,
  repairRunNameForJob,
  repairRunNamePrefixForJob,
  repoRoot,
  validateJob,
  waitForLiveWorkerCapacity,
} from "./lib.js";
import { sleepMs } from "./timing.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import { ghSpawn } from "./github-cli.js";
import { AUTOMATION_LIMITS, workerLimit, type WorkerLane } from "./limits.js";
import {
  repairJobIntentForFrontmatter,
  repairJobUsesClusterLane,
  workerLaneForRepairJobIntent,
} from "./job-intent.js";
import {
  repairSourceRevision,
  runRepairMutation,
  type RepairLifecycleInput,
} from "./repair-action-ledger.js";

const args = parseArgs(process.argv.slice(2));
const defaultRunner = process.env.CLAWSWEEPER_WORKER_RUNNER ?? "blacksmith-4vcpu-ubuntu-2404";
const defaultExecutionRunner =
  process.env.CLAWSWEEPER_EXECUTION_RUNNER ?? "blacksmith-16vcpu-ubuntu-2404";
const mode = String(args.mode ?? "plan");
const runner = args.runner ?? defaultRunner;
const executionRunner = args["execution-runner"] ?? args.execution_runner ?? defaultExecutionRunner;
const workflow = args.workflow ?? REPAIR_CLUSTER_WORKFLOW;
const repo = String(args.repo ?? currentProjectRepo());
const model = String(args.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal");
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const ref = args.ref ? String(args.ref) : "";
const requestedDispatchKey = dispatchKeyArg(args["dispatch-key"] ?? args.dispatch_key);
const stateRevision = immutableHexArg(
  args["state-revision"] ?? args.state_revision,
  "state revision",
  40,
);
const jobSha256 = immutableHexArg(args["job-sha256"] ?? args.job_sha256, "job SHA-256", 64);
const files = args._;
const activeRepairRunsByPrefix = new Map<string, LooseRecord[]>();
const jobDispatchKeys = new Map<string, string>();
const jobWorkerLanes = new Map<string, WorkerLane>();

if (files.length === 0) {
  console.error(
    `usage: node scripts/dispatch-jobs.ts <job.md> [--mode plan|execute|autonomous] [--runner label] [--execution-runner label] [--model model] [--dispatch-key key] [--state-revision sha] [--job-sha256 digest] [--max-live-workers ${AUTOMATION_LIMITS.repair_live_runs.default}] [--wait-for-capacity]`,
  );
  process.exit(2);
}
if (!stateRevision || !jobSha256) {
  throw new Error("--state-revision and --job-sha256 are required for immutable job handoff");
}
if (files.length !== 1) {
  throw new Error("immutable job handoff requires exactly one job");
}

let failed = false;
const validatedJobs: JsonValue[] = [];
for (const file of files) {
  const job = parseJob(file);
  const errors = validateJob(job);
  if (errors.length > 0) {
    failed = true;
    console.error(`invalid job: ${file}`);
    for (const error of errors) console.error(`- ${error}`);
    continue;
  }
  const actualJobSha256 = createHash("sha256").update(fs.readFileSync(job.path)).digest("hex");
  if (actualJobSha256 !== jobSha256) {
    failed = true;
    console.error(
      `immutable job SHA-256 mismatch for ${file}: expected ${jobSha256}, got ${actualJobSha256}`,
    );
    continue;
  }

  const relative = job.relativePath;
  const dispatchKey = derivedDispatchKey(relative);
  jobDispatchKeys.set(relative, dispatchKey);
  jobWorkerLanes.set(
    relative,
    workerLaneForRepairJobIntent(repairJobIntentForFrontmatter(job.frontmatter)),
  );
  if (!fs.existsSync(path.join(repoRoot(), relative))) {
    failed = true;
    console.error(`job does not exist inside repo: ${file}`);
    continue;
  }
  validatedJobs.push(relative);
}

const jobs = failed ? [] : validatedJobs.filter((relative) => shouldDispatchJob(relative));
const maxLiveWorkers = dispatchMaxLiveWorkers(jobs);

if (!failed) {
  const requested = waitForCapacity ? Math.min(jobs.length, 1) : jobs.length;
  const capacityOptions = { repo, workflow, requested, maxLiveWorkers };
  const capacity = waitForCapacity
    ? waitForLiveWorkerCapacity(capacityOptions)
    : assertLiveWorkerCapacity(capacityOptions);
  console.log(
    `live worker capacity: ${capacity.active}/${capacity.max_live_workers} active; dispatching ${jobs.length} ${workflow} run(s)`,
  );
}

let dispatched = 0;
let index = 0;
while (!failed && index < jobs.length) {
  let batchSize = jobs.length - index;
  if (waitForCapacity) {
    const capacity = waitForLiveWorkerCapacity({
      repo,
      workflow,
      requested: 1,
      maxLiveWorkers,
    });
    batchSize = Math.min(batchSize, Math.max(1, capacity.available || 1));
    console.log(
      `live worker capacity: ${capacity.active}/${capacity.max_live_workers} active; dispatching next ${batchSize} run(s)`,
    );
  }

  for (const relative of jobs.slice(index, index + batchSize)) {
    if (failed) break;
    dispatched += 1;
    dispatchJob(relative, dispatched, jobs.length);
  }
  index += batchSize;
  if (waitForCapacity && !failed && index < jobs.length) {
    sleepMs(15_000);
  }
}

function dispatchJob(relative: JsonValue, position: JsonValue, total: JsonValue) {
  const jobPath = String(relative);
  const dispatchKey = jobDispatchKeys.get(jobPath);
  if (!dispatchKey) throw new Error(`missing immutable dispatch key for ${jobPath}`);
  const commandArgs = [
    "workflow",
    "run",
    workflow,
    "--repo",
    repo,
    ...(ref ? ["--ref", ref] : []),
    "-f",
    `job=${jobPath}`,
    "-f",
    `dispatch_key=${dispatchKey}`,
    "-f",
    "payload_version=2",
    ...(stateRevision
      ? ["-f", `state_revision=${stateRevision}`, "-f", `job_sha256=${jobSha256}`]
      : []),
    "-f",
    `mode=${mode}`,
    "-f",
    `runner=${runner}`,
    "-f",
    `execution_runner=${executionRunner}`,
    "-f",
    `model=${model}`,
  ];
  try {
    runRepairMutation(dispatchLifecycle(jobPath), {
      kind: "repair_dispatch",
      operationName: "repair_dispatch",
      component: "repair_dispatch",
      identity: {
        repository: repo,
        workflow,
        ref: ref || null,
        jobPath,
        mode,
        runner,
        executionRunner,
        model,
        dispatchKey,
        requestedDispatchKey: requestedDispatchKey || null,
        stateRevision: stateRevision || null,
        jobSha256: jobSha256 || null,
      },
      operation: () => {
        const result = ghSpawn(commandArgs, { cwd: repoRoot() });
        if (result.status !== 0) {
          const detail = result.stderr || result.stdout || result.error?.message || "unknown error";
          throw new Error(`failed to dispatch ${jobPath}: ${detail}`);
        }
        return result;
      },
    });
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : String(error));
    return;
  }
  console.log(
    `dispatched ${position}/${total} ${relative} (${mode}) on ${runner}; execution on ${executionRunner}`,
  );
}

function dispatchKeyArg(value: JsonValue | undefined): string {
  const key = String(value ?? "").trim();
  if (!key) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new Error("dispatch key must be a bounded machine identifier");
  }
  return key;
}

function immutableHexArg(value: JsonValue | undefined, label: string, length: 40 | 64): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(normalized)) {
    throw new Error(`${label} must be an exact lowercase ${length}-hex value`);
  }
  return normalized;
}

function derivedDispatchKey(jobPath: string): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        repository: repo,
        workflow,
        ref: ref || null,
        jobPath,
        mode,
        runner,
        executionRunner,
        model,
        requestedDispatchKey: requestedDispatchKey || null,
        stateRevision,
        jobSha256,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `repair-dispatch-${digest}`;
}

function dispatchLifecycle(jobPath: string): RepairLifecycleInput {
  const job = parseJob(jobPath);
  const targetRepo = String(job.frontmatter.repo ?? repo);
  const issueNumber = Number(job.frontmatter.issue_number ?? job.frontmatter.pr ?? 0);
  const number = Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
  return {
    repository: targetRepo,
    workKey: `repair-dispatch:${targetRepo}:${job.relativePath}`,
    sourceRevision: repairSourceRevision(job.frontmatter),
    recordPath: job.relativePath,
    ...(number ? { number } : {}),
    subjectKind: number && job.frontmatter.pr ? "pull_request" : number ? "issue" : "workflow",
  };
}

function shouldDispatchJob(relative: JsonValue) {
  const jobPath = String(relative);
  const dispatchKey = jobDispatchKeys.get(jobPath);
  if (!dispatchKey) throw new Error(`missing immutable dispatch key for ${jobPath}`);
  const prefix = repairRunNamePrefixForJob(jobPath);
  if (!activeRepairRunsByPrefix.has(prefix)) {
    activeRepairRunsByPrefix.set(
      prefix,
      listActiveWorkflowRuns({
        repo,
        workflow,
        runNamePrefix: prefix,
      }),
    );
  }
  const expectedTitle = `${repairRunNameForJob(jobPath, undefined, dispatchKey)} (${jobSha256})`;
  const activeRun = activeRepairRunsByPrefix
    .get(prefix)
    ?.find((run: LooseRecord) => String(run.displayTitle ?? "") === expectedTitle);
  if (!activeRun) return true;
  console.log(
    `skipping ${relative}: active ${workflow} run already exists (${activeRun.url ?? activeRun.databaseId ?? "unknown run"})`,
  );
  return false;
}

if (failed) process.exit(1);

function dispatchMaxLiveWorkers(jobPaths: JsonValue[]): number {
  if (
    args["max-live-workers"] !== undefined ||
    args.max_live_workers !== undefined ||
    process.env.CLAWSWEEPER_MAX_LIVE_WORKERS
  ) {
    return readMaxLiveWorkers(args);
  }
  const lane = strongestWorkerLane(jobPaths);
  return readMaxLiveWorkers({ "max-live-workers": workerLimit(lane) });
}

function strongestWorkerLane(jobPaths: JsonValue[]): WorkerLane {
  const lanes = new Set(
    jobPaths.map((jobPath) => {
      const job = parseJob(String(jobPath));
      return repairJobUsesClusterLane(job.frontmatter)
        ? "cluster_repair"
        : jobWorkerLanes.get(String(jobPath));
    }),
  );
  if (lanes.has("cluster_repair")) return "cluster_repair";
  if (lanes.has("automerge_repair")) return "automerge_repair";
  if (lanes.has("issue_implementation")) return "issue_implementation";
  return "repair";
}
