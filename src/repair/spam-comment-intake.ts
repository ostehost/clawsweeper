#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEventEvidence,
  type ActionEventReasonCode,
  type ActionEventSubject,
} from "../action-ledger.js";
import { recordWorkflowPhaseEvent } from "../action-ledger-runtime.js";
import type { JsonObject, JsonValue } from "./json-types.js";
import { asJsonObject } from "./json-types.js";
import { parseArgs, repoRoot } from "./lib.js";
import {
  deterministicSpamSignals,
  shouldSendToCheapModel,
  type SpamScanComment,
} from "./spam-scanner-core.js";
import { boolEnv, errorText, stringArg, stringOrNull } from "./openclaw-hook.js";

export type SpamCommentIntakeDecision =
  | {
      accepted: false;
      reason: string;
      comment: SpamScanComment | null;
      target_repo: string | null;
    }
  | {
      accepted: true;
      reason: string;
      target_repo: string;
      comment: SpamScanComment;
      dispatch_payload: SpamScannerDispatchPayload;
    };

export type SpamScannerDispatchPayload = {
  event_type: "clawsweeper_spam_comment";
  client_payload: {
    target_repo: string;
    comment_id?: string;
    review_comment_id?: string;
    max_comments: "1";
  };
};

export type SpamCommentIntakeSummary = {
  status: "ok" | "skipped" | "failed";
  dispatched: number;
  reason: string | null;
  decision: SpamCommentIntakeDecision | null;
};

const DEFAULT_REPORT_PATH = "notifications/spam-comment-intake-report.json";
const DEFAULT_DISPATCH_REPO = "openclaw/clawsweeper";
const MAX_REPORT_BYTES = 64 * 1024;

type SpamCommentIntakeLedger = {
  root: string;
  actionLedgerRoot: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  operationIdentity: {
    dispatchRepository: string;
    sourceEvent: string;
    targetRepository: string;
    commentKind: string;
    commentId: string;
  };
  subject: ActionEventSubject;
  lastEventId: string | null;
  nextPhaseSeq: number;
  startedAtMs: number;
  mutationObserved: boolean;
  uncertainMutationObserved: boolean;
  terminal: boolean;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSpamCommentIntake(process.argv.slice(2))
    .then((summary) => {
      process.exitCode = summary.status === "failed" ? 1 : 0;
    })
    .catch((error) => {
      console.error(errorText(error));
      process.exitCode = 1;
    });
}

