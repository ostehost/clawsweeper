#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import {
  assertAllowedOwner,
  hasDeterministicSecuritySignal,
  parseArgs,
  parseJob,
  repoRoot,
  validateJob,
} from "./lib.js";
import { stripAnsi } from "./comment-router-utils.js";
import { externalMessageProvenance, postMergeCloseoutComment } from "./external-messages.js";
import {
  ghErrorText,
  ghJsonWithRetry as ghJson,
  ghPagedWithRetry as ghPaged,
  ghText,
  ghTextWithRetry as ghWithRetry,
} from "./github-cli.js";
import { ghRetryKind } from "../github-retry.js";
import { issueNumberFromRef, parsePullRequestUrl } from "./github-ref.js";
import { sleepMs } from "./timing.js";
import {
  CLAWSWEEPER_LABEL,
  CLAWSWEEPER_LABEL_COLOR,
  CLAWSWEEPER_LABEL_DESCRIPTION,
} from "./constants.js";
import { AUTOMERGE_LABEL } from "./comment-router-core.js";
import { numberEnv } from "./env-utils.js";
import {
  buildRepairSquashMergeMessage,
  writeRepairSquashMergeBody,
} from "./repair-merge-message.js";
import { isPassedStagedProofBundle } from "./staged-proof-gates.js";
import { runtimeStrictBaseBindingBlock } from "./strict-base-binding.js";
import { squashAutomergeMethodBlock, squashMergeQueueMethodBlock } from "./automerge-effect.js";
import { compactText as compactPlainText } from "./text-utils.js";
import {
  runVerifiedPublishedPullMutation,
  verifyPublishedPullContext,
} from "./execution-handoff.js";
import {
  recordRepairMutationObservedSafely,
  recordRepairWorkflowEvent,
  repairSourceRevision,
  repairWorkflowTerminalPhase,
  runRepairMutation,
  type RepairLifecycleInput,
  type RepairWorkflowPhase,
} from "./repair-action-ledger.js";
import {
  ensureExactHeadMergeClaim,
  exactHeadMergeClaimIdentity,
  exactHeadMergeClaimRecoveryDecision,
  exactHeadMergeClaimWorkflowRunEnv,
  exactHeadMergeClaimant,
  isTrustedExactHeadMergeClaimComment,
  isTrustedExactHeadMergeClaimDispatchComment,
  isTrustedExactHeadMergeClaimRecoveryComment,
  isTrustedExactHeadMergeClaimReleaseComment,
  markExactHeadMergeClaimDispatched,
  releaseExactHeadMergeClaim,
  type ExactHeadMergeClaimRequest,
  type ExactHeadMergeClaimResult,
} from "./exact-head-merge-claim.js";
import {
  issueImplementationPublishedHeadBlock,
  postFlightOutcomeExitCode,
  publicationOnlyPostFlightAction,
  shouldFinalizePublicationOnlyPostFlight,
  summarizePostFlightReport,
} from "./post-flight-report.js";

const PASSING_CHECK_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const FIX_PR_MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const FIX_PR_ACTIONS = new Set(["open_fix_pr", "repair_contributor_branch"]);
const FIX_PR_READY_STATUSES = new Set(["opened", "pushed"]);
const POST_MERGE_CLOSE_ACTIONS = new Set([
  "close_duplicate",
  "close_superseded",
  "close_fixed_by_candidate",
  "post_merge_close",
]);
const DEFAULT_IGNORED_CHECKS = ["auto-response", "Labeler", "Stale"];
const POST_FLIGHT_WAIT_MS = numberEnv("CLAWSWEEPER_POST_FLIGHT_WAIT_MS", 10 * 60 * 1000);
const POST_FLIGHT_POLL_MS = numberEnv("CLAWSWEEPER_POST_FLIGHT_POLL_MS", 15 * 1000);

const args = parseArgs(process.argv.slice(2));
const jobPath = args._[0];
const resultPathArg = args._[1];
const latest = Boolean(args.latest);
const dryRun = Boolean(args["dry-run"] || process.env.CLAWSWEEPER_POST_FLIGHT_DRY_RUN === "1");
const publicationVerification = args["publication-receipt"]
  ? {
      root: requiredOption("handoff-root"),
      publicationReceiptPath: requiredOption("publication-receipt"),
      validationReceiptPath: requiredOption("validation-receipt"),
      expectedAuthorizationSha256: requiredOption("authorization-sha256"),
      expectedValidationReceiptSha256: requiredOption("validation-receipt-sha256"),
      expectedPublicationReceiptSha256: requiredOption("publication-receipt-sha256"),
    }
  : null;
const publicationContext = publicationVerification
  ? verifyPublishedPullContext(publicationVerification)
  : null;
const publicationReceipt = publicationContext?.receipt ?? null;

if (!jobPath) {
  console.error("usage: node scripts/post-flight.ts <job.md> [result.json] [--latest] [--dry-run]");
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
  throw new Error("refusing post-flight: job frontmatter mode is not execute or autonomous");
}
if (process.env.CLAWSWEEPER_ALLOW_EXECUTE !== "1") {
  throw new Error("refusing post-flight: CLAWSWEEPER_ALLOW_EXECUTE must be 1");
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
  throw new Error(`refusing post-flight: result mode is ${result.mode}`);
}
recordPostFlightWorkflowEventSafely("started");
process.on("uncaughtExceptionMonitor", (error) => {
  recordPostFlightWorkflowEventSafely("failed", error);
});
process.on("exit", () => {
  recordPostFlightWorkflowEventSafely("finalized");
});

const fixReport = readSiblingJson(resultPath, "fix-execution-report.json");
const report: LooseRecord = {
  repo: result.repo,
  cluster_id: result.cluster_id,
  dry_run: dryRun,
  result_path: path.relative(repoRoot(), resultPath),
  post_flight_at: new Date().toISOString(),
  actions: [],
};

if (!fixReport) {
  report.actions.push({
    action: "post_flight",
    status: "skipped",
    reason: "no fix-execution-report.json",
  });
  process.exit(postFlightOutcomeExitCode(writeReport(report, resultPath).outcome));
}

const fixActions = publicationReceipt
  ? [publishedFixAction(fixReport, publicationReceipt)]
  : (fixReport.actions ?? []);
for (const action of fixActions) {
  if (!FIX_PR_ACTIONS.has(String(action.action ?? ""))) continue;
  const finalized = finalizeFixPr(action);
  report.actions.push(finalized);
  if (finalized.status === "executed" && !publicationReceipt) {
    report.actions.push(...finalizePostMergeCloseouts(action, finalized));
  }
}

if (report.actions.length === 0) {
  report.actions.push({
    action: "post_flight",
    status: "skipped",
    reason: "no ClawSweeper Repair fix PR actions to finalize",
  });
}

process.exitCode = postFlightOutcomeExitCode(writeReport(report, resultPath).outcome);

