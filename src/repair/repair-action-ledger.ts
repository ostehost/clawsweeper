import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionAttemptId,
  actionEventKey,
  actionIdempotencyKey,
  actionLedgerJson,
  actionOperationId,
  readSpooledActionEvents,
  type ActionEventEvidence,
  type ActionEventReasonCode,
  type ActionEventStatus,
  type ActionEvent,
} from "../action-ledger.js";
import {
  prepareSafeReadRoot,
  prepareSafeReadTarget,
  readUtf8FileNoFollow,
} from "../action-ledger-files.js";
import {
  flushWorkflowActionEvents,
  interruptOpenWorkflowActionEvents,
  readValidatedActionEventShardBatch,
  recordWorkflowActionEvent,
  workflowActionProducer,
  workflowActionEventsEnabled,
  type ValidatedActionEventShardSource,
} from "../action-ledger-runtime.js";
import {
  actionLedgerRecoveryEnvironment,
  actionLedgerRecoveryRoot,
  readMutationRecoveries,
  removeMutationRecovery,
  writeMutationRecovery,
} from "../action-ledger-recovery.js";
import { repoRoot } from "./paths.js";
import { parseRepairActionLedgerManifest } from "./repair-action-ledger-manifest.js";

export type RepairLifecycleInput = {
  repository: string;
  workKey: string;
  clusterId?: string | null;
  number?: number | null;
  sourceRevision?: string | null;
  recordPath?: string | null;
  subjectKind?: ActionEvent["subject"]["kind"];
  subjectId?: string | null;
};

export type RepairLifecycleEvent = {
  type: string;
  status: ActionEventStatus;
  reasonCode: ActionEventReasonCode;
  mutation: boolean;
  component: string;
  parentEventId?: string | null;
  operation?: string;
  state?: string;
  phase?: string;
  workKind?: string;
  publicationKind?: string;
  statusKind?: string;
  reviewMode?: string;
  logKind?: string;
  workflowPhase?: string;
  completionReason?: string;
  retryable?: boolean;
  eventIdentity?: unknown;
  idempotencyIdentity?: unknown;
  idempotencySlot?: string;
  evidence?: readonly ActionEventEvidence[];
};

export type RepairLifecycleFailureOptions = {
  component: string;
  operation?: string;
  phase?: string;
  workKind?: string;
  error: unknown;
};

export type RepairMutationOutcome = "accepted" | "rejected" | "unknown";
export type RepairWorkflowPhase =
  | "started"
  | "completed"
  | "blocked"
  | "requeued"
  | "failed"
  | "finalized";

export type RepairMutationOptions<T> = {
  kind: string;
  identity: unknown;
  operation: () => T;
  operationName?: string;
  component?: string;
  outcome?: (result: T) => RepairMutationOutcome;
  knownNoMutation?: (error: unknown) => boolean;
};

export type RepairMutationObservationOptions = {
  kind: string;
  identity: unknown;
  operationName?: string;
  component?: string;
};

export function repairMutationIdempotencyIdentity(
  input: RepairLifecycleInput,
  options: {
    kind: string;
    identity: unknown;
    operationName?: string;
  },
) {
  return {
    operation: repairOperationIdentity(input),
    operationName: machineText(options.operationName ?? "repair", "repair"),
    mutation: machineText(options.kind, "github_mutation"),
    requestSha256: stableDigest(options.identity),
  };
}

export function repairPublicationContentDigest(
  paths: readonly string[],
  root: string = process.cwd(),
): string {
  const digest = createHash("sha256");
  const selections = [...new Set(paths.map((value) => value.trim()).filter(Boolean))].sort(
    compareUtf8,
  );
  if (selections.length === 0) throw new Error("No publication paths were provided");

  updatePublicationDigest(digest, "version", "repair-publication-content-v1");
  for (const selection of selections) {
    updatePublicationDigest(digest, "selection", selection);
    hashPublicationEntry(digest, path.resolve(root, selection), "");
  }
  return digest.digest("hex");
}

type RepairActionLedgerContext = {
  root: string;
  recoveryRoot: string;
  env: NodeJS.ProcessEnv;
};

const DEFINITE_HTTP_MUTATION_REJECTIONS = new Set([
  400, 401, 403, 404, 405, 406, 407, 410, 411, 413, 414, 415, 416, 417, 421, 422, 426, 428, 431,
  451,
]);
const REPAIR_CAUSAL_MANIFEST_FILE = "repair-action-ledger-manifest.json";
const REPAIR_CAUSAL_MANIFEST_MAX_BYTES = 256 * 1024;
const REPAIR_CAUSAL_MANIFEST_LANE = "cluster";
const REPAIR_CAUSAL_PRODUCER_JOB = "cluster";
const TERMINAL_MUTATION_COMPLETION_REASONS = new Set([
  "mutation_accepted",
  "mutation_observed",
  "mutation_rejected",
  "mutation_outcome_unknown",
]);

