#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  assertLiveWorkerCapacity,
  currentProjectRepo,
  parseArgs,
  readMaxLiveWorkers,
  repoRoot,
  waitForLiveWorkerCapacity,
} from "./lib.js";
import { ghJson, ghText } from "./github-cli.js";
import { sleepMs } from "./timing.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import { AUTOMATION_LIMITS } from "./limits.js";
import {
  flushCommandActionEvents,
  recordCommandLifecycleFailure,
  recordCommandRequeue,
  runCommandLifecycleMutation,
  type CommandLifecycleInput,
} from "./command-action-ledger.js";
import {
  boundedNextRequeueDepth,
  deterministicRequeueDispatchKey,
  normalizedRequeueSourceJobPath,
} from "./requeue-job-key.js";
import { immutableJobDispatchArgs, resolveStateJobIdentity } from "./immutable-job-handoff.js";

const DEFAULT_REPO = currentProjectRepo();
const DEFAULT_WORKFLOW = REPAIR_CLUSTER_WORKFLOW;
const DEFAULT_RUNNER = process.env.CLAWSWEEPER_WORKER_RUNNER ?? "blacksmith-4vcpu-ubuntu-2404";
const DEFAULT_EXECUTION_RUNNER =
  process.env.CLAWSWEEPER_EXECUTION_RUNNER ?? "blacksmith-16vcpu-ubuntu-2404";
const QUEUED_STATUSES = new Set(["queued", "requested", "waiting", "pending"]);
const SOURCE_JOB_PATH = /^jobs\/[A-Za-z0-9_.-]+\/inbox\/[A-Za-z0-9_.-]+\.md$/;
const STATE_REVISION = /^[a-f0-9]{40}$/;
const JOB_SHA256 = /^[a-f0-9]{64}$/;
const REPAIR_MODES = new Set(["plan", "execute", "autonomous"]);
const WORKFLOW_INPUTS_BASENAME = "workflow-inputs.json";