export async function runSpamCommentIntake(
  argv: string[],
  runtime: {
    root?: string;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    log?: (message: string) => void;
    now?: () => Date;
  } = {},
): Promise<SpamCommentIntakeSummary> {
  const args = parseArgs(argv);
  const root = runtime.root ?? repoRoot();
  const env = runtime.env ?? process.env;
  const log = runtime.log ?? console.log;
  const fetcher = runtime.fetch ?? fetch;
  const now = runtime.now ?? (() => new Date());
  const eventPath = stringArg(args.input) ?? env.GITHUB_EVENT_PATH;
  const eventName = stringArg(args.event) ?? env.GITHUB_EVENT_NAME;
  const reportPath = path.resolve(root, stringArg(args.report) ?? DEFAULT_REPORT_PATH);
  const writeReport = Boolean(args["write-report"]);
  const dryRun = Boolean(args["dry-run"] || boolEnv(env.CLAWSWEEPER_SPAM_INTAKE_DRY_RUN, false));
  const dispatchRepo = stringArg(args["dispatch-repo"]) ?? DEFAULT_DISPATCH_REPO;
  const token = stringArg(env.GH_TOKEN) ?? stringArg(env.GITHUB_TOKEN);
  let decision: SpamCommentIntakeDecision | null = null;
  let ledger: SpamCommentIntakeLedger | null = null;
  let finalSummary: SpamCommentIntakeSummary | null = null;
  let primaryError: unknown = null;

  try {
    if (!eventPath || !eventName || !fs.existsSync(eventPath)) {
      ledger = startIntakeLedger({
        root,
        env,
        now,
        eventName,
        dispatchRepo,
        decision,
      });
      recordClassification(ledger, decision);
      finalSummary = {
        status: "skipped",
        dispatched: 0,
        reason: "GitHub event payload missing",
        decision: null,
      };
    } else {
      decision = classifySpamCommentActivity({
        eventName,
        payload: JSON.parse(fs.readFileSync(eventPath, "utf8")),
      });
      ledger = startIntakeLedger({
        root,
        env,
        now,
        eventName,
        dispatchRepo,
        decision,
      });
      recordClassification(ledger, decision);
      if (!decision.accepted) {
        finalSummary = {
          status: "skipped",
          dispatched: 0,
          reason: decision.reason,
          decision,
        };
      } else if (dryRun) {
        finalSummary = {
          status: "ok",
          dispatched: 0,
          reason: "dry run",
          decision,
        };
      } else if (!token) {
        finalSummary = {
          status: "failed",
          dispatched: 0,
          reason: "GH_TOKEN or GITHUB_TOKEN is required",
          decision,
        };
      } else {
        await dispatchSpamScanner({
          fetcher,
          token,
          dispatchRepo,
          payload: decision.dispatch_payload,
          ledger,
        });
        finalSummary = {
          status: "ok",
          dispatched: 1,
          reason: decision.reason,
          decision,
        };
      }
    }
    completeIntake({
      summary: finalSummary,
      ledger,
      writeReport,
      reportPath,
      now,
      log,
    });
  } catch (error) {
    primaryError = error;
    if (!ledger) {
      ledger = startIntakeLedger({
        root,
        env,
        now,
        eventName,
        dispatchRepo,
        decision,
      });
      try {
        recordClassification(ledger, decision);
      } catch (classificationError) {
        log(
          `[spam-comment-intake] failed to record classification after the primary failure: ${errorText(classificationError)}`,
        );
      }
    }
    finalSummary = {
      status: "failed",
      dispatched: 0,
      reason: ledger.mutationObserved
        ? "spam scanner dispatch failed"
        : "spam comment intake failed",
      decision,
    };
    try {
      completeIntake({
        summary: finalSummary,
        ledger,
        writeReport,
        reportPath,
        now,
        log,
      });
    } catch (finalizationError) {
      log(
        `[spam-comment-intake] failed to record terminal intake state after the primary failure: ${errorText(finalizationError)}`,
      );
    }
  }

  if (primaryError) throw primaryError;
  return finalSummary;
}

export function classifySpamCommentActivity({
  eventName,
  payload,
}: {
  eventName: string;
  payload: JsonValue;
}): SpamCommentIntakeDecision {
  const root = asJsonObject(payload);
  const clientPayload = asJsonObject(root.client_payload);
  const activity = activityPayload(root);
  const type =
    stringOrNull(activity.type) ??
    stringOrNull(clientPayload.event_name) ??
    (eventName === "repository_dispatch" ? null : eventName);
  const action =
    stringOrNull(activity.action) ??
    stringOrNull(clientPayload.action) ??
    stringOrNull(root.action);
  if (type !== "issue_comment" && type !== "pull_request_review_comment") {
    return {
      accepted: false,
      reason: `unsupported activity type: ${type}`,
      comment: null,
      target_repo: null,
    };
  }
  if (!["created", "edited"].includes(action ?? "")) {
    return {
      accepted: false,
      reason: `unsupported issue_comment action: ${action ?? "unknown"}`,
      comment: null,
      target_repo: null,
    };
  }

  const targetRepo = targetRepository(root, activity);
  const comment = spamCommentFromActivity(activity, targetRepo, type);
  if (!targetRepo) {
    return { accepted: false, reason: "missing target repository", comment, target_repo: null };
  }
  if (!comment.id) {
    return {
      accepted: false,
      reason: "missing issue comment id",
      comment,
      target_repo: targetRepo,
    };
  }
  if (!comment.body.trim()) {
    return {
      accepted: false,
      reason: "missing issue comment body",
      comment,
      target_repo: targetRepo,
    };
  }
  const deterministic = deterministicSpamSignals(comment);
  if (!shouldSendToCheapModel(comment)) {
    return {
      accepted: false,
      reason: deterministic.signals.length
        ? `protected or low-value candidate: ${deterministic.signals.join(", ")}`
        : "no deterministic spam signal",
      comment,
      target_repo: targetRepo,
    };
  }
  return {
    accepted: true,
    reason: `spam candidate: ${deterministic.signals.join(", ")}`,
    target_repo: targetRepo,
    comment,
    dispatch_payload: {
      event_type: "clawsweeper_spam_comment",
      client_payload: {
        target_repo: targetRepo,
        ...(comment.kind === "pull_request_review_comment"
          ? { review_comment_id: comment.id }
          : { comment_id: comment.id }),
        max_comments: "1",
      },
    },
  };
}

