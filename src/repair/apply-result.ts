#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { stableJson } from "../stable-json.js";
import {
  assertAllowedOwner,
  hasDeterministicSecuritySignal,
  parseArgs,
  parseJob,
  repoRoot,
  validateJob,
} from "./lib.js";
import { defaultCloseComment, externalMessageProvenance } from "./external-messages.js";
import {
  ghErrorText,
  githubLimitedPagePath,
  ghJson as ghJsonOnce,
  ghJsonWithRetry as ghJson,
  ghPagedLimitWithRetry as ghPagedLimit,
  ghPagedWithRetry as ghPaged,
  ghText,
  ghTextWithRetry as ghWithRetry,
} from "./github-cli.js";
import { issueNumberFromRef } from "./github-ref.js";
import { ghRetryKind, ghRetryWaitMs, isLockedConversationCommentError } from "../github-retry.js";
import { lockedConversationSkip, lockedConversationSkipIfLocked } from "./apply-locks.js";
import {
  CLAWSWEEPER_LABEL,
  CLAWSWEEPER_LABEL_COLOR,
  CLAWSWEEPER_LABEL_DESCRIPTION,
} from "./constants.js";
import {
  buildRepairSquashMergeMessage,
  writeRepairSquashMergeBody,
} from "./repair-merge-message.js";
import {
  automergeEffectDefinitelyAbsent,
  automergeUnconfirmedFailureDisposition,
  expectedSquashCommitMessage,
  squashAutomergeMethodBlock,
  squashMergedMethodBlock,
  squashMergeQueueMethodBlock,
  type SquashMergeCommitProof,
} from "./automerge-effect.js";
import {
  confirmAlreadyMergedPullRequest,
  graphqlPullRequestMergeConfirmed,
  pullRequestMainBaseBlock,
  restPullRequestMergeConfirmed,
} from "./merge-confirmation.js";
import { runtimeStrictBaseBindingBlock } from "./strict-base-binding.js";
import {
  ensureExactHeadMergeClaim,
  exactHeadMergeClaimIdentity,
  exactHeadMergeClaimRecoveryDecision,
  exactHeadMergeClaimWorkflowRunEnv,
  exactHeadMergeClaimant,
  exactHeadMergeClaimOwnsUpdatedAt,
  exactHeadMergeUpdatedAtMatches,
  inspectExactHeadMergeClaim,
  isTrustedExactHeadMergeClaimComment,
  isTrustedExactHeadMergeClaimDispatchComment,
  isTrustedExactHeadMergeClaimRejectionComment,
  isTrustedExactHeadMergeClaimRecoveryComment,
  isTrustedExactHeadMergeClaimReleaseComment,
  markExactHeadMergeClaimDispatched,
  rejectExactHeadMergeClaim,
  releaseExactHeadMergeClaim,
  type ExactHeadMergeClaimInspection,
  type ExactHeadMergeClaimRequest,
} from "./exact-head-merge-claim.js";
import { MAX_REVIEWED_TIMELINE_EVENTS, reviewedTimelineTail } from "./timeline-cursor.js";
import {
  recordRepairMutationObservedSafely,
  repairSourceRevision,
  runRepairMutation,
  type RepairLifecycleInput,
  type RepairMutationOptions,
} from "./repair-action-ledger.js";
import { sleepMs } from "./timing.js";
import {
  compactPrCloseCoverageProofComment,
  compactPrCloseCoverageProofText,
  prCloseCoverageProofCandidateCanClose,
  prCloseCoverageProofCloseDecision,
  runPrCloseCoverageProofModel,
  type PrCloseCoverageProofModelResult,
  type PrCloseCoverageProofPullRequestView,
} from "../pr-close-coverage-proof.js";

const MAINTAINER_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const CLOSE_ACTIONS = new Set([
  "close",
  "close_duplicate",
  "close_superseded",
  "close_fixed_by_candidate",
  "close_low_signal",
  "post_merge_close",
]);
const MERGE_ACTIONS = new Set(["merge_candidate", "merge_canonical"]);
const CLOSE_CLASSIFICATIONS = new Set([
  "duplicate",
  "superseded",
  "fixed_by_candidate",
  "low_signal",
]);
const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const CLEAN_MERGE_STATES = new Set(["CLEAN"]);
// A covering PR may need a base update, but actual merge actions remain CLEAN-only.
const VIABLE_COVERING_PR_MERGE_STATES = new Set(["CLEAN", "BEHIND"]);
const PR_CLOSE_COVERAGE_PROOF_COMMENT_LIMIT = 50;
const GITHUB_MAX_PAGE_SIZE = 100;
const COMMENT_PROPAGATED_ISSUE_FIELDS = new Set(["comments", "updated_at", "updatedAt"]);
const CLAWSWEEPER_COMMAND_ONLY_PATTERN = /^@clawsweeper\s+(?:re-review|re-run|review)\s*$/i;
const CLAWSWEEPER_BOT_AUTHORS = new Set(
  [
    "clawsweeper",
    "clawsweeper[bot]",
    "openclaw-clawsweeper[bot]",
    process.env.CLAWSWEEPER_COMMENT_AUTHOR_LOGIN,
  ].filter((login): login is string => typeof login === "string" && login.length > 0),
);

type PrCloseCoverageProofValidation =
  | {
      status: "covered";
      coveringRef: JsonValue;
      coveringUpdatedAt: string | null;
      proof: PrCloseCoverageProofModelResult;
    }
  | {
      status: "blocked";
      reason: string;
      requeue_required?: true;
      pr_close_coverage_proof?: PrCloseCoverageProofModelResult;
    }
  | null;

type PrCloseCoverageProofBlock = {
  reason: string;
  requeue_required?: true;
};

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const resultPathArg = args._[1];
const latest = Boolean(args.latest);
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_APPLY_DRY_RUN === "1");
const allowMissingUpdatedAt = Boolean(args["allow-missing-updated-at"]);
const reportPathArg = args["report"];

if (!jobPath) {
  console.error(
    "usage: node scripts/apply-result.ts <job.md> [result.json] [--latest] [--dry-run]",
  );
  process.exit(2);
}
if (!resultPathArg && !latest) {
  console.error("result path is required unless --latest is set");
  process.exit(2);
}

const job = parseJob(jobPath);
const errors = validateJob(job);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

assertAllowedOwner(job.frontmatter.repo, process.env.CLAWSWEEPER_ALLOWED_OWNER);

if (!["execute", "autonomous"].includes(job.frontmatter.mode)) {
  throw new Error("refusing apply: job frontmatter mode is not execute or autonomous");
}
if (process.env.CLAWSWEEPER_ALLOW_EXECUTE !== "1") {
  throw new Error("refusing apply: CLAWSWEEPER_ALLOW_EXECUTE must be 1");
}
const resultPath = resultPathArg ? path.resolve(resultPathArg) : findLatestResultPath();
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
if (result.repo !== job.frontmatter.repo) {
  throw new Error(`result repo ${result.repo} does not match job repo ${job.frontmatter.repo}`);
}
if (result.cluster_id !== job.frontmatter.cluster_id) {
  throw new Error(
    `result cluster ${result.cluster_id} does not match job cluster ${job.frontmatter.cluster_id}`,
  );
}
if (!["execute", "autonomous"].includes(result.mode)) {
  throw new Error(`refusing apply: result mode is ${result.mode}`);
}
if (result.mode !== job.frontmatter.mode) {
  throw new Error(
    `refusing apply: result mode ${result.mode} does not match job mode ${job.frontmatter.mode}`,
  );
}

const report: LooseRecord = {
  repo: result.repo,
  cluster_id: result.cluster_id,
  dry_run: dryRun,
  result_path: path.relative(repoRoot(), resultPath),
  applied_at: new Date().toISOString(),
  actions: [],
};

const allowedRefs = new Set(
  [
    ...(job.frontmatter.cluster_refs ?? []),
    ...(job.frontmatter.canonical ?? []),
    ...(job.frontmatter.candidates ?? []),
  ]
    .map((ref: JsonValue) => normalizeIssueRef(ref, result.repo))
    .filter(Boolean),
);
const maintainerCloseRefs = new Set(
  (job.frontmatter.maintainer_close_refs ?? [])
    .map((ref: JsonValue) => normalizeIssueRef(ref, result.repo))
    .filter(Boolean),
);

for (const action of result.actions ?? []) {
  if (!isApplicatorAction(action)) continue;
  report.actions.push(applyAction({ job, result, action, dryRun, allowMissingUpdatedAt }));
}