export function repairHttpMutationOutcome(response: {
  ok: boolean;
  status: number;
}): RepairMutationOutcome {
  if (response.ok) return "accepted";
  return DEFINITE_HTTP_MUTATION_REJECTIONS.has(response.status) ? "rejected" : "unknown";
}

export function recordRepairLifecycleEvent(
  input: RepairLifecycleInput,
  event: RepairLifecycleEvent,
  context?: RepairActionLedgerContext,
): ActionEvent | null {
  const env = context?.env ?? process.env;
  if (!workflowActionEventsEnabled(env)) return null;
  const root = context?.root ?? repairActionLedgerRoot(env);
  const operationIdentity = repairOperationIdentity(input);
  const operation = event.operation ?? "repair";
  const attemptIdentity = workflowAttemptIdentity(env);
  const operationId = actionOperationId(input.repository, operation, operationIdentity);
  const attemptId = actionAttemptId(operationId, attemptIdentity);
  const producer = workflowActionProducer(event.component, env);
  const identity = {
    operation: operationIdentity,
    state: event.state ?? event.status,
    phase: event.phase ?? null,
    event: event.eventIdentity ?? null,
  };
  const chainEvents = repairChainEvents(root, input, operation, operationId).filter(
    (candidate) => candidate.operation_id === operationId && candidate.attempt_id === attemptId,
  );
  const replay = chainEvents.find(
    (candidate) =>
      repairProducerMatches(candidate.producer, producer) &&
      candidate.event_key ===
        actionEventKey(event.type, {
          attemptId,
          phaseSeq: candidate.phase_seq,
          producer: {
            job: producer.job,
            component: producer.component,
          },
          identity,
        }),
  );
  const previous = replay ?? latestRepairChainEvent(chainEvents);
  const phaseSeq = replay?.phase_seq ?? (previous?.phase_seq ?? 0) + 1;
  if (!Number.isSafeInteger(phaseSeq) || phaseSeq < 1) {
    throw new Error("repair action event phase sequence is invalid");
  }
  return recordWorkflowActionEvent(
    root,
    {
      scope: event.type,
      identity,
      operation,
      operationIdentity,
      attemptIdentity,
      parentEventId:
        event.parentEventId !== undefined
          ? event.parentEventId
          : (replay?.parent_event_id ?? previous?.event_id ?? null),
      phaseSeq,
      ...(event.idempotencyIdentity !== undefined
        ? { idempotencyIdentity: event.idempotencyIdentity }
        : event.mutation
          ? {
              idempotencyIdentity: {
                operation: operationIdentity,
                slot: event.idempotencySlot ?? event.type,
              },
            }
          : {}),
      type: event.type,
      component: event.component,
      subject: repairSubject(input, event),
      action: {
        name: event.type,
        status: event.status,
        reasonCode: event.reasonCode,
        retryable: event.retryable ?? event.status === ACTION_EVENT_STATUSES.waiting,
        mutation: event.mutation,
      },
      ...(event.evidence?.length ? { evidence: event.evidence } : {}),
      attributes: {
        state: machineText(event.state ?? event.status, "unknown"),
        ...(event.completionReason
          ? { completion_reason: machineText(event.completionReason, "unknown") }
          : {}),
        ...(event.phase ? { phase: machineText(event.phase, "unknown") } : {}),
        ...(event.workKind ? { work_kind: machineText(event.workKind, "unknown") } : {}),
        ...(event.publicationKind
          ? { publication_kind: machineText(event.publicationKind, "unknown") }
          : {}),
        ...(event.statusKind ? { status_kind: machineText(event.statusKind, "unknown") } : {}),
        ...(event.reviewMode ? { review_mode: machineText(event.reviewMode, "unknown") } : {}),
        ...(event.logKind ? { log_kind: machineText(event.logKind, "unknown") } : {}),
        ...(event.workflowPhase
          ? { workflow_phase: machineText(event.workflowPhase, "unknown") }
          : {}),
      },
    },
    { env },
  );
}

