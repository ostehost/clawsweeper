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
    dispatchStateBlock: () => {
      calls.push("state");
      return null;
    },
    finalSafetyBlock: () => {
      calls.push("state");
      return null;
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
    dispatchStateBlock: () => null,
    finalSafetyBlock: () => null,
    rejectDispatched: () => ({ status: "rejected", reason: "", claimId: 1301 }),
  });

  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "waiting",
    reason: "pull request review activity could not be refreshed: HTTP 503",
  });
});

test("live state drift after activity validation retires the claim without merging", () => {
  const calls: string[] = [];
  let mergeCalls = 0;
  const result = guardAutomergeMergeDispatch({
    markDispatched: () => {
      calls.push("mark");
      return {
        status: "dispatched",
        reason: "",
        claimId: 1401,
        expectedSquashMessage: "fix: guarded merge",
        lastClaimMutationId: 1402,
        lastClaimMutationAt: "2026-07-13T20:00:00.000Z",
      };
    },
    reviewActivityBlock: () => {
      calls.push("activity");
      return null;
    },
    dispatchStateBlock: () => {
      calls.push("state");
      return {
        reason: "pull request base is not main",
        retryable: false,
      };
    },
    finalSafetyBlock: () => null,
    rejectDispatched: () => {
      calls.push("reject");
      return { status: "rejected", reason: "", claimId: 1401 };
    },
  });

  if (result.status === "ready") mergeCalls += 1;

  assert.deepEqual(calls, ["mark", "activity", "state", "reject"]);
  assert.equal(mergeCalls, 0);
  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "blocked",
    reason: "pull request base is not main",
  });
});

test("live state refresh failure retires the claim as a retryable no-op", () => {
  let mergeCalls = 0;
  const result = guardAutomergeMergeDispatch({
    markDispatched: () => ({
      status: "dispatched",
      reason: "",
      claimId: 1501,
      expectedSquashMessage: "fix: guarded merge",
      lastClaimMutationId: 1502,
      lastClaimMutationAt: null,
    }),
    reviewActivityBlock: () => null,
    dispatchStateBlock: () => ({
      reason: "pre-dispatch automerge state could not be refreshed: HTTP 503",
      retryable: true,
    }),
    finalSafetyBlock: () => null,
    rejectDispatched: () => ({ status: "rejected", reason: "", claimId: 1501 }),
  });

  if (result.status === "ready") mergeCalls += 1;

  assert.equal(mergeCalls, 0);
  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "waiting",
    reason: "pre-dispatch automerge state could not be refreshed: HTTP 503",
  });
});

test("merge becomes ready only after activity and live state checks pass", () => {
  const calls: string[] = [];
  const result = guardAutomergeMergeDispatch({
    markDispatched: () => {
      calls.push("mark");
      return {
        status: "dispatched",
        reason: "",
        claimId: 1601,
        expectedSquashMessage: "fix: guarded merge",
        lastClaimMutationId: 1602,
        lastClaimMutationAt: null,
      };
    },
    reviewActivityBlock: () => {
      calls.push("activity");
      return null;
    },
    dispatchStateBlock: () => {
      calls.push("state");
      return null;
    },
    finalSafetyBlock: () => {
      calls.push("safety");
      return null;
    },
    rejectDispatched: () => {
      calls.push("reject");
      return { status: "rejected", reason: "", claimId: 1601 };
    },
  });

  assert.deepEqual(calls, ["mark", "activity", "state", "safety"]);
  assert.equal(result.status, "ready");
});

test("review activity arriving during final safety refresh retires the dispatched claim", () => {
  const calls: string[] = [];
  const result = guardAutomergeMergeDispatch({
    markDispatched: () => {
      calls.push("mark");
      return {
        status: "dispatched",
        reason: "",
        claimId: 1701,
        expectedSquashMessage: "fix: guarded merge",
        lastClaimMutationId: 1702,
        lastClaimMutationAt: null,
      };
    },
    reviewActivityBlock: () => {
      calls.push("activity");
      return null;
    },
    dispatchStateBlock: () => {
      calls.push("state");
      return null;
    },
    finalSafetyBlock: () => {
      calls.push("safety");
      return {
        reason: "pull request review activity changed during final safety refresh",
        retryable: false,
      };
    },
    rejectDispatched: () => {
      calls.push("reject");
      return { status: "rejected", reason: "", claimId: 1701 };
    },
  });

  assert.deepEqual(calls, ["mark", "activity", "state", "safety", "reject"]);
  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "blocked",
    reason: "pull request review activity changed during final safety refresh",
  });
});

test("base retarget arriving during final safety refresh retires the dispatched claim", () => {
  const calls: string[] = [];
  const result = guardAutomergeMergeDispatch({
    markDispatched: () => {
      calls.push("mark");
      return {
        status: "dispatched",
        reason: "",
        claimId: 1801,
        expectedSquashMessage: "fix: guarded merge",
        lastClaimMutationId: 1802,
        lastClaimMutationAt: null,
      };
    },
    reviewActivityBlock: () => {
      calls.push("activity");
      return null;
    },
    dispatchStateBlock: () => {
      calls.push("state");
      return null;
    },
    finalSafetyBlock: () => {
      calls.push("safety");
      return { reason: "pull request base is not main", retryable: false };
    },
    rejectDispatched: () => {
      calls.push("reject");
      return { status: "rejected", reason: "", claimId: 1801 };
    },
  });

  assert.deepEqual(calls, ["mark", "activity", "state", "safety", "reject"]);
  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "blocked",
    reason: "pull request base is not main",
  });
});
