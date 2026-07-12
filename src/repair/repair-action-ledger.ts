import { createHash } from "node:crypto";
import path from "node:path";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  actionAttemptId,
  actionEventKey,
  actionLedgerJson,
  actionOperationId,
  readSpooledActionEvents,
  type ActionEventReasonCode,
  type ActionEventStatus,
  type ActionEvent,
} from "../action-ledger.js";
import {
  flushWorkflowActionEvents,
  readValidatedActionEventShardBatch,
  recordWorkflowActionEvent,
  workflowActionProducer,
  workflowActionEventsEnabled,
} from "../action-ledger-runtime.js";
import { repoRoot } from "./paths.js";

export type RepairLifecycleInput = {
  repository: string;
  workKey: string;
  clusterId?: string | null;
  number?: number | null;
  sourceRevision?: string | null;
  recordPath?: string | null;
};

export type RepairLifecycleEvent = {
  type: string;
  status: ActionEventStatus;
  reasonCode: ActionEventReasonCode;
  mutation: boolean;
  component: string;
  operation?: string;
  state?: string;
  phase?: string;
  workKind?: string;
  publicationKind?: string;
  statusKind?: string;
  retryable?: boolean;
  eventIdentity?: unknown;
  idempotencySlot?: string;
};

export type RepairLifecycleFailureOptions = {
  component: string;
  operation?: string;
  phase?: string;
  workKind?: string;
  error: unknown;
};

export function recordRepairLifecycleEvent(
  input: RepairLifecycleInput,
  event: RepairLifecycleEvent,
): void {
  if (!workflowActionEventsEnabled()) return;
  const root = repairActionLedgerRoot();
  const operationIdentity = {
    repository: input.repository.trim().toLowerCase(),
    workKey: input.workKey.trim(),
    sourceRevision: machineRevision(input.sourceRevision),
  };
  const operation = event.operation ?? "repair";
  const attemptIdentity = workflowAttemptIdentity();
  const operationId = actionOperationId(input.repository, operation, operationIdentity);
  const attemptId = actionAttemptId(operationId, attemptIdentity);
  const producer = workflowActionProducer(event.component);
  const identity = {
    operation: operationIdentity,
    state: event.state ?? event.status,
    phase: event.phase ?? null,
    event: event.eventIdentity ?? null,
  };
  const chainEvents = repairChainEvents(root, input.repository).filter(
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
  recordWorkflowActionEvent(root, {
    scope: event.type,
    identity,
    operation,
    operationIdentity,
    attemptIdentity,
    parentEventId: replay?.parent_event_id ?? previous?.event_id ?? null,
    phaseSeq,
    ...(event.mutation
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
    attributes: {
      state: machineText(event.state ?? event.status, "unknown"),
      ...(event.phase ? { phase: machineText(event.phase, "unknown") } : {}),
      ...(event.workKind ? { work_kind: machineText(event.workKind, "unknown") } : {}),
      ...(event.publicationKind
        ? { publication_kind: machineText(event.publicationKind, "unknown") }
        : {}),
      ...(event.statusKind ? { status_kind: machineText(event.statusKind, "unknown") } : {}),
    },
  });
}

export function recordRepairLifecycleFailure(
  input: RepairLifecycleInput,
  options: RepairLifecycleFailureOptions,
): void {
  recordRepairLifecycleEvent(input, {
    type: "repair.failed",
    status: ACTION_EVENT_STATUSES.failed,
    reasonCode: ACTION_EVENT_REASON_CODES.exception,
    mutation: false,
    component: options.component,
    state: "failed",
    ...(options.operation ? { operation: options.operation } : {}),
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

export async function flushRepairActionEvents(): Promise<string[]> {
  return flushWorkflowActionEvents(repairActionLedgerRoot());
}

function repairSubject(input: RepairLifecycleInput, event: RepairLifecycleEvent) {
  const sourceRevision = machineRevision(input.sourceRevision);
  const recordPath = input.recordPath?.trim() || null;
  const subjectId = `repair-${stableDigest({
    repository: input.repository,
    workKey: input.workKey,
  }).slice(0, 24)}`;
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

function workflowAttemptIdentity() {
  return {
    repository: String(process.env.GITHUB_REPOSITORY ?? "")
      .trim()
      .toLowerCase(),
    workflow: String(process.env.GITHUB_WORKFLOW_REF ?? process.env.GITHUB_WORKFLOW ?? "").trim(),
    runId: String(process.env.GITHUB_RUN_ID ?? "").trim(),
    runAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT),
  };
}

export function repairActionLedgerRoot(): string {
  return process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || repoRoot();
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

function repairChainEvents(root: string, repository: string): ActionEvent[] {
  const byId = new Map<string, ActionEvent>();
  for (const event of [
    ...readSpooledActionEvents(root, repository),
    ...readRepairCausalContextEvents(),
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

function readRepairCausalContextEvents(): ActionEvent[] {
  const roots = String(process.env.CLAWSWEEPER_ACTION_LEDGER_CAUSAL_ROOTS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  return readValidatedActionEventShardBatch(roots.map((root) => path.resolve(root))).events;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