export function runRepairMutation<T>(
  input: RepairLifecycleInput,
  options: RepairMutationOptions<T>,
): T {
  const ledgerContext = repairActionLedgerContext();
  const kind = machineText(options.kind, "github_mutation");
  const operation = machineText(options.operationName ?? "repair", "repair");
  const requestSha256 = stableDigest(options.identity);
  const idempotencyIdentity = repairMutationIdempotencyIdentity(input, options);
  const requestAttempt = nextRepairRequestAttempt(
    input,
    operation,
    idempotencyIdentity,
    ledgerContext,
  );
  const attemptEvent = recordRepairLifecycleEvent(
    input,
    {
      type: ACTION_EVENT_TYPES.repairMutation,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      mutation: false,
      retryable: true,
      component: options.component ?? "repair_mutation",
      operation,
      eventIdentity: { kind, requestSha256, requestAttempt, outcome: "attempted" },
      idempotencyIdentity,
      completionReason: "mutation_attempted",
      state: "mutation_attempted",
    },
    ledgerContext,
  );
  const outcomeOptions = {
    kind,
    requestSha256,
    requestAttempt,
    idempotencyIdentity,
    operation,
    parentEventId: attemptEvent?.event_id ?? null,
    ...(options.component ? { component: options.component } : {}),
  };
  const recovery = attemptEvent
    ? beginRepairMutationRecovery(ledgerContext, attemptEvent.event_id, input, {
        ...outcomeOptions,
        outcome: "unknown",
      })
    : null;

  let result: T;
  try {
    result = options.operation();
  } catch (error) {
    let outcome: RepairMutationOutcome = "unknown";
    try {
      if (options.knownNoMutation?.(error) === true) outcome = "rejected";
    } catch {
      outcome = "unknown";
    }
    recordRepairMutationOutcomeSafely(
      input,
      {
        ...outcomeOptions,
        outcome,
      },
      ledgerContext,
      recovery,
    );
    throw error;
  }

  let outcome: RepairMutationOutcome;
  try {
    outcome = options.outcome?.(result) ?? "accepted";
  } catch (error) {
    recordRepairMutationOutcomeSafely(
      input,
      {
        ...outcomeOptions,
        outcome: "unknown",
      },
      ledgerContext,
      recovery,
      "after the successful operation",
    );
    console.error(
      `[action-ledger] failed to classify ${kind} outcome after the successful operation: ${errorText(error)}`,
    );
    return result;
  }
  recordRepairMutationOutcomeSafely(
    input,
    { ...outcomeOptions, outcome },
    ledgerContext,
    recovery,
    "after the successful operation",
  );
  return result;
}

export function recordRepairMutationObservedSafely(
  input: RepairLifecycleInput,
  options: RepairMutationObservationOptions,
): void {
  try {
    const kind = machineText(options.kind, "github_mutation");
    const operation = machineText(options.operationName ?? "repair", "repair");
    const requestSha256 = stableDigest(options.identity);
    const idempotencyIdentity = repairMutationIdempotencyIdentity(input, options);
    const requestAttempt = latestRepairRequestAttempt(input, operation, idempotencyIdentity);
    recordRepairLifecycleEvent(input, {
      type: ACTION_EVENT_TYPES.repairMutation,
      status: ACTION_EVENT_STATUSES.executed,
      reasonCode: ACTION_EVENT_REASON_CODES.alreadyComplete,
      mutation: true,
      retryable: false,
      component: options.component ?? "repair_mutation",
      operation,
      eventIdentity: { kind, requestSha256, requestAttempt, outcome: "observed" },
      idempotencyIdentity,
      completionReason: "mutation_observed",
      state: "mutation_observed",
    });
  } catch (error) {
    console.error(
      `[action-ledger] failed to record observed ${options.kind} mutation: ${errorText(error)}`,
    );
  }
}

export async function runRepairMutationAsync<T>(
  input: RepairLifecycleInput,
  options: Omit<RepairMutationOptions<Promise<T>>, "outcome"> & {
    outcome?: (result: T) => RepairMutationOutcome;
  },
): Promise<T> {
  const ledgerContext = repairActionLedgerContext();
  const kind = machineText(options.kind, "github_mutation");
  const operation = machineText(options.operationName ?? "repair", "repair");
  const requestSha256 = stableDigest(options.identity);
  const idempotencyIdentity = repairMutationIdempotencyIdentity(input, options);
  const requestAttempt = nextRepairRequestAttempt(
    input,
    operation,
    idempotencyIdentity,
    ledgerContext,
  );
  const attemptEvent = recordRepairLifecycleEvent(
    input,
    {
      type: ACTION_EVENT_TYPES.repairMutation,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      mutation: false,
      retryable: true,
      component: options.component ?? "repair_mutation",
      operation,
      eventIdentity: { kind, requestSha256, requestAttempt, outcome: "attempted" },
      idempotencyIdentity,
      completionReason: "mutation_attempted",
      state: "mutation_attempted",
    },
    ledgerContext,
  );
  const outcomeOptions = {
    kind,
    requestSha256,
    requestAttempt,
    idempotencyIdentity,
    operation,
    parentEventId: attemptEvent?.event_id ?? null,
    ...(options.component ? { component: options.component } : {}),
  };
  const recovery = attemptEvent
    ? beginRepairMutationRecovery(ledgerContext, attemptEvent.event_id, input, {
        ...outcomeOptions,
        outcome: "unknown",
      })
    : null;

  let result: T;
  try {
    result = await options.operation();
  } catch (error) {
    let outcome: RepairMutationOutcome = "unknown";
    try {
      if (options.knownNoMutation?.(error) === true) outcome = "rejected";
    } catch {
      outcome = "unknown";
    }
    recordRepairMutationOutcomeSafely(
      input,
      {
        ...outcomeOptions,
        outcome,
      },
      ledgerContext,
      recovery,
    );
    throw error;
  }

  let outcome: RepairMutationOutcome;
  try {
    outcome = options.outcome?.(result) ?? "accepted";
  } catch (error) {
    recordRepairMutationOutcomeSafely(
      input,
      {
        ...outcomeOptions,
        outcome: "unknown",
      },
      ledgerContext,
      recovery,
      "after the successful operation",
    );
    console.error(
      `[action-ledger] failed to classify ${kind} outcome after the successful operation: ${errorText(error)}`,
    );
    return result;
  }
  recordRepairMutationOutcomeSafely(
    input,
    { ...outcomeOptions, outcome },
    ledgerContext,
    recovery,
    "after the successful operation",
  );
  return result;
}

