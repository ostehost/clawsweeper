import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionAttemptId,
  actionIdempotencyKey,
  actionOperationId,
  readSpooledActionEvents,
  type ActionEvent,
  type ActionEventReasonCode,
  type ActionEventStatus,
} from "./action-ledger.js";
import { recordWorkflowActionEvent, workflowActionEventsEnabled } from "./action-ledger-runtime.js";

export type CommitLifecycleInput = {
  repository: string;
  sha: string;
};

type CommitLifecycleEvent = {
  type: string;
  status: ActionEventStatus;
  reasonCode: ActionEventReasonCode;
  mutation: boolean;
  component: string;
  state: string;
  completionReason?: string;
  reviewMode?: string;
  publicationKind?: string;
  logKind?: string;
  eventIdentity?: unknown;
  idempotencyIdentity?: unknown;
  retryable?: boolean;
  evidence?: Array<{ kind: string; sha256?: string }>;
};

export function recordCommitLifecycleEvent(
  input: CommitLifecycleInput,
  event: CommitLifecycleEvent,
): ActionEvent | null {
  if (!workflowActionEventsEnabled()) return null;
  const operationIdentity = commitOperationIdentity(input);
  const operationId = actionOperationId(input.repository, "commit_review", operationIdentity);
  const attemptIdentity = workflowAttemptIdentity();
  const attemptId = actionAttemptId(operationId, attemptIdentity);
  const previous = latestCommitEvent(
    readSpooledActionEvents(commitActionLedgerRoot(), input.repository).filter(
      (candidate) => candidate.operation_id === operationId && candidate.attempt_id === attemptId,
    ),
  );
  const phaseSeq = (previous?.phase_seq ?? 0) + 1;
  return recordWorkflowActionEvent(commitActionLedgerRoot(), {
    scope: event.type,
    identity: {
      operation: operationIdentity,
      state: event.state,
      event: event.eventIdentity ?? null,
    },
    operation: "commit_review",
    operationIdentity,
    attemptIdentity,
    parentEventId: previous?.event_id ?? null,
    phaseSeq,
    ...(event.idempotencyIdentity !== undefined
      ? { idempotencyIdentity: event.idempotencyIdentity }
      : event.mutation
        ? {
            idempotencyIdentity: {
              operation: operationIdentity,
              slot: event.type,
            },
          }
        : {}),
    type: event.type,
    component: event.component,
    subject: {
      repository: input.repository,
      kind: "commit",
      subjectId: `commit-${input.sha}`,
      sourceRevision: input.sha,
    },
    action: {
      name: event.type,
      status: event.status,
      reasonCode: event.reasonCode,
      retryable: event.retryable ?? false,
      mutation: event.mutation,
    },
    ...(event.evidence?.length ? { evidence: event.evidence } : {}),
    attributes: {
      state: event.state,
      ...(event.completionReason ? { completion_reason: event.completionReason } : {}),
      ...(event.reviewMode ? { review_mode: event.reviewMode } : {}),
      ...(event.publicationKind ? { publication_kind: event.publicationKind } : {}),
      ...(event.logKind ? { log_kind: event.logKind } : {}),
    },
  });
}

export function recordCommitWorkflowEvent(
  input: CommitLifecycleInput,
  phase: "started" | "completed" | "failed" | "finalized",
  error?: unknown,
): void {
  recordCommitLifecycleEvent(input, {
    type: ACTION_EVENT_TYPES.workflowAttempt,
    status:
      phase === "started"
        ? ACTION_EVENT_STATUSES.started
        : phase === "failed"
          ? ACTION_EVENT_STATUSES.failed
          : ACTION_EVENT_STATUSES.completed,
    reasonCode:
      phase === "started"
        ? ACTION_EVENT_REASON_CODES.selected
        : phase === "failed"
          ? ACTION_EVENT_REASON_CODES.exception
          : ACTION_EVENT_REASON_CODES.completed,
    mutation: commitMutationState(input).observed,
    retryable: commitMutationState(input).unknown,
    component: "commit_review",
    state: phase,
    completionReason:
      phase === "failed"
        ? commitFailureReason(input)
        : phase === "finalized"
          ? "workflow_finalized"
          : `workflow_${phase}`,
    eventIdentity: {
      phase,
      ...(error === undefined
        ? {}
        : { errorKind: error instanceof Error ? error.name : typeof error }),
    },
  });
}

export function recordCommitArtifact(
  input: CommitLifecycleInput,
  options: {
    path: string;
    kind: string;
    type?: string;
    logKind?: string;
  },
): void {
  if (!existsSync(options.path) || !statSync(options.path).isFile()) return;
  const sha256 = createHash("sha256").update(readFileSync(options.path)).digest("hex");
  recordCommitLifecycleEvent(input, {
    type: options.type ?? ACTION_EVENT_TYPES.reviewLogPublication,
    status: ACTION_EVENT_STATUSES.published,
    reasonCode: ACTION_EVENT_REASON_CODES.published,
    mutation: false,
    component: "commit_review",
    state: "published",
    publicationKind: options.kind,
    ...(options.logKind ? { logKind: options.logKind } : {}),
    eventIdentity: { kind: options.kind, sha256 },
    evidence: [{ kind: options.kind, sha256 }],
  });
}