async function dispatchSpamScanner({
  fetcher,
  token,
  dispatchRepo,
  payload,
  ledger,
}: {
  fetcher: typeof fetch;
  token: string;
  dispatchRepo: string;
  payload: SpamScannerDispatchPayload;
  ledger: SpamCommentIntakeLedger;
}) {
  const request = {
    dispatchRepository: dispatchRepo.trim().toLowerCase(),
    eventType: payload.event_type,
    targetRepository: payload.client_payload.target_repo.trim().toLowerCase(),
    commentKind:
      payload.client_payload.review_comment_id === undefined
        ? "issue_comment"
        : "pull_request_review_comment",
    commentId:
      payload.client_payload.review_comment_id ?? payload.client_payload.comment_id ?? "unknown",
    maxComments: payload.client_payload.max_comments,
  };
  const requestSha256 = sha256(JSON.stringify(request));
  const idempotencyIdentity = {
    operation: "spam_comment_intake",
    mutation: "repository_dispatch",
    request,
  };
  const evidence = [{ kind: "repository_dispatch_request", sha256: requestSha256 }];
  const attempt = recordWorkflowPhaseEvent(
    ledger.actionLedgerRoot,
    {
      phase: ACTION_EVENT_TYPES.dispatchLifecycle,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: true,
      mutation: false,
      identity: { slot: "spam_dispatch_attempt", requestSha256 },
      operation: "spam_comment_intake",
      operationIdentity: ledger.operationIdentity,
      parentEventId: ledger.lastEventId,
      phaseSeq: nextPhaseSeq(ledger),
      idempotencyIdentity,
      component: "spam_comment_intake",
      subject: ledger.subject,
      evidence,
      attributes: {
        attempt: 1,
        completion_reason: "dispatch_attempted",
        dispatch_kind: "repository_dispatch",
        review_mode: "spam_intake",
      },
      privacy: actionLedgerPrivacy(),
    },
    {
      env: ledger.env,
      now: ledger.now,
    },
  );
  ledger.lastEventId = attempt?.event_id ?? ledger.lastEventId;

  let response: Response;
  try {
    response = await fetcher(`https://api.github.com/repos/${dispatchRepo}/dispatches`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "clawsweeper-spam-comment-intake",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    ledger.mutationObserved = true;
    ledger.uncertainMutationObserved = true;
    recordDispatchOutcomeAfterFailure(ledger, {
      attemptEventId: attempt?.event_id ?? null,
      idempotencyIdentity,
      evidence,
      requestSha256,
      outcome: "unknown",
    });
    throw error;
  }
  if (!response.ok) {
    const outcome = spamDispatchHttpOutcome(response);
    const error = new Error(`spam scanner dispatch rejected: ${response.status}`);
    if (outcome === "unknown") {
      ledger.mutationObserved = true;
      ledger.uncertainMutationObserved = true;
    }
    try {
      recordDispatchOutcome(ledger, {
        attemptEventId: attempt?.event_id ?? null,
        idempotencyIdentity,
        evidence,
        requestSha256,
        outcome,
      });
    } catch (receiptError) {
      console.error(
        `[spam-comment-intake] failed to record rejected dispatch outcome: ${errorText(receiptError)}`,
      );
    }
    throw error;
  }
  ledger.mutationObserved = true;
  recordDispatchOutcome(ledger, {
    attemptEventId: attempt?.event_id ?? null,
    idempotencyIdentity,
    evidence,
    requestSha256,
    outcome: "accepted",
  });
}

function activityPayload(root: JsonObject) {
  const clientPayload = asJsonObject(root.client_payload);
  const activity = asJsonObject(clientPayload.activity ?? clientPayload);
  if (Object.keys(activity).length > 0) return activity;
  return root;
}

function targetRepository(root: JsonObject, activity: JsonObject) {
  const clientPayload = asJsonObject(root.client_payload);
  const repo = asJsonObject(root.repository);
  return (
    stringOrNull(activity.target_repo) ??
    stringOrNull(activity.repo) ??
    stringOrNull(activity.repository) ??
    stringOrNull(asJsonObject(activity.repository).full_name) ??
    stringOrNull(clientPayload.target_repo) ??
    stringOrNull(clientPayload.repo) ??
    stringOrNull(clientPayload.repository) ??
    stringOrNull(asJsonObject(clientPayload.repository).full_name) ??
    stringOrNull(repo.full_name)
  );
}

function spamCommentFromActivity(
  activity: JsonObject,
  targetRepo: string | null,
  type: "issue_comment" | "pull_request_review_comment",
): SpamScanComment {
  const comment = asJsonObject(activity.comment);
  const issue = asJsonObject(activity.issue);
  const user = asJsonObject(comment.user);
  return {
    kind: type,
    id: stringValue(comment.id ?? activity.comment_id ?? activity.id),
    node_id: stringOrNull(comment.node_id ?? activity.comment_node_id),
    html_url: stringOrNull(comment.html_url ?? comment.url ?? activity.comment_url ?? activity.url),
    issue_url:
      type === "issue_comment"
        ? (stringOrNull(issue.url ?? activity.issue_url) ?? issueApiUrl(targetRepo, activity))
        : null,
    pull_request_url:
      type === "pull_request_review_comment"
        ? (stringOrNull(activity.pull_request_url) ?? subjectUrl(activity, "pull_request"))
        : null,
    body: String(
      comment.body ?? comment.body_excerpt ?? activity.body ?? activity.body_excerpt ?? "",
    ),
    author:
      stringOrNull(user.login) ??
      stringOrNull(comment.author) ??
      stringOrNull(activity.author) ??
      stringOrNull(activity.actor),
    author_association: String(
      comment.author_association ?? activity.author_association ?? "NONE",
    ).toUpperCase(),
    created_at: stringOrNull(comment.created_at ?? activity.created_at),
    updated_at: stringOrNull(comment.updated_at ?? activity.updated_at),
  };
}

function issueApiUrl(targetRepo: string | null, activity: JsonObject) {
  const number = Number(
    asJsonObject(activity.subject).number ?? asJsonObject(activity.issue).number ?? activity.number,
  );
  if (!targetRepo || !Number.isInteger(number) || number <= 0) return null;
  return `https://api.github.com/repos/${targetRepo}/issues/${number}`;
}

function subjectUrl(activity: JsonObject, kind: string) {
  const subject = asJsonObject(activity.subject);
  if (stringOrNull(subject.kind) !== kind) return null;
  return stringOrNull(subject.url);
}

function stringValue(value: JsonValue) {
  const text = String(value ?? "").trim();
  return text;
}

function completeIntake({
  summary,
  ledger,
  writeReport,
  reportPath,
  now,
  log,
}: {
  summary: SpamCommentIntakeSummary;
  ledger: SpamCommentIntakeLedger;
  writeReport: boolean;
  reportPath: string;
  now: () => Date;
  log: (message: string) => void;
}) {
  let reportEvidence: ActionEventEvidence | null = null;
  const report = privacySafeSummary(summary, now().toISOString());
  if (writeReport) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const content = `${JSON.stringify(report, null, 2)}\n`;
    const bytes = Buffer.from(content);
    if (bytes.byteLength > MAX_REPORT_BYTES) {
      throw new Error(`spam comment intake report exceeds ${MAX_REPORT_BYTES} bytes`);
    }
    fs.writeFileSync(reportPath, bytes);
    const relativePath = path.relative(ledger.root, reportPath).split(path.sep).join("/");
    reportEvidence = {
      kind: "spam_comment_intake_report",
      sha256: sha256(bytes),
      ...(!relativePath.startsWith("../") && relativePath !== ".."
        ? { reportPath: relativePath }
        : {}),
    };
  }
  recordIntakeTerminal(ledger, summary, reportEvidence ? [reportEvidence] : []);
  log(JSON.stringify(report));
  return summary;
}