type RecoveredRunCohort = {
  source_job: string;
  mode: string;
  state_revision: string;
  job_sha256: string;
  producer_attempt: number;
};

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? DEFAULT_REPO);
const workflow = String(args.workflow ?? DEFAULT_WORKFLOW);
const runner = String(args.runner ?? DEFAULT_RUNNER);
const executionRunner = String(
  args["execution-runner"] ?? args.execution_runner ?? DEFAULT_EXECUTION_RUNNER,
);
const model = String(args.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal");
const maxLiveWorkers = readMaxLiveWorkers(args);
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const execute = Boolean(args.execute || args.live);
const openExecuteWindow = Boolean(args["open-execute-window"] || args.live);
const requestedMode = typeof args.mode === "string" ? args.mode : null;
const requestedRunId = args["run-id"] ?? (looksLikeRunId(args._[0]) ? args._[0] : null);
const runRecordsDir = path.resolve(
  String(args["runs-dir"] ?? args.runs_dir ?? path.join(repoRoot(), "results", "runs")),
);
const sourceRunId = String(
  args["source-run-id"] ?? requestedRunId ?? process.env.GITHUB_RUN_ID ?? "",
).trim();
const requeueDepth = nonNegativeIntegerArg(args["requeue-depth"], "requeue-depth", 0);
const maxRequeueDepth = nonNegativeIntegerArg(args["max-requeue-depth"], "max-requeue-depth", 1);

const resolved = requestedRunId
  ? resolveFromRunId(String(requestedRunId))
  : {
      source_job: args._[0],
      mode: requestedMode,
      state_revision: null,
      job_sha256: null,
    };

if (!resolved.source_job) {
  console.error(
    `usage: node scripts/requeue-job.ts <job.md|run-id> [--runs-dir path] [--state-revision sha] [--job-sha256 digest] [--mode plan|execute|autonomous] [--execute] [--open-execute-window] [--source-run-id id] [--source-job-path path] [--requeue-depth n] [--max-requeue-depth n] [--runner label] [--execution-runner label] [--model model] [--max-live-workers ${AUTOMATION_LIMITS.repair_live_runs.default}] [--wait-for-capacity]`,
  );
  process.exit(2);
}

const sourceJobPath = normalizedRequeueSourceJobPath(
  args["source-job-path"],
  String(resolved.source_job),
);
const immutableJob = resolveStateJobIdentity({
  jobPath: sourceJobPath,
  stateRevision: args["state-revision"] ?? args.state_revision ?? resolved.state_revision,
  jobSha256: args["job-sha256"] ?? args.job_sha256 ?? resolved.job_sha256,
});
const job = immutableJob.job;
const authorizationSha256 = immutableJob.jobSha256;
if (
  resolved.mode &&
  resolved.mode !== "plan" &&
  resolved.mode !== String(job.frontmatter.mode ?? "").trim()
) {
  throw new Error(
    `recovered effective mode ${resolved.mode} conflicts with immutable job mode ${
      job.frontmatter.mode
    }`,
  );
}

const mode = requestedMode ?? resolved.mode ?? job.frontmatter.mode;
if (!["plan", "execute", "autonomous"].includes(mode)) {
  throw new Error(`unsupported mode: ${mode}`);
}

const summary: LooseRecord = {
  status: execute ? "dispatching" : "dry_run",
  repo,
  workflow,
  source_run_id: sourceRunId || null,
  source_job: sourceJobPath,
  source_state_revision: immutableJob.stateRevision,
  source_job_sha256: immutableJob.jobSha256,
  source_authorization_sha256: authorizationSha256,
  requeue_depth: requeueDepth,
  max_requeue_depth: maxRequeueDepth,
  mode,
  runner,
  execution_runner: executionRunner,
  model,
  max_live_workers: maxLiveWorkers,
};

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const gateRestores: JsonValue[] = [];
const headSha = currentHeadSha();
const dispatchStartedAt = new Date(Date.now() - 5000).toISOString();
const nextRequeueDepth = boundedNextRequeueDepth(requeueDepth, maxRequeueDepth);
const dispatchKey = deterministicRequeueDispatchKey({
  repo,
  workflow,
  sourceRunId: sourceRunId || null,
  sourceJobPath,
  stateRevision: immutableJob.stateRevision,
  authorizationSha256,
  depth: nextRequeueDepth,
});
const requeueLifecycle: CommandLifecycleInput = {
  repository: repo,
  operationKey: `repair-requeue:${repo}:${immutableJob.identityKey}:depth:${nextRequeueDepth}`,
  sourceRevision: immutableJob.stateRevision,
  attemptId: dispatchKey,
};
let commandError: unknown = null;

try {
  if (openExecuteWindow && ["execute", "autonomous"].includes(mode)) {
    openGate("CLAWSWEEPER_ALLOW_EXECUTE", requeueLifecycle);
    if (job.frontmatter.allow_fix_pr === true || job.frontmatter.allowed_actions.includes("fix")) {
      openGate("CLAWSWEEPER_ALLOW_FIX_PR", requeueLifecycle);
    }
  }

  assertGateOpenIfNeeded(mode);
  summary.live_worker_capacity_before_dispatch = waitForCapacity
    ? waitForLiveWorkerCapacity({ repo, workflow, requested: 1, maxLiveWorkers })
    : assertLiveWorkerCapacity({ repo, workflow, requested: 1, maxLiveWorkers });
  dispatchJob(sourceJobPath, mode, dispatchKey, requeueLifecycle);
  recordCommandRequeue(requeueLifecycle, {
    dispatchKey,
    sourceJobPath,
    sourceJobSha256: authorizationSha256,
    sourceStateRevision: immutableJob.stateRevision,
    depth: nextRequeueDepth,
  });
  const observedRuns = waitForStartedRuns({ headSha, since: dispatchStartedAt, expectedCount: 1 });

  summary.status = "dispatched";
  summary.dispatch_key = dispatchKey;
  summary.observed_runs = observedRuns.map((run: JsonValue) => ({
    run_id: String(run.databaseId),
    status: run.status,
    conclusion: run.conclusion ?? null,
    created_at: run.createdAt,
    url: run.url,
  }));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  commandError = error;
} finally {
  for (const gate of gateRestores.reverse()) {
    try {
      setGate(gate.name, gate.previous || "1", requeueLifecycle);
    } catch (error) {
      if (!commandError) {
        commandError = error;
      } else {
        console.error(
          `failed to restore ${gate.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
if (commandError) {
  recordCommandLifecycleFailure(requeueLifecycle, {
    component: "repair_requeue",
    error: commandError,
  });
}
try {
  await flushCommandActionEvents();
} catch (error) {
  if (commandError) {
    console.error(
      `[action-ledger] failed to finalize repair requeue receipts: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } else {
    commandError = error;
  }
}
if (commandError) throw commandError;

function resolveFromRunId(runId: string) {
  const fromLedger = readPublishedRunRecord(runId);
  const ledgerSourceJob = publishedRecordField(
    fromLedger,
    "source_job",
    SOURCE_JOB_PATH,
    runId,
    "source job",
  );
  const ledgerStateRevision = publishedRecordField(
    fromLedger,
    "source_state_revision",
    STATE_REVISION,
    runId,
    "state revision",
  );
  const ledgerJobSha256 = publishedRecordField(
    fromLedger,
    "source_job_sha256",
    JOB_SHA256,
    runId,
    "job digest",
  );
  const ledgerMode = publishedRecordMode(fromLedger, runId);
  if (ledgerSourceJob && ledgerStateRevision && ledgerJobSha256 && ledgerMode) {
    return {
      source_job: ledgerSourceJob,
      mode: ledgerMode,
      state_revision: ledgerStateRevision,
      job_sha256: ledgerJobSha256,
    };
  }

  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `clawsweeper-repair-requeue-${runId}-`),
  );
  try {
    const downloaded = spawnSync(
      "gh",
      ["run", "download", runId, "--repo", repo, "--dir", artifactDir],
      { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
    );
    if (downloaded.status !== 0) {
      throw new Error(`could not resolve run ${runId}: ${downloaded.stderr || downloaded.stdout}`);
    }
    const recovered = resolveDownloadedRunCohort(artifactDir, runId, ledgerSourceJob || null);
    if (ledgerStateRevision && ledgerStateRevision !== recovered.state_revision) {
      throw new Error(`run ${runId} record state revision conflicts with its artifact cohort`);
    }
    if (ledgerJobSha256 && ledgerJobSha256 !== recovered.job_sha256) {
      throw new Error(`run ${runId} record job digest conflicts with its artifact cohort`);
    }
    if (ledgerMode && ledgerMode !== recovered.mode) {
      throw new Error(`run ${runId} record effective mode conflicts with its artifact cohort`);
    }
    return recovered;
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

function readPublishedRunRecord(runId: string): LooseRecord | null {
  const file = path.join(runRecordsDir, `${runId}.json`);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`run ${runId} record must be a JSON object`);
  }
  const recordedRunId = String(record.run_id ?? "").trim();
  if (recordedRunId && recordedRunId !== runId) {
    throw new Error(`run ${runId} record identity conflicts with its filename`);
  }
  return record;
}

function publishedRecordField(
  record: LooseRecord | null,
  field: string,
  pattern: RegExp,
  runId: string,
  label: string,
): string | null {
  const value = String(record?.[field] ?? "").trim();
  if (!value) return null;
  if (!pattern.test(value)) {
    throw new Error(`run ${runId} record has invalid ${label}`);
  }
  return value;
}

function publishedRecordMode(record: LooseRecord | null, runId: string): string | null {
  const mode = String(record?.mode ?? "").trim();
  if (!mode) return null;
  if (!REPAIR_MODES.has(mode)) {
    throw new Error(`run ${runId} record has invalid effective mode`);
  }
  return mode;
}

function resolveDownloadedRunCohort(
  root: string,
  runId: string,
  expectedSourceJob: string | null,
): RecoveredRunCohort {
  const candidatesByAttempt = new Map<number, RecoveredRunCohort[]>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const producerAttempt = repairArtifactProducerAttempt(entry.name, runId);
    if (producerAttempt === null) continue;
    const artifactRoot = path.join(root, entry.name);
    for (const inputPath of findNamedFiles(artifactRoot, WORKFLOW_INPUTS_BASENAME)) {
      const candidate = readRecoveredWorkflowInputs({
        inputPath,
        producerAttempt,
        expectedSourceJob,
      });
      candidatesByAttempt.set(producerAttempt, [
        ...(candidatesByAttempt.get(producerAttempt) ?? []),
        candidate,
      ]);
    }
    for (const planPath of findNamedFiles(artifactRoot, "cluster-plan.json")) {
      const runDir = path.dirname(planPath);
      const resultPath = path.join(runDir, "result.json");
      const identityPath = path.join(runDir, "source-job.json");
      if (!fs.existsSync(resultPath) || !fs.existsSync(identityPath)) continue;
      const candidate = readRecoveredRunCohort({
        planPath,
        resultPath,
        identityPath,
        producerAttempt,
        expectedSourceJob,
      });
      candidatesByAttempt.set(producerAttempt, [
        ...(candidatesByAttempt.get(producerAttempt) ?? []),
        candidate,
      ]);
    }
  }

  for (const producerAttempt of [...candidatesByAttempt.keys()].sort(
    (left, right) => right - left,
  )) {
    const candidates = candidatesByAttempt.get(producerAttempt) ?? [];
    const unique = new Map(
      candidates.map((candidate) => [JSON.stringify(candidate), candidate] as const),
    );
    if (unique.size > 1) {
      throw new Error(
        `run ${runId} has an ambiguous repair artifact cohort at attempt ${producerAttempt}`,
      );
    }
    const selected = unique.values().next().value;
    if (selected) return selected;
  }
  throw new Error(
    `run ${runId} did not publish immutable workflow inputs or one complete sealed repair artifact cohort`,
  );
}

function readRecoveredWorkflowInputs({
  inputPath,
  producerAttempt,
  expectedSourceJob,
}: {
  inputPath: string;
  producerAttempt: number;
  expectedSourceJob: string | null;
}): RecoveredRunCohort {
  const input = readJsonObject(inputPath, "immutable workflow inputs");
  const inputKeys = Object.keys(input).sort();
  if (
    JSON.stringify(inputKeys) !==
    JSON.stringify([
      "effective_mode",
      "job_sha256",
      "requested_mode",
      "schema_version",
      "source_job",
      "state_revision",
    ])
  ) {
    throw new Error("immutable workflow inputs have unexpected fields");
  }
  const sourceJob = String(input.source_job ?? "").trim();
  const stateRevision = String(input.state_revision ?? "").trim();
  const jobSha256 = String(input.job_sha256 ?? "").trim();
  const requestedMode = String(input.requested_mode ?? "").trim();
  const effectiveMode = String(input.effective_mode ?? "").trim();
  if (
    input.schema_version !== 1 ||
    !SOURCE_JOB_PATH.test(sourceJob) ||
    !STATE_REVISION.test(stateRevision) ||
    !JOB_SHA256.test(jobSha256) ||
    (expectedSourceJob !== null && sourceJob !== expectedSourceJob) ||
    !REPAIR_MODES.has(requestedMode) ||
    !REPAIR_MODES.has(effectiveMode) ||
    (effectiveMode !== requestedMode && effectiveMode !== "plan")
  ) {
    throw new Error("immutable workflow inputs have invalid repair provenance");
  }
  return {
    source_job: sourceJob,
    mode: effectiveMode,
    state_revision: stateRevision,
    job_sha256: jobSha256,
    producer_attempt: producerAttempt,
  };
}

function readRecoveredRunCohort({
  planPath,
  resultPath,
  identityPath,
  producerAttempt,
  expectedSourceJob,
}: {
  planPath: string;
  resultPath: string;
  identityPath: string;
  producerAttempt: number;
  expectedSourceJob: string | null;
}): RecoveredRunCohort {
  const plan = readJsonObject(planPath, "cluster plan");
  const result = readJsonObject(resultPath, "repair result");
  const identity = readJsonObject(identityPath, "source job identity");
  const identityKeys = Object.keys(identity).sort();
  if (
    JSON.stringify(identityKeys) !==
    JSON.stringify(["job_sha256", "schema_version", "source_job", "state_revision"])
  ) {
    throw new Error("sealed source job identity has unexpected fields");
  }
  const sourceJob = String(identity.source_job ?? "").trim();
  const stateRevision = String(identity.state_revision ?? "").trim();
  const jobSha256 = String(identity.job_sha256 ?? "").trim();
  const planSourceJob = String(plan.source_job ?? "").trim();
  if (
    identity.schema_version !== 1 ||
    !SOURCE_JOB_PATH.test(sourceJob) ||
    !STATE_REVISION.test(stateRevision) ||
    !JOB_SHA256.test(jobSha256) ||
    planSourceJob !== sourceJob ||
    (expectedSourceJob !== null && sourceJob !== expectedSourceJob)
  ) {
    throw new Error("sealed repair artifact cohort has invalid source job provenance");
  }
  const planMode = String(plan.mode ?? "").trim();
  const resultMode = String(result.mode ?? planMode).trim();
  if (!REPAIR_MODES.has(planMode) || !REPAIR_MODES.has(resultMode) || planMode !== resultMode) {
    throw new Error("sealed repair artifact cohort has inconsistent repair mode");
  }
  return {
    source_job: sourceJob,
    mode: resultMode,
    state_revision: stateRevision,
    job_sha256: jobSha256,
    producer_attempt: producerAttempt,
  };
}

function repairArtifactProducerAttempt(name: string, runId: string): number | null {
  const match = name.match(
    new RegExp(`^clawsweeper-repair(?:-(?:inputs|worker))?-${runId}-([1-9][0-9]*)$`),
  );
  if (!match) return null;
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) ? attempt : null;
}

function findNamedFiles(root: string, basename: string): string[] {
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === basename) matches.push(candidate);
    }
  }
  return matches.sort();
}