function finalizeFixPr(action: LooseRecord) {
  const base = {
    action: "finalize_fix_pr",
    source_action: action.action,
    source_status: action.status,
    target: action.pr_url ?? action.target ?? null,
  };

  if (!FIX_PR_READY_STATUSES.has(String(action.status ?? ""))) {
    return {
      ...base,
      status: "skipped",
      reason: `fix PR action status is ${action.status ?? "missing"}`,
    };
  }

  const parsed = parsePullRequestUrl(action.pr_url ?? action.target);
  if (!parsed || parsed.repo !== result.repo) {
    return { ...base, status: "blocked", reason: "fix PR URL is missing or outside target repo" };
  }

  if (isIssueImplementationJob()) {
    return finalizeIssueImplementationPr({
      base,
      parsed,
      expectedPublishedHeadSha: publicationReceipt?.published_head_sha ?? null,
    });
  }
  const deadline = Date.now() + POST_FLIGHT_WAIT_MS;
  let pull;
  let view;
  let prBase;
  let mergeBlock = "";
  let waitedMs = 0;
  for (;;) {
    pull = fetchPullRequest(result.repo, parsed.number);
    view = fetchPullRequestView(result.repo, parsed.number);
    prBase = { ...base, pr: `#${parsed.number}`, title: view.title ?? pull.title ?? null };
    const securityBlock = liveSecurityBlockReason(parsed.number, pull.labels ?? []);
    if (securityBlock) return { ...prBase, status: "blocked", reason: securityBlock };
    if (
      shouldFinalizePublicationOnlyPostFlight({
        hasPublicationReceipt: Boolean(publicationReceipt),
        frontmatter: job.frontmatter,
        automergeReplacement: isAutomergeReplacementMerge(action, pull),
      })
    ) {
      return publicationOnlyPostFlightAction({
        action,
        base: prBase,
        pull,
        view,
        publication: publicationContext!.publication,
        intent: publicationContext!.intent,
      });
    }
    const policyBlock = validateMergePolicy(action, pull);
    if (policyBlock) return { ...prBase, status: "blocked", reason: policyBlock };

    const existingMerge = confirmMergedPullSnapshot(pull, action.commit);
    if (existingMerge.block) {
      return { ...prBase, status: "blocked", reason: existingMerge.block };
    }
    if (existingMerge.mergedAt) {
      recordPostFlightMergeObserved(parsed.number, action.commit);
      return {
        ...prBase,
        status: "executed",
        reason: "already merged",
        merged_at: existingMerge.mergedAt,
        merge_commit_sha: pull.merge_commit_sha ?? null,
        waited_ms: waitedMs,
      };
    }

    mergeBlock = postFlightMergeRetryBlock({
      action,
      number: parsed.number,
      pull,
      view,
    });
    if (!mergeBlock) break;
    const waitable = shouldWaitForMergeReadiness({ mergeBlock, view });
    const deadlineExpired = Date.now() >= deadline;
    if (dryRun || !waitable || deadlineExpired) {
      return {
        ...prBase,
        status: "blocked",
        reason: mergeBlock,
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        ...(!dryRun && waitable && deadlineExpired ? { retry_recommended: true } : {}),
        waited_ms: waitedMs,
      };
    }
    const sleepFor = Math.min(POST_FLIGHT_POLL_MS, Math.max(0, deadline - Date.now()));
    sleepMs(sleepFor);
    waitedMs += sleepFor;
  }

  if (dryRun) {
    return {
      ...prBase,
      status: "planned",
      reason: "dry run",
      merge_method: "squash",
      waited_ms: waitedMs,
    };
  }

  if (process.env.CLAWSWEEPER_ALLOW_MERGE !== "1") {
    const securityBlock = liveSecurityBlockReason(
      parsed.number,
      fetchPullRequest(result.repo, parsed.number).labels ?? [],
    );
    if (securityBlock) return { ...prBase, status: "blocked", reason: securityBlock };
    const mutationBlock = postFlightPullMutationBlock(parsed.number);
    if (mutationBlock) return { ...prBase, status: "blocked", reason: mutationBlock };
    runVerifiedPostFlightPullMutation(parsed.number, () =>
      labelForClawSweeperReview(result.repo, parsed.number),
    );
    return {
      ...prBase,
      status: "blocked",
      reason: "merge requires CLAWSWEEPER_ALLOW_MERGE=1; labeled clawsweeper",
      merge_method: "squash",
      waited_ms: waitedMs,
    };
  }

  const mergeMessage = buildRepairSquashMergeMessage({
    target: parsed.number,
    title: view.title ?? pull.title,
    headSha: pull.head?.sha,
    preflight: action.merge_preflight,
    reason: "merged by ClawSweeper Repair post-flight",
  });
  const bodyFile = writeRepairSquashMergeBody(parsed.number, pull.head?.sha, mergeMessage.body);
  const mergeArgs = [
    "pr",
    "merge",
    String(parsed.number),
    "--repo",
    result.repo,
    "--squash",
    "--subject",
    String(mergeMessage.subject),
    "--body-file",
    bodyFile,
  ];
  if (pull.head?.sha) mergeArgs.push("--match-head-commit", String(pull.head.sha));
  const securityBlock = liveSecurityBlockReason(
    parsed.number,
    fetchPullRequest(result.repo, parsed.number).labels ?? [],
  );
  if (securityBlock) return { ...prBase, status: "blocked", reason: securityBlock };
  const mutationBlock = postFlightPullMutationBlock(parsed.number);
  if (mutationBlock) return { ...prBase, status: "blocked", reason: mutationBlock };
  let mergeAttempts = 0;
  for (;;) {
    let mergeAttempt: {
      policyBlock: string;
      claim: ExactHeadMergeClaimResult | null;
      pull: LooseRecord;
      view: LooseRecord;
      confirmation: ReturnType<typeof reconcileMergeState> | null;
      confirmationError: string;
      ambiguous: boolean;
      reconciliationOnly: boolean;
      claimReleaseRetry?: boolean;
    };
    let acquiredClaimId: number | null = null;
    let mergeRequestStarted = false;
    try {
      mergeAttempt = runVerifiedPostFlightPullMutation(parsed.number, () => {
        const finalPull = fetchPullRequest(result.repo, parsed.number);
        const finalView = fetchPullRequestView(result.repo, parsed.number);
        const policyBlock = postFlightMergeRetryBlock({
          action,
          number: parsed.number,
          pull: finalPull,
          view: finalView,
        });
        if (policyBlock) {
          return {
            policyBlock,
            claim: null,
            pull: finalPull,
            view: finalView,
            confirmation: null,
            confirmationError: "",
            ambiguous: false,
            reconciliationOnly: false,
          };
        }
        const claim = claimPostFlightMergeRequest(parsed.number, action.commit);
        if (
          claim.status === "blocked" ||
          claim.status === "unknown" ||
          claim.status === "recovered"
        ) {
          return {
            policyBlock: "",
            claim,
            pull: finalPull,
            view: finalView,
            confirmation: null,
            confirmationError: "",
            ambiguous: false,
            reconciliationOnly: true,
          };
        }
        if (claim.status === "existing") {
          try {
            const confirmation = reconcileMergeState(parsed.number, action.commit);
            return {
              policyBlock: "",
              claim,
              pull: confirmation.pull,
              view: confirmation.view,
              confirmation,
              confirmationError: "",
              ambiguous: false,
              reconciliationOnly: true,
            };
          } catch (error) {
            return {
              policyBlock: "",
              claim,
              pull: finalPull,
              view: finalView,
              confirmation: null,
              confirmationError: ghErrorText(error),
              ambiguous: false,
              reconciliationOnly: true,
            };
          }
        }
        if (claim.status !== "acquired") {
          throw new Error("exact-head merge claim reached an unsupported state");
        }
        acquiredClaimId = claim.claimId;
        const claimedPull = fetchPullRequest(result.repo, parsed.number);
        const claimedView = fetchPullRequestView(result.repo, parsed.number);
        const claimedConfirmation = {
          pull: claimedPull,
          view: claimedView,
          ...confirmPostFlightMergeSnapshot(claimedPull, claimedView, action.commit),
        };
        if (
          !claimedConfirmation.block &&
          (claimedConfirmation.mergedAt || claimedConfirmation.pendingReason)
        ) {
          return {
            policyBlock: "",
            claim,
            pull: claimedPull,
            view: claimedView,
            confirmation: claimedConfirmation,
            confirmationError: "",
            ambiguous: false,
            reconciliationOnly: true,
          };
        }
        const claimedPolicyBlock = postFlightMergeRetryBlock({
          action,
          number: parsed.number,
          pull: claimedPull,
          view: claimedView,
        });
        if (claimedPolicyBlock) {
          const release = releasePostFlightMergeClaim(parsed.number, action.commit, claim.claimId);
          return {
            policyBlock:
              release.status === "released"
                ? claimedPolicyBlock
                : `${claimedPolicyBlock}; ${release.reason}`,
            claim,
            pull: claimedPull,
            view: claimedView,
            confirmation: null,
            confirmationError: "",
            ambiguous: false,
            reconciliationOnly: false,
            claimReleaseRetry: release.status === "unknown",
          };
        }
        const mutation = runRepairMutation(postFlightLifecycle(null), {
          kind: "post_flight_merge",
          identity: postFlightMergeMutationIdentity(parsed.number, action.commit),
          component: "post_flight",
          operation: () => {
            const dispatchBoundary = markPostFlightMergeClaimDispatched(
              parsed.number,
              action.commit,
              claim.claimId,
            );
            if (dispatchBoundary.status !== "dispatched") {
              throw new Error(dispatchBoundary.reason);
            }
            mergeAttempts += 1;
            let commandError: unknown = null;
            mergeRequestStarted = true;
            try {
              ghText(mergeArgs);
            } catch (error) {
              commandError = error;
            }
            let confirmation: ReturnType<typeof reconcileMergeState>;
            try {
              confirmation = reconcileMergeState(parsed.number, action.commit);
            } catch (error) {
              return {
                confirmation: null,
                confirmationError: ghErrorText(error),
                ambiguous: commandError !== null,
              };
            }
            if (commandError !== null) {
              if ((confirmation.mergedAt || confirmation.pendingReason) && !confirmation.block) {
                return { confirmation, confirmationError: "", ambiguous: true };
              }
              throw commandError;
            }
            return { confirmation, confirmationError: "", ambiguous: false };
          },
          outcome: ({ confirmation }) =>
            (confirmation?.mergedAt || confirmation?.pendingReason) && !confirmation.block
              ? "accepted"
              : "unknown",
        });
        return {
          policyBlock: "",
          claim,
          pull: mutation.confirmation?.pull ?? finalPull,
          view: mutation.confirmation?.view ?? finalView,
          confirmation: mutation.confirmation,
          confirmationError: mutation.confirmationError,
          ambiguous: mutation.ambiguous,
          reconciliationOnly: false,
        };
      });
    } catch (error) {
      const detail = ghErrorText(error);
      if (acquiredClaimId && !mergeRequestStarted) {
        const release = releasePostFlightMergeClaim(parsed.number, action.commit, acquiredClaimId);
        return {
          ...prBase,
          status: "blocked",
          reason:
            release.status === "released"
              ? `post-claim merge preflight failed before dispatch: ${compactText(detail, 500)}`
              : `post-claim merge preflight failed before dispatch: ${compactText(detail, 500)}; ${release.reason}`,
          merge_method: "squash",
          ...(release.status !== "blocked" ? { retry_recommended: true } : {}),
          merge_attempts: mergeAttempts,
          waited_ms: waitedMs,
        };
      }
      let reconciliation: ReturnType<typeof reconcileMergeState>;
      try {
        reconciliation = reconcileMergeState(parsed.number, action.commit);
      } catch (reconciliationError) {
        return {
          ...prBase,
          status: "blocked",
          reason: `merge attempt failed and its outcome could not be confirmed: ${compactText(ghErrorText(reconciliationError), 500)}`,
          merge_method: "squash",
          retry_recommended: true,
          merge_attempts: mergeAttempts,
          waited_ms: waitedMs,
        };
      }
      pull = reconciliation.pull;
      view = reconciliation.view;
      prBase = { ...base, pr: `#${parsed.number}`, title: view.title ?? pull.title ?? null };
      if (reconciliation.mergedAt) {
        recordPostFlightMergeObserved(parsed.number, action.commit);
        return {
          ...prBase,
          status: "executed",
          reason: "merge confirmed after ambiguous response",
          merged_at: reconciliation.mergedAt,
          merge_commit_sha: pull.merge_commit_sha ?? null,
          merge_method: "squash",
          commit_subject: mergeMessage.subject,
          summary_lines: mergeMessage.summaryLines,
          fixup_lines: mergeMessage.fixupLines,
          merge_attempts: mergeAttempts,
          waited_ms: waitedMs,
        };
      }
      if (reconciliation.block) {
        return {
          ...prBase,
          status: "blocked",
          reason: reconciliation.block,
          merge_method: "squash",
          merge_attempts: mergeAttempts,
          waited_ms: waitedMs,
        };
      }
      if (reconciliation.pendingReason) {
        recordPostFlightMergeObserved(parsed.number, action.commit);
        return {
          ...prBase,
          status: "blocked",
          reason: reconciliation.pendingReason,
          merge_method: "squash",
          retry_recommended: true,
          merge_attempts: mergeAttempts,
          waited_ms: waitedMs,
        };
      }
      const retryBlock = postFlightMergeRetryBlock({
        action,
        number: parsed.number,
        pull,
        view,
      });
      if (retryBlock) {
        const retryRecommended = shouldWaitForMergeReadiness({ mergeBlock: retryBlock, view });
        return {
          ...prBase,
          status: "blocked",
          reason: retryBlock,
          merge_method: "squash",
          ...(retryRecommended ? { retry_recommended: true } : {}),
          merge_attempts: mergeAttempts,
          waited_ms: waitedMs,
        };
      }

      if (isRecoverableMergeRace(detail)) {
        return {
          ...prBase,
          status: "blocked",
          reason: `merge attempt needs branch refresh: ${compactText(detail, 500)}`,
          mergeable: view.mergeable ?? null,
          merge_state_status: view.mergeStateStatus ?? null,
          review_decision: view.reviewDecision ?? null,
          retry_recommended: true,
          merge_attempts: mergeAttempts,
          waited_ms: waitedMs,
        };
      }
      const retryKind = ghRetryKind(error);
      if (retryKind !== "none") {
        return {
          ...prBase,
          status: "blocked",
          reason: `merge attempt was ${retryKind} and GitHub did not confirm an exact-head merge effect: ${compactText(detail, 500)}`,
          mergeable: view.mergeable ?? null,
          merge_state_status: view.mergeStateStatus ?? null,
          review_decision: view.reviewDecision ?? null,
          retry_recommended: true,
          merge_attempts: mergeAttempts,
          waited_ms: waitedMs,
        };
      }
      throw error;
    }

    pull = mergeAttempt.pull;
    view = mergeAttempt.view;
    prBase = { ...base, pr: `#${parsed.number}`, title: view.title ?? pull.title ?? null };
    if (mergeAttempt.policyBlock) {
      const retryRecommended = shouldWaitForMergeReadiness({
        mergeBlock: mergeAttempt.policyBlock,
        view,
      });
      return {
        ...prBase,
        status: "blocked",
        reason: mergeAttempt.policyBlock,
        merge_method: "squash",
        ...(retryRecommended || mergeAttempt.claimReleaseRetry ? { retry_recommended: true } : {}),
        merge_attempts: mergeAttempts,
        waited_ms: waitedMs,
      };
    }
    if (
      mergeAttempt.claim?.status === "blocked" ||
      mergeAttempt.claim?.status === "unknown" ||
      mergeAttempt.claim?.status === "recovered"
    ) {
      return {
        ...prBase,
        status: "blocked",
        reason: mergeAttempt.claim.reason,
        merge_method: "squash",
        ...(mergeAttempt.claim.status === "unknown" || mergeAttempt.claim.status === "recovered"
          ? { retry_recommended: true }
          : {}),
        merge_attempts: mergeAttempts,
        waited_ms: waitedMs,
      };
    }

    const confirmation = mergeAttempt.confirmation;
    if (!confirmation) {
      return {
        ...prBase,
        status: "blocked",
        reason: `merge outcome could not be confirmed: ${compactText(mergeAttempt.confirmationError, 500)}`,
        merge_method: "squash",
        retry_recommended: true,
        merge_attempts: mergeAttempts,
        waited_ms: waitedMs,
      };
    }
    pull = confirmation.pull;
    view = confirmation.view;
    prBase = { ...base, pr: `#${parsed.number}`, title: view.title ?? pull.title ?? null };
    if (confirmation.block) {
      return {
        ...prBase,
        status: "blocked",
        reason: confirmation.block,
        merge_method: "squash",
        merge_attempts: mergeAttempts,
        waited_ms: waitedMs,
      };
    }
    if (confirmation.pendingReason) {
      if (mergeAttempt.reconciliationOnly) {
        recordPostFlightMergeObserved(parsed.number, action.commit);
      }
      return {
        ...prBase,
        status: "blocked",
        reason: confirmation.pendingReason,
        merge_method: "squash",
        retry_recommended: true,
        merge_attempts: mergeAttempts,
        waited_ms: waitedMs,
      };
    }
    if (!confirmation.mergedAt) {
      return {
        ...prBase,
        status: "blocked",
        reason:
          mergeAttempt.reconciliationOnly && mergeAttempt.claim?.status === "existing"
            ? mergeAttempt.claim.reason
            : "merge command completed but GitHub has not confirmed the pull request as merged",
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        live_state: pull.state ?? view.state ?? null,
        retry_recommended: true,
        merge_attempts: mergeAttempts,
        waited_ms: waitedMs,
      };
    }
    if (mergeAttempt.reconciliationOnly) {
      recordPostFlightMergeObserved(parsed.number, action.commit);
    }
    return {
      ...prBase,
      status: "executed",
      reason: mergeAttempt.ambiguous
        ? "merge confirmed after ambiguous response"
        : mergeAttempt.reconciliationOnly
          ? "merge confirmed for durably claimed exact head"
          : "merged by ClawSweeper Repair post-flight",
      merged_at: confirmation.mergedAt,
      merge_commit_sha: pull.merge_commit_sha ?? null,
      merge_method: "squash",
      commit_subject: mergeMessage.subject,
      summary_lines: mergeMessage.summaryLines,
      fixup_lines: mergeMessage.fixupLines,
      merge_attempts: mergeAttempts,
      waited_ms: waitedMs,
    };
  }
}

