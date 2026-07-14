#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveSpawnCommand, runText } from "../command.js";
import {
  assertLiveWorkerCapacity,
  currentProjectRepo,
  parseArgs,
  parseRepairRunTitle,
  readMaxLiveWorkers,
  repoRoot,
  waitForLiveWorkerCapacity,
} from "./lib.js";
import { ghEnv, ghErrorText, ghJson, ghSpawn, ghText } from "./github-cli.js";
import { sleepMs } from "./timing.js";
import { REPAIR_CLUSTER_WORKFLOW } from "./constants.js";
import {
  immutableJobDispatchArgs,
  isMissingImmutableJobError,
  resolveCurrentStateJobIdentity,
  resolveStateJobIdentity,
} from "./immutable-job-handoff.js";
import { activeRepairJobGenerations as listActiveRepairJobGenerations } from "./live-worker-capacity.js";
import { runRepairMutation, type RepairLifecycleInput } from "./repair-action-ledger.js";
import {
  restoreGateSequence,
  restoreGateWithFallback,
  type GateCleanupFailure,
  type GateRestoreResult,
} from "./self-heal-gate-restore.js";
import { fetchWorkflowRunHistory } from "./workflow-run-history.js";
import {
  boundedRecoveryTimeoutMs,
  isRepairWorkflowArtifactUnavailable,
  readNewestRepairWorkflowRecoveryInputs,
  resolveRepairWorkflowRetryMode,
  type RepairWorkflowRecoveryInputs,
} from "./workflow-recovery-inputs.js";

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
const STATE_REVISION_FETCH_TIMEOUT_MS = 60_000;
const WORKFLOW_INPUT_DOWNLOAD_TIMEOUT_MS = 60_000;
const RECOVERY_SCAN_BUDGET_MS = 3 * 60_000;
const MAX_RECOVERY_CANDIDATE_SCANS = 200;
const preparedStateRevisions = new Set<string>();

type GateState = {
  exists: boolean;
  value: string;
};

type GateRestore = {
  name: string;
  previous: GateState;
};

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? DEFAULT_REPO);
const workflow = String(args.workflow ?? DEFAULT_WORKFLOW);
const runner = String(args.runner ?? DEFAULT_RUNNER);
const executionRunner = String(
  args["execution-runner"] ?? args.execution_runner ?? DEFAULT_EXECUTION_RUNNER,
);
const model = String(args.model ?? process.env.CLAWSWEEPER_MODEL ?? "internal");
const maxJobs = Number(args["max-jobs"] ?? args.limit ?? 5);
const maxAgeHours = Number(
  args["max-age-hours"] ??
    args.max_age_hours ??
    process.env.CLAWSWEEPER_SELF_HEAL_MAX_AGE_HOURS ??
    6,
);
const maxAttemptsPerJob = Number(process.env.CLAWSWEEPER_SELF_HEAL_MAX_ATTEMPTS_PER_JOB ?? 3);
const maxLiveWorkers = readMaxLiveWorkers(args);
const waitForCapacity = Boolean(args["wait-for-capacity"]);
const execute = Boolean(args.execute);
const openExecuteWindow = Boolean(args["open-execute-window"] || args.live);
const allowRepeat = Boolean(args["allow-repeat"]);
const requestedMode = typeof args.mode === "string" ? args.mode : null;
const runRecordsDir = path.resolve(
  String(args["runs-dir"] ?? args.runs_dir ?? path.join(repoRoot(), "results", "runs")),
);
const skippedCandidates: LooseRecord[] = [];

if (!Number.isInteger(maxJobs) || maxJobs < 1) {
  throw new Error("--max-jobs must be a positive integer");
}
if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
  throw new Error("--max-age-hours must be a positive number");
}
if (!Number.isInteger(maxAttemptsPerJob) || maxAttemptsPerJob < 1) {
  throw new Error("CLAWSWEEPER_SELF_HEAL_MAX_ATTEMPTS_PER_JOB must be a positive integer");
}
if (requestedMode !== null && !REPAIR_MODES.has(requestedMode)) {
  throw new Error("--mode must be plan, execute, or autonomous");
}

