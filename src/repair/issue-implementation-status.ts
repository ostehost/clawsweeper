#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../action-ledger.js";
import { DEFAULT_TRUSTED_BOTS } from "./config.js";
import { repoSlug } from "./comment-router-core.js";
import { isAllowedMutationActor, writePayload } from "./comment-router-utils.js";
import {
  runVerifiedPublishedPullMutation,
  runVerifiedSealedSourceMutation,
} from "./execution-handoff.js";
import { ghJson, ghJsonWithRetry, ghPagedWithRetry, ghText } from "./github-cli.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { parseArgs, parseJob, repoRoot } from "./lib.js";
import {
  flushRepairActionEvents,
  recordRepairLifecycleEvent,
  recordRepairLifecycleFailureSafely,
  repairHttpMutationOutcome,
  repairSourceRevision,
  runRepairMutation,
  runRepairMutationAsync,
  type RepairMutationOutcome,
  type RepairLifecycleInput,
} from "./repair-action-ledger.js";

const PROGRESS_START = "<!-- clawsweeper-issue-implementation-progress:start -->";
const PROGRESS_END = "<!-- clawsweeper-issue-implementation-progress:end -->";

type StatusOptions = {
  repo: string;
  itemNumber: number;
  state: string;
  detail: string;
  runUrl: string;
  prUrl: string;
  title: string;
  sourceRevision?: string;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runIssueImplementationStatus();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobPath = stringArg(args.job);
  const job = jobPath ? parseJob(path.resolve(jobPath)) : null;
  if (job && job.frontmatter.source !== "issue_implementation") {
    console.log(JSON.stringify({ status: "skipped", reason: "not an issue implementation job" }));
    return;
  }
  const triggerSource = String(job?.frontmatter.trigger_source ?? "");
  if (job && triggerSource && !triggerSource.startsWith("review_")) {
    console.log(JSON.stringify({ status: "skipped", reason: "not an automatic issue build" }));
    return;
  }

  const repo = stringArg(args.repo) || String(job?.frontmatter.source_issue_repo ?? "");
  const itemNumber = positiveInteger(
    stringArg(args["item-number"]) || String(job?.frontmatter.source_issue_number ?? ""),
  );
  const state = stringArg(args.state) || "Queued";
  const detail = stringArg(args.detail) || "ClawSweeper is preparing the implementation worker.";
  const runUrl = stringArg(args["run-url"]) || currentActionsRunUrl();
  const prUrl = stringArg(args["pr-url"]);
  const dashboardOnly = Boolean(args["dashboard-only"]);
  const explicitSourceRevision = stringArg(args["source-revision"]);
  const sourceRevision = explicitSourceRevision
    ? repairSourceRevision({ source_issue_revision_sha256: explicitSourceRevision })
    : repairSourceRevision(job?.frontmatter ?? {});
  if (explicitSourceRevision && !sourceRevision) {
    throw new Error("invalid source revision");
  }
  validateRepo(repo);
  validatePrUrl(prUrl, repo);

  if (dashboardOnly) {
    const options: StatusOptions = {
      repo,
      itemNumber,
      state,
      detail,
      runUrl,
      prUrl,
      title: stringArg(args.title) || `Issue #${itemNumber}`,
      sourceRevision: sourceRevision ?? "",
    };
    let dashboard: DashboardStatus;
    let failureOutcome: RepairMutationOutcome | undefined;
    try {
      dashboard = await postDashboardStatus(options);
    } catch (error) {
      dashboard = "failed";
      failureOutcome = dashboardFailureOutcome(error);
      recordDashboardStatus(options, dashboard, failureOutcome);
      throw error;
    }
    recordDashboardStatus(options, dashboard);
    writeStepOutput("dashboard_status", dashboard);
    console.log(
      JSON.stringify({
        status: "dashboard_only",
        dashboard_status: dashboard,
        repo,
        item_number: itemNumber,
        state,
      }),
    );
    return;
  }

  const issue = ghJsonWithRetry<LooseRecord>(["api", `repos/${repo}/issues/${itemNumber}`]);
  const options: StatusOptions = {
    repo,
    itemNumber,
    state,
    detail,
    runUrl,
    prUrl,
    title: stringArg(args.title) || String(issue.title ?? `Issue #${itemNumber}`),
    sourceRevision: sourceRevision ?? "",
  };
  const comments = ghPagedWithRetry<LooseRecord>(
    `repos/${repo}/issues/${itemNumber}/comments?per_page=100`,
    { attempts: 3 },
  );
  const marker = issueImplementationStatusMarker(itemNumber);
  const existing =
    comments
      .filter(
        (comment) => isTrustedBotComment(comment) && String(comment.body ?? "").includes(marker),
      )
      .at(-1) ?? null;
  if (job && !triggerSource && !existing) {
    recordRepairLifecycleEvent(issueStatusLifecycle(options), {
      type: ACTION_EVENT_TYPES.statusLifecycle,
      status: ACTION_EVENT_STATUSES.skipped,
      reasonCode: ACTION_EVENT_REASON_CODES.notFound,
      mutation: false,
      component: "issue_implementation_status",
      operation: "status",
      state,
      statusKind: "github_comment",
    });
    console.log(
      JSON.stringify({ status: "skipped", reason: "automatic issue build marker not found" }),
    );
    return;
  }
  const body = renderIssueImplementationStatusComment(existing?.body, options);
  const payload = writePayload(
    repoRoot(),
    `issue-implementation-status-${repoSlug(repo)}-${itemNumber}`,
    { body },
  );
  let commentId = Number(existing?.id ?? 0);
  const mutateComment = () => {
    if (commentId > 0) {
      ghText([
        "api",
        `repos/${repo}/issues/comments/${commentId}`,
        "--method",
        "PATCH",
        "--input",
        payload,
      ]);
      return;
    }
    const created = ghJson<LooseRecord>([
      "api",
      `repos/${repo}/issues/${itemNumber}/comments`,
      "--method",
      "POST",
      "--input",
      payload,
    ]);
    commentId = Number(created.id ?? 0);
  };
  const mutateCommentWithReceipt = () =>
    runRepairMutation(issueStatusLifecycle(options), {
      kind: existing ? "issue_status_comment_update" : "issue_status_comment_create",
      identity: {
        repo,
        itemNumber,
        commentId: commentId || null,
        state,
        body,
      },
      component: "issue_implementation_status",
      operation: mutateComment,
    });
  if (isTerminalMutationState(state)) {
    const root = requiredArg(args, "handoff-root");
    const validationReceiptPath = requiredArg(args, "validation-receipt");
    const expectedAuthorizationSha256 = requiredArg(args, "authorization-sha256");
    const expectedValidationReceiptSha256 = requiredArg(args, "validation-receipt-sha256");
    const publicationReceiptSha256 = stringArg(args["publication-receipt-sha256"]);
    const assertSealedSource = (intent: LooseRecord) => {
      if (
        intent.source?.kind !== "issue" ||
        intent.source?.repo !== repo ||
        intent.source?.number !== itemNumber
      ) {
        throw new Error("terminal status target differs from the sealed source issue");
      }
    };
    if (publicationReceiptSha256) {
      runVerifiedPublishedPullMutation({
        root,
        publicationReceiptPath: requiredArg(args, "publication-receipt"),
        validationReceiptPath,
        expectedAuthorizationSha256,
        expectedValidationReceiptSha256,
        expectedPublicationReceiptSha256: publicationReceiptSha256,
        mutation: ({ receipt, intent }) => {
          assertSealedSource(intent);
          if (receipt.target_pr_url !== prUrl) {
            throw new Error("terminal status pull request differs from the publication receipt");
          }
          mutateCommentWithReceipt();
        },
      });
    } else {
      if (!args["sealed-source-only"]) {
        throw new Error(
          "terminal status without a publication receipt requires --sealed-source-only",
        );
      }
      if (isSuccessfulTerminalMutationState(state) || prUrl) {
        throw new Error("successful terminal status requires a verified publication receipt");
      }
      runVerifiedSealedSourceMutation({
        root,
        validationReceiptPath,
        expectedAuthorizationSha256,
        expectedValidationReceiptSha256,
        mutation: ({ intent }) => {
          assertSealedSource(intent);
          mutateCommentWithReceipt();
        },
      });
    }
  } else {
    mutateCommentWithReceipt();
  }
  recordRepairLifecycleEvent(issueStatusLifecycle(options), {
    type: ACTION_EVENT_TYPES.statusLifecycle,
    status: ACTION_EVENT_STATUSES.published,
    reasonCode: ACTION_EVENT_REASON_CODES.published,
    mutation: true,
    component: "issue_implementation_status",
    operation: "status",
    state,
    statusKind: existing ? "github_comment_update" : "github_comment_create",
    idempotencySlot: `issue_status:${state.trim().toLowerCase()}`,
  });

  let dashboardFailure: RepairMutationOutcome | undefined;
  const dashboard: DashboardStatus = await postDashboardStatus(options).catch((error) => {
    dashboardFailure = dashboardFailureOutcome(error);
    recordRepairLifecycleFailureSafely(issueStatusLifecycle(options), {
      component: "issue_implementation_status",
      operation: "dashboard",
      phase: state,
      workKind: "issue_to_pr",
      error,
    });
    console.warn(`dashboard status publish failed: ${errorText(error)}`);
    return "failed";
  });
  recordDashboardStatus(options, dashboard, dashboardFailure);
  writeStepOutput("comment_id", String(commentId || ""));
  writeStepOutput("dashboard_status", dashboard);
  console.log(
    JSON.stringify({
      status: existing ? "updated" : "created",
      comment_id: commentId || null,
      dashboard_status: dashboard,
      repo,
      item_number: itemNumber,
      state,
    }),
  );
}

