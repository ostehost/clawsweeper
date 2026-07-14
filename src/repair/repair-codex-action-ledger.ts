import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../action-ledger.js";
import {
  recordRepairArtifactPrepared,
  recordRepairLifecycleEvent,
  type RepairLifecycleInput,
} from "./repair-action-ledger.js";

export type RepairCodexAction =
  | "repair_plan"
  | "repair_result_repair"
  | "repair_edit"
  | "repair_base_reconcile"
  | "repair_review"
  | "repair_review_fix"
  | "repair_validation_fix";

export type RepairCodexAttemptVariant = "standard" | "final" | "final_sync";

export type RepairCodexAttemptIdentity = {
  ordinal: number;
  variant: RepairCodexAttemptVariant;
  subattempt?: number;
};

export type RepairCodexArtifactPaths = {
  jsonl?: string;
  stderr?: string;
  report?: string;
};

export function repairCodexAttempt(
  ordinal: number,
  variant: RepairCodexAttemptVariant = "standard",
  subattempt?: number,
): RepairCodexAttemptIdentity {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error("repair Codex attempt ordinal must be a positive integer");
  }
  if (subattempt !== undefined && (!Number.isSafeInteger(subattempt) || subattempt < 1)) {
    throw new Error("repair Codex subattempt must be a positive integer");
  }
  return {
    ordinal,
    variant,
    ...(subattempt === undefined ? {} : { subattempt }),
  };
}

export function repairCodexAttemptLabel(attempt: RepairCodexAttemptIdentity): string {
  const variant =
    attempt.variant === "standard" ? "" : attempt.variant === "final" ? "-final" : "-final-sync";
  const subattempt = attempt.subattempt === undefined ? "" : `-${attempt.subattempt}`;
  return `${attempt.ordinal}${variant}${subattempt}`;
}

export function beginRepairCodexAction(
  input: RepairLifecycleInput,
  options: {
    action: RepairCodexAction;
    mode: string;
    attempt: RepairCodexAttemptIdentity;
    paths: RepairCodexArtifactPaths;
    component?: string;
    report?: (message: string) => void;
  },
) {
  const report = options.report ?? console.error;
  const lifecycle = repairCodexLifecycle(input, options);
  let settled = false;
  recordLifecycleSafely(lifecycle, options, "started", undefined, report);

  return {
    complete(): void {
      if (settled) return;
      settled = true;
      publishArtifactsSafely(lifecycle, options, report);
      recordLifecycleSafely(lifecycle, options, "completed", undefined, report);
    },
    fail(error: unknown): void {
      if (settled) return;
      settled = true;
      publishArtifactsSafely(lifecycle, options, report);
      recordLifecycleSafely(lifecycle, options, "failed", error, report);
    },
  };
}

function repairCodexLifecycle(
  input: RepairLifecycleInput,
  options: {
    action: RepairCodexAction;
    mode: string;
    attempt: RepairCodexAttemptIdentity;
  },
): RepairLifecycleInput {
  return {
    ...input,
    workKey: [
      input.workKey,
      "codex",
      options.action,
      options.mode,
      repairCodexAttemptLabel(options.attempt),
    ].join(":"),
  };
}

function recordLifecycleSafely(
  input: RepairLifecycleInput,
  options: {
    action: RepairCodexAction;
    mode: string;
    attempt: RepairCodexAttemptIdentity;
    component?: string;
  },
  phase: "started" | "completed" | "failed",
  error: unknown,
  report: (message: string) => void,
): void {
  try {
    recordRepairLifecycleEvent(input, {
      type:
        phase === "started"
          ? ACTION_EVENT_TYPES.reviewStarted
          : phase === "completed"
            ? ACTION_EVENT_TYPES.reviewCompleted
            : ACTION_EVENT_TYPES.reviewFailed,
      status:
        phase === "started"
          ? ACTION_EVENT_STATUSES.started
          : phase === "completed"
            ? ACTION_EVENT_STATUSES.completed
            : ACTION_EVENT_STATUSES.failed,
      reasonCode:
        phase === "started"
          ? ACTION_EVENT_REASON_CODES.selected
          : phase === "completed"
            ? ACTION_EVENT_REASON_CODES.completed
            : ACTION_EVENT_REASON_CODES.exception,
      mutation: false,
      component: options.component ?? "execute_fix_codex",
      state: phase,
      reviewMode: options.action,
      eventIdentity: {
        action: options.action,
        mode: options.mode,
        attempt: options.attempt,
        ...(error === undefined
          ? {}
          : { errorKind: error instanceof Error ? error.name : typeof error }),
      },
      idempotencyIdentity: {
        action: options.action,
        mode: options.mode,
        attempt: options.attempt,
      },
    });
  } catch (receiptError) {
    report(
      `[action-ledger] failed to record ${options.action} ${phase}: ${
        receiptError instanceof Error ? receiptError.message : String(receiptError)
      }`,
    );
  }
}

function publishArtifactsSafely(
  input: RepairLifecycleInput,
  options: {
    action: RepairCodexAction;
    paths: RepairCodexArtifactPaths;
    component?: string;
  },
  report: (message: string) => void,
): void {
  for (const [kind, artifactPath] of Object.entries(options.paths)) {
    if (!artifactPath) continue;
    try {
      recordRepairArtifactPrepared(input, {
        path: artifactPath,
        kind: `${options.action}_${kind}`,
        component: options.component ?? "execute_fix_codex",
        reviewMode: options.action,
      });
    } catch (receiptError) {
      report(
        `[action-ledger] failed to record ${options.action} ${kind} artifact: ${
          receiptError instanceof Error ? receiptError.message : String(receiptError)
        }`,
      );
    }
  }
}