const reportPath =
  typeof reportPathArg === "string"
    ? path.resolve(reportPathArg)
    : path.join(path.dirname(resultPath), "apply-report.json");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function findLatestResultPath() {
  const runsRoot = path.join(repoRoot(), ".clawsweeper-repair", "runs");
  if (!fs.existsSync(runsRoot)) {
    throw new Error("no run directory exists");
  }
  const candidates: LooseRecord[] = [];
  for (const runName of fs.readdirSync(runsRoot)) {
    const candidate = path.join(runsRoot, runName, "result.json");
    if (!fs.existsSync(candidate)) continue;
    candidates.push({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
  }
  candidates.sort((left: JsonValue, right: JsonValue) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) throw new Error("no result.json files found");
  return candidates[0].path;
}

function readFixExecutionReport(_result?: JsonValue) {
  const reportPath = path.join(path.dirname(resultPath), "fix-execution-report.json");
  if (!fs.existsSync(reportPath)) return null;
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

function applyAction({ job, result, action, dryRun, allowMissingUpdatedAt }: LooseRecord) {
  const target = normalizeIssueRef(action.target, result.repo);
  const actionName = String(action.action ?? "");
  const classification = normalizeClassification(action);
  const canonical = normalizeIssueRef(action.canonical ?? action.duplicate_of, result.repo);
  const candidateFix = normalizeIssueRef(
    action.candidate_fix ?? action.fixed_by ?? action.fix_candidate,
    result.repo,
  );
  const idempotencyKey =
    typeof action.idempotency_key === "string" && action.idempotency_key.trim()
      ? action.idempotency_key.trim()
      : defaultIdempotencyKey(result.cluster_id, target, actionName, classification);
  const base = {
    target: `#${target}`,
    action: actionName,
    classification,
    canonical: canonical ? `#${canonical}` : undefined,
    candidate_fix: candidateFix ? `#${candidateFix}` : undefined,
    idempotency_key: idempotencyKey,
  };

  if (!target) return { ...base, status: "failed", reason: "target must look like #123" };
  if (action.status !== "planned") {
    return {
      ...base,
      status: "skipped",
      source_status: action.status ?? null,
      reason: action.reason ?? `action status is ${action.status}`,
    };
  }
  if (MERGE_ACTIONS.has(actionName)) {
    return applyMergeAction({ job, result, action, dryRun, allowMissingUpdatedAt, target, base });
  }
  if (!CLOSE_ACTIONS.has(actionName)) {
    return { ...base, status: "skipped", reason: "action is not an applicator action" };
  }

  return applyCloseAction({
    job,
    result,
    action,
    dryRun,
    allowMissingUpdatedAt,
    target,
    base,
    actionName,
    classification,
    canonical,
    candidateFix,
    idempotencyKey,
  });
}

function applyCloseAction({
  job,
  result,
  action,
  dryRun,
  allowMissingUpdatedAt,
  target,
  base,
  actionName,
  classification,
  canonical,
  candidateFix,
  idempotencyKey,
}: LooseRecord) {
  const closePolicyBlock = validateClosePolicy({ job, actionName });
  if (closePolicyBlock) return { ...base, status: "blocked", reason: closePolicyBlock };
  const fixFirstBlock = validateFixFirstClose({
    job,
    result,
    actionName,
    classification,
    candidateFix,
  });
  if (fixFirstBlock) return { ...base, status: "blocked", reason: fixFirstBlock };
  if (!CLOSE_CLASSIFICATIONS.has(classification)) {
    return {
      ...base,
      status: "blocked",
      reason:
        "auto-closure requires duplicate, superseded, fixed_by_candidate, or low_signal classification",
    };
  }
  if (actionName === "post_merge_close" && job.frontmatter.allow_post_merge_close !== true) {
    return {
      ...base,
      status: "blocked",
      reason: "post-merge close requires allow_post_merge_close: true",
    };
  }
  if (!job.frontmatter.candidates.map(normalizeIssueRef).includes(target)) {
    return { ...base, status: "blocked", reason: "target is not listed in job candidates" };
  }
  if (classification === "low_signal" || actionName === "close_low_signal") {
    const lowSignalBlock = validateLowSignalIntent({ job, action, actionName, classification });
    if (lowSignalBlock) return { ...base, status: "blocked", reason: lowSignalBlock };
  }
  const explicitSupersededByCandidate =
    actionName === "close_superseded" &&
    classification === "superseded" &&
    !canonical &&
    candidateFix &&
    maintainerCloseRefs.has(target);
  if (
    (classification === "duplicate" || classification === "superseded") &&
    !canonical &&
    !explicitSupersededByCandidate
  ) {
    return { ...base, status: "blocked", reason: "closure requires canonical or duplicate_of" };
  }
  const isPostMergeFixedClose =
    actionName === "post_merge_close" && classification === "fixed_by_candidate";
  if (canonical && !allowedRefs.has(canonical) && !isPostMergeFixedClose) {
    return { ...base, status: "blocked", reason: "canonical is not listed in job refs" };
  }
  if (classification === "fixed_by_candidate" && !candidateFix) {
    return { ...base, status: "blocked", reason: "closure requires candidate_fix" };
  }
  if (candidateFix && !allowedRefs.has(candidateFix) && !isPostMergeFixedClose) {
    return { ...base, status: "blocked", reason: "candidate fix is not listed in job refs" };
  }
  if (actionName === "post_merge_close" || explicitSupersededByCandidate) {
    const candidateBlock = validateMergedCandidateFix(result.repo, candidateFix);
    if (candidateBlock) return { ...base, status: "blocked", reason: candidateBlock };
  }
  if (canonical === target || candidateFix === target) {
    return { ...base, status: "blocked", reason: "target cannot close against itself" };
  }
  const replacementCloseoutBlock = validateReplacementCloseout({ result, actionName, target });
  if (replacementCloseoutBlock)
    return { ...base, status: "blocked", reason: replacementCloseoutBlock };

  let live = fetchIssue(result.repo, target);
  const kind = live.pull_request ? "pull_request" : "issue";
  const authorAssociation = normalizeAuthorAssociation(live.author_association);
  if (hasSecuritySignal(live)) {
    return {
      ...base,
      status: "blocked",
      reason: "security-sensitive target requires central security triage",
      live_state: live.state,
    };
  }
  if (MAINTAINER_AUTHOR_ASSOCIATIONS.has(authorAssociation) && !maintainerCloseRefs.has(target)) {
    return {
      ...base,
      status: "blocked",
      reason: `target author association is ${authorAssociation}`,
      live_state: live.state,
    };
  }
  if (classification === "low_signal") {
    const lowSignalBlock = validateLowSignalLiveState(result.repo, target, live, kind);
    if (lowSignalBlock) {
      return {
        ...base,
        status: "blocked",
        reason: lowSignalBlock,
        live_state: live.state,
        live_updated_at: live.updated_at,
      };
    }
  }

  const expectedUpdatedAt = action.target_updated_at ?? action.live_updated_at;
  if (!expectedUpdatedAt && !allowMissingUpdatedAt) {
    return {
      ...base,
      status: "blocked",
      reason: "missing target_updated_at; rerun the worker against live GitHub state",
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  if (expectedUpdatedAt && expectedUpdatedAt !== live.updated_at) {
    return {
      ...base,
      status: "blocked",
      reason: "target changed since worker review",
      expected_updated_at: expectedUpdatedAt,
      live_updated_at: live.updated_at,
      live_state: live.state,
    };
  }

  const comment = renderCloseComment({ action, classification, result, target, live });
  const marker = idempotencyMarker(result.cluster_id, target, idempotencyKey);
  const body = comment.includes(marker) ? comment : `${comment.trim()}\n\n${marker}`;
  const existingComment = findExistingComment(result.repo, target, marker, body);

  if (live.state !== "open") {
    return {
      ...base,
      status: existingComment ? "executed" : "skipped",
      reason: existingComment
        ? "already closed with matching clawsweeper-repair comment"
        : "already closed",
      live_state: live.state,
    };
  }
  const lockedSkip = lockedConversationSkipIfLocked(base, live);
  if (lockedSkip) return lockedSkip;

  const proofValidation = validatePrCloseCoverageProof({
    result,
    action,
    actionName,
    target,
    live,
    canonical,
    candidateFix,
    classification,
  });
  if (proofValidation?.status === "blocked") {
    return {
      ...base,
      ...proofValidation,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  live = fetchIssue(result.repo, target);
  if (live.state !== "open") {
    return {
      ...base,
      status: existingComment ? "executed" : "skipped",
      reason: existingComment
        ? "already closed with matching clawsweeper-repair comment"
        : "already closed",
      live_state: live.state,
    };
  }
  if (expectedUpdatedAt && expectedUpdatedAt !== live.updated_at) {
    return {
      ...base,
      status: "blocked",
      reason: "target changed since worker review",
      expected_updated_at: expectedUpdatedAt,
      live_updated_at: live.updated_at,
      live_state: live.state,
    };
  }
  if (proofValidation?.status === "covered") {
    const postProofCoveringFreshnessBlock = validatePrCloseCoverageCoveringFreshness({
      result,
      coveringRef: proofValidation.coveringRef,
      coveringUpdatedAt: proofValidation.coveringUpdatedAt,
    });
    if (postProofCoveringFreshnessBlock) {
      return {
        ...base,
        status: "blocked",
        reason: postProofCoveringFreshnessBlock,
        requeue_required: true,
        live_state: live.state,
        live_updated_at: live.updated_at,
      };
    }
  }
  const postProofCoveringSafetyBlock = validatePrCloseCoverageCoveringRefSafety({
    result,
    actionName,
    target,
    live,
    canonical,
    candidateFix,
    classification,
  });
  if (postProofCoveringSafetyBlock) {
    return {
      ...base,
      status: "blocked",
      ...postProofCoveringSafetyBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }

  if (dryRun) {
    return {
      ...base,
      status: "planned",
      reason: "dry run",
      live_state: live.state,
      live_updated_at: live.updated_at,
      ...prCloseCoverageProofActionReport(proofValidation),
      comment,
    };
  }

  try {
    if (!existingComment) {
      postIssueComment(result.repo, target, kind, idempotencyKey, body);
    }
    closeIssueOrPullRequest(result.repo, target, kind, classification, idempotencyKey);
  } catch (error) {
    if (isLockedConversationCommentError(error)) {
      return lockedConversationSkip(base, live, { terminalWriteError: true });
    }
    throw error;
  }

  return {
    ...base,
    status: "executed",
    reason: closeReasonText(classification),
    live_state: "closed",
    live_updated_at: live.updated_at,
    ...prCloseCoverageProofActionReport(proofValidation),
  };
}

function prCloseCoverageProofActionReport(proofValidation: PrCloseCoverageProofValidation): {
  pr_close_coverage_proof?: PrCloseCoverageProofModelResult;
} {
  return proofValidation?.status === "covered" && proofValidation.proof
    ? { pr_close_coverage_proof: proofValidation.proof }
    : {};
}

function applyMergeAction({
  job,
  result,
  action,
  dryRun,
  allowMissingUpdatedAt,
  target,
  base,
}: LooseRecord) {
  const policyBlock = validateMergePolicy({ job, action });
  if (policyBlock) return { ...base, status: "blocked", reason: policyBlock };
  if (!allowedRefs.has(target)) {
    return { ...base, status: "blocked", reason: "merge target is not listed in job refs" };
  }

  if (action.target_kind !== "pull_request") {
    return { ...base, status: "blocked", reason: "merge action requires pull_request target_kind" };
  }

  const live = fetchIssue(result.repo, target);
  if (!live.pull_request) {
    return {
      ...base,
      status: "blocked",
      reason: "merge target is not a pull request",
      live_state: live.state,
    };
  }
  if (hasSecuritySignal(live)) {
    return {
      ...base,
      status: "blocked",
      reason: "security-sensitive target requires central security triage",
      live_state: live.state,
    };
  }

  const pullRequest = fetchPullRequest(result.repo, target);
  const view = fetchPullRequestView(result.repo, target);
  const authorizedHeadSha = String(pullRequest.head?.sha ?? "");
  const mergeEnabled = process.env.CLAWSWEEPER_ALLOW_MERGE === "1" && !dryRun;
  const preliminaryClaim: ExactHeadMergeClaimInspection =
    mergeEnabled && isFullCommitSha(authorizedHeadSha)
      ? inspectApplyMergeClaim(result.repo, target, authorizedHeadSha)
      : { status: "absent", reason: "", claimId: null };
  if (preliminaryClaim.status === "blocked" || preliminaryClaim.status === "unknown") {
    return {
      ...base,
      status: "blocked",
      reason: preliminaryClaim.reason,
      live_state: live.state,
      live_updated_at: live.updated_at,
      merge_method: "squash",
      ...(preliminaryClaim.status === "unknown" ? { requeue_required: true } : {}),
    };
  }
  const expectedUpdatedAt = action.target_updated_at ?? action.live_updated_at;
  const expectedTimelineCursor = action.target_timeline_cursor;
  if (!expectedUpdatedAt && !allowMissingUpdatedAt) {
    return {
      ...base,
      status: "blocked",
      reason: "missing target_updated_at; rerun the worker against live GitHub state",
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  if (!expectedTimelineCursor) {
    return {
      ...base,
      status: "blocked",
      reason: "missing target_timeline_cursor; rerun the worker against live GitHub state",
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  let existingSquashCommitProof: SquashMergeCommitProof | undefined;
  if (
    preliminaryClaim.status === "existing" &&
    preliminaryClaim.dispatched &&
    preliminaryClaim.expectedSquashMessage &&
    pullRequest.merged_at
  ) {
    try {
      existingSquashCommitProof = fetchSquashMergeCommitProof(
        result.repo,
        pullRequest,
        preliminaryClaim.expectedSquashMessage,
      );
    } catch (error) {
      return {
        ...base,
        status: "blocked",
        reason: `durably claimed merge proof could not be read: ${ghErrorText(error)}`,
        live_state: live.state,
        live_updated_at: live.updated_at,
        merge_method: "squash",
        requeue_required: true,
      };
    }
  }
  const existingMerge = confirmExactMergeSnapshot(pullRequest, view, authorizedHeadSha, {
    ...(preliminaryClaim.status === "existing" && preliminaryClaim.dispatched
      ? { requireSquashMethod: true }
      : {}),
    ...(existingSquashCommitProof ? { squashCommit: existingSquashCommitProof } : {}),
  });
  if (existingMerge.block) {
    return {
      ...base,
      status: "blocked",
      reason: existingMerge.block,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  if (existingMerge.pendingReason) {
    return {
      ...base,
      status: "blocked",
      reason: existingMerge.pendingReason,
      live_state: live.state,
      live_updated_at: live.updated_at,
      merge_method: "squash",
      requeue_required: true,
    };
  }
  if (existingMerge.mergedAt) {
    const mergeOwned =
      preliminaryClaim.status === "existing" && preliminaryClaim.dispatched === true;
    if (mergeOwned) {
      recordApplyMergeObserved(target, authorizedHeadSha);
    }
    return {
      ...base,
      status: mergeOwned ? "executed" : "skipped",
      reason: mergeOwned
        ? "already merged"
        : "already merged without a dispatched ClawSweeper claim",
      live_state: "merged",
      live_updated_at: live.updated_at,
      merged_at: existingMerge.mergedAt,
      merge_commit_sha: existingMerge.mergeCommitSha,
    };
  }
  if (
    expectedUpdatedAt &&
    preliminaryClaim.status !== "existing" &&
    !applyMergeUpdatedAtMatches(
      result.repo,
      target,
      authorizedHeadSha,
      expectedUpdatedAt,
      expectedTimelineCursor,
      live.updated_at,
      preliminaryClaim,
    )
  ) {
    return {
      ...base,
      status: "blocked",
      reason: "target changed since worker review",
      expected_updated_at: expectedUpdatedAt,
      live_updated_at: live.updated_at,
      live_state: live.state,
    };
  }
  const lockedSkip = lockedConversationSkipIfLocked(base, live);
  if (lockedSkip) return { ...lockedSkip, merge_method: "squash" };

  const mergePreflightBlock = validateMergePreflight({ result, target });
  if (mergePreflightBlock) {
    return {
      ...base,
      status: "blocked",
      reason: mergePreflightBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  const headBindingBlock = validateMergeHeadBinding({ authorizedHeadSha, view });
  if (headBindingBlock) {
    return {
      ...base,
      status: "blocked",
      reason: headBindingBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  const mergePreflight = findMergePreflight(result, target);
  const hardMergeBlock = validateMergeablePullRequestHard({ pullRequest, view });
  if (hardMergeBlock) {
    return {
      ...base,
      status: "blocked",
      reason: hardMergeBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }
  const strictBaseBindingBlock = runtimeStrictBaseBindingBlock({
    repo: result.repo,
    baseBranch: String(view.baseRefName ?? pullRequest.base?.ref ?? ""),
    policyReadJson: rulesetPolicyReader(),
  });
  if (strictBaseBindingBlock) {
    return {
      ...base,
      status: "blocked",
      reason: strictBaseBindingBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }

  const pendingMerge = exactHeadPendingMerge(view, authorizedHeadSha);
  if (pendingMerge) {
    return pendingMergeAction({ base, live, reason: pendingMerge });
  }

  const mergeBlock = validateMergeablePullRequestReadiness({ view });
  if (mergeBlock) {
    return {
      ...base,
      status: "blocked",
      reason: mergeBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
    };
  }

  if (process.env.CLAWSWEEPER_ALLOW_MERGE !== "1") {
    if (!dryRun) labelForClawSweeperReview(result.repo, target);
    return {
      ...base,
      status: "blocked",
      reason: "merge requires CLAWSWEEPER_ALLOW_MERGE=1; labeled clawsweeper",
      live_state: live.state,
      live_updated_at: live.updated_at,
      merge_method: "squash",
    };
  }

  if (dryRun) {
    return {
      ...base,
      status: "planned",
      reason: "dry run",
      live_state: live.state,
      live_updated_at: live.updated_at,
      merge_method: "squash",
    };
  }

  const mergeMessage = buildRepairSquashMergeMessage({
    target,
    title: view.title ?? pullRequest.title,
    headSha: authorizedHeadSha,
    preflight: mergePreflight,
    reason: "merged by ClawSweeper Repair",
  });
  const bodyFile = writeRepairSquashMergeBody(target, authorizedHeadSha, mergeMessage.body);
  const squashCommitMessage = expectedSquashCommitMessage(mergeMessage.subject, mergeMessage.body);
  const mergeArgs = [
    "pr",
    "merge",
    String(target),
    "--repo",
    result.repo,
    "--squash",
    "--subject",
    String(mergeMessage.subject),
    "--body-file",
    bodyFile,
    "--match-head-commit",
    authorizedHeadSha,
  ];
  let commandError: unknown = null;
  let dispatchedSquashCommitMessage = "";
  const finalView = fetchPullRequestView(result.repo, target);
  const finalHeadBindingBlock = validateMergeHeadBinding({ authorizedHeadSha, view: finalView });
  if (finalHeadBindingBlock) {
    return {
      ...base,
      status: "blocked",
      reason: finalHeadBindingBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
      merge_method: "squash",
    };
  }
  const finalHardMergeBlock = validateMergeablePullRequestHard({
    pullRequest,
    view: finalView,
  });
  if (finalHardMergeBlock) {
    return {
      ...base,
      status: "blocked",
      reason: finalHardMergeBlock,
      live_state: live.state,
      live_updated_at: live.updated_at,
      merge_method: "squash",
    };
  }
  const finalLive = fetchIssue(result.repo, target);
  if (hasSecuritySignal(finalLive)) {
    return {
      ...base,
      status: "blocked",
      reason: "security-sensitive target requires central security triage",
      live_state: finalLive.state,
      live_updated_at: finalLive.updated_at,
      merge_method: "squash",
    };
  }
  if (
    expectedUpdatedAt &&
    preliminaryClaim.status !== "existing" &&
    !applyMergeUpdatedAtMatches(
      result.repo,
      target,
      authorizedHeadSha,
      expectedUpdatedAt,
      expectedTimelineCursor,
      finalLive.updated_at,
      preliminaryClaim,
    )
  ) {
    return {
      ...base,
      status: "blocked",
      reason: "target changed during final merge preflight",
      expected_updated_at: expectedUpdatedAt,
      live_updated_at: finalLive.updated_at,
      live_state: finalLive.state,
      merge_method: "squash",
    };
  }
  const finalPendingMerge = exactHeadPendingMerge(finalView, authorizedHeadSha);
  if (finalPendingMerge) {
    return pendingMergeAction({ base, live: finalLive, reason: finalPendingMerge });
  }
  const finalMergeBlock = validateMergeablePullRequestReadiness({ view: finalView });
  if (finalMergeBlock) {
    return {
      ...base,
      status: "blocked",
      reason: finalMergeBlock,
      live_state: finalLive.state,
      live_updated_at: finalLive.updated_at,
      merge_method: "squash",
    };
  }
  const mergeClaim = claimApplyMergeRequest(result.repo, target, authorizedHeadSha);
  if (mergeClaim.status === "recovered") {
    return {
      ...base,
      status: "blocked",
      reason: mergeClaim.reason,
      live_state: finalLive.state,
      live_updated_at: finalLive.updated_at,
      merge_method: "squash",
      requeue_required: true,
    };
  }
  if (mergeClaim.status === "blocked" || mergeClaim.status === "unknown") {
    return {
      ...base,
      status: "blocked",
      reason: mergeClaim.reason,
      live_state: finalLive.state,
      live_updated_at: finalLive.updated_at,
      merge_method: "squash",
      ...(mergeClaim.status === "unknown" ? { requeue_required: true } : {}),
    };
  }
  if (mergeClaim.status !== "acquired" && mergeClaim.status !== "existing") {
    return {
      ...base,
      status: "blocked",
      reason: "exact-head merge claim entered an unsupported state",
      live_state: finalLive.state,
      live_updated_at: finalLive.updated_at,
      merge_method: "squash",
      requeue_required: true,
    };
  }
  const reconciliationOnly = mergeClaim.status === "existing";
  const retireDispatchedClaim = (actionResult: LooseRecord) =>
    retireApplyMergeClaimAfterDefinitiveNoMutation({
      actionResult,
      repository: result.repo,
      number: target,
      headSha: authorizedHeadSha,
      claim: mergeClaim,
    });
  if (mergeClaim.status === "existing" && mergeClaim.dispatched) {
    dispatchedSquashCommitMessage = mergeClaim.expectedSquashMessage ?? "";
  }
  if (mergeClaim.status === "acquired") {
    const releaseBeforeDispatch = (actionResult: LooseRecord) =>
      releaseApplyMergeClaimBeforeDispatch({
        actionResult,
        repository: result.repo,
        number: target,
        headSha: authorizedHeadSha,
        claimId: mergeClaim.claimId,
      });
    let claimedPull;
    let claimedView;
    try {
      claimedPull = fetchPullRequestOnce(result.repo, target);
      claimedView = fetchPullRequestViewOnce(result.repo, target);
    } catch (error) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: `post-claim merge preflight could not be refreshed: ${ghErrorText(error)}`,
        live_state: finalLive.state,
        live_updated_at: finalLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    const claimedRestHeadBlock = validatePullRequestHeadBinding({
      authorizedHeadSha,
      pullRequest: claimedPull,
    });
    if (claimedRestHeadBlock) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: claimedRestHeadBlock,
        live_state: claimedPull.state ?? finalLive.state,
        live_updated_at: claimedPull.updated_at ?? finalLive.updated_at,
        merge_method: "squash",
      });
    }
    const claimedViewHeadBlock = validateMergeHeadBinding({
      authorizedHeadSha,
      view: claimedView,
    });
    if (claimedViewHeadBlock) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: claimedViewHeadBlock,
        live_state: claimedPull.state ?? finalLive.state,
        live_updated_at: claimedPull.updated_at ?? finalLive.updated_at,
        merge_method: "squash",
      });
    }
    const claimedMerge = confirmExactMergeSnapshot(claimedPull, claimedView, authorizedHeadSha, {
      requireSquashMethod: true,
    });
    if (claimedMerge.block) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: claimedMerge.block,
        live_state: claimedPull.state ?? finalLive.state,
        live_updated_at: claimedPull.updated_at ?? finalLive.updated_at,
        merge_method: "squash",
      });
    }
    if (claimedMerge.pendingReason) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: claimedMerge.pendingReason,
        live_state: claimedPull.state ?? finalLive.state,
        live_updated_at: claimedPull.updated_at ?? finalLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    if (claimedMerge.mergedAt) {
      recordApplyMergeObserved(target, authorizedHeadSha);
      return {
        ...base,
        status: "executed",
        reason: "merge confirmed after exact-head claim",
        live_state: "merged",
        live_updated_at: claimedPull.updated_at ?? finalLive.updated_at,
        merged_at: claimedMerge.mergedAt,
        merge_commit_sha: claimedMerge.mergeCommitSha,
        merge_method: "squash",
        commit_subject: mergeMessage.subject,
        summary_lines: mergeMessage.summaryLines,
        fixup_lines: mergeMessage.fixupLines,
      };
    }
    const claimedHardBlock = validateMergeablePullRequestHard({
      pullRequest: claimedPull,
      view: claimedView,
    });
    if (claimedHardBlock) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: claimedHardBlock,
        live_state: claimedPull.state ?? finalLive.state,
        live_updated_at: claimedPull.updated_at ?? finalLive.updated_at,
        merge_method: "squash",
      });
    }
    let claimedLive;
    try {
      claimedLive = fetchIssue(result.repo, target);
    } catch (error) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: `post-claim security state could not be refreshed: ${ghErrorText(error)}`,
        live_state: claimedPull.state ?? finalLive.state,
        live_updated_at: claimedPull.updated_at ?? finalLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    if (hasSecuritySignal(claimedLive)) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: "security-sensitive target requires central security triage",
        live_state: claimedLive.state,
        live_updated_at: claimedLive.updated_at,
        merge_method: "squash",
      });
    }
    if (
      expectedUpdatedAt &&
      !applyMergeUpdatedAtMatches(
        result.repo,
        target,
        authorizedHeadSha,
        expectedUpdatedAt,
        expectedTimelineCursor,
        claimedLive.updated_at,
        mergeClaim,
        {
          verifiedTargetContentUnchanged: issueMutationSensitiveContentMatches(
            finalLive,
            claimedLive,
          ),
        },
      )
    ) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: "target changed after exact-head merge claim",
        expected_updated_at: expectedUpdatedAt,
        live_state: claimedLive.state,
        live_updated_at: claimedLive.updated_at,
        merge_method: "squash",
      });
    }
    const claimedPendingMerge = exactHeadPendingMerge(claimedView, authorizedHeadSha);
    if (claimedPendingMerge) {
      return releaseBeforeDispatch(
        pendingMergeAction({ base, live: claimedLive, reason: claimedPendingMerge }),
      );
    }
    const claimedReadinessBlock = validateMergeablePullRequestReadiness({ view: claimedView });
    if (claimedReadinessBlock) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: claimedReadinessBlock,
        live_state: claimedLive.state,
        live_updated_at: claimedLive.updated_at,
        merge_method: "squash",
      });
    }
    let dispatchBoundary;
    try {
      dispatchBoundary = markApplyMergeClaimDispatched(
        result.repo,
        target,
        authorizedHeadSha,
        mergeClaim.claimId,
        squashCommitMessage,
      );
    } catch (error) {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: `merge dispatch boundary could not be recorded: ${ghErrorText(error)}`,
        live_state: claimedLive.state,
        live_updated_at: claimedLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    if (dispatchBoundary.status !== "dispatched") {
      return releaseBeforeDispatch({
        ...base,
        status: "blocked",
        reason: dispatchBoundary.reason,
        live_state: claimedLive.state,
        live_updated_at: claimedLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    dispatchedSquashCommitMessage = dispatchBoundary.expectedSquashMessage;
    const dispatchedClaimState = {
      ...mergeClaim,
      lastClaimMutationId: dispatchBoundary.lastClaimMutationId,
      lastClaimMutationAt: dispatchBoundary.lastClaimMutationAt,
      claimMutationIds: [
        ...(mergeClaim.claimMutationIds ?? []),
        mergeClaim.claimId,
        dispatchBoundary.lastClaimMutationId,
      ],
    };
    let dispatchLive;
    let dispatchPull;
    let dispatchView;
    try {
      dispatchLive = fetchIssue(result.repo, target);
      dispatchPull = fetchPullRequestOnce(result.repo, target);
      dispatchView = fetchPullRequestViewOnce(result.repo, target);
    } catch (error) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: `dispatch-boundary merge state could not be refreshed: ${ghErrorText(error)}`,
        live_state: claimedLive.state,
        live_updated_at: claimedLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    const dispatchRestHeadBlock = validatePullRequestHeadBinding({
      authorizedHeadSha,
      pullRequest: dispatchPull,
    });
    if (dispatchRestHeadBlock) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: dispatchRestHeadBlock,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
      });
    }
    const dispatchViewHeadBlock = validateMergeHeadBinding({
      authorizedHeadSha,
      view: dispatchView,
    });
    if (dispatchViewHeadBlock) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: dispatchViewHeadBlock,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
      });
    }
    let dispatchSquashCommitProof: SquashMergeCommitProof | undefined;
    try {
      dispatchSquashCommitProof = dispatchedSquashCommitMessage
        ? fetchSquashMergeCommitProof(result.repo, dispatchPull, dispatchedSquashCommitMessage)
        : undefined;
    } catch (error) {
      return {
        ...base,
        status: "blocked",
        reason: `dispatch-boundary merge proof could not be read: ${ghErrorText(error)}`,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      };
    }
    const dispatchMerge = confirmExactMergeSnapshot(dispatchPull, dispatchView, authorizedHeadSha, {
      requireSquashMethod: true,
      ...(dispatchSquashCommitProof ? { squashCommit: dispatchSquashCommitProof } : {}),
    });
    if (dispatchMerge.block) {
      return {
        ...base,
        status: "blocked",
        reason: dispatchMerge.block,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
      };
    }
    if (dispatchMerge.pendingReason) {
      recordApplyMergeObserved(target, authorizedHeadSha);
      return {
        ...base,
        status: "blocked",
        reason: dispatchMerge.pendingReason,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      };
    }
    if (dispatchMerge.mergedAt) {
      recordApplyMergeObserved(target, authorizedHeadSha);
      return {
        ...base,
        status: "executed",
        reason: "merge confirmed at the exact-head dispatch boundary",
        live_state: "merged",
        live_updated_at: dispatchLive.updated_at,
        merged_at: dispatchMerge.mergedAt,
        merge_commit_sha: dispatchMerge.mergeCommitSha,
        merge_method: "squash",
        commit_subject: mergeMessage.subject,
        summary_lines: mergeMessage.summaryLines,
        fixup_lines: mergeMessage.fixupLines,
      };
    }
    const dispatchHardMergeBlock = validateMergeablePullRequestHard({
      pullRequest: dispatchPull,
      view: dispatchView,
    });
    if (dispatchHardMergeBlock) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: dispatchHardMergeBlock,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
      });
    }
    let dispatchSecuritySignal = false;
    try {
      dispatchSecuritySignal = hasSecuritySignal(dispatchLive);
    } catch (error) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: `dispatch-boundary security state could not be refreshed: ${ghErrorText(error)}`,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    if (dispatchSecuritySignal) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: "security-sensitive target requires central security triage",
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
      });
    }
    if (
      expectedUpdatedAt &&
      !applyMergeUpdatedAtMatches(
        result.repo,
        target,
        authorizedHeadSha,
        expectedUpdatedAt,
        expectedTimelineCursor,
        dispatchLive.updated_at,
        dispatchedClaimState,
        {
          verifiedTargetContentUnchanged: issueMutationSensitiveContentMatches(
            claimedLive,
            dispatchLive,
          ),
        },
      )
    ) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: "target changed at the merge dispatch boundary",
        expected_updated_at: expectedUpdatedAt,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
      });
    }
    const dispatchPendingMerge = exactHeadPendingMerge(dispatchView, authorizedHeadSha);
    if (dispatchPendingMerge) {
      recordApplyMergeObserved(target, authorizedHeadSha);
      return pendingMergeAction({
        base,
        live: dispatchLive,
        reason: dispatchPendingMerge,
      });
    }
    const dispatchReadinessBlock = validateMergeablePullRequestReadiness({
      view: dispatchView,
    });
    if (dispatchReadinessBlock) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: dispatchReadinessBlock,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
      });
    }
    const dispatchBaseBranch = String(dispatchView.baseRefName ?? dispatchPull.base?.ref ?? "");
    let absoluteFinalLive;
    let absoluteFinalPull;
    let absoluteFinalView;
    try {
      absoluteFinalLive = fetchIssue(result.repo, target);
      absoluteFinalPull = fetchPullRequestOnce(result.repo, target);
      absoluteFinalView = fetchPullRequestViewOnce(result.repo, target);
    } catch (error) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: `absolute-final merge state could not be refreshed: ${ghErrorText(error)}`,
        live_state: dispatchLive.state,
        live_updated_at: dispatchLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    const absoluteFinalRestHeadBlock = validatePullRequestHeadBinding({
      authorizedHeadSha,
      pullRequest: absoluteFinalPull,
    });
    if (absoluteFinalRestHeadBlock) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: absoluteFinalRestHeadBlock,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
      });
    }
    const absoluteFinalViewHeadBlock = validateMergeHeadBinding({
      authorizedHeadSha,
      view: absoluteFinalView,
    });
    if (absoluteFinalViewHeadBlock) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: absoluteFinalViewHeadBlock,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
      });
    }
    let absoluteFinalSquashCommitProof: SquashMergeCommitProof | undefined;
    try {
      absoluteFinalSquashCommitProof = dispatchedSquashCommitMessage
        ? fetchSquashMergeCommitProof(result.repo, absoluteFinalPull, dispatchedSquashCommitMessage)
        : undefined;
    } catch (error) {
      return {
        ...base,
        status: "blocked",
        reason: `absolute-final merge proof could not be read: ${ghErrorText(error)}`,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      };
    }
    const absoluteFinalMerge = confirmExactMergeSnapshot(
      absoluteFinalPull,
      absoluteFinalView,
      authorizedHeadSha,
      {
        requireSquashMethod: true,
        ...(absoluteFinalSquashCommitProof ? { squashCommit: absoluteFinalSquashCommitProof } : {}),
      },
    );
    if (absoluteFinalMerge.block) {
      return {
        ...base,
        status: "blocked",
        reason: absoluteFinalMerge.block,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
      };
    }
    if (absoluteFinalMerge.pendingReason) {
      recordApplyMergeObserved(target, authorizedHeadSha);
      return {
        ...base,
        status: "blocked",
        reason: absoluteFinalMerge.pendingReason,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      };
    }
    if (absoluteFinalMerge.mergedAt) {
      recordApplyMergeObserved(target, authorizedHeadSha);
      return {
        ...base,
        status: "executed",
        reason: "merge confirmed at the absolute-final exact-head boundary",
        live_state: "merged",
        live_updated_at: absoluteFinalLive.updated_at,
        merged_at: absoluteFinalMerge.mergedAt,
        merge_commit_sha: absoluteFinalMerge.mergeCommitSha,
        merge_method: "squash",
        commit_subject: mergeMessage.subject,
        summary_lines: mergeMessage.summaryLines,
        fixup_lines: mergeMessage.fixupLines,
      };
    }
    const absoluteFinalHardMergeBlock = validateMergeablePullRequestHard({
      pullRequest: absoluteFinalPull,
      view: absoluteFinalView,
    });
    if (absoluteFinalHardMergeBlock) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: absoluteFinalHardMergeBlock,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
      });
    }
    let absoluteFinalSecuritySignal = false;
    try {
      absoluteFinalSecuritySignal = hasSecuritySignal(absoluteFinalLive);
    } catch (error) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: `absolute-final security state could not be refreshed: ${ghErrorText(error)}`,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    if (absoluteFinalSecuritySignal) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: "security-sensitive target requires central security triage",
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
      });
    }
    if (
      expectedUpdatedAt &&
      !applyMergeUpdatedAtMatches(
        result.repo,
        target,
        authorizedHeadSha,
        expectedUpdatedAt,
        expectedTimelineCursor,
        absoluteFinalLive.updated_at,
        dispatchedClaimState,
        {
          verifiedTargetContentUnchanged: issueMutationSensitiveContentMatches(
            claimedLive,
            absoluteFinalLive,
          ),
        },
      )
    ) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: "target changed at the absolute-final merge boundary",
        expected_updated_at: expectedUpdatedAt,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
      });
    }
    const absoluteFinalPendingMerge = exactHeadPendingMerge(absoluteFinalView, authorizedHeadSha);
    if (absoluteFinalPendingMerge) {
      recordApplyMergeObserved(target, authorizedHeadSha);
      return pendingMergeAction({
        base,
        live: absoluteFinalLive,
        reason: absoluteFinalPendingMerge,
      });
    }
    const absoluteFinalReadinessBlock = validateMergeablePullRequestReadiness({
      view: absoluteFinalView,
    });
    if (absoluteFinalReadinessBlock) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: absoluteFinalReadinessBlock,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
      });
    }
    const absoluteFinalBaseBranch = String(
      absoluteFinalView.baseRefName ?? absoluteFinalPull.base?.ref ?? "",
    );
    if (absoluteFinalBaseBranch !== dispatchBaseBranch) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: "pull request base changed during final merge preflight",
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
      });
    }
    const absoluteFinalStrictBaseBindingBlock = runtimeStrictBaseBindingBlock({
      repo: result.repo,
      baseBranch: absoluteFinalBaseBranch,
      policyReadJson: rulesetPolicyReader(),
    });
    if (absoluteFinalStrictBaseBindingBlock) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: absoluteFinalStrictBaseBindingBlock,
        live_state: absoluteFinalLive.state,
        live_updated_at: absoluteFinalLive.updated_at,
        merge_method: "squash",
      });
    }
    let mergeRequestStarted = false;
    try {
      runRepairMutation(applyResultLifecycle(target), {
        kind: "apply_result_merge",
        identity: applyMergeMutationIdentity(target, authorizedHeadSha),
        component: "apply_result",
        operation: () => {
          mergeRequestStarted = true;
          return ghText(mergeArgs);
        },
        knownNoMutation: applyMergeCommandDefinitivelyRejected,
        outcome: () => "unknown",
      });
    } catch (error) {
      if (!mergeRequestStarted) {
        return retireDispatchedClaim({
          ...base,
          status: "blocked",
          reason: `merge ledger failed before dispatch: ${ghErrorText(error)}`,
          live_state: absoluteFinalLive.state,
          live_updated_at: absoluteFinalLive.updated_at,
          merge_method: "squash",
          requeue_required: true,
        });
      }
      commandError = error;
    }
  }

  let merged;
  let mergedView;
  let squashCommitProof: SquashMergeCommitProof | undefined;
  try {
    merged = fetchPullRequestOnce(result.repo, target);
    squashCommitProof = dispatchedSquashCommitMessage
      ? fetchSquashMergeCommitProof(result.repo, merged, dispatchedSquashCommitMessage)
      : undefined;
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      reason: `merge outcome could not be reconciled from GitHub REST: ${ghErrorText(error)}`,
      live_state: live.state,
      live_updated_at: live.updated_at,
      merge_method: "squash",
      requeue_required: true,
    };
  }
  try {
    mergedView = fetchPullRequestViewOnce(result.repo, target);
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      reason: `merge outcome could not be reconciled from GitHub GraphQL: ${ghErrorText(error)}`,
      live_state: merged.state ?? live.state,
      live_updated_at: merged.updated_at ?? live.updated_at,
      merge_method: "squash",
      requeue_required: true,
    };
  }
  const confirmation = confirmExactMergeSnapshot(merged, mergedView, authorizedHeadSha, {
    requireSquashMethod: true,
    ...(squashCommitProof ? { squashCommit: squashCommitProof } : {}),
  });
  if (confirmation.block) {
    return {
      ...base,
      status: "blocked",
      reason: confirmation.block,
      live_state: merged.state ?? live.state,
      live_updated_at: merged.updated_at ?? live.updated_at,
      merge_method: "squash",
    };
  }
  if (confirmation.pendingReason) {
    recordApplyMergeObserved(target, authorizedHeadSha);
    return {
      ...base,
      status: "blocked",
      reason: confirmation.pendingReason,
      live_state: merged.state ?? mergedView.state ?? live.state,
      live_updated_at: merged.updated_at ?? mergedView.updatedAt ?? live.updated_at,
      merge_method: "squash",
      requeue_required: true,
    };
  }
  if (!confirmation.mergedAt) {
    const restHeadBindingBlock = validatePullRequestHeadBinding({
      authorizedHeadSha,
      pullRequest: merged,
    });
    if (restHeadBindingBlock) {
      return {
        ...base,
        status: "blocked",
        reason: restHeadBindingBlock,
        live_state: merged.state ?? live.state,
        live_updated_at: merged.updated_at ?? live.updated_at,
        merge_method: "squash",
      };
    }

    const reconciledView = mergedView;
    const reconciledHeadBindingBlock = validateMergeHeadBinding({
      authorizedHeadSha,
      view: reconciledView,
    });
    if (reconciledHeadBindingBlock) {
      return {
        ...base,
        status: "blocked",
        reason: reconciledHeadBindingBlock,
        live_state: merged.state ?? live.state,
        live_updated_at: merged.updated_at ?? live.updated_at,
        merge_method: "squash",
      };
    }
    const reconciledHardMergeBlock = validateMergeablePullRequestHard({
      pullRequest: merged,
      view: reconciledView,
    });
    if (reconciledHardMergeBlock) {
      return {
        ...base,
        status: "blocked",
        reason: reconciledHardMergeBlock,
        live_state: merged.state ?? live.state,
        live_updated_at: merged.updated_at ?? live.updated_at,
        merge_method: "squash",
      };
    }
    const pendingReason = exactHeadPendingMerge(reconciledView, authorizedHeadSha);
    if (pendingReason) {
      recordApplyMergeObserved(target, authorizedHeadSha);
      return pendingMergeAction({
        base,
        live: merged,
        reason: pendingReason,
      });
    }
    if (commandError && isLockedConversationCommentError(commandError)) {
      return retireDispatchedClaim({
        ...lockedConversationSkip(base, live, { terminalWriteError: true }),
        merge_method: "squash",
      });
    }
    if (commandError && applyMergeCommandDefinitivelyRejected(commandError)) {
      return retireDispatchedClaim({
        ...base,
        status: "blocked",
        reason: `merge command was definitively rejected: ${ghErrorText(commandError)}`,
        live_state: merged.state ?? live.state,
        live_updated_at: merged.updated_at ?? live.updated_at,
        merge_method: "squash",
        requeue_required: true,
      });
    }
    return {
      ...base,
      status: "blocked",
      reason: commandError
        ? `merge command failed and the exact outcome was not confirmed: ${ghErrorText(commandError)}`
        : reconciliationOnly
          ? mergeClaim.reason
          : "merge command completed but GitHub has not confirmed the exact merge",
      live_state: merged.state ?? live.state,
      live_updated_at: merged.updated_at ?? live.updated_at,
      merge_method: "squash",
      requeue_required: true,
    };
  }

  recordApplyMergeObserved(target, authorizedHeadSha);
  return {
    ...base,
    status: "executed",
    reason: commandError
      ? "merge confirmed after ambiguous response"
      : reconciliationOnly
        ? "merge confirmed for durably claimed exact head"
        : "merged by clawsweeper-repair",
    live_state: "merged",
    live_updated_at: merged.updated_at ?? live.updated_at,
    merged_at: confirmation.mergedAt,
    merge_commit_sha: confirmation.mergeCommitSha,
    merge_method: "squash",
    commit_subject: mergeMessage.subject,
    summary_lines: mergeMessage.summaryLines,
    fixup_lines: mergeMessage.fixupLines,
  };
}