const candidates = selectCandidates();
const summary: LooseRecord = {
  status: execute ? "dispatching" : "dry_run",
  repo,
  workflow,
  runner,
  execution_runner: executionRunner,
  model,
  max_jobs: maxJobs,
  max_age_hours: maxAgeHours,
  max_attempts_per_job: maxAttemptsPerJob,
  max_live_workers: maxLiveWorkers,
  candidates: candidates.map((candidate: JsonValue) => summarizeCandidate(candidate)),
  skipped_candidates: skippedCandidates,
};

if (candidates.length === 0) {
  summary.status = "no_candidates";
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (!execute) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const gateRestores: GateRestore[] = [];
const dispatchStartedAt = new Date(Date.now() - 5000).toISOString();
const headSha = currentHeadSha();
const ledger = readSelfHealLedger();
const batchId = `self-heal-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const attempts: LooseRecord[] = candidates.map((candidate: JsonValue) => ({
  batch_id: batchId,
  source_run_id: candidate.run_id,
  cluster_id: candidate.cluster_id,
  source_job: candidate.source_job,
  source_state_revision: candidate.source_state_revision,
  source_job_sha256: candidate.source_job_sha256,
  immutable_job_key: candidate.immutable_job_key,
  source_dispatch_key: candidate.source_dispatch_key,
  mode: candidate.mode,
  runner: candidate.runner,
  execution_runner: candidate.execution_runner,
  planner_sandbox: candidate.planner_sandbox,
  model: candidate.model,
  dry_run: candidate.dry_run,
  requeue: candidate.requeue,
  requeue_depth: candidate.requeue_depth,
  workflow,
  repo,
  dispatched_at: new Date().toISOString(),
  dispatched_run_ids: [],
  status: "pending",
}));

let primaryFailure: unknown = null;
let cleanupRestoreFailures: GateCleanupFailure[] = [];
try {
  if (openExecuteWindow && candidates.some(isWriteCandidate)) {
    openGate("CLAWSWEEPER_ALLOW_EXECUTE");
    openGate("CLAWSWEEPER_ALLOW_FIX_PR");
  } else {
    assertExecuteGateOpenIfNeeded(candidates);
  }

  summary.live_worker_capacity_before_dispatch = waitForCapacity
    ? waitForLiveWorkerCapacity({ repo, workflow, requested: candidates.length, maxLiveWorkers })
    : assertLiveWorkerCapacity({ repo, workflow, requested: candidates.length, maxLiveWorkers });

  for (let i = 0; i < candidates.length; i += 1) {
    dispatchCandidate(candidates[i]);
    attempts[i].status = "dispatched";
  }

  const observedRuns = openExecuteWindow
    ? waitForStartedRuns({
        expectedCount: candidates.length,
        headSha,
        since: dispatchStartedAt,
      })
    : [];
  const observedRunIds = observedRuns.map((run: JsonValue) => String(run.databaseId));
  for (const attempt of attempts) {
    attempt.dispatched_run_ids = observedRunIds;
    attempt.observed_runs = observedRuns.map((run: JsonValue) => ({
      run_id: String(run.databaseId),
      status: run.status,
      conclusion: run.conclusion ?? null,
      created_at: run.createdAt,
      url: run.url,
    }));
  }

  appendAttempts(ledger, attempts);
  writeSelfHealLedger(ledger);

  summary.status = "dispatched";
  summary.batch_id = batchId;
  summary.observed_runs = attempts[0]?.observed_runs ?? [];
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  primaryFailure = error;
} finally {
  const cleanupFailures = restoreOpenedGates();
  cleanupRestoreFailures = cleanupFailures.restoreFailures;
  for (const failure of cleanupFailures.receiptFailures) {
    console.error(
      `self-heal: restored ${failure.name} but failed to record its cleanup receipt: ${errorText(failure.error)}`,
    );
  }
  for (const failure of cleanupFailures.restoreFailures) {
    console.error(`self-heal: failed to restore ${failure.name}: ${errorText(failure.error)}`);
  }
}
if (primaryFailure !== null) throw primaryFailure;
if (cleanupRestoreFailures.length > 0) {
  throw new AggregateError(
    cleanupRestoreFailures.map((failure) => failure.error),
    "self-heal failed to restore one or more execution gates",
  );
}

function selectCandidates() {
  const records = readRunRecords();
  const attempts = readSelfHealLedger().attempts ?? [];
  const activeJobGenerations = execute ? activeRepairJobGenerations() : new Map<string, string[]>();
  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const attemptedRunGenerations = new Set<string>();
  const attemptCountsByGeneration = new Map<string, number>();
  for (const attempt of attempts) {
    const generation = attemptImmutableJobKey(attempt);
    if (!generation) continue;
    const sourceRunId = String(attempt.source_run_id ?? "");
    if (sourceRunId) attemptedRunGenerations.add(`${sourceRunId}:${generation}`);
    attemptCountsByGeneration.set(generation, (attemptCountsByGeneration.get(generation) ?? 0) + 1);
  }
  const latestByGeneration = new Map<string, LooseRecord>();

  for (const record of records) {
    const sourceJob = record.source_job;
    if (typeof sourceJob !== "string" || !sourceJob) {
      skippedCandidates.push({ reason: "missing_source_job", run_id: record.run_id ?? null });
      continue;
    }
    const generation = runRecordGenerationKey(record, sourceJob);
    const current = latestByGeneration.get(generation);
    const recordSortKey = runSortKey(record);
    const currentSortKey = current ? runSortKey(current) : Number.NEGATIVE_INFINITY;
    if (
      !current ||
      recordSortKey > currentSortKey ||
      (recordSortKey === currentSortKey && record.live_run_record === true)
    ) {
      latestByGeneration.set(generation, record);
    }
  }

  const eligible = [...latestByGeneration.values()]
    .filter((record: JsonValue) => record.workflow_conclusion === "failure")
    .filter((record: JsonValue) => {
      const timestamp = recordTimestampMs(record);
      if (timestamp >= cutoffMs) return true;
      skippedCandidates.push({
        reason: "older_than_max_age",
        run_id: record.run_id ?? null,
        source_job: record.source_job ?? null,
        published_at: record.published_at ?? null,
        workflow_created_at: record.workflow_created_at ?? null,
        workflow_updated_at: record.workflow_updated_at ?? null,
      });
      return false;
    })
    .sort((left: JsonValue, right: JsonValue) => runSortKey(right) - runSortKey(left));
  const boundedEligible = eligible.slice(0, MAX_RECOVERY_CANDIDATE_SCANS);
  const recoveryDeadlineMs = Date.now() + RECOVERY_SCAN_BUDGET_MS;
  const selected: LooseRecord[] = [];

  for (const record of boundedEligible) {
    if (selected.length >= maxJobs) break;
    const sourceJob = String(record.source_job ?? "");
    const recoveryTimeoutMs = boundedRecoveryTimeoutMs({
      deadlineMs: recoveryDeadlineMs,
      nowMs: Date.now(),
      maxTimeoutMs: WORKFLOW_INPUT_DOWNLOAD_TIMEOUT_MS,
    });
    if (recoveryTimeoutMs === 0) {
      skippedCandidates.push({
        reason: "recovery_budget_exhausted",
        run_id: record.run_id ?? null,
        source_job: sourceJob,
      });
      break;
    }

    let recoveredInputs: RepairWorkflowRecoveryInputs | null = null;
    try {
      recoveredInputs = recoverWorkflowInputs(record, recoveryTimeoutMs);
    } catch (error) {
      skippedCandidates.push({
        reason: "immutable_inputs_invalid",
        run_id: record.run_id ?? null,
        source_job: sourceJob,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let candidate: LooseRecord;
    try {
      const immutableJob = resolveRunRecordJob(record, sourceJob, recoveredInputs);
      const plannerSandbox = String(
        args["planner-sandbox"] ??
          args.planner_sandbox ??
          recoveredInputs?.planner_sandbox ??
          "read-only",
      );
      if (!["read-only", "danger-full-access"].includes(plannerSandbox)) {
        throw new Error(`unsupported planner sandbox: ${plannerSandbox}`);
      }
      const mode = immutableJob.legacyUnsealed
        ? "plan"
        : resolveRepairWorkflowRetryMode({
            requestedMode,
            recoveredMode: recoveredInputs?.effective_mode ?? immutableJob.effectiveMode ?? "plan",
            fallbackMode: record.effective_mode ?? record.mode ?? immutableJob.job.frontmatter.mode,
          });
      candidate = {
        ...record,
        source_job: immutableJob.jobPath,
        source_state_revision: immutableJob.stateRevision,
        source_job_sha256: immutableJob.jobSha256,
        immutable_job_key: jobContentGenerationKey(immutableJob.jobPath, immutableJob.jobSha256),
        ...(immutableJob.legacyUnsealed ? { legacy_unsealed: true } : {}),
        source_dispatch_key: recoveredInputs?.source_dispatch_key ?? null,
        mode,
        runner: String(args.runner ?? recoveredInputs?.runner ?? runner),
        execution_runner: String(
          args["execution-runner"] ??
            args.execution_runner ??
            recoveredInputs?.execution_runner ??
            executionRunner,
        ),
        planner_sandbox: plannerSandbox,
        model: String(args.model ?? recoveredInputs?.model ?? model),
        dry_run: immutableJob.legacyUnsealed
          ? true
          : booleanArg(args["dry-run"] ?? args.dry_run, recoveredInputs?.dry_run ?? true),
        requeue: recoveredInputs?.requeue ?? false,
        requeue_depth: recoveredInputs?.requeue_depth ?? 0,
      };
    } catch (error) {
      skippedCandidates.push({
        reason: isMissingImmutableJobError(error)
          ? "missing_job_file"
          : "immutable_provenance_unavailable",
        run_id: record.run_id ?? null,
        source_job: sourceJob,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const activeRunIds = [
      ...(activeJobGenerations.get(
        activeJobGenerationKey(candidate.source_job, candidate.source_job_sha256),
      ) ?? []),
      ...(activeJobGenerations.get(String(candidate.source_job ?? "")) ?? []),
    ].filter((runId, index, all) => all.indexOf(runId) === index);
    if (activeRunIds.length > 0) {
      skippedCandidates.push({
        reason: "active_repair_run",
        run_id: candidate.run_id ?? null,
        source_job: candidate.source_job,
        source_state_revision: candidate.source_state_revision,
        source_job_sha256: candidate.source_job_sha256,
        active_run_ids: activeRunIds,
      });
      continue;
    }

    if (!allowRepeat) {
      const runId = String(candidate.run_id ?? "");
      const generation = String(candidate.immutable_job_key ?? "");
      if (runId && attemptedRunGenerations.has(`${runId}:${generation}`)) continue;
      if ((attemptCountsByGeneration.get(generation) ?? 0) >= maxAttemptsPerJob) {
        skippedCandidates.push({
          reason: "retry_limit_reached",
          run_id: runId || null,
          source_job: candidate.source_job,
          source_state_revision: candidate.source_state_revision,
          source_job_sha256: candidate.source_job_sha256,
          attempts: attemptCountsByGeneration.get(generation) ?? 0,
        });
        continue;
      }
    }
    selected.push(candidate);
  }
  return selected;
}

function runRecordGenerationKey(record: LooseRecord, sourceJob: string): string {
  const jobSha256 = String(record.source_job_sha256 ?? "").trim();
  return JOB_SHA256.test(jobSha256)
    ? jobContentGenerationKey(sourceJob, jobSha256)
    : `${sourceJob}:unsealed`;
}

function resolveRunRecordJob(
  record: LooseRecord,
  sourceJob: string,
  recoveredInputs: RepairWorkflowRecoveryInputs | null,
) {
  const stateRevision = String(record.source_state_revision ?? "").trim();
  const jobSha256 = String(record.source_job_sha256 ?? "").trim();
  if (recoveredInputs && recoveredInputs.source_job !== sourceJob) {
    throw new Error("immutable workflow inputs conflict with the selected source job");
  }
  if (stateRevision) {
    if (!STATE_REVISION.test(stateRevision)) throw new Error("state revision is malformed");
    if (
      recoveredInputs &&
      "state_revision" in recoveredInputs &&
      (recoveredInputs.state_revision !== stateRevision || recoveredInputs.job_sha256 !== jobSha256)
    ) {
      throw new Error("immutable workflow inputs conflict with published repair provenance");
    }
    ensureHistoricalStateRevision(stateRevision);
    return {
      ...resolveStateJobIdentity({
        jobPath: sourceJob,
        stateRevision,
        jobSha256,
      }),
      effectiveMode: null,
      legacyUnsealed: false,
    };
  }
  if (jobSha256) {
    if (!JOB_SHA256.test(jobSha256)) throw new Error("job SHA-256 is malformed");
    if (!recoveredInputs || !("state_revision" in recoveredInputs)) {
      throw new Error("immutable recovery inputs do not include a state revision");
    }
    if (recoveredInputs.job_sha256 !== jobSha256) {
      throw new Error("immutable recovery inputs conflict with the published job digest");
    }
    ensureHistoricalStateRevision(recoveredInputs.state_revision);
    return {
      ...resolveStateJobIdentity({
        jobPath: sourceJob,
        stateRevision: recoveredInputs.state_revision,
        jobSha256: recoveredInputs.job_sha256,
      }),
      effectiveMode: recoveredInputs.effective_mode,
      legacyUnsealed: false,
    };
  }
  return {
    ...resolveCurrentStateJobIdentity(sourceJob),
    effectiveMode: null,
    legacyUnsealed: true,
  };
}

function recoverWorkflowInputs(
  record: LooseRecord,
  timeoutMs: number,
): RepairWorkflowRecoveryInputs | null {
  const runId = String(record.run_id ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(runId)) return null;
  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `clawsweeper-self-heal-inputs-${runId}-`),
  );
  try {
    const env = ghEnv();
    const cwd = repoRoot();
    const command = resolveSpawnCommand(
      "gh",
      [
        "run",
        "download",
        runId,
        "--repo",
        repo,
        "--pattern",
        `clawsweeper-repair-inputs-${runId}-*`,
        "--dir",
        artifactDir,
      ],
      { cwd, env },
    );
    const downloaded = spawnSync(command.command, command.args, {
      cwd,
      encoding: "utf8",
      env,
      stdio: "pipe",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    if (downloaded.status !== 0) {
      if (isRepairWorkflowArtifactUnavailable(downloaded.stderr, downloaded.stdout)) return null;
      throw new Error(
        `could not recover run ${runId} inputs: ${
          downloaded.stderr ||
          downloaded.stdout ||
          downloaded.error?.message ||
          "artifact unavailable"
        }`,
      );
    }
    const recovered = readNewestRepairWorkflowRecoveryInputs(artifactDir, runId);
    if (recovered && recovered.source_job !== String(record.source_job ?? "")) {
      throw new Error(`run ${runId} immutable inputs conflict with the selected source job`);
    }
    return recovered;
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

function activeRepairJobGenerations() {
  try {
    return listActiveRepairJobGenerations({ repo, workflow });
  } catch (error) {
    throw new Error(
      `cannot verify active repair generations; refusing dispatch: ${ghErrorText(error)}`,
    );
  }
}

function dispatchCandidate(candidate: LooseRecord) {
  const commandArgs = [
    "workflow",
    "run",
    workflow,
    "--repo",
    repo,
    "-f",
    `job=${candidate.source_job}`,
    ...immutableJobDispatchArgs({
      stateRevision: candidate.source_state_revision,
      jobSha256: candidate.source_job_sha256,
    }),
    "-f",
    `mode=${candidate.mode}`,
    "-f",
    `runner=${candidate.runner}`,
    "-f",
    `execution_runner=${candidate.execution_runner}`,
    "-f",
    `planner_sandbox=${candidate.planner_sandbox}`,
    "-f",
    `model=${candidate.model}`,
    "-f",
    `dry_run=${candidate.dry_run}`,
    "-f",
    `requeue=${candidate.requeue}`,
    "-f",
    `requeue_depth=${candidate.requeue_depth}`,
  ];
  runRepairMutation(selfHealDispatchLifecycle(candidate), {
    kind: "repair_dispatch",
    operationName: "failed_run_self_heal",
    component: "failed_run_self_heal",
    identity: {
      repository: repo,
      workflow,
      sourceRunId: candidate.run_id,
      jobPath: candidate.source_job,
      stateRevision: candidate.source_state_revision,
      jobSha256: candidate.source_job_sha256,
      mode: candidate.mode,
      runner: candidate.runner,
      executionRunner: candidate.execution_runner,
      plannerSandbox: candidate.planner_sandbox,
      model: candidate.model,
      dryRun: candidate.dry_run,
      requeue: candidate.requeue,
      requeueDepth: candidate.requeue_depth,
    },
    operation: () => {
      const result = ghSpawn(commandArgs, { cwd: repoRoot() });
      if (result.status !== 0) {
        throw new Error(
          `failed to dispatch ${candidate.source_job}: ${result.stderr || result.stdout}`,
        );
      }
      return result;
    },
  });
  console.log(`dispatched ${candidate.source_job} from failed run ${candidate.run_id}`);
}

function waitForStartedRuns({ expectedCount, headSha, since }: LooseRecord) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let latest: JsonValue[] = [];
  while (Date.now() < deadline) {
    latest = listClusterRuns({ cutoffMs: Date.parse(since) })
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
      return latest;
    }
    sleepMs(10_000);
  }
  return latest;
}

function assertExecuteGateOpenIfNeeded(candidates: LooseRecord[]) {
  if (!candidates.some(isWriteCandidate)) return;
  const current = readExecuteGate();
  if (current !== "1") {
    throw new Error(
      "refusing write-mode self-heal: CLAWSWEEPER_ALLOW_EXECUTE is not 1; rerun with --open-execute-window or open the gate manually",
    );
  }
  const fixCurrent = readFixGate();
  if (fixCurrent !== "1") {
    throw new Error(
      "refusing write-mode self-heal: CLAWSWEEPER_ALLOW_FIX_PR is not 1; rerun with --open-execute-window or open both gates manually",
    );
  }
}

function readRunRecords() {
  const records = fs.existsSync(runRecordsDir)
    ? fs
        .readdirSync(runRecordsDir)
        .filter((name: string) => name.endsWith(".json"))
        .map((name: string) => JSON.parse(fs.readFileSync(path.join(runRecordsDir, name), "utf8")))
    : [];
  return [...records, ...liveRunRecords(liveRunDiscoveryCutoffMs(records))];
}

function liveRunDiscoveryCutoffMs(records: LooseRecord[]): number {
  const maxAgeCutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let cutoffMs = maxAgeCutoffMs;
  for (const record of records) {
    if (recordTimestampMs(record) < maxAgeCutoffMs) continue;
    const createdAtMs = Date.parse(String(record.workflow_created_at ?? ""));
    if (!Number.isFinite(createdAtMs)) return 0;
    cutoffMs = Math.min(cutoffMs, createdAtMs);
  }
  return cutoffMs;
}

function liveRunRecords(cutoffMs: number) {
  try {
    return listClusterRuns({ cutoffMs })
      .map((run: LooseRecord) => {
        const parsed = parseRepairRunTitle(run.displayTitle);
        if (!parsed) return null;
        return {
          run_id: String(run.databaseId ?? ""),
          source_job: parsed.jobPath,
          source_job_sha256: parsed.jobSha256,
          workflow_conclusion: run.conclusion ?? null,
          workflow_created_at: run.createdAt ?? null,
          workflow_updated_at: run.updatedAt ?? null,
          run_url: run.url ?? null,
          live_run_record: true,
        };
      })
      .filter(Boolean);
  } catch (error) {
    const detail = ghErrorText(error);
    if (execute) {
      throw new Error(`cannot list live repair runs; refusing dispatch: ${detail}`);
    }
    console.warn(`self-heal: cannot list live repair runs: ${detail}`);
    return [];
  }
}

function readSelfHealLedger() {
  const file = selfHealLedgerPath();
  if (!fs.existsSync(file)) {
    return { updated_at: null, attempts: [] };
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function appendAttempts(ledger: LooseRecord, attempts: LooseRecord[]) {
  ledger.updated_at = new Date().toISOString();
  ledger.attempts = [...(ledger.attempts ?? []), ...attempts];
}

function writeSelfHealLedger(ledger: LooseRecord) {
  const file = selfHealLedgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function selfHealLedgerPath() {
  return path.join(repoRoot(), "results", "self-heal.json");
}

function listClusterRuns({
  cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000,
}: {
  cutoffMs?: number;
} = {}) {
  return fetchWorkflowRunHistory({ repo, workflow, cutoffMs });
}

function readExecuteGate() {
  return readGateValue("CLAWSWEEPER_ALLOW_EXECUTE", { preferEnv: true });
}

function readFixGate() {
  return readGateValue("CLAWSWEEPER_ALLOW_FIX_PR", { preferEnv: true });
}

function openGate(name: string) {
  const previous = readMutableGateState(name);
  gateRestores.push({ name, previous });
  if (!previous.exists || previous.value !== "1") setGate(name, "1");
}

function readMutableGateState(name: string): GateState {
  const variables = readRepoVariables({ required: true });
  const variable = variables.find((candidate: JsonValue) => candidate.name === name);
  return variable
    ? { exists: true, value: String(variable.value ?? "") }
    : { exists: false, value: "" };
}

function readGateValue(name: string, { preferEnv }: { preferEnv: boolean }) {
  const envValue = process.env[name];
  if (preferEnv && envValue !== undefined && envValue !== "") return envValue;
  const variables = readRepoVariables();
  return variables.find((variable: JsonValue) => variable.name === name)?.value ?? envValue ?? "";
}

function readRepoVariables({ required = false }: { required?: boolean } = {}) {
  try {
    return ghJson<LooseRecord[]>(["variable", "list", "--repo", repo, "--json", "name,value"]);
  } catch (error) {
    const detail = ghErrorText(error);
    if (/HTTP 403|Resource not accessible by integration/i.test(detail)) {
      if (required) {
        throw new Error(
          `cannot read repository variables before opening temporary execution gates: ${detail}`,
        );
      }
      console.warn("self-heal: cannot read repo variables; falling back to workflow env");
      return [];
    }
    throw error;
  }
}

function setGate(name: string, value: JsonValue) {
  const normalizedValue = String(value ?? "");
  runRepairMutation(selfHealGateLifecycle(name, normalizedValue), {
    kind: "repository_variable_update",
    operationName: "failed_run_self_heal_gate",
    component: "failed_run_self_heal",
    identity: { repository: repo, variable: name, value: normalizedValue },
    operation: () => writeGateValue(name, normalizedValue),
  });
}

function restoreOpenedGates(): {
  receiptFailures: GateCleanupFailure[];
  restoreFailures: GateCleanupFailure[];
} {
  return restoreGateSequence(
    gateRestores.map((gate) => ({ name: gate.name, state: gate.previous })),
    restoreGate,
  );
}

function restoreGate(name: string, state: GateState): GateRestoreResult {
  const receiptState = state.exists ? `set:${state.value}` : "delete";
  return restoreGateWithFallback({
    runWithReceipt: (operation) =>
      runRepairMutation(selfHealGateLifecycle(name, receiptState), {
        kind: "repository_variable_update",
        operationName: "failed_run_self_heal_gate",
        component: "failed_run_self_heal",
        identity: {
          repository: repo,
          variable: name,
          exists: state.exists,
          value: state.value,
        },
        operation,
      }),
    writeState: () => writeGateState(name, state),
  });
}

function writeGateState(name: string, state: GateState): string {
  if (state.exists) return writeGateValue(name, state.value);
  let result = "";
  try {
    result = ghText(["variable", "delete", name, "--repo", repo]);
  } catch (error) {
    if (!/\bHTTP 404\b|not found/i.test(ghErrorText(error))) throw error;
    if (readMutableGateState(name).exists) throw error;
  }
  console.log(`${name}=<absent>`);
  return result;
}

function writeGateValue(name: string, value: string): string {
  const result = ghText(["variable", "set", name, "--repo", repo, "--body", value]);
  console.log(`${name}=${value}`);
  return result;
}

function selfHealDispatchLifecycle(candidate: LooseRecord): RepairLifecycleInput {
  return {
    repository: repo,
    workKey: `failed-run-self-heal:${candidate.run_id ?? "unknown"}:${candidate.immutable_job_key ?? "unknown"}`,
    sourceRevision: String(candidate.source_state_revision ?? ""),
    recordPath: String(candidate.source_job ?? ""),
    subjectKind: "workflow",
    subjectId: `failed-repair-run-${candidate.run_id ?? "unknown"}`,
  };
}

function selfHealGateLifecycle(name: string, value: string): RepairLifecycleInput {
  return {
    repository: repo,
    workKey: `failed-run-self-heal:gate:${name}:${value}`,
    sourceRevision: value,
    subjectKind: "workflow",
    subjectId: "failed-run-self-heal-gates",
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentHeadSha() {
  return runText("git", ["rev-parse", "origin/main"], {
    cwd: repoRoot(),
    stdio: ["ignore", "pipe", "pipe"],
    trim: "both",
  });
}

function runSortKey(record: LooseRecord) {
  const runId = Number(record.run_id);
  if (Number.isFinite(runId) && runId > 0) return runId;
  return Date.parse(record.published_at ?? "") || 0;
}

function recordTimestampMs(record: LooseRecord) {
  return (
    Date.parse(
      record.workflow_updated_at ?? record.workflow_created_at ?? record.published_at ?? "",
    ) || 0
  );
}

function summarizeCandidate(candidate: LooseRecord) {
  return {
    source_run_id: candidate.run_id,
    cluster_id: candidate.cluster_id,
    source_job: candidate.source_job,
    source_state_revision: candidate.source_state_revision,
    source_job_sha256: candidate.source_job_sha256,
    ...(candidate.legacy_unsealed === true ? { legacy_unsealed: true } : {}),
    mode: candidate.mode,
    runner: candidate.runner,
    execution_runner: candidate.execution_runner,
    planner_sandbox: candidate.planner_sandbox,
    model: candidate.model,
    dry_run: candidate.dry_run,
    requeue: candidate.requeue,
    requeue_depth: candidate.requeue_depth,
    result_status: candidate.result_status,
    run_url: candidate.run_url,
  };
}

function attemptImmutableJobKey(attempt: LooseRecord): string | null {
  const jobSha256 = attempt.source_job_sha256;
  if (!jobSha256) return null;
  try {
    return jobContentGenerationKey(attempt.source_job, jobSha256);
  } catch {
    return null;
  }
}

function activeJobGenerationKey(jobPath: JsonValue, jobSha256: JsonValue): string {
  return jobContentGenerationKey(jobPath, jobSha256);
}

function jobContentGenerationKey(jobPath: JsonValue, jobSha256: JsonValue): string {
  const pathText = String(jobPath ?? "").trim();
  const digest = String(jobSha256 ?? "").trim();
  if (!SOURCE_JOB_PATH.test(pathText)) {
    throw new Error("active repair run contains a malformed job path");
  }
  if (!JOB_SHA256.test(digest)) {
    throw new Error("active repair run contains a malformed job SHA-256");
  }
  return `${pathText}:${digest}`;
}

function isWriteCandidate(candidate: LooseRecord): boolean {
  return (
    candidate.dry_run !== true && ["execute", "autonomous"].includes(String(candidate.mode ?? ""))
  );
}

function booleanArg(value: JsonValue, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("boolean arguments must be true or false");
}

function ensureHistoricalStateRevision(value: JsonValue): void {
  const stateRevision = String(value ?? "").trim();
  if (!STATE_REVISION.test(stateRevision)) throw new Error("state revision is malformed");
  if (preparedStateRevisions.has(stateRevision)) return;
  const stateRoot = String(process.env.CLAWSWEEPER_STATE_DIR ?? "").trim();
  if (!stateRoot) {
    throw new Error("CLAWSWEEPER_STATE_DIR is required for immutable job handoff");
  }
  if (stateCommitExists(stateRoot, stateRevision)) {
    preparedStateRevisions.add(stateRevision);
    return;
  }

  try {
    runText(
      "git",
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--depth=1",
        "--filter=blob:none",
        "origin",
        stateRevision,
      ],
      {
        cwd: stateRoot,
        timeoutMs: STATE_REVISION_FETCH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).trim();
    throw new Error(
      detail
        ? `could not fetch historical clawsweeper-state commit ${stateRevision}: ${detail}`
        : `could not fetch historical clawsweeper-state commit ${stateRevision}`,
    );
  }
  if (!stateCommitExists(stateRoot, stateRevision)) {
    throw new Error(`could not fetch historical clawsweeper-state commit ${stateRevision}`);
  }
  preparedStateRevisions.add(stateRevision);
}

function stateCommitExists(stateRoot: string, stateRevision: string): boolean {
  try {
    runText("git", ["cat-file", "-e", `${stateRevision}^{commit}`], {
      cwd: stateRoot,
      stdio: ["ignore", "pipe", "ignore"],
      timeoutMs: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