async function runIssueImplementationStatus() {
  let commandError: unknown = null;
  try {
    await main();
  } catch (error) {
    commandError = error;
    const lifecycle = issueStatusLifecycleFromArgs();
    if (lifecycle) {
      recordRepairLifecycleFailureSafely(lifecycle, {
        component: "issue_implementation_status",
        operation: "status",
        error,
      });
    }
  }
  try {
    await flushRepairActionEvents();
  } catch (error) {
    if (commandError) {
      console.error(
        `[action-ledger] failed to finalize issue status receipts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } else {
      commandError = error;
    }
  }
  if (commandError) throw commandError;
}

function issueStatusLifecycle(
  options: Pick<StatusOptions, "repo" | "itemNumber" | "sourceRevision">,
) {
  return {
    repository: options.repo,
    workKey: `issue-implementation:${options.repo}#${options.itemNumber}`,
    clusterId: `issue-${repoSlug(options.repo)}-${options.itemNumber}`,
    number: options.itemNumber,
    sourceRevision: options.sourceRevision ?? null,
  } satisfies RepairLifecycleInput;
}

function issueStatusLifecycleFromArgs(): RepairLifecycleInput | null {
  try {
    const args = parseArgs(process.argv.slice(2));
    const jobPath = stringArg(args.job);
    const job = jobPath ? parseJob(path.resolve(jobPath)) : null;
    const repo = stringArg(args.repo) || String(job?.frontmatter.source_issue_repo ?? "");
    const itemNumber = positiveInteger(
      stringArg(args["item-number"]) || String(job?.frontmatter.source_issue_number ?? ""),
    );
    const explicitSourceRevision = stringArg(args["source-revision"]);
    const sourceRevision = explicitSourceRevision
      ? repairSourceRevision({ source_issue_revision_sha256: explicitSourceRevision })
      : repairSourceRevision(job?.frontmatter ?? {});
    return issueStatusLifecycle({ repo, itemNumber, sourceRevision: sourceRevision ?? "" });
  } catch {
    return null;
  }
}

type DashboardStatus = "sent" | "skipped" | "failed";

export function recordDashboardStatus(
  options: StatusOptions,
  dashboard: DashboardStatus,
  failureOutcome?: RepairMutationOutcome,
) {
  const mutationOutcome =
    dashboard === "sent"
      ? "accepted"
      : dashboard === "skipped"
        ? null
        : (failureOutcome ?? "unknown");
  const mutationUnknown = mutationOutcome === "unknown";
  const mutationRejected = mutationOutcome === "rejected";
  recordRepairLifecycleEvent(issueStatusLifecycle(options), {
    type: ACTION_EVENT_TYPES.dashboardLifecycle,
    status:
      dashboard === "sent"
        ? ACTION_EVENT_STATUSES.sent
        : dashboard === "skipped"
          ? ACTION_EVENT_STATUSES.skipped
          : mutationRejected
            ? ACTION_EVENT_STATUSES.skipped
            : ACTION_EVENT_STATUSES.failed,
    reasonCode:
      dashboard === "sent"
        ? ACTION_EVENT_REASON_CODES.published
        : dashboard === "skipped"
          ? ACTION_EVENT_REASON_CODES.notApplicable
          : mutationRejected
            ? ACTION_EVENT_REASON_CODES.notApplicable
            : ACTION_EVENT_REASON_CODES.unavailable,
    mutation: mutationOutcome !== null && !mutationRejected,
    retryable: mutationUnknown,
    component: "issue_implementation_status",
    operation: "dashboard",
    state: mutationUnknown ? "mutation_unknown" : options.state,
    ...(mutationOutcome
      ? {
          completionReason:
            mutationOutcome === "accepted"
              ? "mutation_accepted"
              : mutationRejected
                ? "mutation_rejected"
                : "mutation_outcome_unknown",
        }
      : {}),
    statusKind: "issue_implementation",
    idempotencySlot: `dashboard_status:${options.state.trim().toLowerCase()}`,
  });
}

export function issueImplementationStatusMarker(itemNumber: number) {
  return `<!-- clawsweeper-command-status:${itemNumber}:implement_issue:auto -->`;
}

export function renderIssueImplementationStatusComment(
  existingBody: JsonValue,
  options: StatusOptions,
) {
  const marker = issueImplementationStatusMarker(options.itemNumber);
  const normalizedState = options.state.trim().toLowerCase();
  if (normalizedState.includes("complete") || normalizedState.includes("open")) {
    return [
      marker,
      "🦞✅",
      options.prUrl
        ? `Implementation PR opened: ${options.prUrl}`
        : "Automatic implementation completed.",
      options.detail ? `Status: ${options.detail}` : null,
      options.runUrl ? `Worker: ${options.runUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (normalizedState.includes("block") || normalizedState.includes("fail")) {
    return [
      marker,
      "🦞⚠️",
      "Automatic implementation stopped before completion.",
      options.detail ? `Reason: ${options.detail}` : null,
      options.prUrl ? `PR: ${options.prUrl}` : null,
      options.runUrl ? `Worker: ${options.runUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const progress = [
    PROGRESS_START,
    "Automatic implementation progress:",
    `- State: ${options.state}`,
    `- Detail: ${options.detail}`,
    options.runUrl ? `- Run: ${options.runUrl}` : null,
    options.prUrl ? `- PR: ${options.prUrl}` : null,
    `- Updated: ${new Date().toISOString()}`,
    "- Opt out: add `clawsweeper:manual-only` or `clawsweeper:human-review`.",
    PROGRESS_END,
  ]
    .filter(Boolean)
    .join("\n");
  const existing = String(existingBody ?? "").trim();
  if (!existing) {
    return [
      marker,
      "🦞🔧",
      "ClawSweeper is automatically building this issue.",
      "",
      "The issue review finished and no active implementation pull request was found.",
      "",
      progress,
    ].join("\n");
  }
  const start = existing.indexOf(PROGRESS_START);
  const end = existing.indexOf(PROGRESS_END);
  if (start >= 0 && end > start) {
    return `${existing.slice(0, start).trimEnd()}\n\n${progress}\n${existing
      .slice(end + PROGRESS_END.length)
      .trimStart()}`;
  }
  return `${existing}\n\n${progress}`;
}

export async function postDashboardStatus(options: StatusOptions, fetchImpl: typeof fetch = fetch) {
  const token = String(process.env.CLAWSWEEPER_STATUS_INGEST_TOKEN ?? "").trim();
  if (!token) return "skipped";
  const url =
    String(process.env.CLAWSWEEPER_STATUS_INGEST_URL ?? "").trim() ||
    "https://clawsweeper.openclaw.ai/api/events";
  const state = options.state.trim().toLowerCase();
  const requestBody = {
    event_type: eventTypeForState(state),
    mode: "automatic-issue-to-pr",
    stage: state.replace(/\s+/g, "_"),
    status: eventStatusForState(state),
    repository: options.repo,
    item_number: options.itemNumber,
    source_item_number: options.itemNumber,
    item_url: `https://github.com/${options.repo}/issues/${options.itemNumber}`,
    source_item_url: `https://github.com/${options.repo}/issues/${options.itemNumber}`,
    run_url: options.runUrl || null,
    pr_url: options.prUrl || null,
    title: options.title,
    note: options.detail,
    work_kind: "issue_to_pr",
    automatic: true,
    cluster_id: `issue-${repoSlug(options.repo)}-${options.itemNumber}`,
  };
  const response = await runRepairMutationAsync(issueStatusLifecycle(options), {
    kind: "issue_status_dashboard_post",
    identity: {
      url,
      request: requestBody,
    },
    component: "issue_implementation_status",
    operationName: "dashboard",
    operation: () =>
      fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }),
    outcome: repairHttpMutationOutcome,
  });
  if (!response.ok) {
    throw new DashboardIngestError(
      response.status,
      await response.text(),
      repairHttpMutationOutcome(response),
    );
  }
  return "sent";
}

class DashboardIngestError extends Error {
  constructor(
    status: number,
    detail: string,
    readonly mutationOutcome: RepairMutationOutcome,
  ) {
    super(`dashboard ingest returned ${status}: ${detail}`);
    this.name = "DashboardIngestError";
  }
}

export function dashboardFailureOutcome(error: unknown): RepairMutationOutcome {
  return error instanceof DashboardIngestError ? error.mutationOutcome : "unknown";
}

function eventTypeForState(state: string) {
  if (state.includes("plan")) return "clawsweeper.issue_build_planning";
  if (state.includes("build") || state.includes("implement"))
    return "clawsweeper.issue_build_started";
  if (state.includes("complete") || state.includes("open"))
    return "clawsweeper.issue_build_completed";
  if (state.includes("block") || state.includes("fail")) return "clawsweeper.issue_build_blocked";
  return "clawsweeper.issue_build_queued";
}

function eventStatusForState(state: string) {
  if (state.includes("complete") || state.includes("open")) return "completed";
  if (state.includes("block") || state.includes("fail")) return "blocked";
  if (state.includes("queue")) return "queued";
  return "running";
}

function isTrustedBotComment(comment: LooseRecord) {
  return isAllowedMutationActor(comment.user?.login, new Set(DEFAULT_TRUSTED_BOTS));
}

function stringArg(value: JsonValue) {
  return typeof value === "string" ? value.trim() : "";
}

function requiredArg(args: LooseRecord, name: string) {
  const value = stringArg(args[name]);
  if (!value) throw new Error(`--${name} is required for terminal status publication`);
  return value;
}

export function isTerminalMutationState(state: string) {
  const normalized = state.trim().toLowerCase();
  return (
    normalized.includes("complete") ||
    normalized.includes("open") ||
    normalized.includes("block") ||
    normalized.includes("fail")
  );
}

export function isSuccessfulTerminalMutationState(state: string) {
  const normalized = state.trim().toLowerCase();
  return normalized.includes("complete") || normalized.includes("open");
}

function positiveInteger(value: JsonValue) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid issue number: ${value}`);
  }
  return parsed;
}

function validateRepo(repo: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid repo: ${repo}`);
  }
}

function validatePrUrl(prUrl: string, repo: string) {
  if (!prUrl) return;
  if (!new RegExp(`^https://github\\.com/${escapeRegex(repo)}/pull/[1-9][0-9]*$`).test(prUrl)) {
    throw new Error(`invalid pull request URL: ${prUrl}`);
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentActionsRunUrl() {
  const repository = String(process.env.GITHUB_REPOSITORY ?? "").trim();
  const runId = String(process.env.GITHUB_RUN_ID ?? "").trim();
  return repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : "";
}

function writeStepOutput(name: string, value: string) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  fs.appendFileSync(output, `${name}=${value}\n`);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