function startIntakeLedger({
  root,
  env,
  now,
  eventName,
  dispatchRepo,
  decision,
}: {
  root: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  eventName: string | undefined;
  dispatchRepo: string;
  decision: SpamCommentIntakeDecision | null;
}): SpamCommentIntakeLedger {
  const operationIdentity = intakeOperationIdentity(eventName, dispatchRepo, decision);
  const actionLedgerRoot = env.CLAWSWEEPER_ACTION_LEDGER_ROOT?.trim() || root;
  fs.mkdirSync(actionLedgerRoot, { recursive: true });
  const subject: ActionEventSubject = {
    repository: decision?.target_repo?.trim().toLowerCase() || dispatchRepo.trim().toLowerCase(),
    kind: "notification",
    subjectId:
      decision?.comment?.id && decision.comment.kind
        ? `${decision.comment.kind}:${decision.comment.id}`
        : "spam-comment-intake",
  };
  const startedAt = now();
  const start = recordWorkflowPhaseEvent(
    actionLedgerRoot,
    {
      phase: ACTION_EVENT_TYPES.reviewBatch,
      status: ACTION_EVENT_STATUSES.started,
      reasonCode: ACTION_EVENT_REASON_CODES.selected,
      retryable: false,
      mutation: false,
      identity: { slot: "spam_intake_start" },
      operation: "spam_comment_intake",
      operationIdentity,
      phaseSeq: 1,
      idempotencyIdentity: { operationIdentity, slot: "spam_intake_start" },
      component: "spam_comment_intake",
      subject,
      attributes: {
        batch_size: 1,
        review_mode: "spam_intake",
      },
      privacy: actionLedgerPrivacy(),
    },
    {
      env,
      now,
    },
  );
  return {
    root,
    actionLedgerRoot,
    env,
    now,
    operationIdentity,
    subject,
    lastEventId: start?.event_id ?? null,
    nextPhaseSeq: 2,
    startedAtMs: startedAt.getTime(),
    mutationObserved: false,
    uncertainMutationObserved: false,
    terminal: false,
  };
}

