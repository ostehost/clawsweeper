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
import { shouldSelfHealRunRecord } from "./self-heal-policy.js";
import {
  immutableJobIdentityKey,
  isMissingImmutableJobError,
  resolveStateJobIdentity,
} from "./immutable-job-handoff.js";
import { activeRepairJobGenerations as listActiveRepairJobGenerations } from "./live-worker-capacity.js";
import { runRepairMutation, type RepairLifecycleInput } from "./repair-action-ledger.js";

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
const preparedStateRevisions = new Map<string, string | null>();

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

const gateRestores: JsonValue[] = [];
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
} finally {
  for (const gate of gateRestores.reverse()) {
    setGate(gate.name, gate.previous || "1");
  }
}

function selectCandidates() {
  const records = readRunRecords();
  const attempts = readSelfHealLedger().attempts ?? [];
  const activeJobGenerations = execute ? activeRepairJobGenerations() : new Map<string, string[]>();
  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const attemptedIdentities = new Set<string>();
  const attemptCountsByIdentity = new Map<string, number>();
  const legacyAttemptedRunsByJob = new Set<string>();
  const legacyAttemptCountsByJob = new Map<string, number>();
  for (const attempt of attempts) {
    const immutableKey = attemptImmutableJobKey(attempt);
    const sourceRunId = String(attempt.source_run_id ?? "");
    if (immutableKey) {
      if (sourceRunId) attemptedIdentities.add(`${sourceRunId}:${immutableKey}`);
      attemptCountsByIdentity.set(
        immutableKey,
        (attemptCountsByIdentity.get(immutableKey) ?? 0) + 1,
      );
      continue;
    }
    const legacyJobPath = legacyAttemptJobPath(attempt);
    if (!legacyJobPath) continue;
    if (sourceRunId) legacyAttemptedRunsByJob.add(`${sourceRunId}:${legacyJobPath}`);
    legacyAttemptCountsByJob.set(
      legacyJobPath,
      (legacyAttemptCountsByJob.get(legacyJobPath) ?? 0) + 1,
    );
  }
  const latestByJob = new Map();

  for (const record of records) {
    const sourceJob = record.source_job;
    if (typeof sourceJob !== "string" || !sourceJob) {
      skippedCandidates.push({ reason: "missing_source_job", run_id: record.run_id ?? null });
      continue;
    }
    const current = latestByJob.get(sourceJob);
    if (!current || runSortKey(record) > runSortKey(current)) {
      latestByJob.set(sourceJob, record);
    }
  }

  return [...latestByJob.values()]
    .filter((record: JsonValue) => shouldSelfHealRunRecord(record))
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
        const { immutableJob, recoveredMode } = resolveRunRecordJob(record, sourceJob);
        return {
          ...record,
          source_job: immutableJob.jobPath,
          source_state_revision: immutableJob.stateRevision,
          source_job_sha256: immutableJob.jobSha256,
          immutable_job_key: immutableJob.identityKey,
          mode: requestedMode ?? recoveredMode ?? immutableJob.job.frontmatter.mode,
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
        ...(activeJobGenerations.get(activeLegacyJobKey(record.source_job)) ?? []),
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
      const immutableKey = String(record.immutable_job_key ?? "");
      const sourceJob = String(record.source_job ?? "");
      if (
        runId &&
        (attemptedIdentities.has(`${runId}:${immutableKey}`) ||
          legacyAttemptedRunsByJob.has(`${runId}:${sourceJob}`))
      ) {
        return false;
      }
      const attemptsForJob =
        (attemptCountsByIdentity.get(immutableKey) ?? 0) +
        (legacyAttemptCountsByJob.get(sourceJob) ?? 0);
      if (attemptsForJob < maxAttemptsPerJob) return true;
      skippedCandidates.push({
        reason: "retry_limit_reached",
        run_id: runId || null,
        source_job: record.source_job,
        source_state_revision: record.source_state_revision,
        source_job_sha256: record.source_job_sha256,
        attempts: attemptsForJob,
      });
      return false;
    })
    .sort((left: JsonValue, right: JsonValue) => runSortKey(right) - runSortKey(left));
}