export function recordRepairArtifactPrepared(
  input: RepairLifecycleInput,
  options: {
    path: string;
    kind: string;
    component: string;
    reviewMode?: string;
  },
): void {
  if (!fs.existsSync(options.path) || !fs.statSync(options.path).isFile()) return;
  const sha256 = createHash("sha256").update(fs.readFileSync(options.path)).digest("hex");
  const kind = machineText(options.kind, "artifact");
  recordRepairLifecycleEvent(input, {
    type: ACTION_EVENT_TYPES.reviewLogPublication,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    mutation: false,
    component: options.component,
    state: "prepared",
    publicationKind: kind,
    ...(options.reviewMode ? { reviewMode: options.reviewMode } : {}),
    eventIdentity: { kind, sha256, state: "prepared" },
    evidence: [{ kind, sha256 }],
  });
}

export function recordRepairWorkflowEvent(
  input: RepairLifecycleInput,
  options: {
    component: string;
    phase: RepairWorkflowPhase;
    error?: unknown;
  },
): void {
  const mutationState = repairMutationState(input);
  const status =
    options.phase === "started"
      ? ACTION_EVENT_STATUSES.started
      : options.phase === "failed"
        ? ACTION_EVENT_STATUSES.failed
        : options.phase === "blocked"
          ? ACTION_EVENT_STATUSES.blocked
          : options.phase === "requeued"
            ? ACTION_EVENT_STATUSES.requeued
            : ACTION_EVENT_STATUSES.completed;
  recordRepairLifecycleEvent(input, {
    type: ACTION_EVENT_TYPES.workflowAttempt,
    status,
    reasonCode:
      options.phase === "started"
        ? ACTION_EVENT_REASON_CODES.selected
        : options.phase === "failed"
          ? ACTION_EVENT_REASON_CODES.exception
          : options.phase === "blocked"
            ? ACTION_EVENT_REASON_CODES.policyBlocked
            : options.phase === "requeued"
              ? ACTION_EVENT_REASON_CODES.retryScheduled
              : ACTION_EVENT_REASON_CODES.completed,
    mutation: mutationState.mutationObserved,
    retryable:
      options.phase === "requeued" ||
      (options.phase === "failed" && mutationState.uncertainMutationObserved),
    component: options.component,
    state: options.phase,
    workflowPhase: options.phase,
    completionReason:
      options.phase === "failed"
        ? repairCompletionReason(input)
        : options.phase === "finalized"
          ? "workflow_finalized"
          : `workflow_${options.phase}`,
    eventIdentity: {
      phase: options.phase,
      ...(options.error
        ? { errorKind: options.error instanceof Error ? options.error.name : typeof options.error }
        : {}),
    },
  });
}

export function repairWorkflowTerminalPhase(report: unknown): RepairWorkflowPhase {
  if (!report || typeof report !== "object" || Array.isArray(report)) return "failed";
  const record = report as Record<string, unknown>;
  const actions = Array.isArray(record.actions)
    ? record.actions.filter(
        (action): action is Record<string, unknown> =>
          Boolean(action) && typeof action === "object" && !Array.isArray(action),
      )
    : [];
  if (
    String(record.outcome ?? "").toLowerCase() === "requeue" ||
    actions.some((action) => action.requeue_required === true)
  ) {
    return "requeued";
  }
  const status = String(record.status ?? record.outcome ?? "").toLowerCase();
  if (status === "failed" || actions.some((action) => action.status === "failed")) {
    return "failed";
  }
  if (
    status === "blocked" ||
    status === "needs_human" ||
    actions.some((action) => action.status === "blocked" || action.status === "needs_human")
  ) {
    return "blocked";
  }
  return "completed";
}

export function recordRepairLifecycleFailure(
  input: RepairLifecycleInput,
  options: RepairLifecycleFailureOptions,
): void {
  const operation = options.operation ?? "repair";
  const mutationState = repairMutationState(input, operation);
  recordRepairLifecycleEvent(input, {
    type: "repair.failed",
    status: ACTION_EVENT_STATUSES.failed,
    reasonCode: ACTION_EVENT_REASON_CODES.exception,
    mutation: mutationState.mutationObserved,
    component: options.component,
    state: "failed",
    retryable: mutationState.uncertainMutationObserved,
    completionReason: repairCompletionReason(input, operation),
    operation,
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.workKind ? { workKind: options.workKind } : {}),
    eventIdentity: {
      errorKind: options.error instanceof Error ? options.error.name : typeof options.error,
    },
  });
}