function recordClassification(
  ledger: SpamCommentIntakeLedger,
  decision: SpamCommentIntakeDecision | null,
): void {
  const accepted = decision?.accepted === true;
  const event = recordWorkflowPhaseEvent(
    ledger.actionLedgerRoot,
    {
      phase: ACTION_EVENT_TYPES.reviewItem,
      status: accepted ? ACTION_EVENT_STATUSES.classified : ACTION_EVENT_STATUSES.skipped,
      reasonCode: classificationReasonCode(decision),
      retryable: false,
      mutation: false,
      identity: {
        slot: "spam_intake_classification",
        outcome: accepted ? "accepted" : "rejected",
      },
      operation: "spam_comment_intake",
      operationIdentity: ledger.operationIdentity,
      parentEventId: ledger.lastEventId,
      phaseSeq: nextPhaseSeq(ledger),
      idempotencyIdentity: {
        operationIdentity: ledger.operationIdentity,
        slot: "spam_intake_classification",
      },
      component: "spam_comment_intake",
      subject: ledger.subject,
      attributes: {
        candidate_count: accepted ? 1 : 0,
        completion_reason: accepted ? "candidate_accepted" : "candidate_rejected",
        review_mode: "spam_intake",
        skipped_count: accepted ? 0 : 1,
      },
      privacy: actionLedgerPrivacy(),
    },
    {
      env: ledger.env,
      now: ledger.now,
    },
  );
  ledger.lastEventId = event?.event_id ?? ledger.lastEventId;
}

