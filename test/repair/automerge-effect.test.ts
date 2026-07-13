import assert from "node:assert/strict";
import test from "node:test";

import {
  automergeAttemptReceiptOutcome,
  automergeUnconfirmedFailureDisposition,
  confirmAutomergeEffectSnapshot,
} from "../../dist/repair/automerge-effect.js";
import {
  ensureExactHeadMergeClaim,
  exactHeadMergeClaimBody,
} from "../../dist/repair/exact-head-merge-claim.js";

const headSha = "a".repeat(40);

test("automerge effect certification binds the merged REST snapshot to the reviewed head", () => {
  assert.deepEqual(
    confirmAutomergeEffectSnapshot(
      {
        pull: {
          head: { sha: headSha },
          merged_at: "2026-07-13T08:00:00Z",
          merge_commit_sha: "b".repeat(40),
        },
        view: {
          headRefOid: "c".repeat(40),
          isInMergeQueue: true,
        },
      },
      headSha,
    ),
    {
      mergedAt: "2026-07-13T08:00:00Z",
      mergeCommitSha: "b".repeat(40),
      pendingReason: "",
      block: "",
    },
  );
});

test("automerge effect certification uses exact-head GraphQL queue and auto-merge state", () => {
  const pull = { head: { sha: headSha }, merged_at: null, merge_commit_sha: null };
  const queued = confirmAutomergeEffectSnapshot(
    {
      pull,
      view: { headRefOid: headSha, isInMergeQueue: true, autoMergeRequest: null },
    },
    headSha,
  );
  assert.equal(queued.pendingReason, `reviewed head ${headSha} is pending in the merge queue`);
  assert.equal(automergeAttemptReceiptOutcome({ confirmation: queued }), "accepted");

  const autoMerge = confirmAutomergeEffectSnapshot(
    {
      pull,
      view: {
        headRefOid: headSha,
        isInMergeQueue: false,
        autoMergeRequest: { mergeMethod: "SQUASH" },
      },
    },
    headSha,
  );
  assert.equal(autoMerge.pendingReason, `reviewed head ${headSha} has auto-merge pending`);
  assert.equal(automergeAttemptReceiptOutcome({ confirmation: autoMerge }), "accepted");
});

test("automerge effect certification preserves uncertainty for conflicting head observations", () => {
  const confirmation = confirmAutomergeEffectSnapshot(
    {
      pull: { head: { sha: headSha }, merged_at: null },
      view: { headRefOid: "b".repeat(40), isInMergeQueue: true },
    },
    headSha,
  );
  assert.equal(
    confirmation.block,
    "pull request head changed before the automerge effect could be confirmed",
  );
  assert.equal(automergeAttemptReceiptOutcome({ confirmation }), "unknown");
});

test("transient unconfirmed merge responses remain waiting with unknown receipts", () => {
  const attempt = {
    command_result: {
      status: 1,
      stdout: "",
      stderr: "gh: HTTP 502: Bad Gateway",
      error: null,
    },
    command_error: null,
    confirmation: {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: "",
    },
  };
  assert.equal(automergeUnconfirmedFailureDisposition(attempt), "waiting");
  assert.equal(automergeAttemptReceiptOutcome(attempt), "unknown");
});

test("definitive unconfirmed merge rejection closes the mutation receipt", () => {
  const attempt = {
    command_result: {
      status: 1,
      stdout: "",
      stderr: "GraphQL: Pull Request is not mergeable (mergePullRequest)",
      error: null,
    },
    command_error: null,
    confirmation: {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: "",
    },
  };
  assert.equal(automergeUnconfirmedFailureDisposition(attempt), "blocked");
  assert.equal(automergeAttemptReceiptOutcome(attempt), "rejected");
});

test("fresh comment-router attempts reconcile a durable claim after an unknown merge response", () => {
  const comments: Record<string, any>[] = [];
  let claimCreates = 0;
  let mergeRequests = 0;
  const request = (runAttempt: number) => ({
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner: "comment_router",
    claimant: `comment_router:9001:${runAttempt}`,
    appId: 3306130,
    appSlug: "openclaw-clawsweeper",
  });
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      claimCreates += 1;
      const comment = {
        id: 1000 + claimCreates,
        body,
        performed_via_github_app: { id: 3306130, slug: "openclaw-clawsweeper" },
        user: { login: "openclaw-clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  const first = ensureExactHeadMergeClaim(request(1), io);
  if (first.status === "acquired") mergeRequests += 1;
  assert.equal(first.status, "acquired");

  const freshAttempt = ensureExactHeadMergeClaim(request(2), io);
  if (freshAttempt.status === "acquired") mergeRequests += 1;
  assert.equal(freshAttempt.status, "existing");
  assert.equal(claimCreates, 1);
  assert.equal(mergeRequests, 1);
});

test("exact-head merge claims fail closed on a trusted conflicting head", () => {
  const conflicting = {
    repository: "openclaw/openclaw",
    number: 42,
    headSha: "b".repeat(40),
    method: "squash" as const,
    owner: "post_flight",
    claimant: "post_flight:8001:1",
    appId: 3306130,
    appSlug: "openclaw-clawsweeper",
  };
  const comments = [
    {
      id: 1001,
      body: exactHeadMergeClaimBody(conflicting),
      performed_via_github_app: { id: 3306130, slug: "openclaw-clawsweeper" },
      user: { login: "openclaw-clawsweeper[bot]" },
    },
  ];
  const result = ensureExactHeadMergeClaim(
    {
      ...conflicting,
      headSha,
      owner: "apply_result",
      claimant: "apply_result:8002:1",
    },
    {
      listComments: () => comments,
      createComment: () => {
        throw new Error("must not create a claim after conflicting durable state");
      },
    },
  );
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /conflicting durable merge claim/);
});