export function runCommitMutation<T>(
  input: CommitLifecycleInput,
  options: {
    kind: string;
    identity: unknown;
    operation: () => T;
    knownNoMutation?: (error: unknown) => boolean;
  },
): T {
  const requestSha256 = stableDigest(options.identity);
  const idempotencyIdentity = {
    operation: commitOperationIdentity(input),
    mutation: options.kind,
    requestSha256,
  };
  const requestAttempt = nextRequestAttempt(input, idempotencyIdentity);
  recordCommitLifecycleEvent(input, {
    type: ACTION_EVENT_TYPES.publicationLifecycle,
    status: ACTION_EVENT_STATUSES.started,
    reasonCode: ACTION_EVENT_REASON_CODES.selected,
    mutation: false,
    retryable: true,
    component: "commit_review",
    state: "mutation_attempted",
    completionReason: "mutation_attempted",
    publicationKind: options.kind,
    eventIdentity: { kind: options.kind, requestSha256, requestAttempt, outcome: "attempted" },
    idempotencyIdentity,
  });
  try {
    const result = options.operation();
    recordCommitMutationOutcome(
      input,
      options.kind,
      requestSha256,
      requestAttempt,
      idempotencyIdentity,
      "accepted",
    );
    return result;
  } catch (error) {
    const outcome = options.knownNoMutation?.(error) === true ? "rejected" : "unknown";
    recordCommitMutationOutcome(
      input,
      options.kind,
      requestSha256,
      requestAttempt,
      idempotencyIdentity,
      outcome,
    );
    throw error;
  }
}

function recordCommitMutationOutcome(
  input: CommitLifecycleInput,
  kind: string,
  requestSha256: string,
  requestAttempt: number,
  idempotencyIdentity: unknown,
  outcome: "accepted" | "rejected" | "unknown",
): void {
  recordCommitLifecycleEvent(input, {
    type: ACTION_EVENT_TYPES.publicationLifecycle,
    status:
      outcome === "accepted"
        ? ACTION_EVENT_STATUSES.published
        : outcome === "rejected"
          ? ACTION_EVENT_STATUSES.skipped
          : ACTION_EVENT_STATUSES.failed,
    reasonCode:
      outcome === "accepted"
        ? ACTION_EVENT_REASON_CODES.published
        : outcome === "rejected"
          ? ACTION_EVENT_REASON_CODES.notApplicable
          : ACTION_EVENT_REASON_CODES.unavailable,
    mutation: outcome !== "rejected",
    retryable: outcome === "unknown",
    component: "commit_review",
    state: `mutation_${outcome}`,
    completionReason:
      outcome === "accepted"
        ? "mutation_accepted"
        : outcome === "rejected"
          ? "mutation_rejected"
          : "mutation_outcome_unknown",
    publicationKind: kind,
    eventIdentity: { kind, requestSha256, requestAttempt, outcome },
    idempotencyIdentity,
  });
}

function commitOperationIdentity(input: CommitLifecycleInput) {
  return {
    repository: input.repository.trim().toLowerCase(),
    sha: input.sha.trim().toLowerCase(),
  };
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

function commitActionLedgerRoot(): string {
  return process.env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || process.cwd();
}

function commitEvents(input: CommitLifecycleInput): ActionEvent[] {
  const operationId = actionOperationId(
    input.repository,
    "commit_review",
    commitOperationIdentity(input),
  );
  const attemptId = actionAttemptId(operationId, workflowAttemptIdentity());
  return readSpooledActionEvents(commitActionLedgerRoot(), input.repository).filter(
    (event) => event.operation_id === operationId && event.attempt_id === attemptId,
  );
}

function latestCommitEvent(events: readonly ActionEvent[]): ActionEvent | null {
  return [...events].sort((left, right) => left.phase_seq - right.phase_seq).at(-1) ?? null;
}

function nextRequestAttempt(input: CommitLifecycleInput, idempotencyIdentity: unknown): number {
  const idempotencyKey = actionIdempotencyKey(idempotencyIdentity);
  return (
    commitEvents(input).filter(
      (event) =>
        event.action.status === ACTION_EVENT_STATUSES.started &&
        event.idempotency_key_sha256 === idempotencyKey,
    ).length + 1
  );
}

function commitMutationState(input: CommitLifecycleInput): { observed: boolean; unknown: boolean } {
  let observed = false;
  let unknown = false;
  for (const event of commitEvents(input)) {
    const reason = String(event.attributes?.completion_reason ?? "");
    if (reason === "mutation_accepted" || reason === "mutation_outcome_unknown") observed = true;
    if (reason === "mutation_outcome_unknown") unknown = true;
  }
  return { observed, unknown };
}

function commitFailureReason(input: CommitLifecycleInput): string {
  const state = commitMutationState(input);
  return state.unknown
    ? "mutation_outcome_unknown"
    : state.observed
      ? "mutation_observed"
      : "failed";
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