function readJsonObject(file: string, label: string): LooseRecord {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function dispatchJob(
  jobPath: string,
  mode: string,
  dispatchKey: string,
  lifecycle: CommandLifecycleInput,
) {
  const result = runCommandLifecycleMutation(lifecycle, {
    kind: "requeue_dispatch",
    identity: {
      repository: repo,
      workflow,
      sourceJobPath,
      sourceJobSha256: authorizationSha256,
      sourceStateRevision: immutableJob.stateRevision,
      depth: nextRequeueDepth,
      dispatchKey,
    },
    component: "repair_requeue",
    operation: () =>
      spawnSync(
        "gh",
        [
          "workflow",
          "run",
          workflow,
          "--repo",
          repo,
          "-f",
          `job=${jobPath}`,
          "-f",
          `dispatch_key=${dispatchKey}`,
          ...immutableJobDispatchArgs(immutableJob),
          "-f",
          `mode=${mode}`,
          "-f",
          `runner=${runner}`,
          "-f",
          `execution_runner=${executionRunner}`,
          "-f",
          `model=${model}`,
          "-f",
          "requeue=true",
          "-f",
          `requeue_depth=${nextRequeueDepth}`,
        ],
        { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
      ),
    outcome: (dispatch) => (dispatch.status === 0 && !dispatch.error ? "accepted" : "unknown"),
  });
  if (result.status !== 0) {
    throw new Error(`failed to dispatch ${jobPath}: ${result.stderr || result.stdout}`);
  }
}

function waitForStartedRuns({ expectedCount, headSha, since }: LooseRecord) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let latest: JsonValue[] = [];
  while (Date.now() < deadline) {
    latest = listClusterRuns()
      .filter((run: JsonValue) => run.headSha === headSha)
      .filter((run: JsonValue) => Date.parse(run.createdAt) >= Date.parse(since))
      .sort(
        (left: JsonValue, right: JsonValue) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt),
      );
    if (
      latest.length >= expectedCount &&
      latest.every((run: JsonValue) => !QUEUED_STATUSES.has(run.status))
    ) {
      return latest.slice(-expectedCount);
    }
    sleepMs(5_000);
  }
  return latest.slice(-expectedCount);
}