function recordDispatchOutcomeAfterFailure(
  ledger: SpamCommentIntakeLedger,
  options: DispatchOutcomeOptions,
): void {
  try {
    recordDispatchOutcome(ledger, options);
  } catch (receiptError) {
    console.error(
      `[spam-comment-intake] failed to record unknown dispatch outcome after the primary failure: ${errorText(receiptError)}`,
    );
  }
}

type DispatchOutcomeOptions = {
  attemptEventId: string | null;
  idempotencyIdentity: unknown;
  evidence: ActionEventEvidence[];
  requestSha256: string;
  outcome: "accepted" | "rejected" | "unknown";
};

function recordDispatchOutcome(
  ledger: SpamCommentIntakeLedger,
  options: DispatchOutcomeOptions,
): void {
  const event = recordWorkflowPhaseEvent(
    ledger.actionLedgerRoot,
    {
      phase: ACTION_EVENT_TYPES.dispatchLifecycle,
      status:
        options.outcome === "accepted"
          ? ACTION_EVENT_STATUSES.dispatched
          : options.outcome === "rejected"
            ? ACTION_EVENT_STATUSES.skipped
            : ACTION_EVENT_STATUSES.failed,
      reasonCode:
        options.outcome === "accepted"
          ? ACTION_EVENT_REASON_CODES.accepted
          : options.outcome === "rejected"
            ? ACTION_EVENT_REASON_CODES.notApplicable
            : ACTION_EVENT_REASON_CODES.unavailable,
      retryable: false,
      mutation: options.outcome !== "rejected",
      identity: {
        slot: "spam_dispatch_outcome",
        requestSha256: options.requestSha256,
        outcome: options.outcome,
      },
      operation: "spam_comment_intake",
      operationIdentity: ledger.operationIdentity,
      parentEventId: options.attemptEventId ?? ledger.lastEventId,
      phaseSeq: nextPhaseSeq(ledger),
      idempotencyIdentity: options.idempotencyIdentity,
      component: "spam_comment_intake",
      subject: ledger.subject,
      evidence: options.evidence,
      attributes: {
        attempt: 1,
        completion_reason:
          options.outcome === "accepted"
            ? "mutation_accepted"
            : options.outcome === "rejected"
              ? "mutation_rejected"
              : "mutation_outcome_unknown",
        dispatch_kind: "repository_dispatch",
        failed_count: options.outcome === "accepted" ? 0 : 1,
        review_mode: "spam_intake",
      },
      privacy: actionLedgerPrivacy(),
    },
    {
      env: ledger.env,
      now: ledger.now,
    },
  );
  ledger.lastEventId = event?.event_id ?? ledger.lastEventId;
}

function recordIntakeTerminal(
  ledger: SpamCommentIntakeLedger,
  summary: SpamCommentIntakeSummary,
  evidence: ActionEventEvidence[],
): void {
  if (ledger.terminal) return;
  const event = recordWorkflowPhaseEvent(
    ledger.actionLedgerRoot,
    {
      phase: ACTION_EVENT_TYPES.reviewBatch,
      status:
        summary.status === "ok"
          ? ACTION_EVENT_STATUSES.completed
          : summary.status === "skipped"
            ? ACTION_EVENT_STATUSES.skipped
            : ACTION_EVENT_STATUSES.failed,
      reasonCode: terminalReasonCode(summary),
      retryable: false,
      mutation: ledger.mutationObserved,
      identity: {
        slot: "spam_intake_terminal",
        outcome: summary.status,
      },
      operation: "spam_comment_intake",
      operationIdentity: ledger.operationIdentity,
      parentEventId: ledger.lastEventId,
      phaseSeq: nextPhaseSeq(ledger),
      idempotencyIdentity: {
        operationIdentity: ledger.operationIdentity,
        slot: "spam_intake_terminal",
      },
      component: "spam_comment_intake",
      subject: ledger.subject,
      evidence,
      attributes: {
        candidate_count: summary.decision?.accepted ? 1 : 0,
        completion_reason: terminalCompletionReason(summary, ledger),
        duration_ms: Math.max(0, ledger.now().getTime() - ledger.startedAtMs),
        failed_count: summary.status === "failed" ? 1 : 0,
        partial: summary.status === "failed" && ledger.mutationObserved,
        processed_count: summary.dispatched,
        review_mode: "spam_intake",
        skipped_count: summary.status === "skipped" ? 1 : 0,
      },
      privacy: actionLedgerPrivacy(),
    },
    {
      env: ledger.env,
      now: ledger.now,
    },
  );
  ledger.lastEventId = event?.event_id ?? ledger.lastEventId;
  ledger.terminal = true;
}

