import { createHash } from "node:crypto";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../action-ledger.js";
import {
  recordRepairLifecycleEvent,
  repairMutationIdempotencyIdentity,
  runRepairMutationAsync,
  type RepairLifecycleInput,
} from "./repair-action-ledger.js";
import { isRejectedOpenClawHookError } from "./openclaw-hook.js";

export type NotificationLedgerInput = {
  repository: string;
  key: string;
  number?: number | null;
  sourceRevision?: string | null;
};

export type NotificationMutationOutcome =
  | "mutation_observed"
  | "mutation_rejected"
  | "mutation_outcome_unknown";
export type NotificationAttemptRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export function recordNotificationPhase(
  input: NotificationLedgerInput,
  phase: "planned" | "skipped" | "sent" | "failed",
  reason: string = phase,
  failureOutcome: NotificationMutationOutcome = "mutation_outcome_unknown",
): void {
  const lifecycle = notificationLifecycle(input);
  recordRepairLifecycleEvent(lifecycle, {
    type:
      phase === "planned"
        ? ACTION_EVENT_TYPES.notificationPlanned
        : phase === "skipped"
          ? ACTION_EVENT_TYPES.notificationSkipped
          : phase === "sent"
            ? ACTION_EVENT_TYPES.notificationSent
            : ACTION_EVENT_TYPES.notificationFailed,
    status:
      phase === "planned"
        ? ACTION_EVENT_STATUSES.planned
        : phase === "skipped"
          ? ACTION_EVENT_STATUSES.skipped
          : phase === "sent"
            ? ACTION_EVENT_STATUSES.sent
            : ACTION_EVENT_STATUSES.failed,
    reasonCode:
      phase === "planned"
        ? ACTION_EVENT_REASON_CODES.selected
        : phase === "skipped"
          ? ACTION_EVENT_REASON_CODES.notApplicable
          : phase === "sent"
            ? ACTION_EVENT_REASON_CODES.completed
            : ACTION_EVENT_REASON_CODES.exception,
    mutation: phase === "sent" || (phase === "failed" && failureOutcome !== "mutation_rejected"),
    retryable: phase === "failed" && failureOutcome === "mutation_outcome_unknown",
    component: "notification",
    operation: "notification",
    state: phase,
    ...(phase === "sent"
      ? { completionReason: "mutation_observed" }
      : phase === "failed"
        ? { completionReason: failureOutcome }
        : {}),
    eventIdentity: { key: input.key, reason },
    ...(phase === "sent" || phase === "failed"
      ? { idempotencyIdentity: notificationDeliveryIdempotencyIdentity(input) }
      : {}),
  });
}

export function recordNotificationPhaseSafely(
  input: NotificationLedgerInput,
  phase: "planned" | "skipped" | "sent" | "failed",
  reason: string = phase,
  failureOutcome: NotificationMutationOutcome = "mutation_outcome_unknown",
  report: (message: string) => void = console.error,
): void {
  try {
    recordNotificationPhase(input, phase, reason, failureOutcome);
  } catch (receiptError) {
    report(
      `[action-ledger] failed to record notification ${phase} after the primary failure: ${
        receiptError instanceof Error ? receiptError.message : String(receiptError)
      }`,
    );
  }
}

export function recordNotificationPreflightFailureSafely(
  input: NotificationLedgerInput,
  error: unknown,
  report: (message: string) => void = console.error,
): void {
  try {
    recordRepairLifecycleEvent(notificationLifecycle(input), {
      type: ACTION_EVENT_TYPES.notificationFailed,
      status: ACTION_EVENT_STATUSES.failed,
      reasonCode: ACTION_EVENT_REASON_CODES.exception,
      mutation: false,
      retryable: true,
      component: "notification",
      operation: "notification",
      state: "failed",
      completionReason: "preflight_failed",
      eventIdentity: {
        key: input.key,
        errorKind: error instanceof Error ? error.name : typeof error,
      },
    });
  } catch (receiptError) {
    report(
      `[action-ledger] failed to record notification preflight failure after the primary failure: ${
        receiptError instanceof Error ? receiptError.message : String(receiptError)
      }`,
    );
  }
}

export async function deliverNotificationAttempt<T>(
  input: NotificationLedgerInput,
  options: {
    kind: string;
    destination: string;
    operation: () => Promise<T>;
    knownNoMutation?: (error: unknown) => boolean;
  },
): Promise<T> {
  const knownNoMutation =
    options.knownNoMutation ??
    (options.destination === "openclaw_hook" ? isRejectedOpenClawHookError : undefined);
  return runRepairMutationAsync(notificationLifecycle(input), {
    kind: options.kind,
    identity: { key: input.key, destination: options.destination },
    component: "notification",
    operationName: "notification",
    operation: options.operation,
    ...(knownNoMutation ? { knownNoMutation } : {}),
  });
}

export async function deliverNotification<T>(
  input: NotificationLedgerInput,
  operation: () => Promise<T>,
): Promise<T> {
  recordNotificationPhase(input, "planned");
  try {
    const result = await deliverNotificationAttempt(input, {
      kind: "notification_delivery",
      destination: "openclaw_hook",
      operation,
    });
    recordNotificationPhase(input, "sent");
    return result;
  } catch (error) {
    recordNotificationPhaseSafely(
      input,
      "failed",
      error instanceof Error ? error.name : typeof error,
      isRejectedOpenClawHookError(error) ? "mutation_rejected" : "mutation_outcome_unknown",
    );
    throw error;
  }
}

export async function deliverRetriedNotification<T>(
  input: NotificationLedgerInput,
  operation: (attemptRunner: NotificationAttemptRunner) => Promise<T>,
): Promise<T> {
  recordNotificationPhase(input, "planned");
  try {
    const result = await operation((attempt) =>
      deliverNotificationAttempt(input, {
        kind: "notification_delivery",
        destination: "openclaw_hook",
        operation: attempt,
      }),
    );
    recordNotificationPhase(input, "sent");
    return result;
  } catch (error) {
    recordNotificationPhaseSafely(
      input,
      "failed",
      error instanceof Error ? error.name : typeof error,
      isRejectedOpenClawHookError(error) ? "mutation_rejected" : "mutation_outcome_unknown",
    );
    throw error;
  }
}

function notificationLifecycle(input: NotificationLedgerInput): RepairLifecycleInput {
  return {
    repository: input.repository,
    workKey: `notification:${input.key}`,
    ...(input.number ? { number: input.number } : {}),
    ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
    subjectKind: "notification",
    subjectId: `notification-${createHash("sha256").update(input.key).digest("hex").slice(0, 24)}`,
  };
}

function notificationDeliveryIdempotencyIdentity(input: NotificationLedgerInput) {
  return repairMutationIdempotencyIdentity(notificationLifecycle(input), {
    kind: "notification_delivery",
    operationName: "notification",
    identity: { key: input.key, destination: "openclaw_hook" },
  });
}