function assertGateOpenIfNeeded(mode: string) {
  if (!["execute", "autonomous"].includes(mode)) return;
  if (readGate("CLAWSWEEPER_ALLOW_EXECUTE") !== "1") {
    throw new Error(
      "refusing write-mode requeue: CLAWSWEEPER_ALLOW_EXECUTE is not 1; use --open-execute-window",
    );
  }
}

function listClusterRuns() {
  const workflowName = workflowDisplayName(workflow);
  return ghJson<LooseRecord[]>([
    "run",
    "list",
    "--repo",
    repo,
    "--limit",
    "200",
    "--json",
    "databaseId,workflowName,headSha,status,conclusion,createdAt,url",
  ]).filter((run: LooseRecord) => run.workflowName === workflowName);
}

function workflowDisplayName(workflowNameOrFile: string): string {
  if (workflowNameOrFile === "repair-cluster-worker.yml") return "repair cluster worker";
  return workflowNameOrFile;
}

function readGate(name: string) {
  const variables = ghJson(["variable", "list", "--repo", repo, "--json", "name,value"]);
  return variables.find((variable: JsonValue) => variable.name === name)?.value ?? "";
}

function openGate(name: string, lifecycle: CommandLifecycleInput) {
  const previous = readGate(name);
  gateRestores.push({ name, previous });
  if (previous !== "1") setGate(name, "1", lifecycle);
}

function setGate(name: string, value: JsonValue, lifecycle: CommandLifecycleInput) {
  runCommandLifecycleMutation(lifecycle, {
    kind: "repository_variable_update",
    identity: { repository: repo, name, value: String(value ?? "") },
    component: "repair_requeue",
    operation: () =>
      ghText(["variable", "set", name, "--repo", repo, "--body", String(value ?? "")]),
  });
  console.log(`${name}=${value}`);
}

function currentHeadSha() {
  return execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function looksLikeRunId(value: JsonValue) {
  return /^[0-9]{6,}$/.test(String(value ?? ""));
}

function nonNegativeIntegerArg(value: JsonValue, name: string, fallback: number): number {
  if (value === undefined || value === null || value === false || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}