function rulesetPolicyReader() {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!token) return undefined;
  return (ghArgs: string[]) =>
    ghJson(ghArgs, {
      env: { GH_TOKEN: token, GITHUB_TOKEN: token },
    });
}

function validateMergeHeadBinding({
  authorizedHeadSha,
  view,
}: {
  authorizedHeadSha: string;
  view: LooseRecord;
}): string {
  if (!isFullCommitSha(authorizedHeadSha)) {
    return "pull request head is missing or malformed for exact merge binding";
  }
  const viewHeadSha = String(view.headRefOid ?? "");
  if (!isFullCommitSha(viewHeadSha)) {
    return "pull request view head is missing or malformed for exact merge binding";
  }
  if (viewHeadSha !== authorizedHeadSha) {
    return "pull request head changed during merge preflight";
  }
  return "";
}

function validatePullRequestHeadBinding({
  authorizedHeadSha,
  pullRequest,
}: {
  authorizedHeadSha: string;
  pullRequest: LooseRecord;
}): string {
  if (!isFullCommitSha(authorizedHeadSha)) {
    return "pull request head is missing or malformed for exact merge binding";
  }
  const pullRequestHeadSha = String(pullRequest.head?.sha ?? "");
  if (!isFullCommitSha(pullRequestHeadSha)) {
    return "pull request REST head is missing or malformed for exact merge binding";
  }
  if (pullRequestHeadSha !== authorizedHeadSha) {
    return "pull request REST head changed during merge reconciliation";
  }
  return "";
}

