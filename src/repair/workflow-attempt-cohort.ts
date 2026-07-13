import type { JsonValue, LooseRecord } from "./json-types.js";

export type WorkflowArtifactRef = {
  id: number;
  name: string;
  attempt: number;
};

export type WorkflowJobResult = {
  attempt: number;
  result: string;
};

export type WorkflowJobInventory = {
  attempt: number;
  pages: JsonValue;
};

export type WorkerPublicationCohort = {
  resultArtifact: WorkflowArtifactRef | null;
  clusterJob: WorkflowJobResult | null;
  executeJob: WorkflowJobResult | null;
  clusterLedger: WorkflowArtifactRef | null;
  executeLedger: WorkflowArtifactRef | null;
};

export function selectLatestAttemptArtifact(
  pages: JsonValue,
  baseName: string,
  maxAttemptValue: number | string,
): WorkflowArtifactRef | null {
  const maxAttempt = positiveInteger(maxAttemptValue, "maximum workflow attempt");
  const pattern = new RegExp(`^${escapeRegExp(baseName)}-([1-9][0-9]*)$`);
  const candidates = workflowArtifacts(pages)
    .map((artifact) => artifactRef(artifact, pattern))
    .filter(
      (artifact): artifact is WorkflowArtifactRef =>
        artifact !== null && artifact.attempt <= maxAttempt,
    );
  if (candidates.length === 0) return null;
  const latestAttempt = Math.max(...candidates.map((artifact) => artifact.attempt));
  const latest = candidates.filter((artifact) => artifact.attempt === latestAttempt);
  if (latest.length !== 1) {
    throw new Error(`${baseName}-${latestAttempt} artifact is ambiguous`);
  }
  return latest[0]!;
}

export function selectExactAttemptArtifact(
  pages: JsonValue,
  baseName: string,
  attemptValue: number | string,
): WorkflowArtifactRef | null {
  const attempt = positiveInteger(attemptValue, "workflow attempt");
  const name = `${baseName}-${attempt}`;
  const pattern = new RegExp(`^${escapeRegExp(baseName)}-([1-9][0-9]*)$`);
  const matches = workflowArtifacts(pages)
    .map((artifact) => artifactRef(artifact, pattern))
    .filter(
      (artifact): artifact is WorkflowArtifactRef =>
        artifact !== null && artifact.attempt === attempt,
    );
  if (matches.length > 1) throw new Error(`${name} artifact is ambiguous`);
  return matches[0] ?? null;
}

export function selectLatestJobResult(
  inventories: readonly WorkflowJobInventory[],
  name: string,
  maxAttemptValue: number | string,
): WorkflowJobResult {
  const maxAttempt = positiveInteger(maxAttemptValue, "maximum workflow attempt");
  const byAttempt = new Map<number, JsonValue>();
  for (const inventory of inventories) {
    const attempt = positiveInteger(inventory.attempt, "job inventory attempt");
    if (byAttempt.has(attempt)) {
      throw new Error(`workflow job inventory for attempt ${attempt} is duplicated`);
    }
    byAttempt.set(attempt, inventory.pages);
  }
  for (let attempt = maxAttempt; attempt >= 1; attempt -= 1) {
    const pages = byAttempt.get(attempt);
    if (pages === undefined) continue;
    const matches = workflowJobs(pages).filter((job) => job.name === name);
    if (matches.length > 1) {
      throw new Error(`workflow attempt ${attempt} has ${matches.length} ${name} jobs`);
    }
    if (matches.length === 0) continue;
    const result = String(matches[0]!.conclusion ?? matches[0]!.status ?? "").trim();
    if (!result) throw new Error(`workflow job ${name} in attempt ${attempt} has no result`);
    return { attempt, result };
  }
  throw new Error(`workflow job inventory has no ${name} job through attempt ${maxAttempt}`);
}

export function resolveWorkerPublicationCohort(input: {
  artifactPages: JsonValue;
  jobInventories: readonly WorkflowJobInventory[];
  runId: number | string;
  currentAttempt: number | string;
  workerLedgersRequired: boolean;
}): WorkerPublicationCohort {
  const runId = positiveInteger(input.runId, "workflow run id");
  const currentAttempt = positiveInteger(input.currentAttempt, "workflow run attempt");
  const finalArtifact = selectExactAttemptArtifact(
    input.artifactPages,
    `clawsweeper-repair-${runId}`,
    currentAttempt,
  );
  const workerArtifact = selectExactAttemptArtifact(
    input.artifactPages,
    `clawsweeper-repair-worker-${runId}`,
    currentAttempt,
  );
  if (!input.workerLedgersRequired) {
    return {
      resultArtifact: finalArtifact ?? workerArtifact,
      clusterJob: null,
      executeJob: null,
      clusterLedger: null,
      executeLedger: null,
    };
  }
  const clusterJob = selectLatestJobResult(
    input.jobInventories,
    "Plan and review cluster",
    currentAttempt,
  );
  const executeJob = selectLatestJobResult(
    input.jobInventories,
    "Execute and apply cluster actions",
    currentAttempt,
  );
  return {
    resultArtifact: finalArtifact ?? workerArtifact,
    clusterJob,
    executeJob,
    clusterLedger: selectExactAttemptArtifact(
      input.artifactPages,
      `clawsweeper-repair-worker-action-ledger-cluster-${runId}`,
      clusterJob.attempt,
    ),
    executeLedger: selectExactAttemptArtifact(
      input.artifactPages,
      `clawsweeper-repair-worker-action-ledger-execute-${runId}`,
      executeJob.attempt,
    ),
  };
}

function workflowArtifacts(pages: JsonValue): LooseRecord[] {
  if (!Array.isArray(pages)) throw new Error("workflow artifact response is invalid");
  return pages.flatMap((page) => {
    if (!isRecord(page) || !Array.isArray(page.artifacts)) {
      throw new Error("workflow artifact page is invalid");
    }
    return page.artifacts.filter(isRecord);
  });
}

function workflowJobs(pages: JsonValue): LooseRecord[] {
  if (!Array.isArray(pages)) throw new Error("workflow job response is invalid");
  return pages.flatMap((page) => {
    if (!isRecord(page) || !Array.isArray(page.jobs)) {
      throw new Error("workflow job page is invalid");
    }
    return page.jobs.filter(isRecord);
  });
}

function artifactRef(artifact: LooseRecord, pattern: RegExp): WorkflowArtifactRef | null {
  if (artifact.expired === true) return null;
  const name = typeof artifact.name === "string" ? artifact.name : "";
  const match = pattern.exec(name);
  if (!match) return null;
  const id = Number(artifact.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const attempt = positiveInteger(match[1], "artifact attempt");
  return { id, name, attempt };
}

function positiveInteger(value: unknown, label: string): number {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${label} is invalid`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
