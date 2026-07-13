import type {
  ExactHeadMergeClaimDispatchResult,
  ExactHeadMergeClaimRejectionResult,
} from "./exact-head-merge-claim.js";

export type AutomergeReviewActivityBlock = {
  reason: string;
  retryable: boolean;
};

type DispatchedClaim = Extract<ExactHeadMergeClaimDispatchResult, { status: "dispatched" }>;
type FailedDispatchClaim = Exclude<ExactHeadMergeClaimDispatchResult, { status: "dispatched" }>;

export type AutomergeMergeDispatchGuardResult =
  | { status: "ready"; dispatch: DispatchedClaim }
  | {
      status: "aborted";
      dispatch: DispatchedClaim;
      action: { status: "waiting" | "blocked"; reason: string };
    }
  | { status: "marker_failed"; dispatch: FailedDispatchClaim; reason: string };

export function guardAutomergeMergeDispatch(options: {
  markDispatched: () => ExactHeadMergeClaimDispatchResult;
  reviewActivityBlock: () => AutomergeReviewActivityBlock | null;
  rejectDispatched: () => ExactHeadMergeClaimRejectionResult;
}): AutomergeMergeDispatchGuardResult {
  const dispatch = options.markDispatched();
  if (dispatch.status !== "dispatched") {
    return { status: "marker_failed", dispatch, reason: dispatch.reason };
  }

  const activityBlock = options.reviewActivityBlock();
  if (!activityBlock) return { status: "ready", dispatch };

  let rejection: ExactHeadMergeClaimRejectionResult;
  try {
    rejection = options.rejectDispatched();
  } catch (error) {
    return {
      status: "aborted",
      dispatch,
      action: {
        status: "waiting",
        reason: `${activityBlock.reason}; exact-head merge claim rejection failed: ${errorText(error)}`,
      },
    };
  }
  if (rejection.status === "rejected") {
    return {
      status: "aborted",
      dispatch,
      action: {
        status: activityBlock.retryable ? "waiting" : "blocked",
        reason: activityBlock.reason,
      },
    };
  }
  return {
    status: "aborted",
    dispatch,
    action: {
      status: rejection.status === "unknown" ? "waiting" : "blocked",
      reason: `${activityBlock.reason}; ${rejection.reason}`,
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
