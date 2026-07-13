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
    strictBaseBindingBlock: () => {
      calls.push("policy");
      return null;
    },
    finalStateBlock: () => {
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
    strictBaseBindingBlock: () => null,
    finalStateBlock: () => null,
    rejectDispatched: () => ({ status: "rejected", reason: "", claimId: 1301 }),
  });

  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "waiting",
    reason: "pull request review activity could not be refreshed: HTTP 503",
  });
});

test("strict-base drift after activity validation retires the claim without merging", () => {
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
    strictBaseBindingBlock: () => {
      calls.push("policy");
      return {
        reason: "automerge disabled: main lacks server-enforced strict base binding",
        retryable: false,
      };
    },
    finalStateBlock: () => null,
    rejectDispatched: () => {
      calls.push("reject");
      return { status: "rejected", reason: "", claimId: 1401 };
    },
  });

  if (result.status === "ready") mergeCalls += 1;

  assert.deepEqual(calls, ["mark", "activity", "policy", "reject"]);
  assert.equal(mergeCalls, 0);
  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "blocked",
    reason: "automerge disabled: main lacks server-enforced strict base binding",
  });
});

test("strict-base refresh failure retires the claim as a retryable no-op", () => {
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
    strictBaseBindingBlock: () => ({
      reason: "pre-dispatch strict-base policy could not be refreshed: HTTP 503",
      retryable: true,
    }),
    finalStateBlock: () => null,
    rejectDispatched: () => ({ status: "rejected", reason: "", claimId: 1501 }),
  });

  if (result.status === "ready") mergeCalls += 1;

  assert.equal(mergeCalls, 0);
  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "waiting",
    reason: "pre-dispatch strict-base policy could not be refreshed: HTTP 503",
  });
});

test("merge becomes ready only after activity and strict-base checks pass", () => {
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
    strictBaseBindingBlock: () => {
      calls.push("policy");
      return null;
    },
    finalStateBlock: () => {
      calls.push("state");
      return null;
    },
    rejectDispatched: () => {
      calls.push("reject");
      return { status: "rejected", reason: "", claimId: 1601 };
    },
  });

  assert.deepEqual(calls, ["mark", "activity", "policy", "state", "activity"]);
  assert.equal(result.status, "ready");
});

test("review activity arriving during policy refresh retires the dispatched claim", () => {
  const calls: string[] = [];
  let activityChecks = 0;
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
      activityChecks += 1;
      return activityChecks === 1
        ? null
        : {
            reason: "pull request review activity changed during policy refresh",
            retryable: false,
          };
    },
    strictBaseBindingBlock: () => {
      calls.push("policy");
      return null;
    },
    finalStateBlock: () => {
      calls.push("state");
      return null;
    },
    rejectDispatched: () => {
      calls.push("reject");
      return { status: "rejected", reason: "", claimId: 1701 };
    },
  });

  assert.deepEqual(calls, ["mark", "activity", "policy", "state", "activity", "reject"]);
  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "blocked",
    reason: "pull request review activity changed during policy refresh",
  });
});

test("base retarget arriving during policy refresh retires the dispatched claim", () => {
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
    strictBaseBindingBlock: () => {
      calls.push("policy");
      return null;
    },
    finalStateBlock: () => {
      calls.push("state");
      return { reason: "pull request base is not main", retryable: false };
    },
    rejectDispatched: () => {
      calls.push("reject");
      return { status: "rejected", reason: "", claimId: 1801 };
    },
  });

  assert.deepEqual(calls, ["mark", "activity", "policy", "state", "reject"]);
  assert.equal(result.status, "aborted");
  if (result.status !== "aborted") return;
  assert.deepEqual(result.action, {
    status: "blocked",
    reason: "pull request base is not main",
  });
});