export function recordRepairLifecycleFailureSafely(
  input: RepairLifecycleInput,
  options: RepairLifecycleFailureOptions,
  report: (message: string) => void = console.error,
): void {
  try {
    recordRepairLifecycleFailure(input, options);
  } catch (error) {
    report(
      `[action-ledger] failed to record repair failure receipt after the primary failure: ${errorText(error)}`,
    );
  }
}

export async function flushRepairActionEvents(
  options: { preserveOpenWorkflows?: boolean } = {},
): Promise<string[]> {
  const root = repairActionLedgerRoot();
  recoverRepairMutationOutcomes();
  if (options.preserveOpenWorkflows !== true) interruptOpenWorkflowActionEvents(root);
  return flushWorkflowActionEvents(root);
}

function repairSubject(input: RepairLifecycleInput, event: RepairLifecycleEvent) {
  const sourceRevision = machineRevision(input.sourceRevision);
  const recordPath = input.recordPath?.trim() || null;
  const subjectId =
    input.subjectId?.trim() ||
    `repair-${stableDigest({
      repository: input.repository,
      workKey: input.workKey,
    }).slice(0, 24)}`;
  if (input.subjectKind) {
    return {
      repository: input.repository,
      kind: input.subjectKind,
      subjectId,
      ...(input.number && input.number > 0 ? { number: input.number } : {}),
      ...(input.clusterId ? { clusterId: machineText(input.clusterId, "unknown") } : {}),
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(recordPath ? { recordPath } : {}),
    };
  }
  if (input.number && input.number > 0) {
    return {
      repository: input.repository,
      kind: "issue",
      subjectId,
      number: input.number,
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(recordPath ? { recordPath } : {}),
    } as const;
  }
  if (event.operation === "publication") {
    return {
      repository: input.repository,
      kind: "publication",
      subjectId,
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(recordPath ? { recordPath } : {}),
    } as const;
  }
  return {
    repository: input.repository,
    kind: input.clusterId ? "cluster" : "workflow",
    subjectId,
    ...(input.clusterId ? { clusterId: machineText(input.clusterId, "unknown") } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(recordPath ? { recordPath } : {}),
  } as const;
}

function repairActionLedgerContext(): RepairActionLedgerContext {
  const env = { ...process.env };
  return {
    root: repairActionLedgerRoot(env),
    recoveryRoot: actionLedgerRecoveryRoot(env, repairActionLedgerRoot(env)),
    env,
  };
}

function workflowAttemptIdentity(env: NodeJS.ProcessEnv = process.env) {
  return {
    repository: String(env.GITHUB_REPOSITORY ?? "")
      .trim()
      .toLowerCase(),
    workflow: String(env.GITHUB_WORKFLOW_REF ?? env.GITHUB_WORKFLOW ?? "").trim(),
    runId: String(env.GITHUB_RUN_ID ?? "").trim(),
    runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT),
  };
}

export function repairActionLedgerRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
}

export function repairSourceRevision(frontmatter: Record<string, unknown>): string | null {
  for (const key of [
    "source_issue_revision_sha256",
    "expected_head_sha",
    "commit_sha",
    "expected_source_revision",
    "reviewed_sha",
  ]) {
    const revision = machineRevision(frontmatter[key]);
    if (revision) return revision;
  }
  return null;
}

function repairChainEvents(
  root: string,
  input: RepairLifecycleInput,
  operation: string,
  operationId: string,
): ActionEvent[] {
  const byId = new Map<string, ActionEvent>();
  for (const event of [
    ...readSpooledActionEvents(root, input.repository),
    ...readRepairCausalContextEvents(input, operation, operationId),
  ]) {
    const existing = byId.get(event.event_id);
    if (existing && actionLedgerJson(existing) !== actionLedgerJson(event)) {
      throw new Error(`repair causal context contains conflicting event: ${event.event_id}`);
    }
    byId.set(event.event_id, existing ?? event);
  }
  return [...byId.values()];
}

function latestRepairChainEvent(events: readonly ActionEvent[]): ActionEvent | null {
  return (
    [...events]
      .sort(
        (left, right) =>
          left.phase_seq - right.phase_seq ||
          left.recorded_at.localeCompare(right.recorded_at) ||
          left.event_id.localeCompare(right.event_id),
      )
      .at(-1) ?? null
  );
}

function repairOperationIdentity(input: RepairLifecycleInput) {
  return {
    repository: input.repository.trim().toLowerCase(),
    workKey: input.workKey.trim(),
    sourceRevision: machineRevision(input.sourceRevision),
  };
}