function confirmExactMergeSnapshot(
  pullRequest: LooseRecord,
  view: LooseRecord,
  authorizedHeadSha: string,
  proof: {
    requireSquashMethod?: boolean;
    squashCommit?: SquashMergeCommitProof;
  } = {},
): {
  mergedAt: string | null;
  mergeCommitSha: string | null;
  block: string;
  pendingReason: string;
} {
  const confirmation = confirmAlreadyMergedPullRequest({
    expectedHeadSha: authorizedHeadSha,
    pull: pullRequest,
    view,
  });
  if (!confirmation) {
    return { mergedAt: null, mergeCommitSha: null, block: "", pendingReason: "" };
  }
  if (confirmation.status === "waiting") {
    return {
      mergedAt: null,
      mergeCommitSha: null,
      block: "",
      pendingReason: confirmation.reason,
    };
  }
  if (confirmation.status !== "executed") {
    return {
      mergedAt: null,
      mergeCommitSha: null,
      block: confirmation.reason,
      pendingReason: "",
    };
  }
  const methodBlock =
    proof.requireSquashMethod === true ? squashMergedMethodBlock(proof.squashCommit) : "";
  return {
    mergedAt: methodBlock ? null : confirmation.mergedAt,
    mergeCommitSha: methodBlock ? null : confirmation.mergeCommitSha,
    block: methodBlock,
    pendingReason: "",
  };
}

