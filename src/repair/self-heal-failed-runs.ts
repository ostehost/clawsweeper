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
  parseRepairRunTitle,
  readMaxLiveWorkers,
  repoRoot,
  waitForLiveWorkerCapacity,
} from "./lib.js";
import { ghErrorText, ghJson, ghText } from "./github-cli.js";
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

const candidates = selectCandidates().slice(0, maxJobs);
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
  mode: candidate.mode,
  runner,
  execution_runner: executionRunner,
  model,
  workflow,
  repo,
  dispatched_at: new Date().toISOString(),
  dispatched_run_ids: [],
  status: "pending",
}));

let primaryFailure: unknown = null;
let cleanupRestoreFailures: GateCleanupFailure[] = [];
try {
  if (openExecuteWindow) {
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
    if (!current || runSortKey(record) > runSortKey(current)) {
      latestByGeneration.set(generation, record);
    }
  }

  return [...latestByGeneration.values()]
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
    .map((record: JsonValue) => {
      const sourceJob = String(record.source_job ?? "");
      try {
        const immutableJob = resolveRunRecordJob(record, sourceJob);
        return {
          ...record,
          source_job: immutableJob.jobPath,
          source_state_revision: immutableJob.stateRevision,
          source_job_sha256: immutableJob.jobSha256,
          immutable_job_key: jobContentGenerationKey(immutableJob.jobPath, immutableJob.jobSha256),
          ...(immutableJob.legacyUnsealed ? { legacy_unsealed: true } : {}),
          mode: retryMode({
            legacyUnsealed: immutableJob.legacyUnsealed,
            persistedMode:
              immutableJob.effectiveMode ??
              record.effective_mode ??
              record.mode ??
              immutableJob.job.frontmatter.mode,
          }),
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
        return null;
      }
    })
    .filter((record: JsonValue) => record !== null)
    .filter((record: JsonValue) => {
      const activeRunIds = [
        ...(activeJobGenerations.get(
          activeJobGenerationKey(record.source_job, record.source_job_sha256),
        ) ?? []),
        ...(activeJobGenerations.get(String(record.source_job ?? "")) ?? []),
      ].filter((runId, index, all) => all.indexOf(runId) === index);
      if (activeRunIds.length === 0) return true;
      skippedCandidates.push({
        reason: "active_repair_run",
        run_id: record.run_id ?? null,
        source_job: record.source_job,
        source_state_revision: record.source_state_revision,
        source_job_sha256: record.source_job_sha256,
        active_run_ids: activeRunIds,
      });
      return false;
    })
    .filter((record: JsonValue) => {
      if (allowRepeat) return true;
      const runId = String(record.run_id ?? "");
      const generation = String(record.immutable_job_key ?? "");
      if (runId && attemptedRunGenerations.has(`${runId}:${generation}`)) return false;
      if ((attemptCountsByGeneration.get(generation) ?? 0) < maxAttemptsPerJob) return true;
      skippedCandidates.push({
        reason: "retry_limit_reached",
        run_id: runId || null,
        source_job: record.source_job,
        source_state_revision: record.source_state_revision,
        source_job_sha256: record.source_job_sha256,
        attempts: attemptCountsByGeneration.get(generation) ?? 0,
      });
      return false;
    })
    .sort((left: JsonValue, right: JsonValue) => runSortKey(right) - runSortKey(left));
}

function runRecordGenerationKey(record: LooseRecord, sourceJob: string): string {
  const jobSha256 = String(record.source_job_sha256 ?? "").trim();
  return JOB_SHA256.test(jobSha256)
    ? jobContentGenerationKey(sourceJob, jobSha256)
    : `${sourceJob}:unsealed`;
}

function resolveRunRecordJob(record: LooseRecord, sourceJob: string) {
  const stateRevision = String(record.source_state_revision ?? "").trim();
  const jobSha256 = String(record.source_job_sha256 ?? "").trim();
  if (stateRevision) {
    if (!STATE_REVISION.test(stateRevision)) throw new Error("state revision is malformed");
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
    const recovered = resolveRunRecoveryInputs(record.run_id, sourceJob, jobSha256);
    ensureHistoricalStateRevision(recovered.stateRevision);
    return {
      ...resolveStateJobIdentity({
        jobPath: sourceJob,
        stateRevision: recovered.stateRevision,
        jobSha256: recovered.jobSha256,
      }),
      effectiveMode: recovered.effectiveMode,
      legacyUnsealed: false,
    };
  }
  return {
    ...resolveCurrentStateJobIdentity(sourceJob),
    effectiveMode: null,
    legacyUnsealed: true,
  };
}

function resolveRunRecoveryInputs(runIdValue: JsonValue, sourceJob: string, jobSha256: string) {
  const runId = String(runIdValue ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(runId)) {
    throw new Error("run id is malformed for immutable recovery input lookup");
  }
  const artifactDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `clawsweeper-self-heal-inputs-${runId}-`),
  );
  try {
    const downloaded = spawnSync(
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
      { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
    );
    if (downloaded.status !== 0) {
      throw new Error(
        `cannot download immutable recovery inputs for run ${runId}: ${
          downloaded.stderr || downloaded.stdout
        }`,
      );
    }
    const inputs = fs
      .globSync(path.join(artifactDir, "**", "workflow-inputs.json"))
      .filter((file) => fs.lstatSync(file).isFile())
      .map((file) => {
        const bytes = fs.readFileSync(file);
        if (bytes.length > 64 * 1024) {
          throw new Error(`immutable recovery input artifact is oversized for run ${runId}`);
        }
        const input = JSON.parse(bytes.toString("utf8")) as LooseRecord;
        const keys = Object.keys(input).sort();
        if (
          JSON.stringify(keys) !==
          JSON.stringify([
            "effective_mode",
            "job_sha256",
            "requested_mode",
            "schema_version",
            "source_job",
            "state_revision",
          ])
        ) {
          throw new Error(`immutable recovery inputs have unexpected fields for run ${runId}`);
        }
        return input;
      })
      .filter((input) => {
        const requested = String(input.requested_mode ?? "").trim();
        const effective = String(input.effective_mode ?? "").trim();
        return (
          input.schema_version === 1 &&
          input.source_job === sourceJob &&
          input.job_sha256 === jobSha256 &&
          STATE_REVISION.test(String(input.state_revision ?? "")) &&
          REPAIR_MODES.has(requested) &&
          REPAIR_MODES.has(effective) &&
          (effective === requested || effective === "plan")
        );
      });
    if (inputs.length === 0) {
      throw new Error(`immutable recovery inputs are unavailable for run ${runId}`);
    }
    const identities = new Set(
      inputs.map((input) =>
        JSON.stringify({
          stateRevision: input.state_revision,
          jobSha256: input.job_sha256,
          effectiveMode: input.effective_mode,
        }),
      ),
    );
    if (identities.size !== 1) {
      throw new Error(`immutable recovery inputs are ambiguous for run ${runId}`);
    }
    return {
      stateRevision: String(inputs[0]!.state_revision),
      jobSha256: String(inputs[0]!.job_sha256),
      effectiveMode: String(inputs[0]!.effective_mode),
    };
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
    `runner=${runner}`,
    "-f",
    `execution_runner=${executionRunner}`,
    "-f",
    `model=${model}`,
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
      runner,
      executionRunner,
      model,
    },
    operation: () => {
      const result = spawnSync("gh", commandArgs, {
        cwd: repoRoot(),
        encoding: "utf8",
        stdio: "pipe",
      });
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
  if (
    !candidates.some((candidate: JsonValue) => ["execute", "autonomous"].includes(candidate.mode))
  )
    return;
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
  return execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

function retryMode({
  legacyUnsealed,
  persistedMode,
}: {
  legacyUnsealed: boolean;
  persistedMode: JsonValue;
}): string {
  if (legacyUnsealed) return "plan";
  const mode = String(persistedMode ?? "").trim();
  if (!REPAIR_MODES.has(mode)) throw new Error("persisted repair mode is malformed");
  if (mode === "plan") return "plan";
  return requestedMode ?? mode;
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

  const fetched = spawnSync(
    "git",
    [
      "-C",
      stateRoot,
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=1",
      "--filter=blob:none",
      "origin",
      stateRevision,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: STATE_REVISION_FETCH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
  if (fetched.status !== 0 || fetched.error || !stateCommitExists(stateRoot, stateRevision)) {
    const detail = String(fetched.stderr || fetched.stdout || fetched.error?.message || "").trim();
    throw new Error(
      detail
        ? `could not fetch historical clawsweeper-state commit ${stateRevision}: ${detail}`
        : `could not fetch historical clawsweeper-state commit ${stateRevision}`,
    );
  }
  preparedStateRevisions.add(stateRevision);
}

function stateCommitExists(stateRoot: string, stateRevision: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", stateRoot, "cat-file", "-e", `${stateRevision}^{commit}`],
    {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10_000,
    },
  );
  return result.status === 0 && !result.error;
}