function repairAttemptEvents(
  input: RepairLifecycleInput,
  operation: string = "repair",
  context?: RepairActionLedgerContext,
): ActionEvent[] {
  const operationId = actionOperationId(
    input.repository,
    operation,
    repairOperationIdentity(input),
  );
  const attemptId = actionAttemptId(operationId, workflowAttemptIdentity(context?.env));
  return repairChainEvents(context?.root ?? repairActionLedgerRoot(), input, operation, operationId)
    .filter((event) => event.operation_id === operationId && event.attempt_id === attemptId)
    .sort(
      (left, right) =>
        left.phase_seq - right.phase_seq ||
        left.recorded_at.localeCompare(right.recorded_at) ||
        left.event_id.localeCompare(right.event_id),
    );
}

function nextRepairRequestAttempt(
  input: RepairLifecycleInput,
  operation: string,
  idempotencyIdentity: unknown,
  context?: RepairActionLedgerContext,
): number {
  return latestRepairRequestAttempt(input, operation, idempotencyIdentity, context) + 1;
}

function latestRepairRequestAttempt(
  input: RepairLifecycleInput,
  operation: string,
  idempotencyIdentity: unknown,
  context?: RepairActionLedgerContext,
): number {
  const idempotencyKeySha256 = actionIdempotencyKey(idempotencyIdentity);
  return repairAttemptEvents(input, operation, context).filter(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.repairMutation &&
      event.action.status === ACTION_EVENT_STATUSES.started &&
      event.attributes?.state === "mutation_attempted" &&
      event.idempotency_key_sha256 === idempotencyKeySha256,
  ).length;
}

function repairMutationState(
  input: RepairLifecycleInput,
  operation: string = "repair",
): {
  mutationObserved: boolean;
  uncertainMutationObserved: boolean;
} {
  const outcomes = new Map<string, { observed: boolean; unknown: boolean; phaseSeq: number }>();
  for (const event of repairAttemptEvents(input, operation)) {
    if (event.event_type !== ACTION_EVENT_TYPES.repairMutation) continue;
    const completionReason = String(event.attributes?.completion_reason ?? "");
    const key = event.idempotency_key_sha256;
    if (!key) continue;
    const current = outcomes.get(key) ?? { observed: false, unknown: false, phaseSeq: 0 };
    if (event.phase_seq < current.phaseSeq) continue;
    if (completionReason === "mutation_observed") {
      outcomes.set(key, { observed: true, unknown: false, phaseSeq: event.phase_seq });
    } else if (completionReason === "mutation_accepted") {
      outcomes.set(key, {
        observed: true,
        unknown: current.unknown,
        phaseSeq: event.phase_seq,
      });
    } else if (completionReason === "mutation_outcome_unknown") {
      outcomes.set(key, {
        observed: current.observed,
        unknown: true,
        phaseSeq: event.phase_seq,
      });
    }
  }
  const states = [...outcomes.values()];
  const mutationObserved = states.some((state) => state.observed || state.unknown);
  const uncertainMutationObserved = states.some((state) => state.unknown);
  return { mutationObserved, uncertainMutationObserved };
}

function repairCompletionReason(input: RepairLifecycleInput, operation: string = "repair"): string {
  const state = repairMutationState(input, operation);
  return state.uncertainMutationObserved
    ? "mutation_outcome_unknown"
    : state.mutationObserved
      ? "mutation_observed"
      : "failed";
}

function recordRepairMutationOutcome(
  input: RepairLifecycleInput,
  options: {
    kind: string;
    requestSha256: string;
    requestAttempt: number;
    idempotencyIdentity: unknown;
    operation: string;
    parentEventId?: string | null;
    component?: string;
    outcome: RepairMutationOutcome;
  },
  context?: RepairActionLedgerContext,
): void {
  recordRepairLifecycleEvent(
    input,
    {
      type: ACTION_EVENT_TYPES.repairMutation,
      status:
        options.outcome === "accepted"
          ? ACTION_EVENT_STATUSES.executed
          : options.outcome === "rejected"
            ? ACTION_EVENT_STATUSES.skipped
            : ACTION_EVENT_STATUSES.failed,
      reasonCode:
        options.outcome === "accepted"
          ? ACTION_EVENT_REASON_CODES.completed
          : options.outcome === "rejected"
            ? ACTION_EVENT_REASON_CODES.notApplicable
            : ACTION_EVENT_REASON_CODES.unavailable,
      mutation: options.outcome !== "rejected",
      retryable: options.outcome === "unknown",
      component: options.component ?? "repair_mutation",
      ...(options.parentEventId !== undefined ? { parentEventId: options.parentEventId } : {}),
      operation: options.operation,
      eventIdentity: {
        kind: options.kind,
        requestSha256: options.requestSha256,
        requestAttempt: options.requestAttempt,
        outcome: options.outcome,
      },
      idempotencyIdentity: options.idempotencyIdentity,
      completionReason:
        options.outcome === "accepted"
          ? "mutation_accepted"
          : options.outcome === "rejected"
            ? "mutation_rejected"
            : "mutation_outcome_unknown",
      state: `mutation_${options.outcome}`,
    },
    context,
  );
}