function claimApplyMergeRequest(repository: string, number: number, headSha: string) {
  const request = applyMergeClaimRequest(repository, number, headSha);
  return ensureExactHeadMergeClaim(request, {
    listComments: () => listApplyMergeClaimComments(request),
    createComment: (body, context) =>
      runRepairMutation(applyResultLifecycle(number), {
        kind:
          context.kind === "claim"
            ? "apply_result_merge_claim"
            : "apply_result_merge_claim_recovery",
        identity:
          context.kind === "claim"
            ? exactHeadMergeClaimIdentity(request)
            : {
                ...exactHeadMergeClaimIdentity(request),
                claimId: context.claimId,
                owner: context.owner,
                claimant: context.claimant,
              },
        component: "merge_claim",
        operation: () =>
          ghJsonOnce([
            "api",
            `repos/${request.repository}/issues/${request.number}/comments`,
            "-f",
            `body=${body}`,
          ]),
        outcome: (comment) => {
          const trusted =
            context.kind === "claim"
              ? isTrustedExactHeadMergeClaimComment(comment, request)
              : isTrustedExactHeadMergeClaimRecoveryComment(
                  comment,
                  request,
                  context.claimId,
                  context.owner,
                  context.claimant,
                );
          return trusted ? "accepted" : "unknown";
        },
      }),
    recoverClaim: (candidate) =>
      exactHeadMergeClaimRecoveryDecision(candidate, (path) =>
        ghJsonOnce(["api", path], { env: exactHeadMergeClaimWorkflowRunEnv() }),
      ),
    dispatchedClaimEffectAbsent: () => {
      const pullRequest = fetchPullRequestOnce(repository, number);
      const view = fetchPullRequestViewOnce(repository, number);
      return automergeEffectDefinitelyAbsent({ pull: pullRequest, view }, headSha);
    },
  });
}

function markApplyMergeClaimDispatched(
  repository: string,
  number: number,
  headSha: string,
  claimId: number,
  expectedSquashMessage: string,
) {
  const request = applyMergeClaimRequest(repository, number, headSha);
  return markExactHeadMergeClaimDispatched(request, claimId, expectedSquashMessage, {
    listComments: () => listApplyMergeClaimComments(request),
    createComment: (body) =>
      runRepairMutation(applyResultLifecycle(number), {
        kind: "apply_result_merge_claim_dispatch",
        identity: { ...exactHeadMergeClaimIdentity(request), claimId },
        component: "merge_claim",
        operation: () =>
          ghJsonOnce([
            "api",
            `repos/${request.repository}/issues/${request.number}/comments`,
            "-f",
            `body=${body}`,
          ]),
        outcome: (comment) =>
          isTrustedExactHeadMergeClaimDispatchComment(
            comment,
            request,
            claimId,
            expectedSquashMessage,
          )
            ? "accepted"
            : "unknown",
      }),
  });
}

function releaseApplyMergeClaimBeforeDispatch({
  actionResult,
  repository,
  number,
  headSha,
  claimId,
}: {
  actionResult: LooseRecord;
  repository: string;
  number: number;
  headSha: string;
  claimId: number;
}) {
  let release;
  try {
    release = releaseApplyMergeClaim(repository, number, headSha, claimId);
  } catch (error) {
    release = {
      status: "unknown" as const,
      reason: `exact-head merge claim release failed: ${ghErrorText(error)}`,
      claimId,
    };
  }
  if (release.status === "released") return actionResult;
  return {
    ...actionResult,
    status: "blocked",
    reason: `${String(actionResult.reason ?? "merge aborted before dispatch")}; ${release.reason}`,
    ...(release.status === "unknown" ? { requeue_required: true } : {}),
  };
}

function retireApplyMergeClaimAfterDefinitiveNoMutation({
  actionResult,
  repository,
  number,
  headSha,
  claim,
}: {
  actionResult: LooseRecord;
  repository: string;
  number: number;
  headSha: string;
  claim:
    | Extract<ReturnType<typeof claimApplyMergeRequest>, { status: "acquired" }>
    | Extract<ReturnType<typeof claimApplyMergeRequest>, { status: "existing" }>;
}) {
  let rejection;
  try {
    rejection = rejectApplyMergeClaim(repository, number, headSha, claim);
  } catch (error) {
    rejection = {
      status: "unknown" as const,
      reason: `exact-head merge claim rejection failed: ${ghErrorText(error)}`,
      claimId: claim.claimId,
    };
  }
  if (rejection.status === "rejected") return actionResult;
  return {
    ...actionResult,
    status: "blocked",
    reason: `${String(actionResult.reason ?? "merge produced no effect")}; ${rejection.reason}`,
    requeue_required: true,
  };
}

function applyMergeCommandDefinitivelyRejected(error: unknown): boolean {
  return (
    automergeUnconfirmedFailureDisposition({
      command_error: error,
    }) === "blocked"
  );
}

function rejectApplyMergeClaim(
  repository: string,
  number: number,
  headSha: string,
  claim:
    | Extract<ReturnType<typeof claimApplyMergeRequest>, { status: "acquired" }>
    | Extract<ReturnType<typeof claimApplyMergeRequest>, { status: "existing" }>,
) {
  const request = applyMergeClaimRequest(repository, number, headSha, {
    owner: claim.status === "existing" ? claim.owner : "apply_result",
    claimant: claim.status === "existing" ? claim.claimant : exactHeadMergeClaimant("apply_result"),
  });
  return rejectExactHeadMergeClaim(request, claim.claimId, {
    listComments: () => listApplyMergeClaimComments(request),
    createComment: (body) =>
      runRepairMutation(applyResultLifecycle(number), {
        kind: "apply_result_merge_claim_rejection",
        identity: { ...exactHeadMergeClaimIdentity(request), claimId: claim.claimId },
        component: "merge_claim",
        operation: () =>
          ghJsonOnce([
            "api",
            `repos/${request.repository}/issues/${request.number}/comments`,
            "-f",
            `body=${body}`,
          ]),
        outcome: (comment) =>
          isTrustedExactHeadMergeClaimRejectionComment(comment, request, claim.claimId)
            ? "accepted"
            : "unknown",
      }),
  });
}

function releaseApplyMergeClaim(
  repository: string,
  number: number,
  headSha: string,
  claimId: number,
) {
  const request = applyMergeClaimRequest(repository, number, headSha);
  return releaseExactHeadMergeClaim(request, claimId, {
    listComments: () => listApplyMergeClaimComments(request),
    createComment: (body) =>
      runRepairMutation(applyResultLifecycle(number), {
        kind: "apply_result_merge_claim_release",
        identity: { ...exactHeadMergeClaimIdentity(request), claimId },
        component: "merge_claim",
        operation: () =>
          ghJsonOnce([
            "api",
            `repos/${request.repository}/issues/${request.number}/comments`,
            "-f",
            `body=${body}`,
          ]),
        outcome: (comment) =>
          isTrustedExactHeadMergeClaimReleaseComment(comment, request, claimId)
            ? "accepted"
            : "unknown",
      }),
  });
}

function inspectApplyMergeClaim(repository: string, number: number, headSha: string) {
  const request = applyMergeClaimRequest(repository, number, headSha);
  return inspectExactHeadMergeClaim(request, () => listApplyMergeClaimComments(request));
}

function applyMergeClaimRequest(
  repository: string,
  number: number,
  headSha: string,
  claimIdentity: { owner: string; claimant: string } = {
    owner: "apply_result",
    claimant: exactHeadMergeClaimant("apply_result"),
  },
): ExactHeadMergeClaimRequest {
  return {
    repository,
    number,
    headSha,
    method: "squash",
    owner: claimIdentity.owner,
    claimant: claimIdentity.claimant,
    appId: Number(process.env.CLAWSWEEPER_AUTHENTICATED_APP_ID),
    appSlug: String(process.env.CLAWSWEEPER_AUTHENTICATED_APP_SLUG ?? ""),
  };
}

function listApplyMergeClaimComments(request: ExactHeadMergeClaimRequest) {
  return ghPaged<LooseRecord>(
    `repos/${request.repository}/issues/${request.number}/comments?per_page=100`,
  );
}

function applyMergeUpdatedAtMatches(
  repository: string,
  number: number,
  headSha: string,
  expectedUpdatedAt: JsonValue,
  expectedTimelineCursor: JsonValue,
  liveUpdatedAt: JsonValue,
  claim: {
    status: string;
    claimId?: number | null;
    lastClaimMutationId?: number | null;
    lastClaimMutationAt?: string | null;
    claimMutationIds?: number[];
  },
  options: { verifiedTargetContentUnchanged?: boolean } = {},
) {
  try {
    const request = applyMergeClaimRequest(repository, number, headSha);
    const timeline = ghPagedLimit<LooseRecord>(
      `repos/${request.repository}/issues/${request.number}/timeline`,
      MAX_REVIEWED_TIMELINE_EVENTS + 1,
    );
    if (timeline.length > MAX_REVIEWED_TIMELINE_EVENTS) return false;
    if (exactHeadMergeUpdatedAtMatches(expectedUpdatedAt, liveUpdatedAt)) {
      return reviewedTimelineTail(expectedTimelineCursor, timeline) !== null;
    }
    if (claim.status !== "acquired" || options.verifiedTargetContentUnchanged !== true) {
      return false;
    }
    return exactHeadMergeClaimOwnsUpdatedAt(
      claim,
      expectedTimelineCursor,
      liveUpdatedAt,
      timeline,
      options,
    );
  } catch {
    return false;
  }
}

function issueMutationSensitiveContentMatches(before: LooseRecord, after: LooseRecord): boolean {
  return (
    stableJson(issueMutationSensitiveContent(before)) ===
    stableJson(issueMutationSensitiveContent(after))
  );
}

function issueMutationSensitiveContent(issue: LooseRecord): LooseRecord {
  return Object.fromEntries(
    Object.entries(issue).filter(([key]) => !COMMENT_PROPAGATED_ISSUE_FIELDS.has(key)),
  );
}

function applyMergeMutationIdentity(number: number, headSha: string) {
  return {
    repo: result.repo,
    number,
    headSha,
    method: "squash",
  };
}

function recordApplyMergeObserved(number: number, headSha: string) {
  recordRepairMutationObservedSafely(applyResultLifecycle(number), {
    kind: "apply_result_merge",
    identity: applyMergeMutationIdentity(number, headSha),
    component: "apply_result",
  });
}

function applyResultLifecycle(
  number: number | null,
  subjectKind: RepairLifecycleInput["subjectKind"] = "pull_request",
): RepairLifecycleInput {
  return {
    repository: result.repo,
    workKey: `apply-result:${result.cluster_id ?? result.run_id ?? result.reviewed_sha ?? "unknown"}`,
    ...(number && number > 0 ? { number } : {}),
    sourceRevision:
      repairSourceRevision(job.frontmatter) ??
      repairSourceRevision({ reviewed_sha: result.reviewed_sha ?? result.head_sha }),
    subjectKind: number && number > 0 ? subjectKind : "workflow",
  };
}

function exactHeadPendingMerge(view: LooseRecord, authorizedHeadSha: string): string {
  if (String(view.headRefOid ?? "") !== authorizedHeadSha) return "";
  if (view.isInMergeQueue === true) {
    return "merge is pending in GitHub's merge queue for the authorized pull request head";
  }
  if (view.autoMergeRequest) {
    return "auto-merge is pending for the authorized pull request head";
  }
  return "";
}

function pendingMergeAction({ base, live, reason }: LooseRecord) {
  return {
    ...base,
    status: "blocked",
    reason,
    live_state: live.state,
    live_updated_at: live.updated_at,
    merge_method: "squash",
    requeue_required: true,
  };
}

function validateClosePolicy({ job, actionName }: LooseRecord) {
  if (!job.frontmatter.allowed_actions.includes("close")) return "job does not allow close";
  if (!job.frontmatter.allowed_actions.includes("comment"))
    return "job does not allow close comments";
  if ((job.frontmatter.blocked_actions ?? []).includes("close"))
    return "close is blocked by job frontmatter";
  if ((job.frontmatter.blocked_actions ?? []).includes("comment"))
    return "comment is blocked by job frontmatter";

  if (
    !["close_low_signal", "post_merge_close"].includes(actionName) &&
    job.frontmatter.allow_instant_close !== true
  ) {
    return "instant close requires allow_instant_close: true";
  }
  return "";
}

function validateFixFirstClose({
  job,
  result,
  actionName,
  classification,
  candidateFix,
}: LooseRecord) {
  if (job.frontmatter.require_fix_before_close !== true) return "";
  if (["close_low_signal", "post_merge_close"].includes(actionName)) return "";
  if (classification === "duplicate") return "";

  const priorMerge = report.actions.some(
    (entry: JsonValue) => MERGE_ACTIONS.has(entry.action) && entry.status === "executed",
  );
  if (priorMerge) return "";

  if (candidateFix && isMergedCandidateFix(result.repo, candidateFix)) {
    return "";
  }

  if (
    classification === "fixed_by_candidate" &&
    job.frontmatter.allow_unmerged_fix_close !== true
  ) {
    return "fixed_by_candidate close requires a merged fix PR unless allow_unmerged_fix_close: true";
  }

  const fixReport = readFixExecutionReport(result);
  const fixLanded = (fixReport?.actions ?? []).some(
    (entry: JsonValue) =>
      ["open_fix_pr", "repair_contributor_branch"].includes(String(entry.action ?? "")) &&
      ["opened", "pushed"].includes(String(entry.status ?? "")),
  );
  if (fixLanded) return "";

  return "close requires ClawSweeper fix PR opened/pushed, merged candidate fix, or merge executed first";
}

function isMergedCandidateFix(repo: string, candidateFix: LooseRecord) {
  try {
    return validateMergedCandidateFix(repo, candidateFix) === "";
  } catch {
    return false;
  }
}

function validateMergePolicy({ job, action }: LooseRecord) {
  if (!job.frontmatter.allowed_actions.includes("merge")) return "job does not allow merge";
  if ((job.frontmatter.blocked_actions ?? []).includes("merge"))
    return "merge is blocked by job frontmatter";
  if (job.frontmatter.allow_merge !== true) return "merge requires allow_merge: true";
  if (!["merge_candidate", "merge_canonical"].includes(String(action.action ?? ""))) {
    return "unsupported merge action";
  }
  return "";
}

