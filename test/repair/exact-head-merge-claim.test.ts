import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureExactHeadMergeClaim,
  exactHeadMergeClaimRecoveryDecision,
  markExactHeadMergeClaimDispatched,
} from "../../dist/repair/exact-head-merge-claim.js";

const headSha = "a".repeat(40);
const squashCommitMessage = "fix: preserve exact-head ownership";

test("dispatched claim recovery grace starts at the dispatch marker", () => {
  const comments: Record<string, any>[] = [];
  let nextId = 2001;
  const request = (runId: number) => ({
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner: "comment_router",
    claimant: `comment_router:${runId}:1`,
    appId: 3306130,
    appSlug: "clawsweeper",
  });
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      const comment = {
        id: nextId++,
        body,
        created_at: comments.length === 0 ? "2026-07-13T08:00:00Z" : "2026-07-13T08:10:00Z",
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  const claim = ensureExactHeadMergeClaim(request(7001), io);
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") return;
  assert.equal(
    markExactHeadMergeClaimDispatched(request(7001), claim.claimId, squashCommitMessage, io).status,
    "dispatched",
  );

  let workflowReads = 0;
  let effectReads = 0;
  const result = ensureExactHeadMergeClaim(request(7002), {
    ...io,
    dispatchedClaimEffectAbsent: () => {
      effectReads += 1;
      return true;
    },
    recoverClaim: (candidate) => {
      assert.equal(candidate.createdAt, "2026-07-13T08:00:00.000Z");
      assert.equal(candidate.dispatchedAt, "2026-07-13T08:10:00.000Z");
      return exactHeadMergeClaimRecoveryDecision(
        candidate,
        () => {
          workflowReads += 1;
          return { id: 7001, run_attempt: 1, status: "completed", conclusion: "success" };
        },
        {
          GITHUB_REPOSITORY: "openclaw/clawsweeper",
          GITHUB_RUN_ID: "7002",
          GITHUB_RUN_ATTEMPT: "1",
        },
        Date.parse("2026-07-13T08:12:00Z"),
      );
    },
  });

  assert.equal(result.status, "existing");
  assert.equal(workflowReads, 0);
  assert.equal(effectReads, 0);
});

test("successful dispatched claims recover only after grace and definitive effect absence", () => {
  const candidate = {
    claimId: 2101,
    owner: "comment_router",
    claimant: "comment_router:7101:1",
    createdAt: "2026-07-13T08:00:00Z",
    dispatched: true,
    dispatchedAt: "2026-07-13T08:10:00Z",
  };
  const env = {
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ID: "7102",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const readSuccessfulRun = () => ({
    id: 7101,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
  });

  assert.equal(
    exactHeadMergeClaimRecoveryDecision(
      candidate,
      readSuccessfulRun,
      env,
      Date.parse("2026-07-13T08:16:00Z"),
    ).status,
    "recoverable",
  );

  const comments: Record<string, any>[] = [];
  let nextId = 2101;
  const request = (runId: number) => ({
    repository: "openclaw/openclaw",
    number: 43,
    headSha,
    method: "squash" as const,
    owner: "comment_router",
    claimant: `comment_router:${runId}:1`,
    appId: 3306130,
    appSlug: "clawsweeper",
  });
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      const comment = {
        id: nextId++,
        body,
        created_at: comments.length === 0 ? "2026-07-13T08:00:00Z" : "2026-07-13T08:10:00Z",
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };
  const claim = ensureExactHeadMergeClaim(request(7101), io);
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") return;
  assert.equal(
    markExactHeadMergeClaimDispatched(request(7101), claim.claimId, squashCommitMessage, io).status,
    "dispatched",
  );
  const recoverClaim = (recoveryCandidate: typeof candidate) =>
    exactHeadMergeClaimRecoveryDecision(
      recoveryCandidate,
      readSuccessfulRun,
      env,
      Date.parse("2026-07-13T08:16:00Z"),
    );

  assert.equal(
    ensureExactHeadMergeClaim(request(7102), {
      ...io,
      dispatchedClaimEffectAbsent: () => false,
      recoverClaim,
    }).status,
    "existing",
  );
  assert.equal(
    ensureExactHeadMergeClaim(request(7102), {
      ...io,
      dispatchedClaimEffectAbsent: () => true,
      recoverClaim,
    }).status,
    "recovered",
  );
});
