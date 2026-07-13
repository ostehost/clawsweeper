import assert from "node:assert/strict";
import test from "node:test";

import { guardAutomergeMergeDispatch } from "../../dist/repair/comment-router-merge-dispatch.js";

test("review activity arriving after dispatch marking retires the claim without merging", () => {
  const calls: string[] = [];
  let mergeCalls = 0;
  const result = guardAutomergeMergeDispatch({
    markDispatched: () => {
      calls.push("mark");
      return {
        status: "dispatched",
        reason: "",
        claimId: 1201,
        expectedSquashMessage: "fix: guarded merge",
        lastClaimMutationId: 1202,
        lastClaimMutationAt: "2026-07-13T18:00:00.000Z",
      };
    },
    reviewActivityBlock: () => {
      calls.push("activity");
      return {
        reason: "pull request review activity changed since the trusted ClawSweeper verdict",
        retryable: false,
      };
    },
    rejectDispatched: () => {
      calls.push("reject");
      return { status: "rejected", reason: "", claimId: 1201 };
    },
  });

  if (result.status === "ready") mergeCalls += 1;

  assert.deepEqual(calls, ["mark", "activity", "reject"]);
  assert.equal(mergeCalls, 0);
  assert.deepEqual(result, {
    status: "aborted",
    dispatch: {
      status: "dispatched",
      reason: "",
      claimId: 1201,
      expectedSquashMessage: "fix: guarded merge",
      lastClaimMutationId: 1202,
      lastClaimMutationAt: "2026-07-13T18:00:00.000Z",
    },
    action: {
      status: "blocked",
      reason: "pull request review activity changed since the trusted ClawSweeper verdict",
    },
  });
});

test("review activity refresh failure waits after retiring the dispatched claim", () => {
  const result = guardAutomergeMergeDispatch({
    markDispatched: () => ({
      status: "dispatched",
      reason: "",
      claimId: 1301,
      expectedSquashMessage: "fix: guarded merge",
      lastClaimMutationId: 1302,
      lastClaimMutationAt: null,
    }),
    reviewActivityBlock: () => ({
      reason: "pull request review activity could not be refreshed: HTTP 503",
      retryable: true,
    }),
    rejectDispatched: () => ({ status: "rejected", reason: "", claimId: 1301 }),
  });

  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "waiting",
    reason: "pull request review activity could not be refreshed: HTTP 503",
  });
});