type RepairMutationOutcomeOptions = Parameters<typeof recordRepairMutationOutcome>[1];

type RepairMutationRecoveryPayload = {
  context: {
    root: string;
    env: Record<string, string>;
  };
  input: RepairLifecycleInput;
  options: RepairMutationOutcomeOptions;
};

type RepairMutationRecovery = {
  key: string;
  recoveryRoot: string;
  context: RepairActionLedgerContext;
  content: string;
};

function beginRepairMutationRecovery(
  context: RepairActionLedgerContext,
  key: string,
  input: RepairLifecycleInput,
  options: RepairMutationOutcomeOptions,
): RepairMutationRecovery {
  const recovery = { key, recoveryRoot: context.recoveryRoot, context, content: "" };
  recovery.content = writeRepairMutationRecovery(recovery, input, options);
  return recovery;
}

export function recoverRepairMutationOutcomes(): void {
  const current = repairActionLedgerContext();
  for (const recovery of readMutationRecoveries<RepairMutationRecoveryPayload>(
    current.recoveryRoot,
    "repair",
  )) {
    const payload = recovery.payload;
    const context: RepairActionLedgerContext = {
      root: payload.context.root,
      recoveryRoot: current.recoveryRoot,
      env: { ...process.env, ...payload.context.env },
    };
    if (!repairMutationOutcomeRecorded(payload, context)) {
      recordRepairMutationOutcome(payload.input, payload.options, context);
    }
    removeMutationRecovery(current.recoveryRoot, "repair", recovery.key, recovery.content);
  }
}

function recordRepairMutationOutcomeSafely(
  input: RepairLifecycleInput,
  options: RepairMutationOutcomeOptions,
  context?: RepairActionLedgerContext,
  recovery?: RepairMutationRecovery | null,
  failureContext: string = "after the primary failure",
): boolean {
  updateRepairMutationRecoverySafely(recovery, input, options);
  try {
    recordRepairMutationOutcome(input, options, context);
    removeRepairMutationRecoverySafely(recovery);
    return true;
  } catch (error) {
    console.error(
      `[action-ledger] failed to record ${options.kind} ${options.outcome} outcome ${failureContext}; deferred for recovery: ${errorText(error)}`,
    );
    return false;
  }
}

function writeRepairMutationRecovery(
  recovery: RepairMutationRecovery,
  input: RepairLifecycleInput,
  options: RepairMutationOutcomeOptions,
): string {
  return writeMutationRecovery(recovery.recoveryRoot, "repair", recovery.key, {
    context: {
      root: recovery.context.root,
      env: actionLedgerRecoveryEnvironment(recovery.context.env),
    },
    input,
    options,
  });
}

function updateRepairMutationRecoverySafely(
  recovery: RepairMutationRecovery | null | undefined,
  input: RepairLifecycleInput,
  options: RepairMutationOutcomeOptions,
): void {
  if (!recovery) return;
  try {
    recovery.content = writeRepairMutationRecovery(recovery, input, options);
  } catch (error) {
    console.error(
      `[action-ledger] failed to persist ${options.kind} ${options.outcome} recovery: ${errorText(error)}`,
    );
  }
}

function removeRepairMutationRecoverySafely(
  recovery: RepairMutationRecovery | null | undefined,
): void {
  if (!recovery) return;
  try {
    removeMutationRecovery(recovery.recoveryRoot, "repair", recovery.key, recovery.content);
  } catch (error) {
    console.error(`[action-ledger] failed to clear ${recovery.key} recovery: ${errorText(error)}`);
  }
}

function repairMutationOutcomeRecorded(
  payload: RepairMutationRecoveryPayload,
  context: RepairActionLedgerContext,
): boolean {
  const idempotencyKeySha256 = actionIdempotencyKey(payload.options.idempotencyIdentity);
  return repairAttemptEvents(payload.input, payload.options.operation, context).some((event) => {
    const completionReason = String(event.attributes?.completion_reason ?? "");
    return (
      event.parent_event_id === (payload.options.parentEventId ?? null) &&
      event.event_type === ACTION_EVENT_TYPES.repairMutation &&
      event.idempotency_key_sha256 === idempotencyKeySha256 &&
      repairMutationOutcomeSatisfies(payload.options.outcome, completionReason)
    );
  });
}

function repairMutationOutcomeSatisfies(
  expected: RepairMutationOutcome,
  completionReason: string,
): boolean {
  if (!TERMINAL_MUTATION_COMPLETION_REASONS.has(completionReason)) return false;
  if (expected === "unknown") return true;
  if (expected === "accepted") {
    return completionReason === "mutation_accepted" || completionReason === "mutation_observed";
  }
  return completionReason === "mutation_rejected";
}

function repairProducerMatches(
  persisted: ActionEvent["producer"],
  current: ReturnType<typeof workflowActionProducer>,
): boolean {
  return (
    persisted.repository === current.repository &&
    persisted.sha === current.sha &&
    persisted.workflow === current.workflow &&
    persisted.job === current.job &&
    persisted.run_id === current.runId &&
    persisted.run_attempt === current.runAttempt &&
    persisted.component === current.component
  );
}