function labelForClawSweeperReview(repo: string, target: LooseRecord) {
  const number = Number(target);
  ensureLabel(
    repo,
    number,
    CLAWSWEEPER_LABEL,
    CLAWSWEEPER_LABEL_COLOR,
    CLAWSWEEPER_LABEL_DESCRIPTION,
  );
  try {
    runApplyResultMutationWithRetry(
      applyResultLifecycle(number),
      {
        kind: "apply_result_blocked_merge_label_add",
        identity: {
          repository: repo,
          number,
          label: CLAWSWEEPER_LABEL,
          operation: "blocked_merge_label_add",
        },
        component: "apply_result",
      },
      ["issue", "edit", String(target), "--repo", repo, "--add-label", CLAWSWEEPER_LABEL],
    );
  } catch {
    // Helpful metadata should not block the primary command path.
  }
}

function ensureLabel(
  repo: string,
  number: number,
  name: string,
  color: JsonValue,
  description: JsonValue,
) {
  try {
    runApplyResultMutationWithRetry(
      applyResultLifecycle(number),
      {
        kind: "apply_result_blocked_merge_label_create",
        identity: {
          repository: repo,
          label: name,
          operation: "blocked_merge_label_create",
        },
        component: "apply_result",
      },
      ["label", "create", name, "--repo", repo, "--color", color, "--description", description],
      2,
    );
  } catch (error) {
    const detail = ghErrorText(error);
    if (!/already exists/i.test(detail)) return;
  }
}

function validateMergePreflight({ result, target }: LooseRecord) {
  const preflight = findMergePreflight(result, target);
  if (!preflight) return "merge requires merge_preflight entry";
  if (preflight.security_status !== "cleared") return "security preflight is not cleared";
  if (!Array.isArray(preflight.security_evidence) || preflight.security_evidence.length === 0) {
    return "security preflight evidence is missing";
  }
  if (preflight.comments_status !== "resolved") return "review comments are not resolved";
  if (!Array.isArray(preflight.comments_evidence) || preflight.comments_evidence.length === 0) {
    return "review comments resolution evidence is missing";
  }
  if (preflight.bot_comments_status !== "resolved") return "review-bot comments are not resolved";
  if (
    !Array.isArray(preflight.bot_comments_evidence) ||
    preflight.bot_comments_evidence.length === 0
  ) {
    return "review-bot comment resolution evidence is missing";
  }
  if (!Array.isArray(preflight.validation_commands) || preflight.validation_commands.length === 0) {
    return "merge validation commands are missing";
  }
  const codexReview = preflight.codex_review;
  if (!codexReview || codexReview.command !== "/review")
    return "Codex /review preflight is missing";
  if (!["passed", "clean"].includes(codexReview.status))
    return `Codex /review status is ${codexReview.status || "missing"}`;
  if (codexReview.findings_addressed !== true) return "Codex /review findings are not addressed";
  if (!Array.isArray(codexReview.evidence) || codexReview.evidence.length === 0) {
    return "Codex /review evidence is missing";
  }
  const unresolvedThreadBlock = validateResolvedReviewThreads(result.repo, target);
  if (unresolvedThreadBlock) return unresolvedThreadBlock;
  return "";
}

function findMergePreflight(result: LooseRecord, target: LooseRecord) {
  const expected = `#${target}`;
  for (const item of result.merge_preflight ?? []) {
    if (
      normalizeIssueRef(item?.target, result.repo) === target ||
      String(item?.target ?? "") === expected
    ) {
      return item;
    }
  }
  return null;
}

function validateMergedCandidateFix(repo: string, candidateFix: LooseRecord) {
  if (!candidateFix) return "post-merge close requires candidate_fix";
  const candidate = fetchPullRequest(repo, candidateFix);
  const candidateView = fetchPullRequestView(repo, candidateFix);
  const baseBlock = pullRequestMainBaseBlock(candidate, candidateView);
  if (baseBlock) return baseBlock;
  if (
    !restPullRequestMergeConfirmed(candidate) ||
    !graphqlPullRequestMergeConfirmed(candidateView)
  ) {
    return "candidate fix is not confirmed merged";
  }
  return "";
}

function validateResolvedReviewThreads(repo: string, target: LooseRecord) {
  const [owner, name] = repo.split("/");
  const query = `
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              isResolved
              path
              line
              comments(first: 1) {
                nodes {
                  url
                  author { login }
                  body
                }
              }
            }
          }
        }
      }
    }
  `;
  const data = ghJson([
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${target}`,
    "-f",
    `query=${query}`,
  ]);
  const threads = data?.data?.repository?.pullRequest?.reviewThreads;
  if (threads?.pageInfo?.hasNextPage) return "too many review threads to prove resolved";
  const unresolved = (threads?.nodes ?? []).filter(
    (thread: JsonValue) => thread && !thread.isResolved,
  );
  if (unresolved.length === 0) return "";
  const examples = unresolved
    .slice(0, 3)
    .map(
      (thread: JsonValue) =>
        thread.comments?.nodes?.[0]?.url ?? `${thread.path}:${thread.line ?? "?"}`,
    );
  return `unresolved review threads remain: ${examples.join(", ")}`;
}

function validateReplacementCloseout({ result, actionName, target }: LooseRecord) {
  if (!["close_superseded", "close_fixed_by_candidate", "post_merge_close"].includes(actionName))
    return "";
  const fixArtifact = result.fix_artifact;
  if (fixArtifact?.repair_strategy !== "replace_uneditable_branch") return "";
  const sourceTargets = new Set(
    (fixArtifact.source_prs ?? []).map((ref: JsonValue) => normalizeIssueRef(ref, result.repo)),
  );
  if (!sourceTargets.has(target)) return "";
  return "replacement PR closeout is handled by execute-fix after the replacement branch is pushed";
}

function validatePrCloseCoverageProof({
  result,
  action,
  actionName,
  target,
  live,
  canonical,
  candidateFix,
  classification,
}: LooseRecord): PrCloseCoverageProofValidation {
  const coveringRef = prCloseCoverageProofCoveringRef({
    actionName,
    classification,
    canonical,
    candidateFix,
  });
  if (!coveringRef || coveringRef === target || !live.pull_request) return null;

  let source: PrCloseCoverageProofPullRequestView;
  let covering: PrCloseCoverageProofPullRequestView;
  try {
    const coveringIssue = fetchIssue(result.repo, coveringRef);
    if (!coveringIssue.pull_request) return null;

    source = hydratePrCloseCoveragePullRequest(result.repo, target, live);
    covering = hydratePrCloseCoveragePullRequest(result.repo, coveringRef, coveringIssue);
    if (!prCloseCoverageProofCandidateCanClose(covering)) {
      return {
        status: "blocked",
        reason: `PR close coverage proof requires an open or merged covering pull request; #${coveringRef} is ${covering.state}`,
      };
    }
    const coveringSafetyBlock = validatePrCloseCoverageCoveringSafety({
      result,
      coveringRef,
      coveringIssue,
      covering,
    });
    if (coveringSafetyBlock) {
      return { status: "blocked", reason: coveringSafetyBlock };
    }
  } catch (error) {
    return prCloseCoverageProofSetupFailureBlock(error);
  }

  try {
    const proof = runPrCloseCoverageProofModel({
      source,
      covering,
      markdown: prCloseCoverageProofRepairSourceReport({
        result,
        action,
        actionName,
        classification,
        target,
        live,
        coveringRef,
      }),
      relationshipSignalSnippets: prCloseCoverageProofRelationshipSignals({
        action,
        actionName,
        coveringRef,
      }),
      runtime: prCloseCoverageProofRuntime(),
    });
    const closeDecision = prCloseCoverageProofCloseDecision(proof);
    if (closeDecision.close) {
      return {
        status: "covered",
        coveringRef,
        coveringUpdatedAt: covering.updatedAt,
        proof: closeDecision.proof,
      };
    }
    return {
      status: "blocked",
      reason: `PR close coverage proof kept the source pull request open: ${closeDecision.reason}`,
      pr_close_coverage_proof: closeDecision.proof,
    };
  } catch (error) {
    return {
      status: "blocked",
      requeue_required: true,
      reason: prCloseCoverageProofFailureReason(error),
    };
  }
}

function prCloseCoverageProofSetupFailureBlock(
  error: unknown,
): Extract<PrCloseCoverageProofValidation, { status: "blocked" }> {
  return { status: "blocked", ...prCloseCoverageProofFailureBlock(error) };
}

function prCloseCoverageProofFailureBlock(error: unknown): PrCloseCoverageProofBlock {
  const block = { reason: prCloseCoverageProofFailureReason(error) };
  return prCloseCoverageProofFailureIsTerminal(error)
    ? block
    : { ...block, requeue_required: true };
}

function prCloseCoverageProofFailureIsTerminal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\b(?:issue|pull) not found: #\d+\b/i.test(text) || /\bHTTP 404\b/i.test(text);
}

function validatePrCloseCoverageCoveringFreshness({
  result,
  coveringRef,
  coveringUpdatedAt,
}: LooseRecord): string {
  const expectedUpdatedAt = stringOrNull(coveringUpdatedAt);
  if (!expectedUpdatedAt) return "";

  try {
    const liveUpdatedAt = prCloseCoverageCoveringUpdatedAt(result.repo, coveringRef);
    if (liveUpdatedAt === expectedUpdatedAt) return "";
    return `linked canonical PR #${coveringRef} changed after coverage proof`;
  } catch (error) {
    return prCloseCoverageProofFailureReason(error);
  }
}

function validatePrCloseCoverageCoveringRefSafety({
  result,
  actionName,
  target,
  live,
  canonical,
  candidateFix,
  classification,
}: LooseRecord): PrCloseCoverageProofBlock | null {
  const coveringRef = prCloseCoverageProofCoveringRef({
    actionName,
    classification,
    canonical,
    candidateFix,
  });
  if (!coveringRef || coveringRef === target || !live.pull_request) return null;

  try {
    const coveringIssue = fetchIssue(result.repo, coveringRef);
    if (!coveringIssue.pull_request) return null;
    const coveringPull = fetchPullRequest(result.repo, coveringRef);
    const covering = {
      state:
        stringFromUnknown(coveringPull.state) ||
        stringFromUnknown(coveringIssue.state) ||
        "unknown",
      mergedAt: stringOrNull(coveringPull.merged_at ?? coveringPull.mergedAt),
    };
    if (!prCloseCoverageProofCandidateCanClose(covering)) {
      return {
        reason: `PR close coverage proof requires an open or merged covering pull request; #${coveringRef} is ${covering.state}`,
      };
    }
    const coveringSafetyBlock = validatePrCloseCoverageCoveringSafety({
      result,
      coveringRef,
      coveringIssue,
      covering,
    });
    return coveringSafetyBlock ? { reason: coveringSafetyBlock } : null;
  } catch (error) {
    return prCloseCoverageProofFailureBlock(error);
  }
}

function prCloseCoverageProofFailureReason(error: unknown): string {
  return `PR close coverage proof failed: ${error instanceof Error ? error.message : String(error)}`;
}

function prCloseCoverageCoveringUpdatedAt(repo: string, number: JsonValue): string | null {
  const pull = fetchPullRequest(repo, number);
  const pullUpdatedAt = stringOrNull(pull.updated_at ?? pull.updatedAt);
  if (pullUpdatedAt) return pullUpdatedAt;
  const issue = fetchIssue(repo, number);
  return stringOrNull(issue.updated_at ?? issue.updatedAt);
}

function validatePrCloseCoverageCoveringSafety({
  result,
  coveringRef,
  coveringIssue,
  covering,
}: LooseRecord): string {
  if (covering.mergedAt) return "";
  const pullRequest = fetchPullRequest(result.repo, coveringRef);
  const view = fetchPullRequestView(result.repo, coveringRef);
  const mergeBlock = validateMergeablePullRequest({
    pullRequest,
    view,
    allowedMergeStates: VIABLE_COVERING_PR_MERGE_STATES,
  });
  if (mergeBlock) return formatCoveringPullRequestBlock(coveringRef, mergeBlock);
  if (resultHasPlannedCloseForTarget(result, coveringRef)) {
    return `linked canonical PR #${coveringRef} is itself proposed for close`;
  }

  const labels = labelNames(coveringIssue.labels).map(normalizeLabelName);
  const proofPassed = labels.some((label) => /^proof:\s*(sufficient|override)\b/i.test(label));
  const needsProof = labels.some(
    (label) =>
      label === "triage: needs-real-behavior-proof" ||
      (label.startsWith("status:") && label.includes("needs proof")),
  );
  if (labels.some((label) => label.startsWith("rating:") && label.includes("unranked"))) {
    return `linked canonical PR #${coveringRef} is F-rated`;
  }
  if (needsProof && !proofPassed) {
    return `linked canonical PR #${coveringRef} is still waiting for real behavior proof`;
  }
  if (!proofPassed) {
    return `linked canonical PR #${coveringRef} has no positive real behavior proof`;
  }
  return "";
}

function formatCoveringPullRequestBlock(coveringRef: JsonValue, reason: string): string {
  if (reason === "pull request is draft") {
    return `linked canonical PR #${coveringRef} is still draft`;
  }
  if (reason === "mergeable state is CONFLICTING") {
    return `linked canonical PR #${coveringRef} has merge conflicts`;
  }
  return `linked canonical PR #${coveringRef} ${reason}`;
}

function resultHasPlannedCloseForTarget(result: LooseRecord, target: JsonValue): boolean {
  return (result.actions ?? []).some(
    (entry: JsonValue) =>
      CLOSE_ACTIONS.has(String(entry?.action ?? "")) &&
      normalizeIssueRef(entry?.target, result.repo) === target &&
      String(entry?.status ?? "") === "planned",
  );
}

