import type {
  ExactHeadMergeClaimDispatchResult,
  ExactHeadMergeClaimRejectionResult,
} from "./exact-head-merge-claim.js";

export type AutomergeReviewActivityBlock = {
  reason: string;
  retryable: boolean;
};

type AutomergeDispatchBlock = AutomergeReviewActivityBlock;

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
  dispatchStateBlock: () => AutomergeDispatchBlock | null;
  finalSafetyBlock: () => AutomergeDispatchBlock | null;
  rejectDispatched: () => ExactHeadMergeClaimRejectionResult;
}): AutomergeMergeDispatchGuardResult {
  const dispatch = options.markDispatched();
  if (dispatch.status !== "dispatched") {
    return { status: "marker_failed", dispatch, reason: dispatch.reason };
  }

  const activityBlock = options.reviewActivityBlock();
  if (activityBlock) {
    return rejectDispatchedClaim(dispatch, activityBlock, options.rejectDispatched);
  }

  const dispatchStateBlock = options.dispatchStateBlock();
  if (dispatchStateBlock) {
    return rejectDispatchedClaim(dispatch, dispatchStateBlock, options.rejectDispatched);
  }

  const finalSafetyBlock = options.finalSafetyBlock();
  if (finalSafetyBlock) {
    return rejectDispatchedClaim(dispatch, finalSafetyBlock, options.rejectDispatched);
  }

  return { status: "ready", dispatch };
}

function rejectDispatchedClaim(
  dispatch: DispatchedClaim,
  block: AutomergeDispatchBlock,
  rejectDispatched: () => ExactHeadMergeClaimRejectionResult,
): AutomergeMergeDispatchGuardResult {
  let rejection: ExactHeadMergeClaimRejectionResult;
  try {
    rejection = rejectDispatched();
  } catch (error) {
    return {
      status: "aborted",
      dispatch,
      action: {
        status: "waiting",
        reason: `${block.reason}; exact-head merge claim rejection failed: ${errorText(error)}`,
      },
    };
  }
  if (rejection.status === "rejected") {
    return {
      status: "aborted",
      dispatch,
      action: {
        status: block.retryable ? "waiting" : "blocked",
        reason: block.reason,
      },
    };
  }
  return {
    status: "aborted",
    dispatch,
    action: {
      status: rejection.status === "unknown" ? "waiting" : "blocked",
      reason: `${block.reason}; ${rejection.reason}`,
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