function readRepairCausalContextEvents(
  input: RepairLifecycleInput,
  operation: string,
  operationId: string,
): ActionEvent[] {
  const roots = String(process.env.CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  if (roots.length === 0) return [];
  const currentProducer = workflowActionProducer("repair_causal_context");
  const expectedProducer = {
    repository: currentProducer.repository,
    sha: currentProducer.sha,
    workflow: currentProducer.workflow,
    job: REPAIR_CAUSAL_PRODUCER_JOB,
    runId: currentProducer.runId,
    runAttempt: currentProducer.runAttempt,
  };
  const sources: ValidatedActionEventShardSource[] = roots.map((root) => {
    const sourceRoot = path.resolve(root);
    const safeRoot = prepareSafeReadRoot(sourceRoot, "repair causal action ledger");
    const manifestTarget = prepareSafeReadTarget(
      safeRoot,
      REPAIR_CAUSAL_MANIFEST_FILE,
      "repair causal action ledger manifest",
    );
    const manifestContent = readUtf8FileNoFollow(manifestTarget, REPAIR_CAUSAL_MANIFEST_MAX_BYTES);
    const manifestAttempt = repairCausalManifestRunAttempt(
      manifestContent,
      currentProducer.runAttempt,
    );
    const manifestProducer = { ...expectedProducer, runAttempt: manifestAttempt };
    const manifest = parseRepairActionLedgerManifest(
      manifestContent,
      REPAIR_CAUSAL_MANIFEST_LANE,
      manifestProducer,
    );
    return {
      sourceRoot,
      expectedEventPaths: manifest.event_paths,
      expectedProducer: manifestProducer,
    };
  });
  return readValidatedActionEventShardBatch(sources).events.filter((event) => {
    if (event.operation_id !== operationId) return false;
    if (!repairCausalSubjectMatches(event, input, operation)) {
      throw new Error(`repair causal context subject mismatch: ${event.event_id}`);
    }
    return true;
  });
}

function repairCausalSubjectMatches(
  event: ActionEvent,
  input: RepairLifecycleInput,
  operation: string,
): boolean {
  const expected = repairSubject(input, {
    type: event.event_type,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    mutation: false,
    component: event.producer.component,
    operation,
  });
  return (
    event.subject.repository === expected.repository &&
    event.subject.kind === expected.kind &&
    event.subject.subject_id === expected.subjectId &&
    event.subject.number === ("number" in expected ? expected.number : undefined) &&
    event.subject.cluster_id === ("clusterId" in expected ? expected.clusterId : undefined) &&
    event.subject.source_revision ===
      ("sourceRevision" in expected ? expected.sourceRevision : undefined) &&
    event.subject.record_path === ("recordPath" in expected ? expected.recordPath : undefined)
  );
}

function repairCausalManifestRunAttempt(content: string, currentAttempt: number): number {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("repair action ledger manifest is not valid JSON");
  }
  const runAttempt =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).run_attempt
      : undefined;
  if (
    !Number.isSafeInteger(runAttempt) ||
    Number(runAttempt) < 1 ||
    Number(runAttempt) > currentAttempt
  ) {
    throw new Error("repair causal action ledger producer attempt is invalid");
  }
  return Number(runAttempt);
}

function machineRevision(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(normalized) ? normalized : null;
}

function machineText(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:/@+-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashPublicationEntry(
  digest: ReturnType<typeof createHash>,
  absolutePath: string,
  relativePath: string,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    updatePublicationDigest(digest, "entry", relativePath);
    updatePublicationDigest(digest, "type", "missing");
    return;
  }

  updatePublicationDigest(digest, "entry", relativePath);
  if (stat.isDirectory()) {
    updatePublicationDigest(digest, "type", "directory");
    const names = fs.readdirSync(absolutePath).sort(compareUtf8);
    for (const name of names) {
      hashPublicationEntry(
        digest,
        path.join(absolutePath, name),
        relativePath ? `${relativePath}/${name}` : name,
      );
    }
    return;
  }
  if (stat.isFile()) {
    updatePublicationDigest(digest, "type", "file");
    updatePublicationDigest(digest, "executable", stat.mode & 0o111 ? "1" : "0");
    updatePublicationDigest(
      digest,
      "sha256",
      createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
    );
    return;
  }
  if (stat.isSymbolicLink()) {
    updatePublicationDigest(digest, "type", "symlink");
    updatePublicationDigest(digest, "target", fs.readlinkSync(absolutePath));
    return;
  }
  throw new Error(`Unsupported publication path entry: ${absolutePath}`);
}

function updatePublicationDigest(
  digest: ReturnType<typeof createHash>,
  field: string,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  digest.update(`${field}:${bytes.length}:`, "utf8");
  digest.update(bytes);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