function intakeOperationIdentity(
  eventName: string | undefined,
  dispatchRepo: string,
  decision: SpamCommentIntakeDecision | null,
) {
  return {
    dispatchRepository: dispatchRepo.trim().toLowerCase(),
    sourceEvent: eventName?.trim() || "unknown",
    targetRepository: decision?.target_repo?.trim().toLowerCase() || "unknown",
    commentKind: decision?.comment?.kind || "unknown",
    commentId: decision?.comment?.id || "unknown",
  };
}

function classificationReasonCode(
  decision: SpamCommentIntakeDecision | null,
): ActionEventReasonCode {
  if (decision?.accepted) return ACTION_EVENT_REASON_CODES.accepted;
  if (!decision || /missing|unsupported/.test(decision.reason)) {
    return ACTION_EVENT_REASON_CODES.invalidInput;
  }
  return ACTION_EVENT_REASON_CODES.policyBlocked;
}

function terminalReasonCode(summary: SpamCommentIntakeSummary): ActionEventReasonCode {
  if (summary.status === "ok") {
    return summary.reason === "dry run"
      ? ACTION_EVENT_REASON_CODES.dryRun
      : ACTION_EVENT_REASON_CODES.completed;
  }
  if (summary.status === "skipped") return classificationReasonCode(summary.decision);
  if (summary.reason?.includes("TOKEN")) return ACTION_EVENT_REASON_CODES.authorizationFailed;
  return ACTION_EVENT_REASON_CODES.unavailable;
}

function terminalCompletionReason(
  summary: SpamCommentIntakeSummary,
  ledger: SpamCommentIntakeLedger,
): string {
  if (ledger.uncertainMutationObserved) return "dispatch_outcome_unknown";
  if (summary.status === "failed") return "failed";
  if (summary.status === "skipped") return "candidate_rejected";
  if (summary.reason === "dry run") return "dry_run";
  return "completed";
}

function privacySafeSummary(summary: SpamCommentIntakeSummary, generatedAt: string) {
  return {
    status: summary.status,
    dispatched: summary.dispatched,
    reason: summary.reason,
    decision: summary.decision
      ? {
          accepted: summary.decision.accepted,
          reason: summary.decision.reason,
          target_repo: summary.decision.target_repo,
          comment: summary.decision.comment
            ? {
                kind: summary.decision.comment.kind,
                id: summary.decision.comment.id,
                author_association: summary.decision.comment.author_association,
                created_at: summary.decision.comment.created_at,
                updated_at: summary.decision.comment.updated_at,
              }
            : null,
          ...(summary.decision.accepted
            ? { dispatch_payload: summary.decision.dispatch_payload }
            : {}),
        }
      : null,
    generated_at: generatedAt,
  };
}

function actionLedgerPrivacy() {
  return {
    classification: "internal" as const,
    redactionVersion: "v1",
    fieldsDropped: [
      "authorization",
      "body",
      "client_payload",
      "comment_url",
      "html_url",
      "private_url",
      "raw_payload",
      "token",
    ],
  };
}

function nextPhaseSeq(ledger: SpamCommentIntakeLedger): number {
  const phaseSeq = ledger.nextPhaseSeq;
  ledger.nextPhaseSeq += 1;
  return phaseSeq;
}

export function spamDispatchHttpOutcome(response: { status: number }): "rejected" | "unknown" {
  if (
    response.status >= 400 &&
    response.status < 500 &&
    ![408, 425, 429].includes(response.status)
  ) {
    return "rejected";
  }
  return "unknown";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
