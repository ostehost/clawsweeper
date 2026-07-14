import type { LooseRecord } from "./json-types.js";

export function restPullRequestMergeConfirmed(pull: LooseRecord): boolean {
  return (
    String(pull?.state ?? "").toLowerCase() === "closed" &&
    typeof pull?.merged_at === "string" &&
    pull.merged_at.trim().length > 0
  );
}

export function graphqlPullRequestMergeConfirmed(view: LooseRecord): boolean {
  return (
    String(view?.state ?? "").toUpperCase() === "MERGED" &&
    typeof view?.mergedAt === "string" &&
    view.mergedAt.trim().length > 0
  );
}

export function pullRequestMainBaseBlock(pull: LooseRecord, view: LooseRecord): string {
  const restBase = pull?.base?.ref;
  const graphqlBase = view?.baseRefName;
  return restBase === "main" && graphqlBase === "main" ? "" : "pull request base is not main";
}

export type AlreadyMergedPullRequestConfirmation =
  | {
      status: "waiting" | "blocked" | "not_merged";
      reason: string;
    }
  | {
      status: "executed";
      reason: string;
      mergedAt: string;
      mergeCommitSha: string;
      headSha: string;
    };

export function confirmAlreadyMergedPullRequest({
  expectedHeadSha,
  pull,
  view,
}: {
  expectedHeadSha: unknown;
  pull: LooseRecord;
  view: LooseRecord;
}): AlreadyMergedPullRequestConfirmation | null {
  const restHasMergeSignal =
    typeof pull?.merged_at === "string" && pull.merged_at.trim().length > 0;
  const graphqlHasMergeSignal =
    String(view?.state ?? "").toUpperCase() === "MERGED" ||
    (typeof view?.mergedAt === "string" && view.mergedAt.trim().length > 0);

  const baseBlock = pullRequestMainBaseBlock(pull, view);
  if (baseBlock) return { status: "blocked", reason: baseBlock };

  const expected = String(expectedHeadSha ?? "")
    .trim()
    .toLowerCase();
  const restHead = String(pull?.head?.sha ?? "")
    .trim()
    .toLowerCase();
  const graphqlHead = String(view?.headRefOid ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    return {
      status: "blocked",
      reason: "merge confirmation requires the durable reviewed head SHA",
    };
  }
  if (restHead !== expected || graphqlHead !== expected) {
    return {
      status: "blocked",
      reason: "pull request head does not match the durable reviewed head SHA",
    };
  }

  if (!restHasMergeSignal && !graphqlHasMergeSignal) {
    const restState = String(pull?.state ?? "").toUpperCase();
    const graphqlState = String(view?.state ?? "").toUpperCase();
    if (restState === "OPEN" && graphqlState === "OPEN") return null;
    if (restState === "CLOSED" && graphqlState === "CLOSED") {
      return {
        status: "not_merged",
        reason: "pull request closed without a confirmed merge",
      };
    }
    if (["OPEN", "CLOSED"].includes(restState) && ["OPEN", "CLOSED"].includes(graphqlState)) {
      return {
        status: "waiting",
        reason: "waiting for GitHub pull request state views to converge",
      };
    }
    return {
      status: "blocked",
      reason: "GitHub pull request views returned an unknown unmerged state",
    };
  }

  if (!restPullRequestMergeConfirmed(pull) || !graphqlPullRequestMergeConfirmed(view)) {
    return {
      status: "waiting",
      reason: "waiting for both GitHub pull request views to confirm the previous merge",
    };
  }

  const restCommit = String(pull?.merge_commit_sha ?? "")
    .trim()
    .toLowerCase();
  const graphqlCommit = String(view?.mergeCommit?.oid ?? "")
    .trim()
    .toLowerCase();
  if (!restCommit || !graphqlCommit) {
    return {
      status: "waiting",
      reason: "waiting for both GitHub pull request views to confirm the merge commit SHA",
    };
  }
  if (!/^[0-9a-f]{40}$/.test(restCommit) || !/^[0-9a-f]{40}$/.test(graphqlCommit)) {
    return {
      status: "blocked",
      reason: "GitHub pull request views returned an invalid merge commit SHA",
    };
  }
  if (restCommit !== graphqlCommit) {
    return {
      status: "blocked",
      reason: "GitHub pull request views disagree on the merge commit SHA",
    };
  }

  return {
    status: "executed",
    reason: "pull request is confirmed merged after the recorded ClawSweeper merge request",
    mergedAt: String(view.mergedAt ?? pull.merged_at),
    mergeCommitSha: graphqlCommit,
    headSha: expected,
  };
}
