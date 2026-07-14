import assert from "node:assert/strict";
import test from "node:test";

import {
  automergeEffectDefinitelyAbsent,
  automergeAttemptReceiptOutcome,
  automergeUnconfirmedFailureDisposition,
  confirmAutomergeEffectSnapshot,
} from "../../dist/repair/automerge-effect.js";
import {
  ensureExactHeadMergeClaim,
  exactHeadMergeClaimBody,
  exactHeadMergeClaimOwnsUpdatedAt,
  exactHeadMergeClaimRecoveryDecision,
  exactHeadMergeClaimWorkflowRunEnv,
  inspectExactHeadMergeClaim,
  markExactHeadMergeClaimDispatched,
  rejectExactHeadMergeClaim,
  releaseExactHeadMergeClaim,
} from "../../dist/repair/exact-head-merge-claim.js";
import { createReviewedTimelineCursor } from "../../dist/repair/timeline-cursor.js";

const headSha = "a".repeat(40);
const mergeCommitSha = "b".repeat(40);
const squashCommitMessage = "fix: exact merge\n\nvalidated squash payload";
const squashCommitProof = {
  mergeCommitSha,
  commit: {
    sha: mergeCommitSha,
    parents: [{ sha: "c".repeat(40) }],
    commit: { message: squashCommitMessage },
  },
  expectedMessage: squashCommitMessage,
};

test("automerge effect certification binds the merged REST snapshot to the reviewed head", () => {
  const snapshot = {
    pull: {
      head: { sha: headSha },
      merged_at: "2026-07-13T08:00:00Z",
      merge_commit_sha: mergeCommitSha,
    },
    view: {
      headRefOid: "c".repeat(40),
      isInMergeQueue: true,
    },
  };
  assert.deepEqual(
    confirmAutomergeEffectSnapshot(snapshot, headSha, { squashCommit: squashCommitProof }),
    {
      mergedAt: "2026-07-13T08:00:00Z",
      mergeCommitSha,
      pendingReason: "",
      block: "",
    },
  );
  assert.deepEqual(confirmAutomergeEffectSnapshot(snapshot, headSha), {
    mergedAt: null,
    mergeCommitSha: null,
    pendingReason: "",
    block: "merged pull request method could not be proven as SQUASH",
  });
});

test("automerge effect certification rejects non-squash commit topology and payloads", () => {
  const snapshot = {
    pull: {
      head: { sha: headSha },
      merged_at: "2026-07-13T08:00:00Z",
      merge_commit_sha: mergeCommitSha,
    },
    view: {},
  };
  for (const squashCommit of [
    {
      ...squashCommitProof,
      commit: { ...squashCommitProof.commit, parents: [{ sha: headSha }, { sha: mergeCommitSha }] },
    },
    {
      ...squashCommitProof,
      commit: {
        ...squashCommitProof.commit,
        commit: { message: "fix: exact merge\n\nraced payload" },
      },
    },
  ]) {
    const confirmation = confirmAutomergeEffectSnapshot(snapshot, headSha, { squashCommit });
    assert.equal(confirmation.mergedAt, null);
    assert.match(confirmation.block, /squash-merge topology|dispatched squash payload/);
  }
});

test("automerge effect certification requires a squash method for queue and auto-merge state", () => {
  const pull = { head: { sha: headSha }, merged_at: null, merge_commit_sha: null };
  const unprovenQueue = confirmAutomergeEffectSnapshot(
    {
      pull,
      view: { headRefOid: headSha, isInMergeQueue: true, autoMergeRequest: null },
    },
    headSha,
  );
  assert.match(unprovenQueue.block, /does not prove the required SQUASH method/);
  assert.equal(automergeAttemptReceiptOutcome({ confirmation: unprovenQueue }), "unknown");

  for (const isInMergeQueue of [false, true]) {
    const autoMerge = confirmAutomergeEffectSnapshot(
      {
        pull,
        view: {
          headRefOid: headSha,
          isInMergeQueue,
          autoMergeRequest: { mergeMethod: "SQUASH" },
        },
      },
      headSha,
    );
    assert.match(
      autoMerge.pendingReason,
      isInMergeQueue ? /pending in the merge queue/ : /has auto-merge pending/,
    );
    assert.equal(automergeAttemptReceiptOutcome({ confirmation: autoMerge }), "accepted");
  }
});