function reconcileMergeState(number: number, expectedHeadSha: JsonValue) {
  const pull = fetchPullRequest(result.repo, number);
  const view = fetchPullRequestView(result.repo, number);
  return {
    pull,
    view,
    ...confirmPostFlightMergeSnapshot(pull, view, expectedHeadSha),
  };
}

function confirmPostFlightMergeSnapshot(
  pull: LooseRecord,
  view: LooseRecord,
  expectedHeadSha: JsonValue,
) {
  const merged = confirmMergedPullSnapshot(pull, expectedHeadSha);
  if (merged.block || merged.mergedAt) return { ...merged, pendingReason: "" };
  const viewAutomergeMethodBlock = squashAutomergeMethodBlock(view.autoMergeRequest);
  if (viewAutomergeMethodBlock) {
    return { mergedAt: null, block: viewAutomergeMethodBlock, pendingReason: "" };
  }
  const restAutomergeMethodBlock = squashAutomergeMethodBlock(pull.auto_merge);
  if (restAutomergeMethodBlock) {
    return { mergedAt: null, block: restAutomergeMethodBlock, pendingReason: "" };
  }
  const queueMethodBlock = squashMergeQueueMethodBlock(view, pull);
  if (queueMethodBlock) {
    return { mergedAt: null, block: queueMethodBlock, pendingReason: "" };
  }
  return {
    mergedAt: null,
    block: "",
    pendingReason: exactHeadPendingMergeReason(view, expectedHeadSha),
  };
}

