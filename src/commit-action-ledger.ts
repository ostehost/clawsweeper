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
import {
  flushWorkflowActionEvents,
  interruptOpenWorkflowActionEvents,
  readValidatedActionEventShardBatch,
  recordWorkflowActionEvent,
  workflowActionProducer,
  workflowActionEventsEnabled,
} from "./action-ledger-runtime.js";
import {
  actionLedgerRecoveryEnvironment,
  actionLedgerRecoveryRoot,
  readMutationRecoveries,
  removeMutationRecovery,
  writeMutationRecovery,
} from "./action-ledger-recovery.js";

export type CommitLifecycleInput = {
  repository: string;
  sha: string;
};

const COMMIT_REVIEW_SUCCESS_RESULTS = new Set([
  "nothing_found",
  "findings",
  "inconclusive",
  "skipped_non_code",
]);
const TERMINAL_MUTATION_COMPLETION_REASONS = new Set([
  "mutation_accepted",
  "mutation_rejected",
  "mutation_outcome_unknown",
]);

export function commitReviewLifecycleSucceeded(options: {
  reviewOutcome: string;
  checkOutcome: string;
  checksRequested: boolean;
  reportResult: string;
}): boolean {
  const reviewOutcome = options.reviewOutcome.trim().toLowerCase();
  const checkOutcome = options.checkOutcome.trim().toLowerCase();
  const reportResult = options.reportResult.trim().toLowerCase();
  return (
    reviewOutcome === "success" &&
    COMMIT_REVIEW_SUCCESS_RESULTS.has(reportResult) &&
    (!options.checksRequested || checkOutcome === "success")
  );
}

type CommitLifecycleEvent = {
  type: string;
  status: ActionEventStatus;
  reasonCode: ActionEventReasonCode;
  mutation: boolean;
  component: string;
  state: string;
  parentEventId?: string | null;
  completionReason?: string;
  reviewMode?: string;
  publicationKind?: string;
  logKind?: string;
  eventIdentity?: unknown;
  idempotencyIdentity?: unknown;
  retryable?: boolean;
  evidence?: Array<{ kind: string; sha256?: string }>;
  requestAttempt?: number;
};

type CommitActionLedgerContext = {
  root: string;
  recoveryRoot: string;
  env: NodeJS.ProcessEnv;
};

export function recordCommitLifecycleEvent(
  input: CommitLifecycleInput,
  event: CommitLifecycleEvent,
  context?: CommitActionLedgerContext,
): ActionEvent | null {
  const env = context?.env ?? process.env;
  if (!workflowActionEventsEnabled(env)) return null;
  const root = context?.root ?? commitActionLedgerRoot(env);
  const operationIdentity = commitOperationIdentity(input);
  const attemptIdentity = workflowAttemptIdentity(env);
  const previous = latestCommitEvent(
    commitEvents(input, {
      root,
      recoveryRoot: context?.recoveryRoot ?? actionLedgerRecoveryRoot(env, root),
      env,
    }),
  );
  const phaseSeq = (previous?.phase_seq ?? 0) + 1;
  return recordWorkflowActionEvent(
    root,
    {
      scope: event.type,
      identity: {
        operation: operationIdentity,
        state: event.state,
        event: event.eventIdentity ?? null,
      },
      operation: "commit_review",
      operationIdentity,
      attemptIdentity,
      parentEventId:
        event.parentEventId !== undefined ? event.parentEventId : (previous?.event_id ?? null),
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
        ...(event.requestAttempt ? { attempt: event.requestAttempt } : {}),
      },
    },
    { env },
  );
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