test("automerge effect certification accepts REST-proven squash queue state", () => {
  const queued = confirmAutomergeEffectSnapshot(
    {
      pull: {
        head: { sha: headSha },
        merged_at: null,
        merge_commit_sha: null,
        auto_merge: { merge_method: "squash" },
      },
      view: {
        headRefOid: headSha,
        isInMergeQueue: true,
        autoMergeRequest: null,
      },
    },
    headSha,
  );
  assert.equal(queued.pendingReason, `reviewed head ${headSha} is pending in the merge queue`);
  assert.equal(automergeAttemptReceiptOutcome({ confirmation: queued }), "accepted");
});

test("automerge effect certification rejects non-squash and unproven auto-merge methods", () => {
  const pull = { head: { sha: headSha }, merged_at: null, merge_commit_sha: null };
  for (const autoMergeRequest of [
    { mergeMethod: "MERGE" },
    { mergeMethod: "REBASE" },
    { enabledAt: "2026-07-13T08:00:00Z" },
  ]) {
    const confirmation = confirmAutomergeEffectSnapshot(
      {
        pull,
        view: { headRefOid: headSha, isInMergeQueue: false, autoMergeRequest },
      },
      headSha,
    );
    assert.match(confirmation.block, /required SQUASH method|instead of SQUASH/);
    assert.equal(confirmation.pendingReason, "");
    assert.equal(automergeAttemptReceiptOutcome({ confirmation }), "unknown");
  }

  const restConfirmation = confirmAutomergeEffectSnapshot(
    {
      pull: { ...pull, auto_merge: { merge_method: "rebase" } },
      view: { headRefOid: headSha, isInMergeQueue: false, autoMergeRequest: null },
    },
    headSha,
  );
  assert.match(restConfirmation.block, /REBASE instead of SQUASH/);
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

test("automerge effect absence requires REST and GraphQL to agree no effect exists", () => {
  const emptySnapshot = {
    pull: { head: { sha: headSha }, merged_at: null, auto_merge: null },
    view: {
      headRefOid: headSha,
      mergedAt: null,
      state: "OPEN",
      isInMergeQueue: false,
      autoMergeRequest: null,
    },
  };
  assert.equal(automergeEffectDefinitelyAbsent(emptySnapshot, headSha), true);

  for (const snapshot of [
    {
      ...emptySnapshot,
      pull: { ...emptySnapshot.pull, auto_merge: { merge_method: "squash" } },
    },
    {
      ...emptySnapshot,
      view: {
        ...emptySnapshot.view,
        autoMergeRequest: { mergeMethod: "SQUASH" },
      },
    },
    {
      ...emptySnapshot,
      view: {
        ...emptySnapshot.view,
        isInMergeQueue: true,
        autoMergeRequest: { mergeMethod: "SQUASH" },
      },
    },
    {
      ...emptySnapshot,
      view: { ...emptySnapshot.view, mergedAt: "2026-07-13T08:00:00Z" },
    },
    {
      ...emptySnapshot,
      view: { ...emptySnapshot.view, state: "MERGED" },
    },
    {
      ...emptySnapshot,
      view: { ...emptySnapshot.view, headRefOid: "c".repeat(40) },
    },
    {
      ...emptySnapshot,
      view: { ...emptySnapshot.view, headRefOid: null },
    },
    {
      ...emptySnapshot,
      view: {
        ...emptySnapshot.view,
        headRefOid: null,
        autoMergeRequest: { mergeMethod: "SQUASH" },
      },
    },
  ]) {
    assert.equal(automergeEffectDefinitelyAbsent(snapshot, headSha), false);
  }
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

test("unrecognized unconfirmed merge failures remain ambiguous", () => {
  const attempt = {
    command_error: new Error("merge command bridge exited without a response"),
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
    appSlug: "clawsweeper",
  });
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      claimCreates += 1;
      const comment = {
        id: 1000 + claimCreates,
        body,
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
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

test("released exact-head merge claims can be reacquired by a fresh workflow attempt", () => {
  const comments: Record<string, any>[] = [];
  let nextId = 1001;
  const request = (runAttempt: number) => ({
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner: "post_flight",
    claimant: `post_flight:8001:${runAttempt}`,
    appId: 3306130,
    appSlug: "clawsweeper",
  });
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      const comment = {
        id: nextId++,
        body,
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  const first = ensureExactHeadMergeClaim(request(1), io);
  assert.equal(first.status, "acquired");
  if (first.status !== "acquired") return;
  assert.equal(releaseExactHeadMergeClaim(request(1), first.claimId, io).status, "released");
  assert.equal(inspectExactHeadMergeClaim(request(1), io.listComments).status, "released");

  const retry = ensureExactHeadMergeClaim(request(2), io);
  assert.equal(retry.status, "acquired");
  assert.equal(comments.length, 3);
});

test("dispatched exact-head merge claims require live effect absence before recovery", () => {
  const comments: Record<string, any>[] = [];
  let nextId = 1401;
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
        created_at: "2026-07-13T08:00:00Z",
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  const claim = ensureExactHeadMergeClaim(request(6901), io);
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") return;
  assert.equal(
    markExactHeadMergeClaimDispatched(request(6901), claim.claimId, squashCommitMessage, io).status,
    "dispatched",
  );
  assert.equal(
    markExactHeadMergeClaimDispatched(request(6901), claim.claimId, squashCommitMessage, io).status,
    "dispatched",
  );
  assert.equal(comments.length, 2);
  const inspected = inspectExactHeadMergeClaim(request(6901), io.listComments);
  assert.equal(inspected.status, "existing");
  if (inspected.status !== "existing") return;
  assert.equal(inspected.expectedSquashMessage, squashCommitMessage);
  assert.match(comments[1].body, /clawsweeper-exact-head-merge-dispatch:v2/);
  assert.equal(releaseExactHeadMergeClaim(request(6901), claim.claimId, io).status, "blocked");

  let recoveryCalls = 0;
  const retry = ensureExactHeadMergeClaim(request(6902), {
    ...io,
    recoverClaim: () => {
      recoveryCalls += 1;
      return { status: "recoverable" as const, reason: "terminal" };
    },
  });
  assert.equal(retry.status, "existing");
  assert.equal(retry.status === "existing" && retry.dispatched, true);
  assert.equal(recoveryCalls, 0);

  const recoveryOrder: string[] = [];
  const recovered = ensureExactHeadMergeClaim(request(6902), {
    ...io,
    dispatchedClaimEffectAbsent: () => {
      recoveryOrder.push("effect");
      return true;
    },
    recoverClaim: () => {
      recoveryOrder.push("terminal");
      recoveryCalls += 1;
      return { status: "recoverable" as const, reason: "terminal failure without effect" };
    },
  });
  assert.equal(recovered.status, "recovered");
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(recoveryOrder, ["terminal", "effect"]);
});

test("durable dispatch records distinguish claim-owned timestamp drift", () => {
  const comments: Record<string, any>[] = [];
  const request = {
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner: "apply_result",
    claimant: "apply_result:6991:1",
    appId: 3306130,
    appSlug: "clawsweeper",
  };
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      const comment = {
        id: 1451 + comments.length,
        body,
        created_at: comments.length === 0 ? "2026-07-13T08:01:00Z" : "2026-07-13T08:02:00Z",
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  const claim = ensureExactHeadMergeClaim(request, io);
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") return;
  assert.equal(
    markExactHeadMergeClaimDispatched(request, claim.claimId, squashCommitMessage, io).status,
    "dispatched",
  );
  const inspected = inspectExactHeadMergeClaim(request, io.listComments);
  assert.equal(inspected.status, "existing");
  if (inspected.status !== "existing") return;
  assert.equal(inspected.expectedSquashMessage, squashCommitMessage);
  assert.equal(inspected.lastClaimMutationId, 1452);
  assert.equal(inspected.lastClaimMutationAt, "2026-07-13T08:02:00.000Z");
  const timeline = comments.map((comment) => ({ ...comment, event: "commented" }));
  const reviewedTimelineCursor = createReviewedTimelineCursor([]);
  assert.equal(
    exactHeadMergeClaimOwnsUpdatedAt(
      inspected,
      reviewedTimelineCursor,
      "2026-07-13T08:02:00Z",
      timeline,
    ),
    true,
  );
  assert.equal(
    exactHeadMergeClaimOwnsUpdatedAt(
      inspected,
      reviewedTimelineCursor,
      "2026-07-13T08:02:02Z",
      timeline,
    ),
    false,
  );
  assert.equal(
    exactHeadMergeClaimOwnsUpdatedAt(
      inspected,
      reviewedTimelineCursor,
      "2026-07-13T08:02:02Z",
      timeline,
      { verifiedTargetContentUnchanged: true },
    ),
    true,
  );
  assert.equal(
    exactHeadMergeClaimOwnsUpdatedAt(
      inspected,
      reviewedTimelineCursor,
      "2026-07-13T08:02:02Z",
      [
        {
          id: 9998,
          event: "commented",
          created_at: "2026-07-13T08:00:30Z",
        },
        ...timeline,
      ],
      { verifiedTargetContentUnchanged: true },
    ),
    false,
  );
  assert.equal(
    exactHeadMergeClaimOwnsUpdatedAt(
      inspected,
      reviewedTimelineCursor,
      "2026-07-13T08:02:02Z",
      [
        ...timeline,
        {
          id: 9999,
          event: "labeled",
          created_at: "2026-07-13T08:02:00Z",
        },
      ],
      { verifiedTargetContentUnchanged: true },
    ),
    false,
  );
  assert.equal(
    exactHeadMergeClaimOwnsUpdatedAt(
      inspected,
      reviewedTimelineCursor,
      "2026-07-13T08:03:00Z",
      timeline,
      { verifiedTargetContentUnchanged: true },
    ),
    false,
  );
});

test("legacy v1 dispatch markers remain fail-closed for squash certification", () => {
  const comments: Record<string, any>[] = [];
  const request = {
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner: "comment_router",
    claimant: "comment_router:6992:1",
    appId: 3306130,
    appSlug: "clawsweeper",
  };
  const trustedComment = (id: number, body: string, createdAt: string) => ({
    id,
    body,
    created_at: createdAt,
    performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
    user: { login: "clawsweeper[bot]" },
  });
  comments.push(
    trustedComment(1461, exactHeadMergeClaimBody(request), "2026-07-13T08:01:00Z"),
    trustedComment(
      1462,
      [
        `<!-- clawsweeper-exact-head-merge-dispatch:v1 claim=1461 repo=openclaw%2Fopenclaw pr=42 head=${headSha} method=squash owner=comment_router claimant=comment_router%3A6992%3A1 -->`,
        "ClawSweeper crossed the exact-head squash merge dispatch boundary for `aaaaaaaaaaaa` under claim 1461. Later workflow attempts must reconcile GitHub state and must not replay the merge request.",
      ].join("\n"),
      "2026-07-13T08:02:00Z",
    ),
  );

  const inspected = inspectExactHeadMergeClaim(request, () => comments);
  assert.equal(inspected.status, "existing");
  if (inspected.status !== "existing") return;
  assert.equal(inspected.dispatched, true);
  assert.equal(inspected.expectedSquashMessage, null);
  assert.equal(
    confirmAutomergeEffectSnapshot(
      {
        pull: {
          head: { sha: headSha },
          merged_at: "2026-07-13T08:03:00Z",
          merge_commit_sha: mergeCommitSha,
        },
        view: {},
      },
      headSha,
    ).block,
    "merged pull request method could not be proven as SQUASH",
  );
});

test("malformed and oversized v2 dispatch payloads cannot become trusted state", () => {
  const request = {
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner: "apply_result",
    claimant: "apply_result:6993:1",
    appId: 3306130,
    appSlug: "clawsweeper",
  };
  const claim = {
    id: 1471,
    body: exactHeadMergeClaimBody(request),
    created_at: "2026-07-13T08:01:00Z",
    performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
    user: { login: "clawsweeper[bot]" },
  };
  for (const expectedPayload of ["%E0%A4%A", "x".repeat(50_001)]) {
    const dispatch = {
      ...claim,
      id: 1472,
      body: `<!-- clawsweeper-exact-head-merge-dispatch:v2 claim=1471 repo=openclaw%2Fopenclaw pr=42 head=${headSha} method=squash owner=apply_result claimant=apply_result%3A6993%3A1 expected=${expectedPayload} -->`,
      created_at: "2026-07-13T08:02:00Z",
    };
    const inspected = inspectExactHeadMergeClaim(request, () => [claim, dispatch]);
    assert.equal(inspected.status, "blocked");
    assert.match(inspected.reason, /malformed, mixed, or duplicated/);
  }

  const comments = [claim];
  assert.throws(
    () =>
      markExactHeadMergeClaimDispatched(request, claim.id, "x".repeat(50_001), {
        listComments: () => comments,
        createComment: (body) => {
          const comment = { ...claim, id: 1472, body };
          comments.push(comment);
          return comment;
        },
      }),
    /too large/,
  );
  assert.equal(comments.length, 1);
});

test("exact-head claim state rejects embedded and conflicting trusted markers", () => {
  const request = {
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner: "apply_result",
    claimant: "apply_result:6994:1",
    appId: 3306130,
    appSlug: "clawsweeper",
  };
  const trustedComment = (id: number, body: string, createdAt: string) => ({
    id,
    body,
    created_at: createdAt,
    performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
    user: { login: "clawsweeper[bot]" },
  });
  const embedded = trustedComment(
    1481,
    `quoted state follows\n${exactHeadMergeClaimBody(request)}`,
    "2026-07-13T08:01:00Z",
  );
  const embeddedInspection = inspectExactHeadMergeClaim(request, () => [embedded]);
  assert.equal(embeddedInspection.status, "blocked");
  assert.match(embeddedInspection.reason, /malformed, mixed, or duplicated/);

  const comments: Record<string, any>[] = [];
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      const comment = trustedComment(
        1482 + comments.length,
        body,
        `2026-07-13T08:0${comments.length + 1}:00Z`,
      );
      comments.push(comment);
      return comment;
    },
  };
  const claim = ensureExactHeadMergeClaim(request, io);
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") return;
  assert.equal(
    markExactHeadMergeClaimDispatched(request, claim.claimId, squashCommitMessage, io).status,
    "dispatched",
  );
  const firstDispatch = comments[1]!;
  comments.push({
    ...firstDispatch,
    id: firstDispatch.id + 1,
    created_at: "2026-07-13T08:03:00Z",
  });
  let inspected = inspectExactHeadMergeClaim(request, io.listComments);
  assert.equal(inspected.status, "existing");
  if (inspected.status !== "existing") return;
  assert.equal(inspected.lastClaimMutationId, firstDispatch.id + 1);
  assert.equal(inspected.lastClaimMutationAt, "2026-07-13T08:03:00.000Z");

  comments.push({
    ...firstDispatch,
    id: firstDispatch.id + 2,
    body: firstDispatch.body.replace(
      encodeURIComponent(squashCommitMessage),
      encodeURIComponent(`${squashCommitMessage}\nconflict`),
    ),
    created_at: "2026-07-13T08:04:00Z",
  });
  inspected = inspectExactHeadMergeClaim(request, io.listComments);
  assert.equal(inspected.status, "blocked");
  assert.match(inspected.reason, /dispatch payloads conflict/);
});

test("definitive dispatch rejection durably retires the exact-head claim", () => {
  const comments: Record<string, any>[] = [];
  let nextId = 1491;
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
        created_at: `2026-07-13T08:0${comments.length + 1}:00Z`,
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  const claim = ensureExactHeadMergeClaim(request(6995), io);
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") return;
  assert.equal(
    markExactHeadMergeClaimDispatched(request(6995), claim.claimId, squashCommitMessage, io).status,
    "dispatched",
  );
  assert.equal(rejectExactHeadMergeClaim(request(6995), claim.claimId, io).status, "rejected");
  assert.match(comments[2].body, /clawsweeper-exact-head-merge-rejection:v1/);
  assert.equal(inspectExactHeadMergeClaim(request(6995), io.listComments).status, "released");

  const reacquired = ensureExactHeadMergeClaim(request(6996), io);
  assert.equal(reacquired.status, "acquired");
  assert.equal(reacquired.claimId, 1494);
});

test("terminal stale claims are retired before a fresh workflow may reacquire", () => {
  const comments: Record<string, any>[] = [];
  let nextId = 1501;
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
        created_at: "2026-07-13T08:00:00Z",
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  assert.equal(ensureExactHeadMergeClaim(request(7001), io).status, "acquired");
  const recovered = ensureExactHeadMergeClaim(request(7002), {
    ...io,
    recoverClaim: () => ({
      status: "recoverable" as const,
      reason: "prior workflow attempt is terminal",
    }),
  });
  assert.equal(recovered.status, "recovered");
  assert.match(comments[1].body, /clawsweeper-exact-head-merge-recovery:v1 claim=1501/);
  assert.equal(inspectExactHeadMergeClaim(request(7002), io.listComments).status, "released");

  const reacquired = ensureExactHeadMergeClaim(request(7002), io);
  assert.equal(reacquired.status, "acquired");
  assert.equal(reacquired.claimId, 1503);
});

test("cross-lane recovery preserves the original claim owner", () => {
  const comments: Record<string, any>[] = [];
  let nextId = 1601;
  const request = (owner: string, runId: number) => ({
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner,
    claimant: `${owner}:${runId}:1`,
    appId: 3306130,
    appSlug: "clawsweeper",
  });
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      const comment = {
        id: nextId++,
        body,
        created_at: "2026-07-13T08:00:00Z",
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  assert.equal(ensureExactHeadMergeClaim(request("comment_router", 7101), io).status, "acquired");
  const recovered = ensureExactHeadMergeClaim(request("post_flight", 7102), {
    ...io,
    recoverClaim: (candidate) => {
      assert.equal(candidate.owner, "comment_router");
      return { status: "recoverable" as const, reason: "prior workflow attempt is terminal" };
    },
  });
  assert.equal(recovered.status, "recovered");
  assert.match(comments[1].body, /owner=comment_router/);
  assert.match(comments[1].body, /recoverer=post_flight%3A7102%3A1/);
  assert.equal(
    inspectExactHeadMergeClaim(request("post_flight", 7102), io.listComments).status,
    "released",
  );
  assert.equal(ensureExactHeadMergeClaim(request("post_flight", 7102), io).status, "acquired");
});

test("claim recovery requires an aged claim and the exact workflow attempt to be terminal", () => {
  const candidate = {
    claimId: 1501,
    owner: "comment_router",
    claimant: "comment_router:7001:2",
    createdAt: "2026-07-13T08:00:00Z",
    dispatchedAt: "2026-07-13T08:00:00Z",
  };
  const env = {
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ID: "7002",
    GITHUB_RUN_ATTEMPT: "1",
  };
  let workflowReads = 0;
  assert.equal(
    exactHeadMergeClaimRecoveryDecision(
      { ...candidate, dispatched: true },
      () => {
        workflowReads += 1;
        return { id: 7001, run_attempt: 2, status: "completed", conclusion: "failure" };
      },
      env,
      Date.parse("2026-07-13T08:10:00Z"),
    ).status,
    "recoverable",
  );
  assert.equal(workflowReads, 1);
  assert.equal(
    exactHeadMergeClaimRecoveryDecision(
      { ...candidate, dispatched: true },
      () => ({ id: 7001, run_attempt: 2, status: "completed", conclusion: "success" }),
      env,
      Date.parse("2026-07-13T08:10:00Z"),
    ).status,
    "recoverable",
  );
  assert.equal(
    exactHeadMergeClaimRecoveryDecision(
      candidate,
      () => ({ id: 7001, run_attempt: 2, status: "completed" }),
      env,
      Date.parse("2026-07-13T08:10:00Z"),
    ).status,
    "recoverable",
  );
  assert.equal(
    exactHeadMergeClaimRecoveryDecision(
      candidate,
      () => ({ id: 7001, run_attempt: 2, status: "in_progress" }),
      env,
      Date.parse("2026-07-13T08:10:00Z"),
    ).status,
    "active",
  );
  assert.equal(
    exactHeadMergeClaimRecoveryDecision(
      candidate,
      () => ({ id: 7001, run_attempt: 2, status: "completed" }),
      env,
      Date.parse("2026-07-13T08:01:00Z"),
    ).status,
    "active",
  );
});

test("claim recovery reads central workflow state with the central token", () => {
  assert.deepEqual(
    exactHeadMergeClaimWorkflowRunEnv({
      CLAWSWEEPER_WORKFLOW_GH_TOKEN: "central-token",
      GH_TOKEN: "target-token",
      GITHUB_TOKEN: "target-token",
    }),
    {
      CLAWSWEEPER_WORKFLOW_GH_TOKEN: "central-token",
      GH_TOKEN: "central-token",
      GITHUB_TOKEN: "central-token",
    },
  );
  assert.throws(
    () => exactHeadMergeClaimWorkflowRunEnv({ GH_TOKEN: "target-token" }),
    /central workflow read token is required/,
  );
});

test("an active claim for an older head does not block the superseding head", () => {
  const comments: Record<string, any>[] = [];
  let nextId = 2001;
  const request = (candidateHead: string, runAttempt: number) => ({
    repository: "openclaw/openclaw",
    number: 42,
    headSha: candidateHead,
    method: "squash" as const,
    owner: "apply_result",
    claimant: `apply_result:8002:${runAttempt}`,
    appId: 3306130,
    appSlug: "clawsweeper",
  });
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      const comment = {
        id: nextId++,
        body,
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  assert.equal(ensureExactHeadMergeClaim(request("b".repeat(40), 1), io).status, "acquired");
  assert.equal(ensureExactHeadMergeClaim(request(headSha, 2), io).status, "acquired");
  assert.equal(comments.length, 2);
});

test("trusted claim markers for a different pull request still fail closed", () => {
  const request = {
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner: "apply_result",
    claimant: "apply_result:8002:1",
    appId: 3306130,
    appSlug: "clawsweeper",
  };
  const comments = [
    {
      id: 2501,
      body: exactHeadMergeClaimBody({ ...request, number: 43 }),
      performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
      user: { login: "clawsweeper[bot]" },
    },
  ];
  const result = ensureExactHeadMergeClaim(request, {
    listComments: () => comments,
    createComment: () => {
      throw new Error("must not create after conflicting durable state");
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /conflicting durable merge claim/);
});

test("a release marker retires the raced claim generation but not later claims", () => {
  const request = {
    repository: "openclaw/openclaw",
    number: 42,
    headSha,
    method: "squash" as const,
    owner: "post_flight",
    claimant: "post_flight:8003:1",
    appId: 3306130,
    appSlug: "clawsweeper",
  };
  const competing = { ...request, claimant: "post_flight:8004:1" };
  const comments: Record<string, any>[] = [
    {
      id: 3001,
      body: exactHeadMergeClaimBody(request),
      performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
      user: { login: "clawsweeper[bot]" },
    },
    {
      id: 3002,
      body: exactHeadMergeClaimBody(competing),
      performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
      user: { login: "clawsweeper[bot]" },
    },
  ];
  let nextId = 3003;
  const io = {
    listComments: () => comments,
    createComment: (body: string) => {
      const comment = {
        id: nextId++,
        body,
        performed_via_github_app: { id: 3306130, slug: "clawsweeper" },
        user: { login: "clawsweeper[bot]" },
      };
      comments.push(comment);
      return comment;
    },
  };

  assert.equal(releaseExactHeadMergeClaim(request, 3001, io).status, "released");
  assert.equal(inspectExactHeadMergeClaim(request, io.listComments).status, "released");
  const retry = ensureExactHeadMergeClaim({ ...request, claimant: "post_flight:8005:1" }, io);
  assert.equal(retry.status, "acquired");
  assert.equal(retry.claimId, 3004);
});