function confirmMergedPullSnapshot(pull: LooseRecord, expectedHeadSha: JsonValue) {
  // Keep the merge timestamp and authorized head bound to one GitHub response.
  const mergedAt = pull.merged_at ?? null;
  if (!mergedAt) return { mergedAt: null, block: "" };
  const mergedHead = String(pull.head?.sha ?? "");
  if (!isFullCommitSha(expectedHeadSha) || mergedHead !== expectedHeadSha) {
    return {
      mergedAt: null,
      block: "merged pull request head does not match the authorized repair commit",
    };
  }
  return { mergedAt, block: "" };
}

function postFlightMergeMutationIdentity(number: number, headSha: JsonValue) {
  return {
    repo: result.repo,
    number,
    headSha: headSha ?? null,
    method: "squash",
  };
}

function claimPostFlightMergeRequest(
  number: number,
  headSha: JsonValue,
): ExactHeadMergeClaimResult {
  try {
    const request = postFlightMergeClaimRequest(number, headSha);
    return ensureExactHeadMergeClaim(request, {
      listComments: () =>
        ghPaged<LooseRecord>(
          `repos/${request.repository}/issues/${request.number}/comments?per_page=100`,
        ),
      createComment: (body, context) =>
        runRepairMutation(postFlightLifecycle(null), {
          kind:
            context.kind === "claim"
              ? "post_flight_merge_claim"
              : "post_flight_merge_claim_recovery",
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
            ghJson(
              [
                "api",
                `repos/${request.repository}/issues/${request.number}/comments`,
                "-f",
                `body=${body}`,
              ],
              { attempts: 1 },
            ),
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
          ghJson(["api", path], {
            attempts: 1,
            env: exactHeadMergeClaimWorkflowRunEnv(),
          }),
        ),
    });
  } catch (error) {
    return {
      status: "unknown",
      reason: `exact-head merge claim could not be prepared: ${compactText(ghErrorText(error), 500)}`,
      claimId: null,
    };
  }
}

function markPostFlightMergeClaimDispatched(number: number, headSha: JsonValue, claimId: number) {
  const request = postFlightMergeClaimRequest(number, headSha);
  return markExactHeadMergeClaimDispatched(request, claimId, {
    listComments: () =>
      ghPaged<LooseRecord>(
        `repos/${request.repository}/issues/${request.number}/comments?per_page=100`,
      ),
    createComment: (body) =>
      runRepairMutation(postFlightLifecycle(null), {
        kind: "post_flight_merge_claim_dispatch",
        identity: { ...exactHeadMergeClaimIdentity(request), claimId },
        component: "merge_claim",
        operation: () =>
          ghJson(
            [
              "api",
              `repos/${request.repository}/issues/${request.number}/comments`,
              "-f",
              `body=${body}`,
            ],
            { attempts: 1 },
          ),
        outcome: (comment) =>
          isTrustedExactHeadMergeClaimDispatchComment(comment, request, claimId)
            ? "accepted"
            : "unknown",
      }),
  });
}

function releasePostFlightMergeClaim(number: number, headSha: JsonValue, claimId: number) {
  try {
    const request = postFlightMergeClaimRequest(number, headSha);
    return releaseExactHeadMergeClaim(request, claimId, {
      listComments: () =>
        ghPaged<LooseRecord>(
          `repos/${request.repository}/issues/${request.number}/comments?per_page=100`,
        ),
      createComment: (body) =>
        runRepairMutation(postFlightLifecycle(null), {
          kind: "post_flight_merge_claim_release",
          identity: { ...exactHeadMergeClaimIdentity(request), claimId },
          component: "merge_claim",
          operation: () =>
            ghJson(
              [
                "api",
                `repos/${request.repository}/issues/${request.number}/comments`,
                "-f",
                `body=${body}`,
              ],
              { attempts: 1 },
            ),
          outcome: (comment) =>
            isTrustedExactHeadMergeClaimReleaseComment(comment, request, claimId)
              ? "accepted"
              : "unknown",
        }),
    });
  } catch (error) {
    return {
      status: "unknown" as const,
      reason: `exact-head merge claim release failed: ${compactText(ghErrorText(error), 500)}`,
      claimId,
    };
  }
}

function postFlightMergeClaimRequest(
  number: number,
  headSha: JsonValue,
): ExactHeadMergeClaimRequest {
  return {
    repository: result.repo,
    number,
    headSha: String(headSha ?? ""),
    method: "squash",
    owner: "post_flight",
    claimant: exactHeadMergeClaimant("post_flight"),
    appId: Number(process.env.CLAWSWEEPER_AUTHENTICATED_APP_ID),
    appSlug: String(process.env.CLAWSWEEPER_AUTHENTICATED_APP_SLUG ?? ""),
  };
}

function exactHeadPendingMergeReason(view: LooseRecord, expectedHeadSha: JsonValue) {
  if (!isFullCommitSha(expectedHeadSha) || view.headRefOid !== expectedHeadSha) return "";
  if (view.isInMergeQueue === true) {
    return "exact-head merge request is queued; waiting for GitHub outcome";
  }
  if (view.autoMergeRequest) {
    return "exact-head auto-merge request is pending; waiting for GitHub outcome";
  }
  return "";
}

function recordPostFlightMergeObserved(number: number, headSha: JsonValue) {
  recordRepairMutationObservedSafely(postFlightLifecycle(null), {
    kind: "post_flight_merge",
    identity: postFlightMergeMutationIdentity(number, headSha),
    component: "post_flight",
  });
}

function postFlightMergeRetryBlock({
  action,
  number,
  pull,
  view,
}: {
  action: LooseRecord;
  number: number;
  pull: LooseRecord;
  view: LooseRecord;
}) {
  const securityBlock = liveSecurityBlockReason(number, pull.labels ?? []);
  if (securityBlock) return securityBlock;
  const policyBlock = validateMergePolicy(action, pull);
  if (policyBlock) return policyBlock;
  const proofBlock = validateFixPrMergeProof({
    pull,
    view,
    preflight: action.merge_preflight,
    expectedHeadSha: action.commit,
    validationProofPlan: fixReport.validation_proof_plan,
  });
  if (proofBlock) return proofBlock;
  const hardReadinessBlock = validateFixPrMergeHardReadiness({ pull, view });
  if (hardReadinessBlock) return hardReadinessBlock;
  const strictBaseBindingBlock = runtimeStrictBaseBindingBlock({
    repo: result.repo,
    baseBranch: String(view.baseRefName ?? pull.base?.ref ?? ""),
    policyReadJson: rulesetPolicyReader(),
  });
  if (strictBaseBindingBlock) return strictBaseBindingBlock;
  const pendingReason = exactHeadPendingMergeReason(view, action.commit);
  if (pendingReason) return pendingReason;
  return validateFixPrMergeReadiness({ pull, view });
}

function publishedFixAction(fixReport: LooseRecord, receipt: LooseRecord): LooseRecord {
  const expectedAction =
    receipt.operation === "update_source_pr" ? "repair_contributor_branch" : "open_fix_pr";
  const prepared = (fixReport.actions ?? []).filter(
    (action: JsonValue) =>
      action?.action === expectedAction &&
      action?.status === "prepared" &&
      action?.commit === receipt.published_head_sha,
  );
  if (prepared.length !== 1) {
    throw new Error("publication receipt does not match one exact prepared fix action");
  }
  return {
    ...prepared[0],
    action: expectedAction,
    status: receipt.operation === "update_source_pr" ? "pushed" : "opened",
    target: receipt.target_pr_url,
    pr_url: receipt.target_pr_url,
    commit: receipt.published_head_sha,
  };
}

function requiredOption(name: string): string {
  const value = String(args[name] ?? "").trim();
  if (!value) throw new Error(`--${name} is required with --publication-receipt`);
  return value;
}

function postFlightPullMutationBlock(number: number): string {
  if (!publicationVerification || !publicationReceipt) {
    return "post-flight pull mutation requires a verified publication checkpoint";
  }
  if (
    publicationReceipt.target_repo !== result.repo ||
    publicationReceipt.target_pr_number !== number
  ) {
    return "post-flight pull mutation target differs from the publication checkpoint";
  }
  return "";
}

function runVerifiedPostFlightPullMutation<T>(number: number, mutation: () => T): T {
  const block = postFlightPullMutationBlock(number);
  if (block || !publicationVerification) throw new Error(block);
  return runVerifiedPublishedPullMutation({
    ...publicationVerification,
    mutation: ({ receipt, intent }) => {
      if (
        receipt.target_repo !== result.repo ||
        receipt.target_pr_number !== number ||
        intent.target_repo !== result.repo
      ) {
        throw new Error("post-flight pull mutation escaped the verified publication target");
      }
      return mutation();
    },
  });
}

function rulesetPolicyReader() {
  const token = process.env.CLAWSWEEPER_RULESET_GH_TOKEN?.trim();
  if (!token) return undefined;
  return (ghArgs: string[]) =>
    ghJson(ghArgs, {
      env: { GH_TOKEN: token, GITHUB_TOKEN: token },
    });
}

function finalizeIssueImplementationPr({ base, parsed, expectedPublishedHeadSha }: LooseRecord) {
  const deadline = Date.now() + POST_FLIGHT_WAIT_MS;
  let waitedMs = 0;
  for (;;) {
    const pull = fetchPullRequest(result.repo, parsed.number);
    const view = fetchPullRequestView(result.repo, parsed.number);
    const prBase = { ...base, pr: `#${parsed.number}`, title: view.title ?? pull.title ?? null };
    const securityBlock = liveSecurityBlockReason(parsed.number, pull.labels ?? []);
    if (securityBlock) {
      return {
        ...prBase,
        status: "blocked",
        reason: securityBlock,
        waited_ms: waitedMs,
      };
    }

    const receiptHeadBlock = issueImplementationPublishedHeadBlock({
      expectedPublishedHeadSha,
      pull,
      view,
    });
    if (receiptHeadBlock) {
      return {
        ...prBase,
        status: "blocked",
        reason: receiptHeadBlock,
        waited_ms: waitedMs,
      };
    }

    if (pull.state !== "open") {
      return {
        ...prBase,
        status: "blocked",
        reason: `pull request is ${pull.state}`,
        waited_ms: waitedMs,
      };
    }

    const checkBlock = validateStatusChecks(view.statusCheckRollup ?? []);
    if (!checkBlock) {
      return {
        ...prBase,
        status: "ready",
        reason:
          "issue implementation PR checks are green; merge intentionally blocked for this lane",
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        ...(expectedPublishedHeadSha
          ? { published_head_sha: String(expectedPublishedHeadSha) }
          : {}),
        waited_ms: waitedMs,
      };
    }

    const waitable = shouldWaitForIssueImplementationChecks(checkBlock, view);
    const deadlineExpired = Date.now() >= deadline;
    if (dryRun || !waitable || deadlineExpired) {
      return {
        ...prBase,
        status: "blocked",
        reason: checkBlock,
        mergeable: view.mergeable ?? null,
        merge_state_status: view.mergeStateStatus ?? null,
        review_decision: view.reviewDecision ?? null,
        ...(!dryRun && waitable && deadlineExpired ? { retry_recommended: true } : {}),
        waited_ms: waitedMs,
      };
    }

    const sleepFor = Math.min(POST_FLIGHT_POLL_MS, Math.max(0, deadline - Date.now()));
    sleepMs(sleepFor);
    waitedMs += sleepFor;
  }
}

function finalizePostMergeCloseouts(fixAction: LooseRecord, finalized: LooseRecord) {
  const fixPr = parsePullRequestUrl(fixAction.pr_url ?? fixAction.target);
  if (!fixPr) return [];
  const fixRef = `#${fixPr.number}`;
  const fixUrl = `https://github.com/${result.repo}/pull/${fixPr.number}`;
  const closeouts: JsonValue[] = [];
  for (const action of result.actions ?? []) {
    const actionName = String(action.action ?? "");
    if (!POST_MERGE_CLOSE_ACTIONS.has(actionName)) continue;
    if (!["blocked", "planned"].includes(String(action.status ?? ""))) continue;
    const target = normalizeIssueRef(action.target);
    if (!target || target === fixPr.number) continue;
    const candidateFix = normalizeIssueRef(
      action.candidate_fix ?? action.fixed_by ?? action.fix_candidate,
    );
    if (candidateFix !== fixPr.number) continue;
    closeouts.push(
      finalizePostMergeCloseout({ action, actionName, target, fixRef, fixUrl, finalized }),
    );
  }
  return closeouts;
}

function finalizePostMergeCloseout({
  action,
  actionName,
  target,
  fixRef,
  fixUrl,
  finalized,
}: LooseRecord) {
  const base = {
    action: "post_merge_closeout",
    source_action: actionName,
    target: `#${target}`,
    canonical: action.canonical ?? undefined,
    candidate_fix: fixRef,
    fix_pr: fixUrl,
  };
  const live = fetchIssue(result.repo, target);
  if (live.state !== "open") {
    return {
      ...base,
      status: live.state === "closed" ? "executed" : "skipped",
      reason:
        live.state === "closed"
          ? "target already closed after canonical fix merged"
          : `target is ${live.state}`,
      live_state: live.state,
      merge_commit_sha: finalized.merge_commit_sha ?? null,
    };
  }
  if (hasLiveSecuritySignal(target, live.labels ?? [])) {
    return {
      ...base,
      status: "blocked",
      reason: "security-sensitive target requires central security triage",
    };
  }
  if (dryRun) {
    return {
      ...base,
      status: "planned",
      reason: "dry run",
      merge_commit_sha: finalized.merge_commit_sha ?? null,
    };
  }

  const beforeLabelSecurityBlock = liveSecurityBlockReason(target, live.labels ?? []);
  if (beforeLabelSecurityBlock) {
    return { ...base, status: "blocked", reason: beforeLabelSecurityBlock };
  }
  try {
    runRepairMutation(postFlightLifecycle(target), {
      kind: "closeout_label",
      identity: { repo: result.repo, number: target, label: "clawsweeper" },
      component: "post_flight",
      operation: () =>
        ghText([
          "issue",
          "edit",
          String(target),
          "--repo",
          result.repo,
          "--add-label",
          "clawsweeper",
        ]),
    });
  } catch {
    // Helpful metadata must not block the verified closeout path.
  }
  const beforeCommentSecurityBlock = freshLiveSecurityBlockReason(target);
  if (beforeCommentSecurityBlock) {
    return { ...base, status: "blocked", reason: beforeCommentSecurityBlock };
  }
  runPostFlightMutation(
    "closeout_comment",
    {
      repo: result.repo,
      number: target,
      fixUrl,
      mergeCommitSha: finalized.merge_commit_sha ?? null,
    },
    () =>
      ghText([
        "issue",
        "comment",
        String(target),
        "--repo",
        result.repo,
        "--body",
        postMergeCloseoutComment({
          actionName,
          fixUrl,
          provenance: externalMessageProvenance({
            reviewedSha:
              finalized.merge_commit_sha ?? action.commit ?? result.reviewed_sha ?? result.head_sha,
          }),
        }),
      ]),
  );
  const beforeCloseSecurityBlock = freshLiveSecurityBlockReason(target);
  if (beforeCloseSecurityBlock) {
    return { ...base, status: "blocked", reason: beforeCloseSecurityBlock };
  }
  if (live.pull_request) {
    runPostFlightMutation(
      "source_pull_request_closeout",
      { repo: result.repo, number: target, fixUrl },
      () => ghText(["pr", "close", String(target), "--repo", result.repo]),
    );
  } else {
    runPostFlightMutation(
      "source_issue_closeout",
      { repo: result.repo, number: target, fixUrl, reason: "completed" },
      () =>
        ghText(["issue", "close", String(target), "--repo", result.repo, "--reason", "completed"]),
    );
  }
  const after = fetchIssue(result.repo, target);
  return {
    ...base,
    status: after.state === "closed" ? "executed" : "blocked",
    reason:
      after.state === "closed" ? "closed after canonical fix merged" : `target is ${after.state}`,
    live_state: after.state,
    merge_commit_sha: finalized.merge_commit_sha ?? null,
  };
}

function validateMergePolicy(action: LooseRecord, pull: LooseRecord) {
  if (isAutomergeReplacementMerge(action, pull)) return "";
  if (!job.frontmatter.allowed_actions.includes("merge")) return "job does not allow merge";
  if ((job.frontmatter.blocked_actions ?? []).includes("merge"))
    return "merge is blocked by job frontmatter";
  if (job.frontmatter.allow_merge !== true) return "merge requires allow_merge: true";
  return "";
}

function isAutomergeReplacementMerge(action: LooseRecord, pull: LooseRecord) {
  return (
    job.frontmatter.source === "pr_automerge" &&
    action.action === "open_fix_pr" &&
    result.fix_artifact?.repair_strategy === "replace_uneditable_branch" &&
    hasLabel(pull.labels, AUTOMERGE_LABEL)
  );
}

function isIssueImplementationJob() {
  return job.frontmatter.source === "issue_implementation";
}

function hasLabel(labels: LooseRecord[], wanted: string) {
  return (labels ?? []).some(
    (label: JsonValue) => String(label?.name ?? label).toLowerCase() === wanted.toLowerCase(),
  );
}

function labelForClawSweeperReview(repo: string, number: JsonValue) {
  ensureLabel(repo, CLAWSWEEPER_LABEL, CLAWSWEEPER_LABEL_COLOR, CLAWSWEEPER_LABEL_DESCRIPTION);
  try {
    runRepairMutation(postFlightLifecycle(Number(number)), {
      kind: "pull_request_label",
      identity: { repo, number: Number(number), label: CLAWSWEEPER_LABEL },
      component: "post_flight",
      operation: () =>
        ghText(["issue", "edit", String(number), "--repo", repo, "--add-label", CLAWSWEEPER_LABEL]),
    });
  } catch {
    // Helpful metadata must not block the verified repair path.
  }
}

function ensureLabel(repo: string, name: string, color: JsonValue, description: JsonValue) {
  try {
    runRepairMutation(postFlightLifecycle(null), {
      kind: "repository_label_create",
      identity: { repo, name, color, description },
      component: "post_flight",
      operation: () =>
        ghText([
          "label",
          "create",
          name,
          "--repo",
          repo,
          "--color",
          color,
          "--description",
          description,
        ]),
      knownNoMutation: (error) => /already exists/i.test(ghErrorText(error)),
    });
  } catch (error) {
    if (!/already exists/i.test(ghErrorText(error))) return;
  }
}

function postFlightLifecycle(number: number | null): RepairLifecycleInput {
  return {
    repository: result.repo,
    workKey: `post-flight:${result.cluster_id ?? result.run_id ?? result.reviewed_sha ?? "unknown"}`,
    ...(number && number > 0 ? { number } : {}),
    sourceRevision:
      repairSourceRevision(job.frontmatter) ??
      repairSourceRevision({ reviewed_sha: result.reviewed_sha ?? result.head_sha }),
    subjectKind: number && number > 0 ? "pull_request" : "workflow",
  };
}

function recordPostFlightWorkflowEventSafely(phase: RepairWorkflowPhase, error?: unknown) {
  try {
    recordRepairWorkflowEvent(postFlightLifecycle(null), {
      component: "post_flight",
      phase,
      ...(error === undefined ? {} : { error }),
    });
  } catch (receiptError) {
    console.error(
      `[action-ledger] failed to record post-flight workflow ${phase}: ${
        receiptError instanceof Error ? receiptError.message : String(receiptError)
      }`,
    );
  }
}

function runPostFlightMutation<T>(kind: string, identity: unknown, operation: () => T): T {
  return runRepairMutation(postFlightLifecycle(null), {
    kind,
    identity,
    component: "post_flight",
    operation,
  });
}

function hasLiveSecuritySignal(number: JsonValue, labels: LooseRecord[]) {
  if (hasDeterministicSecuritySignal({ labels })) return true;
  const bodies = ghWithRetry([
    "api",
    `repos/${result.repo}/issues/${number}/comments?per_page=100`,
    "--paginate",
    "--jq",
    ".[].body",
  ]);
  return hasDeterministicSecuritySignal({ comments: [bodies] });
}

function liveSecurityBlockReason(number: JsonValue, labels: LooseRecord[]) {
  return hasLiveSecuritySignal(number, labels)
    ? "security-sensitive target requires central security triage"
    : "";
}

function freshLiveSecurityBlockReason(number: JsonValue) {
  const issue = fetchIssue(result.repo, number);
  return liveSecurityBlockReason(number, issue.labels ?? []);
}

function validateFixPrMergeProof({
  pull,
  view,
  preflight,
  expectedHeadSha,
  validationProofPlan,
}: LooseRecord) {
  if (pull.state !== "open") return `pull request is ${pull.state}`;
  if (pull.draft || view.isDraft) return "pull request is draft";
  if (String(view.baseRefName ?? pull.base?.ref ?? "") !== "main")
    return "pull request base is not main";
  const preflightBlock = validateMergePreflight(preflight, {
    expectedHeadSha,
    liveHeadSha: pull.head?.sha,
    liveBaseSha: pull.base?.sha,
    validationProofPlan,
  });
  if (preflightBlock) return preflightBlock;

  return "";
}

function validateFixPrMergeHardReadiness({ pull, view }: LooseRecord) {
  if (view.reviewDecision === "CHANGES_REQUESTED") {
    return "review decision is CHANGES_REQUESTED";
  }

  const checkBlock = validateTerminalStatusChecks(view.statusCheckRollup ?? []);
  if (checkBlock) return checkBlock;
  const viewAutomergeMethodBlock = squashAutomergeMethodBlock(view.autoMergeRequest);
  if (viewAutomergeMethodBlock) return viewAutomergeMethodBlock;
  const restAutomergeMethodBlock = squashAutomergeMethodBlock(pull.auto_merge);
  if (restAutomergeMethodBlock) return restAutomergeMethodBlock;
  const queueMethodBlock = squashMergeQueueMethodBlock(view, pull);
  if (queueMethodBlock) return queueMethodBlock;

  return validateResolvedReviewThreads(result.repo, pull.number);
}

function validateFixPrMergeReadiness({ view }: LooseRecord) {
  if (view.mergeable !== "MERGEABLE") return `mergeable state is ${view.mergeable || "unknown"}`;
  if (!FIX_PR_MERGE_STATES.has(String(view.mergeStateStatus ?? ""))) {
    return `merge state status is ${view.mergeStateStatus || "unknown"}`;
  }
  if (view.reviewDecision === "REVIEW_REQUIRED") return "review decision is REVIEW_REQUIRED";

  const checkBlock = shouldRequirePrChecks()
    ? validateStatusChecks(view.statusCheckRollup ?? [])
    : "";
  if (checkBlock) return checkBlock;

  return "";
}

function validateMergePreflight(
  preflight: LooseRecord,
  {
    expectedHeadSha,
    liveHeadSha,
    liveBaseSha,
    validationProofPlan,
  }: {
    expectedHeadSha: unknown;
    liveHeadSha: unknown;
    liveBaseSha: unknown;
    validationProofPlan: unknown;
  },
) {
  if (!preflight || typeof preflight !== "object") return "merge_preflight is missing";
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
  const validationProof = preflight.validation_proof;
  if (!isPassedStagedProofBundle(validationProof, validationProofPlan)) {
    return "staged validation proof is incomplete or failed";
  }
  if (!isFullCommitSha(expectedHeadSha)) return "fix action commit is missing or malformed";
  if (!isFullCommitSha(liveHeadSha)) return "live pull request head is missing or malformed";
  if (!isFullCommitSha(liveBaseSha)) return "live pull request base is missing or malformed";
  if (validationProof.validated_head_sha !== expectedHeadSha) {
    return "staged validation proof does not match the fix action commit";
  }
  if (validationProof.validated_head_sha !== liveHeadSha) {
    return "staged validation proof does not match the live pull request head";
  }
  if (validationProof.validated_base_sha !== liveBaseSha) {
    return "staged validation proof does not match the live pull request base";
  }
  if (
    preflight.validated_head_sha !== validationProof.validated_head_sha ||
    preflight.validated_base_sha !== validationProof.validated_base_sha
  ) {
    return "merge preflight proof identity is inconsistent";
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
  return "";
}

function isFullCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function validateStatusChecks(checks: LooseRecord[]) {
  if (!Array.isArray(checks) || checks.length === 0) return "no PR checks found";
  const ignored = ignoredCheckNames();
  const blockers: LooseRecord[] = [];
  let considered = 0;
  for (const check of latestCheckRuns(checks)) {
    const name = String(check.name ?? check.context ?? "unknown check");
    if (isIgnoredStatusCheck(check, ignored)) continue;
    considered += 1;
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    if (conclusion) {
      if (!PASSING_CHECK_CONCLUSIONS.has(conclusion)) blockers.push(`${name}: ${conclusion}`);
      continue;
    }
    if (!check.status && PASSING_CHECK_CONCLUSIONS.has(String(check.state ?? "").toUpperCase())) {
      continue;
    }
    if (["COMPLETED", "SUCCESS"].includes(status)) {
      blockers.push(`${name}: UNKNOWN (${status} without conclusion)`);
    } else {
      blockers.push(`${name}: ${status || "UNKNOWN"}`);
    }
  }
  if (considered === 0) return "no PR checks found";
  if (blockers.length > 0) return `checks are not clean: ${blockers.slice(0, 5).join(", ")}`;
  return "";
}

function validateTerminalStatusChecks(checks: LooseRecord[]) {
  if (!Array.isArray(checks) || checks.length === 0) return "";
  const ignored = ignoredCheckNames();
  const blockers: LooseRecord[] = [];
  for (const check of latestCheckRuns(checks)) {
    const name = String(check.name ?? check.context ?? "unknown check");
    if (isIgnoredStatusCheck(check, ignored)) continue;
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    if (conclusion) {
      if (!PASSING_CHECK_CONCLUSIONS.has(conclusion)) blockers.push(`${name}: ${conclusion}`);
      continue;
    }
    if (!check.status && PASSING_CHECK_CONCLUSIONS.has(String(check.state ?? "").toUpperCase())) {
      continue;
    }
    if (isPendingStatusCheck(check)) continue;
    if (["COMPLETED", "SUCCESS"].includes(status)) {
      blockers.push(`${name}: UNKNOWN (${status} without conclusion)`);
    } else {
      blockers.push(`${name}: ${status || "UNKNOWN"}`);
    }
  }
  if (blockers.length > 0) return `checks are not clean: ${blockers.slice(0, 5).join(", ")}`;
  return "";
}

function shouldWaitForMergeReadiness({ mergeBlock, view }: LooseRecord) {
  const message = String(mergeBlock ?? "").toLowerCase();
  if (message.includes("exact-head merge request is queued")) return true;
  if (message.includes("exact-head auto-merge request is pending")) return true;
  if (message.includes("mergeable state is unknown")) return true;
  if (message.includes("merge state status is unknown")) return true;
  if (message === "no pr checks found") return true;
  if (message.includes("merge state status is unstable"))
    return hasPendingChecks(view.statusCheckRollup ?? []);
  if (message.includes("checks are not clean"))
    return hasPendingChecks(view.statusCheckRollup ?? []);
  return false;
}

function shouldWaitForIssueImplementationChecks(checkBlock: string, view: LooseRecord) {
  if (/^no PR checks found$/i.test(checkBlock)) return true;
  return shouldWaitForMergeReadiness({ mergeBlock: checkBlock, view });
}

function hasPendingChecks(checks: LooseRecord[]) {
  const ignored = ignoredCheckNames();
  return latestCheckRuns(checks ?? []).some((check: JsonValue) => {
    if (isIgnoredStatusCheck(check, ignored)) return false;
    return isPendingStatusCheck(check);
  });
}

function isIgnoredStatusCheck(check: LooseRecord, ignored: Set<string>) {
  const name = String(check.name ?? check.context ?? "unknown check").toLowerCase();
  const workflow = String(check.workflowName ?? "").toLowerCase();
  return ignored.has(name) || Boolean(workflow && ignored.has(workflow));
}

function latestCheckRuns(checks: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const check of checks) {
    const key = checkIdentity(check);
    const previous = byKey.get(key);
    if (!previous || checkTimestamp(check) >= checkTimestamp(previous)) byKey.set(key, check);
  }
  return [...byKey.values()];
}

function checkIdentity(check: LooseRecord) {
  const name = String(check.name ?? check.context ?? "unknown check").toLowerCase();
  const workflow = String(check.workflowName ?? "").toLowerCase();
  return `${workflow}\n${name}`;
}

function checkTimestamp(check: LooseRecord) {
  for (const field of [
    "startedAt",
    "started_at",
    "createdAt",
    "created_at",
    "completedAt",
    "completed_at",
  ]) {
    const parsed = Date.parse(String(check[field] ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  if (isPendingStatusCheck(check)) return Number.MAX_SAFE_INTEGER;
  return 0;
}

function isPendingStatusCheck(check: LooseRecord) {
  const conclusion = String(check.conclusion ?? "").toUpperCase();
  if (conclusion) return false;
  const checkRunStatus = String(check.status ?? "").toUpperCase();
  const contextState = String(check.state ?? "").toUpperCase();
  if (!checkRunStatus && PASSING_CHECK_CONCLUSIONS.has(contextState)) return false;
  if (["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(checkRunStatus)) {
    return true;
  }
  if (["EXPECTED", "PENDING"].includes(contextState)) return true;
  return ["COMPLETED", "SUCCESS"].includes(checkRunStatus);
}

function ignoredCheckNames() {
  const configured = String(
    process.env.CLAWSWEEPER_POST_FLIGHT_IGNORE_CHECKS ?? DEFAULT_IGNORED_CHECKS.join(","),
  );
  return new Set(
    configured
      .split(",")
      .map((item: JsonValue) => item.trim())
      .map((item: string) => item.toLowerCase())
      .filter(Boolean),
  );
}

function shouldRequirePrChecks() {
  return process.env.CLAWSWEEPER_POST_FLIGHT_REQUIRE_PR_CHECKS === "1";
}

function validateResolvedReviewThreads(repo: string, number: JsonValue) {
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
    `number=${number}`,
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

function fetchPullRequest(repo: string, number: JsonValue) {
  return ghJson(["api", `repos/${repo}/pulls/${number}`]);
}

function fetchIssue(repo: string, number: JsonValue) {
  return ghJson(["api", `repos/${repo}/issues/${number}`]);
}

function fetchPullRequestView(repo: string, number: JsonValue) {
  return ghJson([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    [
      "autoMergeRequest",
      "baseRefName",
      "headRefOid",
      "isDraft",
      "isInMergeQueue",
      "mergeable",
      "mergeCommit",
      "mergeStateStatus",
      "mergedAt",
      "reviewDecision",
      "state",
      "statusCheckRollup",
      "title",
      "updatedAt",
      "url",
    ].join(","),
  ]);
}

function findLatestResultPath() {
  const runsRoot = path.join(repoRoot(), ".clawsweeper-repair", "runs");
  if (!fs.existsSync(runsRoot)) throw new Error("no run directory exists");
  const candidates: LooseRecord[] = [];
  for (const runName of fs.readdirSync(runsRoot)) {
    const candidate = path.join(runsRoot, runName, "result.json");
    if (fs.existsSync(candidate))
      candidates.push({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
  }
  candidates.sort((left: JsonValue, right: JsonValue) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) throw new Error("no result.json files found");
  return candidates[0].path;
}

function readSiblingJson(resultPath: string, name: string) {
  const file = path.join(path.dirname(resultPath), name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeReport(report: LooseRecord, resultPath: string) {
  const summary = summarizePostFlightReport(report);
  const finalReport = {
    ...report,
    ...summary,
  };
  const reportPath = path.join(path.dirname(resultPath), "post-flight-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `report_outcome=${summary.outcome}\nreport_detail=${summary.detail}\n`,
    );
  }
  recordPostFlightWorkflowEventSafely(repairWorkflowTerminalPhase(finalReport));
  console.log(JSON.stringify(finalReport, null, 2));
  return summary;
}

function normalizeIssueRef(value: JsonValue) {
  return issueNumberFromRef(value);
}

function compactText(text: string, maxLength: number) {
  return compactPlainText(stripAnsi(text), maxLength);
}

function isRecoverableMergeRace(message: string) {
  return /pull request has merge conflicts|merge conflict|base branch was modified|head branch was modified|not mergeable/i.test(
    String(message ?? ""),
  );
}