export function recordCommitArtifactPrepared(
  input: CommitLifecycleInput,
  options: {
    path: string;
    kind: string;
    logKind?: string;
  },
): void {
  if (!existsSync(options.path) || !statSync(options.path).isFile()) return;
  const sha256 = createHash("sha256").update(readFileSync(options.path)).digest("hex");
  recordCommitLifecycleEvent(input, {
    type: ACTION_EVENT_TYPES.reviewLogPublication,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    mutation: false,
    component: "commit_review",
    state: "prepared",
    publicationKind: options.kind,
    ...(options.logKind ? { logKind: options.logKind } : {}),
    eventIdentity: { kind: options.kind, sha256, state: "prepared" },
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
  const ledgerContext = commitActionLedgerContext();
  const requestSha256 = stableDigest(options.identity);
  const idempotencyIdentity = {
    operation: commitOperationIdentity(input),
    mutation: options.kind,
    requestSha256,
  };
  const requestAttempt = nextRequestAttempt(input, idempotencyIdentity, ledgerContext);
  const attemptEvent = recordCommitLifecycleEvent(
    input,
    {
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
      requestAttempt,
    },
    ledgerContext,
  );
  const recovery = attemptEvent
    ? beginCommitMutationRecovery(ledgerContext, attemptEvent.event_id, {
        input,
        kind: options.kind,
        requestSha256,
        requestAttempt,
        idempotencyIdentity,
        parentEventId: attemptEvent.event_id,
        outcome: "unknown",
      })
    : null;
  let result: T;
  try {
    result = options.operation();
  } catch (error) {
    let outcome: "rejected" | "unknown" = "unknown";
    try {
      if (options.knownNoMutation?.(error) === true) outcome = "rejected";
    } catch {
      outcome = "unknown";
    }
    recordCommitMutationOutcomeSafely(
      input,
      options.kind,
      requestSha256,
      requestAttempt,
      idempotencyIdentity,
      outcome,
      attemptEvent?.event_id ?? null,
      ledgerContext,
      recovery,
    );
    throw error;
  }
  recordCommitMutationOutcomeSafely(
    input,
    options.kind,
    requestSha256,
    requestAttempt,
    idempotencyIdentity,
    "accepted",
    attemptEvent?.event_id ?? null,
    ledgerContext,
    recovery,
    "after the successful operation",
  );
  return result;
}

function recordCommitMutationOutcome(
  input: CommitLifecycleInput,
  kind: string,
  requestSha256: string,
  requestAttempt: number,
  idempotencyIdentity: unknown,
  outcome: "accepted" | "rejected" | "unknown",
  parentEventId: string | null,
  context?: CommitActionLedgerContext,
): void {
  recordCommitLifecycleEvent(
    input,
    {
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
      parentEventId,
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
      requestAttempt,
    },
    context,
  );
}

function recordCommitMutationOutcomeSafely(
  input: CommitLifecycleInput,
  kind: string,
  requestSha256: string,
  requestAttempt: number,
  idempotencyIdentity: unknown,
  outcome: CommitMutationOutcome,
  parentEventId: string | null,
  context?: CommitActionLedgerContext,
  recovery?: CommitMutationRecovery | null,
  failureContext: string = "after the primary failure",
): boolean {
  updateCommitMutationRecoverySafely(recovery, {
    input,
    kind,
    requestSha256,
    requestAttempt,
    idempotencyIdentity,
    parentEventId,
    outcome,
  });
  try {
    recordCommitMutationOutcome(
      input,
      kind,
      requestSha256,
      requestAttempt,
      idempotencyIdentity,
      outcome,
      parentEventId,
      context,
    );
    removeCommitMutationRecoverySafely(recovery);
    return true;
  } catch (receiptError) {
    console.error(
      `[action-ledger] failed to record ${kind} ${outcome} outcome ${failureContext}; deferred for recovery: ${
        receiptError instanceof Error ? receiptError.message : String(receiptError)
      }`,
    );
    return false;
  }
}

type CommitMutationOutcome = "accepted" | "rejected" | "unknown";

type CommitMutationRecoveryPayload = {
  context: {
    root: string;
    env: Record<string, string>;
  };
  input: CommitLifecycleInput;
  kind: string;
  requestSha256: string;
  requestAttempt: number;
  idempotencyIdentity: unknown;
  parentEventId: string | null;
  outcome: CommitMutationOutcome;
};

type CommitMutationRecovery = {
  key: string;
  recoveryRoot: string;
  context: CommitActionLedgerContext;
  content: string;
};

function beginCommitMutationRecovery(
  context: CommitActionLedgerContext,
  key: string,
  outcome: Omit<CommitMutationRecoveryPayload, "context">,
): CommitMutationRecovery {
  const recovery = { key, recoveryRoot: context.recoveryRoot, context, content: "" };
  recovery.content = writeCommitMutationRecovery(recovery, outcome);
  return recovery;
}

export function recoverCommitMutationOutcomes(): void {
  const current = commitActionLedgerContext();
  for (const recovery of readMutationRecoveries<CommitMutationRecoveryPayload>(
    current.recoveryRoot,
    "commit",
  )) {
    const payload = recovery.payload;
    const context: CommitActionLedgerContext = {
      root: payload.context.root,
      recoveryRoot: current.recoveryRoot,
      env: { ...process.env, ...payload.context.env },
    };
    if (commitMutationOutcomeRecorded(payload, context)) {
      removeMutationRecovery(current.recoveryRoot, "commit", recovery.key, recovery.content);
      continue;
    }
    recordCommitMutationOutcome(
      payload.input,
      payload.kind,
      payload.requestSha256,
      payload.requestAttempt,
      payload.idempotencyIdentity,
      payload.outcome,
      payload.parentEventId,
      context,
    );
    removeMutationRecovery(current.recoveryRoot, "commit", recovery.key, recovery.content);
  }
}

export async function flushCommitActionEvents(): Promise<string[]> {
  const root = commitActionLedgerRoot();
  recoverCommitMutationOutcomes();
  interruptOpenWorkflowActionEvents(root);
  return flushWorkflowActionEvents(root);
}

function writeCommitMutationRecovery(
  recovery: CommitMutationRecovery,
  outcome: Omit<CommitMutationRecoveryPayload, "context">,
): string {
  return writeMutationRecovery(recovery.recoveryRoot, "commit", recovery.key, {
    context: {
      root: recovery.context.root,
      env: actionLedgerRecoveryEnvironment(recovery.context.env),
    },
    ...outcome,
  });
}

function updateCommitMutationRecoverySafely(
  recovery: CommitMutationRecovery | null | undefined,
  outcome: Omit<CommitMutationRecoveryPayload, "context">,
): void {
  if (!recovery) return;
  try {
    recovery.content = writeCommitMutationRecovery(recovery, outcome);
  } catch (error) {
    console.error(
      `[action-ledger] failed to persist ${outcome.kind} ${outcome.outcome} recovery: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function removeCommitMutationRecoverySafely(
  recovery: CommitMutationRecovery | null | undefined,
): void {
  if (!recovery) return;
  try {
    removeMutationRecovery(recovery.recoveryRoot, "commit", recovery.key, recovery.content);
  } catch (error) {
    console.error(
      `[action-ledger] failed to clear ${recovery.key} recovery: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function commitMutationOutcomeRecorded(
  payload: CommitMutationRecoveryPayload,
  context: CommitActionLedgerContext,
): boolean {
  const idempotencyKeySha256 = actionIdempotencyKey(payload.idempotencyIdentity);
  return commitEvents(payload.input, context).some(
    (event) =>
      event.parent_event_id === payload.parentEventId &&
      event.event_type === ACTION_EVENT_TYPES.publicationLifecycle &&
      event.idempotency_key_sha256 === idempotencyKeySha256 &&
      TERMINAL_MUTATION_COMPLETION_REASONS.has(String(event.attributes?.completion_reason ?? "")),
  );
}

function commitOperationIdentity(input: CommitLifecycleInput) {
  return {
    repository: input.repository.trim().toLowerCase(),
    sha: input.sha.trim().toLowerCase(),
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

function commitActionLedgerRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || process.cwd();
}

function commitActionLedgerContext(): CommitActionLedgerContext {
  const env = { ...process.env };
  return {
    root: commitActionLedgerRoot(env),
    recoveryRoot: actionLedgerRecoveryRoot(env, commitActionLedgerRoot(env)),
    env,
  };
}

function commitEvents(
  input: CommitLifecycleInput,
  context: CommitActionLedgerContext = commitActionLedgerContext(),
): ActionEvent[] {
  const operationId = actionOperationId(
    input.repository,
    "commit_review",
    commitOperationIdentity(input),
  );
  const attemptId = actionAttemptId(operationId, workflowAttemptIdentity(context.env));
  const events = [
    ...readPriorCommitActionEvents(input, context.env),
    ...readSpooledActionEvents(context.root, input.repository),
  ].filter((event) => event.operation_id === operationId && event.attempt_id === attemptId);
  return [...new Map(events.map((event) => [event.event_id, event])).values()].sort(
    (left, right) => left.phase_seq - right.phase_seq,
  );
}

type PriorCommitActionLedgerSource = {
  source_root: string;
  event_paths: string[];
  producer: {
    repository: string;
    sha: string;
    workflow: string;
    job: string;
    run_id: string;
    run_attempt: number;
  };
  subject: {
    repository: string;
    sha: string;
  };
};

function readPriorCommitActionEvents(
  input: CommitLifecycleInput,
  env: NodeJS.ProcessEnv,
): ActionEvent[] {
  const contextPath = env.CLAWSWEEPER_COMMIT_ACTION_LEDGER_PRIOR_CONTEXT?.trim();
  if (!contextPath) return [];
  if (!existsSync(contextPath) || !statSync(contextPath).isFile()) {
    throw new Error("commit action ledger prior context is missing");
  }
  if (statSync(contextPath).size > 256 * 1024) {
    throw new Error("commit action ledger prior context is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(contextPath, "utf8"));
  } catch {
    throw new Error("commit action ledger prior context is invalid");
  }
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("commit action ledger prior context is invalid");
  }
  const repository = input.repository.trim().toLowerCase();
  const sha = input.sha.trim().toLowerCase();
  return value.flatMap((candidate, index) => {
    const source = parsePriorCommitActionLedgerSource(candidate, index);
    if (source.subject.repository !== repository || source.subject.sha !== sha) return [];
    assertPriorCommitActionLedgerProducer(source, env);
    const batch = readValidatedActionEventShardBatch(source.source_root);
    if (JSON.stringify(batch.eventPaths) !== JSON.stringify(source.event_paths)) {
      throw new Error(`commit action ledger prior context shard set mismatch at index ${index}`);
    }
    for (const event of batch.events) {
      const producer = event.producer;
      if (
        producer.repository !== source.producer.repository ||
        producer.sha !== source.producer.sha ||
        producer.workflow !== source.producer.workflow ||
        producer.job !== source.producer.job ||
        producer.run_id !== source.producer.run_id ||
        producer.run_attempt !== source.producer.run_attempt
      ) {
        throw new Error(`commit action ledger prior context producer mismatch at index ${index}`);
      }
      if (
        event.subject.repository !== repository ||
        event.subject.kind !== "commit" ||
        event.subject.source_revision !== sha
      ) {
        throw new Error(`commit action ledger prior context subject mismatch at index ${index}`);
      }
    }
    return batch.events;
  });
}

function parsePriorCommitActionLedgerSource(
  value: unknown,
  index: number,
): PriorCommitActionLedgerSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`commit action ledger prior context entry ${index} is invalid`);
  }
  const source = value as Partial<PriorCommitActionLedgerSource>;
  const producer = source.producer;
  const subject = source.subject;
  if (
    Object.keys(source).sort().join(",") !== "event_paths,producer,source_root,subject" ||
    typeof source.source_root !== "string" ||
    !source.source_root.startsWith("/") ||
    !Array.isArray(source.event_paths) ||
    source.event_paths.some((entry) => typeof entry !== "string") ||
    !producer ||
    typeof producer !== "object" ||
    Object.keys(producer).sort().join(",") !== "job,repository,run_attempt,run_id,sha,workflow" ||
    typeof producer.repository !== "string" ||
    typeof producer.sha !== "string" ||
    typeof producer.workflow !== "string" ||
    typeof producer.job !== "string" ||
    typeof producer.run_id !== "string" ||
    !Number.isSafeInteger(producer.run_attempt) ||
    Number(producer.run_attempt) < 1 ||
    !subject ||
    typeof subject !== "object" ||
    Object.keys(subject).sort().join(",") !== "repository,sha" ||
    typeof subject.repository !== "string" ||
    typeof subject.sha !== "string"
  ) {
    throw new Error(`commit action ledger prior context entry ${index} is invalid`);
  }
  return {
    source_root: source.source_root,
    event_paths: source.event_paths,
    producer: {
      repository: producer.repository.trim().toLowerCase(),
      sha: producer.sha.trim().toLowerCase(),
      workflow: producer.workflow.trim(),
      job: producer.job.trim(),
      run_id: producer.run_id.trim(),
      run_attempt: producer.run_attempt,
    },
    subject: {
      repository: subject.repository.trim().toLowerCase(),
      sha: subject.sha.trim().toLowerCase(),
    },
  };
}

function assertPriorCommitActionLedgerProducer(
  source: PriorCommitActionLedgerSource,
  env: NodeJS.ProcessEnv,
): void {
  const current = workflowActionProducer("commit_prior_context", env);
  if (
    source.producer.repository !== current.repository ||
    source.producer.sha !== current.sha ||
    source.producer.workflow !== current.workflow ||
    source.producer.job !== "review" ||
    source.producer.run_id !== current.runId ||
    source.producer.run_attempt > current.runAttempt
  ) {
    throw new Error("commit action ledger prior context producer is not authenticated");
  }
}

function latestCommitEvent(events: readonly ActionEvent[]): ActionEvent | null {
  return [...events].sort((left, right) => left.phase_seq - right.phase_seq).at(-1) ?? null;
}

function nextRequestAttempt(
  input: CommitLifecycleInput,
  idempotencyIdentity: unknown,
  context: CommitActionLedgerContext,
): number {
  const idempotencyKey = actionIdempotencyKey(idempotencyIdentity);
  return (
    commitEvents(input, context).filter(
      (event) =>
        event.action.status === ACTION_EVENT_STATUSES.started &&
        event.idempotency_key_sha256 === idempotencyKey,
    ).length + 1
  );
}

function commitMutationState(input: CommitLifecycleInput): { observed: boolean; unknown: boolean } {
  const outcomes = new Map<string, { observed: boolean; unknown: boolean; phaseSeq: number }>();
  for (const event of commitEvents(input)) {
    const reason = String(event.attributes?.completion_reason ?? "");
    const key = event.idempotency_key_sha256;
    if (!key) continue;
    const current = outcomes.get(key) ?? { observed: false, unknown: false, phaseSeq: 0 };
    if (event.phase_seq < current.phaseSeq) continue;
    if (reason === "mutation_observed") {
      outcomes.set(key, { observed: true, unknown: false, phaseSeq: event.phase_seq });
    } else if (reason === "mutation_accepted") {
      outcomes.set(key, {
        observed: true,
        unknown: current.unknown,
        phaseSeq: event.phase_seq,
      });
    } else if (reason === "mutation_outcome_unknown") {
      outcomes.set(key, {
        observed: current.observed,
        unknown: true,
        phaseSeq: event.phase_seq,
      });
    }
  }
  const states = [...outcomes.values()];
  return {
    observed: states.some((state) => state.observed || state.unknown),
    unknown: states.some((state) => state.unknown),
  };
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