function labelNames(value: JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry: JsonValue) => {
      if (typeof entry === "string") return entry;
      return stringFromUnknown(entry?.name);
    })
    .filter((entry: string) => entry.trim());
}

function normalizeLabelName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function prCloseCoverageProofRepairSourceReport({
  result,
  action,
  actionName,
  classification,
  target,
  live,
  coveringRef,
}: LooseRecord) {
  const evidence = Array.isArray(action.evidence) ? action.evidence.map(compactSignalText) : [];
  const lines = [
    "# PR A repair close action report",
    "",
    `Repository: ${stringFromUnknown(result.repo) || "unknown"}`,
    `Source PR A: #${target} ${stringFromUnknown(live.title) || ""}`.trim(),
    `Covering PR B: #${coveringRef}`,
    `Action: ${actionName}`,
    `Classification: ${classification}`,
    `Reason: ${stringFromUnknown(action.reason) || "none"}`,
    `Close comment: ${stringFromUnknown(action.comment) || "none"}`,
    "",
    "Evidence:",
    ...(evidence.length ? evidence.map((entry: string) => `- ${entry}`) : ["- none"]),
  ];
  return lines.join("\n");
}

function prCloseCoverageProofCoveringRef({
  actionName,
  classification,
  canonical,
  candidateFix,
}: LooseRecord) {
  if (actionName === "close_duplicate") return canonical;
  if (actionName === "close_superseded") return candidateFix || canonical;
  if (["close_fixed_by_candidate", "post_merge_close"].includes(actionName)) return candidateFix;
  if (actionName === "close") {
    if (classification === "duplicate") return canonical;
    if (classification === "superseded") return candidateFix || canonical;
    if (classification === "fixed_by_candidate") return candidateFix;
  }
  return null;
}

function hydratePrCloseCoveragePullRequest(
  repo: string,
  number: LooseRecord,
  issue: LooseRecord,
): PrCloseCoverageProofPullRequestView {
  const pull = fetchPullRequest(repo, number);
  const commentsWindow = fetchPrCloseCoverageProofCommentWindow(
    repo,
    number,
    issue.comments,
    PR_CLOSE_COVERAGE_PROOF_COMMENT_LIMIT,
  );
  const comments = commentsWindow.comments.filter(
    (comment: JsonValue) => !isClawSweeperNoiseComment(comment),
  );
  return {
    number: Number(number),
    title: stringFromUnknown(pull.title) || stringFromUnknown(issue.title) || `#${number}`,
    url:
      stringFromUnknown(pull.html_url) ||
      stringFromUnknown(pull.url) ||
      stringFromUnknown(issue.html_url) ||
      "",
    state: stringFromUnknown(pull.state) || stringFromUnknown(issue.state) || "unknown",
    mergedAt: stringOrNull(pull.merged_at ?? pull.mergedAt),
    body: compactPrCloseCoverageProofText(pull.body),
    updatedAt: stringOrNull(pull.updated_at ?? pull.updatedAt ?? issue.updated_at),
    comments: compactPrCloseCoverageProofCommentWindow(
      comments,
      comments.length,
      PR_CLOSE_COVERAGE_PROOF_COMMENT_LIMIT,
    ),
    commentsTruncated: commentsWindow.total > PR_CLOSE_COVERAGE_PROOF_COMMENT_LIMIT,
  };
}

function rawCommentBody(value: JsonValue): string {
  return stringFromUnknown(value?.body);
}

function isClawSweeperComment(value: JsonValue): boolean {
  const author = stringFromUnknown(value?.user?.login).toLowerCase();
  return CLAWSWEEPER_BOT_AUTHORS.has(author);
}

function isClawSweeperNoiseComment(value: JsonValue): boolean {
  const body = rawCommentBody(value);
  if (CLAWSWEEPER_COMMAND_ONLY_PATTERN.test(body.trim())) return true;
  if (!body.trim() || !isClawSweeperComment(value)) return false;
  if (/<!--\s*clawsweeper-review\s+item=/i.test(body)) return true;
  if (/clawsweeper-review-status:/i.test(body)) return true;
  if (/clawsweeper-command(?:-status|-ack)?:/i.test(body)) return true;
  if (/clawsweeper-close-applied\s+item=/i.test(body)) return true;
  if (/clawsweeper-repair:close:/i.test(body)) return true;
  if (/^ClawSweeper status: review started\./i.test(body)) return true;
  return false;
}

function fetchPrCloseCoverageProofCommentWindow(
  repo: string,
  number: LooseRecord,
  commentsCount: JsonValue,
  limit: number,
): { comments: JsonValue[]; total: number } {
  const apiPath = `repos/${repo}/issues/${number}/comments`;
  const total = nonNegativeIntegerFromUnknown(commentsCount);
  if (total === null) {
    return fetchPrCloseCoverageProofCommentWindowWithoutCount(apiPath, limit);
  }
  if (total === 0 || limit <= 0) {
    return { comments: [], total };
  }
  if (total <= limit) {
    return {
      comments: fetchPrCloseCoverageProofCommentPage(
        apiPath,
        Math.min(total, GITHUB_MAX_PAGE_SIZE),
        1,
      ),
      total,
    };
  }

  if (total <= GITHUB_MAX_PAGE_SIZE) {
    return {
      comments: fetchPrCloseCoverageProofCommentPage(apiPath, total, 1),
      total,
    };
  }

  const keepStart = Math.floor(limit / 2);
  const keepEnd = Math.max(0, limit - keepStart);
  const first = fetchPrCloseCoverageProofCommentPage(apiPath, keepStart, 1);
  const last = fetchLastPrCloseCoverageProofComments(apiPath, total, keepEnd);
  return { comments: [...first, ...last], total };
}

function fetchPrCloseCoverageProofCommentWindowWithoutCount(
  apiPath: string,
  limit: number,
): { comments: JsonValue[]; total: number } {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit <= 0) return { comments: [], total: 0 };
  const first = fetchPrCloseCoverageProofCommentPageWithHeaders(apiPath, GITHUB_MAX_PAGE_SIZE, 1);
  const lastPage =
    first.lastPageNumber ?? (first.comments.length < GITHUB_MAX_PAGE_SIZE ? 1 : null);
  if (lastPage === null) {
    const comments = ghPaged(apiPath);
    return { comments, total: comments.length };
  }
  if (lastPage <= 1) {
    return {
      comments: first.comments,
      total: first.comments.length,
    };
  }

  const last = fetchPrCloseCoverageProofCommentPageWithHeaders(
    apiPath,
    GITHUB_MAX_PAGE_SIZE,
    lastPage,
  ).comments;
  const total = Math.max(0, (lastPage - 1) * GITHUB_MAX_PAGE_SIZE + last.length);
  const keepStart = Math.floor(boundedLimit / 2);
  const keepEnd = Math.max(0, boundedLimit - keepStart);
  const head = first.comments.slice(0, keepStart);
  let tailSource = last;
  if (last.length < keepEnd && lastPage > 1) {
    const previous =
      lastPage - 1 === 1
        ? first.comments
        : fetchPrCloseCoverageProofCommentPage(apiPath, GITHUB_MAX_PAGE_SIZE, lastPage - 1);
    tailSource = [...previous, ...last];
  }
  return { comments: [...head, ...tailSource.slice(-keepEnd)], total };
}

function fetchLastPrCloseCoverageProofComments(
  apiPath: string,
  total: number,
  limit: number,
): JsonValue[] {
  if (limit <= 0) return [];
  const lastPage = Math.max(1, Math.ceil(total / GITHUB_MAX_PAGE_SIZE));
  const lastPageComments = fetchPrCloseCoverageProofCommentPage(
    apiPath,
    GITHUB_MAX_PAGE_SIZE,
    lastPage,
  );
  if (lastPageComments.length >= limit || lastPage <= 1) {
    return lastPageComments.slice(Math.max(0, lastPageComments.length - limit));
  }
  const previousPageComments = fetchPrCloseCoverageProofCommentPage(
    apiPath,
    GITHUB_MAX_PAGE_SIZE,
    lastPage - 1,
  );
  return [...previousPageComments, ...lastPageComments].slice(-limit);
}

function fetchPrCloseCoverageProofCommentPage(
  apiPath: string,
  perPage: number,
  page: number,
): JsonValue[] {
  const entries = ghJson<JsonValue[]>(["api", githubLimitedPagePath(apiPath, perPage, page)]);
  return Array.isArray(entries) ? entries : [];
}

function fetchPrCloseCoverageProofCommentPageWithHeaders(
  apiPath: string,
  perPage: number,
  page: number,
): { comments: JsonValue[]; lastPageNumber: number | null } {
  const limitedPath = githubLimitedPagePath(apiPath, perPage, page);
  const output = ghWithRetry(["api", "-i", limitedPath]);
  const { body, headers } = splitGithubResponse(output);
  const entries = JSON.parse(body || "[]") as JsonValue;
  return {
    comments: Array.isArray(entries) ? entries : [],
    lastPageNumber: githubLastPageNumber(headers),
  };
}

function splitGithubResponse(output: string): { headers: string; body: string } {
  const normalized = output.replace(/\r\n/g, "\n");
  const separator = normalized.lastIndexOf("\n\n");
  if (separator < 0) return { headers: "", body: normalized };
  return {
    headers: normalized.slice(0, separator),
    body: normalized.slice(separator + 2),
  };
}