function activeRepairJobGenerations() {
  try {
    return listActiveRepairJobGenerations({ repo, workflow });
  } catch (error) {
    throw new Error(
      `self-heal: cannot verify active repair generations; refusing dispatch: ${ghErrorText(error)}`,
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
    "-f",
    `state_revision=${candidate.source_state_revision}`,
    "-f",
    `job_sha256=${candidate.source_job_sha256}`,
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
  return [...records, ...liveRunRecords()];
}

function resolveRunRecordJob(record: LooseRecord, sourceJob: string) {
  let stateRevision = String(record.source_state_revision ?? "").trim();
  let jobSha256 = String(record.source_job_sha256 ?? "").trim();
  let recoveredMode: string | null = null;
  if (!STATE_REVISION.test(stateRevision) || !JOB_SHA256.test(jobSha256)) {
    const runId = String(record.run_id ?? "").trim();
    if (!/^[1-9][0-9]*$/.test(runId)) {
      throw new Error("legacy run record is missing a valid workflow run id");
    }
    const recovered = recoverRunArtifactCohort(runId, sourceJob);
    if (stateRevision && stateRevision !== recovered.state_revision) {
      throw new Error("legacy run record state revision conflicts with its artifact cohort");
    }
    if (jobSha256 && jobSha256 !== recovered.job_sha256) {
      throw new Error("legacy run record job digest conflicts with its artifact cohort");
    }
    stateRevision = recovered.state_revision;
    jobSha256 = recovered.job_sha256;
    recoveredMode = recovered.mode;
  }
  ensureHistoricalStateRevision(stateRevision);
  const immutableJob = resolveStateJobIdentity({
    jobPath: sourceJob,
    stateRevision,
    jobSha256,
  });
  if (recoveredMode !== null && immutableJob.job.frontmatter.mode !== recoveredMode) {
    throw new Error("legacy artifact cohort mode does not match its sealed source job");
  }
  return { immutableJob, recoveredMode };
}

function ensureHistoricalStateRevision(stateRevision: string): void {
  if (!STATE_REVISION.test(stateRevision)) {
    throw new Error("state revision is malformed");
  }
  const previous = preparedStateRevisions.get(stateRevision);
  if (previous !== undefined) {
    if (previous) throw new Error(previous);
    return;
  }

  const stateRoot = String(process.env.CLAWSWEEPER_STATE_DIR ?? "").trim();
  if (!stateRoot) {
    throw new Error("CLAWSWEEPER_STATE_DIR is required for immutable job handoff");
  }
  if (stateCommitExists(stateRoot, stateRevision)) {
    preparedStateRevisions.set(stateRevision, null);
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
    const message = detail
      ? `could not fetch historical clawsweeper-state commit ${stateRevision}: ${detail}`
      : `could not fetch historical clawsweeper-state commit ${stateRevision}`;
    preparedStateRevisions.set(stateRevision, message);
    throw new Error(message);
  }
  preparedStateRevisions.set(stateRevision, null);
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

function recoverRunArtifactCohort(runId: string, sourceJob: string): RecoveredRunCohort {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), `clawsweeper-self-heal-${runId}-`));
  try {
    const downloaded = spawnSync(
      "gh",
      ["run", "download", runId, "--repo", repo, "--dir", artifactDir],
      { cwd: repoRoot(), encoding: "utf8", stdio: "pipe" },
    );
    if (downloaded.status !== 0) {
      throw new Error(
        `could not recover immutable provenance for run ${runId}: ${
          downloaded.stderr || downloaded.stdout
        }`,
      );
    }
    return resolveDownloadedRunCohort(artifactDir, runId, sourceJob);
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

function resolveDownloadedRunCohort(
  root: string,
  runId: string,
  expectedSourceJob: string,
): RecoveredRunCohort {
  const candidatesByAttempt = new Map<number, RecoveredRunCohort[]>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const producerAttempt = repairArtifactProducerAttempt(entry.name, runId);
    if (producerAttempt === null) continue;
    const artifactRoot = path.join(root, entry.name);
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
  throw new Error(`run ${runId} did not publish one complete sealed repair artifact cohort`);
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
  expectedSourceJob: string;
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
    sourceJob !== expectedSourceJob ||
    planSourceJob !== sourceJob
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
  const match = name.match(new RegExp(`^clawsweeper-repair(?:-worker)?-${runId}-([1-9][0-9]*)$`));
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

function liveRunRecords() {
  try {
    return listClusterRuns()
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
    console.warn(`self-heal: cannot list live repair runs: ${ghErrorText(error)}`);
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
    "databaseId,workflowName,displayTitle,headSha,status,conclusion,createdAt,updatedAt,url",
  ]).filter((run: LooseRecord) => run.workflowName === workflowName);
}

function workflowDisplayName(workflowNameOrFile: string): string {
  if (workflowNameOrFile === "repair-cluster-worker.yml") return "repair cluster worker";
  return workflowNameOrFile;
}

function readExecuteGate() {
  return readGateValue("CLAWSWEEPER_ALLOW_EXECUTE", { preferEnv: true });
}

function readFixGate() {
  return readGateValue("CLAWSWEEPER_ALLOW_FIX_PR", { preferEnv: true });
}

function openGate(name: string) {
  const previous = readGate(name);
  gateRestores.push({ name, previous });
  if (previous !== "1") setGate(name, "1");
}

function readGate(name: string) {
  return readGateValue(name, { preferEnv: false });
}

function readGateValue(name: string, { preferEnv }: { preferEnv: boolean }) {
  const envValue = process.env[name];
  if (preferEnv && envValue !== undefined && envValue !== "") return envValue;
  const variables = readRepoVariables();
  return variables.find((variable: JsonValue) => variable.name === name)?.value ?? envValue ?? "";
}

function readRepoVariables() {
  try {
    return ghJson<LooseRecord[]>(["variable", "list", "--repo", repo, "--json", "name,value"]);
  } catch (error) {
    const detail = ghErrorText(error);
    if (/HTTP 403|Resource not accessible by integration/i.test(detail)) {
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
    operationName: "failed_run_self_heal",
    component: "failed_run_self_heal_gate",
    identity: { repository: repo, name, value: normalizedValue, batchId },
    operation: () => ghText(["variable", "set", name, "--repo", repo, "--body", normalizedValue]),
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
    mode: candidate.mode,
    result_status: candidate.result_status,
    run_url: candidate.run_url,
  };
}

function attemptImmutableJobKey(attempt: LooseRecord): string | null {
  const stateRevision = attempt.source_state_revision;
  const jobSha256 = attempt.source_job_sha256;
  if (!stateRevision && !jobSha256) return null;
  return immutableJobIdentityKey({
    jobPath: attempt.source_job,
    stateRevision,
    jobSha256,
  });
}

function legacyAttemptJobPath(attempt: LooseRecord): string | null {
  const jobPath = String(attempt.source_job ?? "").trim();
  return /^jobs\/[A-Za-z0-9_.-]+\/inbox\/[A-Za-z0-9_.-]+\.md$/.test(jobPath) ? jobPath : null;
}

function selfHealDispatchLifecycle(candidate: LooseRecord): RepairLifecycleInput {
  return {
    repository: repo,
    workKey: `failed-run-self-heal:${candidate.run_id}:${candidate.immutable_job_key}`,
    clusterId: String(candidate.cluster_id ?? ""),
    sourceRevision: String(candidate.source_state_revision ?? ""),
    recordPath: String(candidate.source_job ?? ""),
    subjectKind: "workflow",
    subjectId: `failed-run-${candidate.run_id}`,
  };
}

function selfHealGateLifecycle(name: string, value: string): RepairLifecycleInput {
  return {
    repository: repo,
    workKey: `failed-run-self-heal:${batchId}:gate:${name}:${value}`,
    sourceRevision: headSha,
    subjectKind: "workflow",
    subjectId: `self-heal-gate-${name.toLowerCase()}`,
  };
}

function activeJobGenerationKey(jobPath: JsonValue, jobSha256: JsonValue): string {
  const pathText = String(jobPath ?? "").trim();
  const digest = String(jobSha256 ?? "").trim();
  if (!/^jobs\/[A-Za-z0-9_.-]+\/inbox\/[A-Za-z0-9_.-]+\.md$/.test(pathText)) {
    throw new Error("active repair run contains a malformed job path");
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("active repair run contains a malformed job SHA-256");
  }
  return `${pathText}:${digest}`;
}

function activeLegacyJobKey(jobPath: JsonValue): string {
  const pathText = String(jobPath ?? "").trim();
  if (!SOURCE_JOB_PATH.test(pathText)) {
    throw new Error("active legacy repair run contains a malformed job path");
  }
  return pathText;
}
