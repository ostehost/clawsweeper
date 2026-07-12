import { createHash } from "node:crypto";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../action-ledger.js";
import {
  recordRepairLifecycleEvent,
  runRepairMutationAsync,
  type RepairLifecycleInput,
} from "./repair-action-ledger.js";

export type NotificationLedgerInput = {
  repository: string;
  key: string;
  number?: number | null;
  sourceRevision?: string | null;
};

export function recordNotificationPhase(
  input: NotificationLedgerInput,
  phase: "planned" | "skipped" | "sent" | "failed",
  reason: string = phase,
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
    mutation: phase === "sent" || phase === "failed",
    retryable: phase === "failed",
    component: "notification",
    operation: "notification",
    state: phase,
    ...(phase === "sent"
      ? { completionReason: "mutation_observed" }
      : phase === "failed"
        ? { completionReason: "mutation_outcome_unknown" }
        : {}),
    eventIdentity: { key: input.key, reason },
    ...(phase === "sent" || phase === "failed"
      ? { idempotencyIdentity: { notification: input.key, outcome: phase } }
      : {}),
  });
}

export async function deliverNotification<T>(
  input: NotificationLedgerInput,
  operation: () => Promise<T>,
): Promise<T> {
  recordNotificationPhase(input, "planned");
  try {
    const result = await runRepairMutationAsync(notificationLifecycle(input), {
      kind: "notification_delivery",
      identity: { key: input.key },
      component: "notification",
      operationName: "notification",
      operation,
    });
    recordNotificationPhase(input, "sent");
    return result;
  } catch (error) {
    recordNotificationPhase(input, "failed", error instanceof Error ? error.name : typeof error);
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