function githubLastPageNumber(headers: string): number | null {
  for (const line of headers.split("\n")) {
    const delimiter = line.indexOf(":");
    if (delimiter <= 0) continue;
    if (line.slice(0, delimiter).trim().toLowerCase() !== "link") continue;
    for (const part of line.slice(delimiter + 1).split(",")) {
      if (!part.includes('rel="last"')) continue;
      const page = part.match(/[?&]page=(\d+)/)?.[1];
      if (!page) continue;
      const value = Number(page);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
  }
  return null;
}

function compactPrCloseCoverageProofCommentWindow(
  comments: JsonValue[],
  total: number,
  limit: number,
): unknown[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const boundedTotal = Math.max(0, Math.floor(total));
  if (boundedTotal <= boundedLimit && comments.length <= boundedLimit) {
    return comments.map(compactPrCloseCoverageProofComment);
  }
  if (boundedLimit === 0) {
    return [{ omitted: boundedTotal, note: "comments omitted from proof context" }];
  }
  const keepStart = Math.floor(boundedLimit / 2);
  const keepEnd = Math.max(0, boundedLimit - keepStart);
  const omitted = Math.max(0, boundedTotal - keepStart - keepEnd);
  return [
    ...comments.slice(0, keepStart).map(compactPrCloseCoverageProofComment),
    ...(omitted > 0 ? [{ omitted, note: "middle comments omitted from proof context" }] : []),
    ...comments.slice(comments.length - keepEnd).map(compactPrCloseCoverageProofComment),
  ];
}

function prCloseCoverageProofRelationshipSignals({ action, actionName, coveringRef }: LooseRecord) {
  const signals = [
    `action: ${actionName}`,
    `covering_ref: #${coveringRef}`,
    stringFromUnknown(action.reason),
    stringFromUnknown(action.comment),
    ...(Array.isArray(action.evidence) ? action.evidence : []).map(compactSignalText),
  ];
  return signals.filter((signal: JsonValue) => typeof signal === "string" && signal.trim());
}

function prCloseCoverageProofRuntime() {
  const ghToken = stringSetting(process.env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN, "");
  const runtime = {
    model: stringSetting(
      args["pr-close-coverage-proof-model"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_MODEL ??
        process.env.CLAWSWEEPER_MODEL,
      "internal",
    ),
    reasoningEffort: stringSetting(
      args["pr-close-coverage-proof-reasoning-effort"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_REASONING_EFFORT,
      "high",
    ),
    sandboxMode: stringSetting(
      args["pr-close-coverage-proof-sandbox"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_SANDBOX,
      "read-only",
    ),
    serviceTier: stringSetting(
      args["pr-close-coverage-proof-service-tier"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_SERVICE_TIER,
      "",
    ),
    timeoutMs: positiveIntegerSetting(
      args["pr-close-coverage-proof-timeout-ms"] ??
        process.env.CLAWSWEEPER_PR_CLOSE_COVERAGE_PROOF_TIMEOUT_MS,
      900_000,
    ),
    workDir: path.join(path.dirname(resultPath), "pr-close-coverage-proof"),
    rootDir: repoRoot(),
    schemaPath: path.join(repoRoot(), "schema/clawsweeper-pr-close-coverage-proof.schema.json"),
    promptTemplate: fs.readFileSync(
      path.join(repoRoot(), "prompts/pr-close-coverage-proof.md"),
      "utf8",
    ),
  };
  return ghToken ? { ...runtime, ghToken } : runtime;
}

function validateMergeablePullRequest({
  pullRequest,
  view,
  allowedMergeStates = CLEAN_MERGE_STATES,
}: LooseRecord) {
  const hardBlock = validateMergeablePullRequestHard({ pullRequest, view });
  if (hardBlock) return hardBlock;
  return validateMergeablePullRequestReadiness({ view, allowedMergeStates });
}

function validateMergeablePullRequestHard({ pullRequest, view }: LooseRecord) {
  if (pullRequest.state !== "open") return `pull request is ${pullRequest.state}`;
  if (pullRequest.draft || view.isDraft) return "pull request is draft";
  if (String(view.baseRefName ?? pullRequest.base?.ref ?? "") !== "main")
    return "pull request base is not main";
  if (["CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(String(view.reviewDecision ?? ""))) {
    return `review decision is ${view.reviewDecision}`;
  }
  const terminalCheckBlock = validateTerminalStatusChecks(view.statusCheckRollup ?? []);
  if (terminalCheckBlock) return terminalCheckBlock;
  const viewAutomergeMethodBlock = squashAutomergeMethodBlock(view.autoMergeRequest);
  if (viewAutomergeMethodBlock) return viewAutomergeMethodBlock;
  const restAutomergeMethodBlock = squashAutomergeMethodBlock(pullRequest.auto_merge);
  if (restAutomergeMethodBlock) return restAutomergeMethodBlock;
  const queueMethodBlock = squashMergeQueueMethodBlock(view, pullRequest);
  if (queueMethodBlock) return queueMethodBlock;
  return "";
}

function validateMergeablePullRequestReadiness({
  view,
  allowedMergeStates = CLEAN_MERGE_STATES,
}: LooseRecord) {
  if (view.mergeable !== "MERGEABLE") return `mergeable state is ${view.mergeable || "unknown"}`;
  if (!allowedMergeStates.has(String(view.mergeStateStatus ?? ""))) {
    return `merge state status is ${view.mergeStateStatus || "unknown"}`;
  }
  const checkBlock = validateStatusChecks(view.statusCheckRollup ?? []);
  if (checkBlock) return checkBlock;
  return "";
}

function validateStatusChecks(checks: LooseRecord[]) {
  if (!Array.isArray(checks) || checks.length === 0) return "no PR checks found";
  const terminalBlock = validateTerminalStatusChecks(checks);
  if (terminalBlock) return terminalBlock;
  const blockers: LooseRecord[] = [];
  for (const check of checks) {
    const name = check.name ?? check.context ?? "unknown check";
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    if (status && !["COMPLETED", "SUCCESS"].includes(status)) {
      blockers.push(`${name}: ${status}`);
      continue;
    }
    if (conclusion && !PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
      blockers.push(`${name}: ${conclusion}`);
    }
  }
  if (blockers.length > 0) return `checks are not clean: ${blockers.slice(0, 5).join(", ")}`;
  return "";
}

function validateTerminalStatusChecks(checks: LooseRecord[]) {
  if (!Array.isArray(checks)) return "";
  const blockers: string[] = [];
  for (const check of checks) {
    const name = check.name ?? check.context ?? "unknown check";
    const status = String(check.status ?? "").toUpperCase();
    const state = String(check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    if (conclusion) {
      if (!PASSING_CHECK_CONCLUSIONS.has(conclusion)) blockers.push(`${name}: ${conclusion}`);
      continue;
    }
    if (!check.status && PASSING_CHECK_CONCLUSIONS.has(state)) continue;
    const terminalState = status || state;
    if (["COMPLETED", "SUCCESS"].includes(terminalState)) {
      blockers.push(`${name}: UNKNOWN (${terminalState} without conclusion)`);
      continue;
    }
    if (
      terminalState &&
      ["ACTION_REQUIRED", "CANCELLED", "ERROR", "FAILURE", "STALE", "TIMED_OUT"].includes(
        terminalState,
      )
    ) {
      blockers.push(`${name}: ${terminalState}`);
    }
  }
  if (blockers.length > 0) {
    return `checks are not clean: ${blockers.slice(0, 5).join(", ")}`;
  }
  return "";
}

function isApplicatorAction(action: LooseRecord) {
  return (
    CLOSE_ACTIONS.has(String(action?.action ?? "")) ||
    MERGE_ACTIONS.has(String(action?.action ?? ""))
  );
}

function normalizeIssueRef(value: JsonValue, expectedRepo: JsonValue = "") {
  return issueNumberFromRef(value, String(expectedRepo ?? ""));
}

function normalizeClassification(action: LooseRecord) {
  const raw = String(
    action.classification ?? action.close_reason ?? action.reason ?? "",
  ).toLowerCase();
  if (raw.includes("low_signal") || raw.includes("low-signal") || raw.includes("low signal"))
    return "low_signal";
  if (raw.includes("fixed") || raw.includes("candidate")) return "fixed_by_candidate";
  if (raw.includes("superseded") || raw.includes("supersede")) return "superseded";
  if (raw.includes("duplicate") || raw.includes("dupe")) return "duplicate";
  if (action.action === "close_fixed_by_candidate") return "fixed_by_candidate";
  if (action.action === "close_low_signal") return "low_signal";
  if (action.action === "close_superseded") return "superseded";
  if (action.action === "close_duplicate") return "duplicate";
  if (action.action === "post_merge_close") return "fixed_by_candidate";
  return raw;
}

function defaultIdempotencyKey(
  clusterId: string,
  target: LooseRecord,
  actionName: JsonValue,
  classification: JsonValue,
) {
  return sha256(`${clusterId}:${target}:${actionName}:${classification}`).slice(0, 24);
}

function idempotencyMarker(clusterId: string, target: LooseRecord, key: string) {
  return `<!-- clawsweeper-repair:close:${clusterId}:#${target}:${key} -->`;
}

function renderCloseComment({ action, classification, result, target, live }: LooseRecord) {
  if (typeof action.comment === "string" && action.comment.trim()) return action.comment;
  const canonical = normalizeIssueRef(action.canonical ?? action.duplicate_of);
  const candidateFix = normalizeIssueRef(
    action.candidate_fix ?? action.fixed_by ?? action.fix_candidate,
  );
  const title = typeof live.title === "string" ? live.title : `#${target}`;
  const reason = action.reason ? String(action.reason).trim() : closeReasonText(classification);
  return defaultCloseComment({
    action,
    classification,
    clusterId: result.cluster_id,
    target,
    title,
    canonical,
    candidateFix,
    reason,
    provenance: externalMessageProvenance({
      reviewedSha: action.reviewed_sha ?? action.head_sha ?? result.reviewed_sha ?? result.head_sha,
    }),
  });
}

function closeReasonText(classification: JsonValue) {
  switch (classification) {
    case "duplicate":
      return "duplicate of the canonical thread";
    case "superseded":
      return "superseded by the canonical candidate";
    case "fixed_by_candidate":
      return "covered by the candidate fix";
    case "low_signal":
      return "low-signal PR cleanup";
    default:
      return "closed by clawsweeper-repair";
  }
}

function validateLowSignalIntent({ job, action, actionName, classification }: LooseRecord) {
  if (job.frontmatter.triage_policy !== "low_signal_prs") {
    return "low-signal close requires triage_policy: low_signal_prs";
  }
  if (job.frontmatter.allow_low_signal_pr_close !== true) {
    return "low-signal close requires allow_low_signal_pr_close: true";
  }
  if (actionName !== "close_low_signal" || classification !== "low_signal") {
    return "low-signal close requires close_low_signal action and low_signal classification";
  }
  if (action.target_kind !== "pull_request") {
    return "low-signal close requires pull_request target_kind";
  }
  return "";
}

function validateLowSignalLiveState(
  repo: string,
  target: LooseRecord,
  live: LooseRecord,
  kind: string,
) {
  if (kind !== "pull_request") return "low-signal cleanup may only close pull requests";
  if (hasSecuritySignal(live)) return "security-sensitive target requires human triage";
  if (Array.isArray(live.assignees) && live.assignees.length > 0) {
    return "assigned PR has maintainer/human signal";
  }

  const pullRequest = fetchPullRequest(repo, target);
  if (
    (pullRequest.requested_reviewers ?? []).length > 0 ||
    (pullRequest.requested_teams ?? []).length > 0
  ) {
    return "requested reviewers or teams indicate active review signal";
  }

  const maintainerComments = ghPaged(`repos/${repo}/issues/${target}/comments`).filter(
    (comment: JsonValue) =>
      MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(comment.author_association)),
  );
  if (maintainerComments.length > 0) return "maintainer issue comment blocks low-signal auto-close";

  const maintainerReviews = ghPaged(`repos/${repo}/pulls/${target}/reviews`).filter(
    (review: JsonValue) =>
      MAINTAINER_AUTHOR_ASSOCIATIONS.has(normalizeAuthorAssociation(review.author_association)),
  );
  if (maintainerReviews.length > 0) return "maintainer PR review blocks low-signal auto-close";

  return "";
}

function hasSecuritySignal(issue: LooseRecord) {
  if (hasDeterministicSecuritySignal({ labels: issue.labels ?? [] })) return true;
  const comments = ghPaged(`repos/${result.repo}/issues/${issue.number}/comments?per_page=100`).map(
    (comment: JsonValue) => comment.body ?? "",
  );
  return hasDeterministicSecuritySignal({ comments });
}

function fetchIssue(repo: string, number: JsonValue) {
  return ghJson(["api", `repos/${repo}/issues/${number}`]);
}

function fetchPullRequest(repo: string, number: JsonValue) {
  return ghJson(["api", `repos/${repo}/pulls/${number}`]);
}

function fetchPullRequestOnce(repo: string, number: JsonValue) {
  return ghJsonOnce(["api", `repos/${repo}/pulls/${number}`]);
}

function fetchSquashMergeCommitProof(
  repo: string,
  pull: LooseRecord,
  expectedMessage: string,
): SquashMergeCommitProof | undefined {
  if (!pull.merged_at) return undefined;
  const mergeCommitSha = String(pull.merge_commit_sha ?? "").trim();
  const commit = mergeCommitSha
    ? ghJsonOnce(["api", `repos/${repo}/commits/${mergeCommitSha}`])
    : null;
  return { mergeCommitSha, commit, expectedMessage };
}

function pullRequestViewArgs(repo: string, number: JsonValue) {
  return [
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    [
      "baseRefName",
      "headRefOid",
      "isDraft",
      "isInMergeQueue",
      "mergeable",
      "mergeCommit",
      "mergeStateStatus",
      "mergedAt",
      "autoMergeRequest",
      "reviewDecision",
      "state",
      "statusCheckRollup",
      "title",
      "updatedAt",
      "url",
    ].join(","),
  ];
}

function fetchPullRequestView(repo: string, number: JsonValue) {
  return ghJson(pullRequestViewArgs(repo, number));
}

function fetchPullRequestViewOnce(repo: string, number: JsonValue) {
  return ghJsonOnce(pullRequestViewArgs(repo, number));
}

function findExistingComment(repo: string, number: JsonValue, marker: LooseRecord, body: string) {
  const comments = ghPaged(`repos/${repo}/issues/${number}/comments`);
  return comments.find(
    (comment: JsonValue) => comment.body?.includes(marker) || comment.body === body,
  );
}

function postIssueComment(
  repo: string,
  number: JsonValue,
  subjectKind: RepairLifecycleInput["subjectKind"],
  actionIdempotencyKey: string,
  body: string,
) {
  const payloadPath = writePayload(`comment-${number}`, { body });
  // A workflow rerun reconciles the marker; retrying this POST could create a duplicate comment.
  runApplyResultMutationWithRetry(
    applyResultLifecycle(Number(number), subjectKind),
    {
      kind: "apply_result_closeout_comment",
      identity: {
        repository: repo,
        number: Number(number),
        clusterId: String(result.cluster_id ?? ""),
        actionIdempotencyKey,
        operation: "closeout_comment_create",
      },
      component: "apply_result",
    },
    ["api", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "--input", payloadPath],
    1,
  );
}

function closeIssueOrPullRequest(
  repo: string,
  number: JsonValue,
  kind: string,
  classification: JsonValue,
  actionIdempotencyKey: string,
) {
  const lifecycle = applyResultLifecycle(
    Number(number),
    kind === "pull_request" ? "pull_request" : "issue",
  );
  const mutation = {
    kind: "apply_result_target_close",
    identity: {
      repository: repo,
      number: Number(number),
      clusterId: String(result.cluster_id ?? ""),
      actionIdempotencyKey,
      targetKind: kind,
      classification: String(classification ?? ""),
      operation: "target_close",
    },
    component: "apply_result",
  } satisfies Omit<RepairMutationOptions<string>, "operation" | "knownNoMutation">;
  if (kind === "pull_request") {
    runApplyResultMutationWithRetry(lifecycle, mutation, [
      "pr",
      "close",
      String(number),
      "--repo",
      repo,
    ]);
    return;
  }
  const stateReason = classification === "fixed_by_candidate" ? "completed" : "not_planned";
  const payloadPath = writePayload(`close-${number}`, {
    state: "closed",
    state_reason: stateReason,
  });
  runApplyResultMutationWithRetry(lifecycle, mutation, [
    "api",
    `repos/${repo}/issues/${number}`,
    "--method",
    "PATCH",
    "--input",
    payloadPath,
  ]);
}

function runApplyResultMutationWithRetry(
  lifecycle: RepairLifecycleInput,
  options: Omit<RepairMutationOptions<string>, "operation" | "knownNoMutation">,
  ghArgs: string[],
  retryAttempts = githubMutationRetryAttempts(),
): string {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    try {
      return runRepairMutation(lifecycle, {
        ...options,
        knownNoMutation: githubMutationRejectedBeforeWrite,
        operation: () => ghText(ghArgs),
      });
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      if (
        attempt >= retryAttempts ||
        retryKind === "none" ||
        githubMutationRejectedBeforeWrite(error)
      ) {
        throw error;
      }
      sleepMs(ghRetryWaitMs(retryKind, attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function githubMutationRetryAttempts(): number {
  const configured = process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
  if (configured == null || configured.trim() === "") return 6;
  const attempts = Number(configured);
  return Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 6;
}

function githubMutationRejectedBeforeWrite(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code ?? "")
      : "";
  if (code === "ENOENT" || code === "EACCES") return true;
  const detail = ghErrorText(error);
  return (
    /already exists/i.test(detail) ||
    /\b(?:HTTP|status(?: code)?)\s*:?\s*(?:400|401|403|404|405|406|407|410|411|413|414|415|416|417|421|422|426|428|431|451)\b/i.test(
      detail,
    )
  );
}

function writePayload(name: string, value: JsonValue) {
  const dir = path.join(repoRoot(), ".clawsweeper-repair", "payloads");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function normalizeAuthorAssociation(value: JsonValue) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "NONE";
}

function stringFromUnknown(value: JsonValue) {
  return typeof value === "string" ? value : "";
}

function stringOrNull(value: JsonValue) {
  return typeof value === "string" && value.trim() ? value : null;
}

function isFullCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function nonNegativeIntegerFromUnknown(value: JsonValue): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function compactSignalText(value: JsonValue) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function stringSetting(value: JsonValue, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function positiveIntegerSetting(value: JsonValue, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
