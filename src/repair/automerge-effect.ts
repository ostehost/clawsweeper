import type { JsonValue, LooseRecord } from "./json-types.js";
import { ghRetryKind } from "../github-retry.js";
import { stripAnsi } from "./comment-router-utils.js";

const DEFINITIVE_AUTOMERGE_REJECTION_PATTERNS = [
  /\bPull Request is not mergeable\b[\s\S]*\bmergePullRequest\b/i,
  /\bmergePullRequest\b[\s\S]*\bPull Request is not mergeable\b/i,
  /\bHTTP\s*405\b[\s\S]*\bPull Request is not mergeable\b/i,
];

export type AutomergeEffectConfirmation = {
  mergedAt: string | null;
  mergeCommitSha: string | null;
  pendingReason: string;
  block: string;
};

export type AutomergeEffectProof = {
  requireSquashMethod?: boolean;
  squashCommit?: SquashMergeCommitProof;
};

export type SquashMergeCommitProof = {
  mergeCommitSha: JsonValue;
  commit: JsonValue;
  expectedMessage: JsonValue;
};

export function expectedSquashCommitMessage(subject: JsonValue, body: JsonValue): string {
  const normalizedSubject = normalizeCommitMessage(subject).trim();
  const normalizedBody = normalizeCommitMessage(body).trimEnd();
  return normalizedBody ? `${normalizedSubject}\n\n${normalizedBody}` : normalizedSubject;
}

export function squashMergedMethodBlock(proof?: SquashMergeCommitProof): string {
  if (!proof) return "merged pull request method could not be proven as SQUASH";
  const mergeCommitSha = normalizeSha(proof.mergeCommitSha);
  const commit = proof.commit;
  if (!mergeCommitSha || !commit || typeof commit !== "object" || Array.isArray(commit)) {
    return "merged pull request method could not be proven as SQUASH";
  }
  if (normalizeSha(commit.sha) !== mergeCommitSha) {
    return "observed merge commit does not match the pull request merge commit";
  }
  if (!Array.isArray(commit.parents) || commit.parents.length !== 1) {
    return "observed merge commit does not have squash-merge topology";
  }
  const expectedMessage = normalizeCommitMessage(proof.expectedMessage).trimEnd();
  const actualMessage = normalizeCommitMessage(commit.commit?.message).trimEnd();
  if (!expectedMessage || actualMessage !== expectedMessage) {
    return "observed merge commit does not match the dispatched squash payload";
  }
  return "";
}

export function squashAutomergeMethodBlock(autoMergeRequest: JsonValue): string {
  if (!autoMergeRequest) return "";
  if (typeof autoMergeRequest !== "object" || Array.isArray(autoMergeRequest)) {
    return "pending auto-merge request does not prove the required SQUASH method";
  }
  const request = autoMergeRequest as LooseRecord;
  const method = String(request.mergeMethod ?? request.merge_method ?? "")
    .trim()
    .toUpperCase();
  if (method === "SQUASH") return "";
  return method
    ? `pending auto-merge request uses ${method} instead of SQUASH`
    : "pending auto-merge request does not prove the required SQUASH method";
}

export function squashMergeQueueMethodBlock(view: LooseRecord, pull: LooseRecord): string {
  if (view.isInMergeQueue !== true) return "";
  if (view.autoMergeRequest || pull.auto_merge) return "";
  return "pending merge queue state does not prove the required SQUASH method";
}

export function applyAutomergeResultToCommand(command: LooseRecord, merge: LooseRecord): boolean {
  command.actions = (Array.isArray(command.actions) ? command.actions : []).map(
    (action: LooseRecord) =>
      action.action === "label"
        ? { ...action, status: "executed", label: action.label }
        : action.action === "remove_label"
          ? { ...action, status: "executed", label: action.label }
          : action.action === "update_description_note"
            ? { ...action, status: "executed" }
            : action.action === "merge"
              ? { ...action, ...merge, completed_at: new Date().toISOString() }
              : action,
  );
  if (merge.status !== "waiting") return false;
  command.status = "waiting";
  return true;
}

export function confirmAutomergeEffectSnapshot(
  snapshot: LooseRecord,
  expectedHeadSha: JsonValue,
  proof: AutomergeEffectProof = {},
): AutomergeEffectConfirmation {
  const expected = normalizeSha(expectedHeadSha);
  const pull = snapshot.pull ?? {};
  const view = snapshot.view ?? {};
  const observed = normalizeSha(pull.head?.sha);
  const mergedAt = String(pull.merged_at ?? "").trim() || null;
  const mergeCommitSha = String(pull.merge_commit_sha ?? "").trim() || null;
  if (!expected || observed !== expected) {
    return {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: mergedAt
        ? "merged pull request head does not match the authorized automerge head"
        : "pull request head changed before the automerge effect could be confirmed",
    };
  }
  if (mergedAt) {
    const methodBlock =
      proof.requireSquashMethod === false ? "" : squashMergedMethodBlock(proof.squashCommit);
    return {
      mergedAt: methodBlock ? null : mergedAt,
      mergeCommitSha: methodBlock ? null : mergeCommitSha,
      pendingReason: "",
      block: methodBlock,
    };
  }

  const viewHead = normalizeSha(view.headRefOid);
  if (viewHead && viewHead !== expected) {
    return {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: "pull request head changed before the automerge effect could be confirmed",
    };
  }
  const viewMethodBlock = squashAutomergeMethodBlock(view.autoMergeRequest);
  if (viewMethodBlock) {
    return {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: viewMethodBlock,
    };
  }
  const restMethodBlock = squashAutomergeMethodBlock(pull.auto_merge);
  if (restMethodBlock) {
    return {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: restMethodBlock,
    };
  }
  const queueMethodBlock = squashMergeQueueMethodBlock(view, pull);
  if (queueMethodBlock) {
    return {
      mergedAt: null,
      mergeCommitSha: null,
      pendingReason: "",
      block: queueMethodBlock,
    };
  }
  const pendingReason =
    viewHead === expected && view.isInMergeQueue === true
      ? `reviewed head ${expected} is pending in the merge queue`
      : viewHead === expected && view.autoMergeRequest
        ? `reviewed head ${expected} has auto-merge pending`
        : pull.auto_merge
          ? `reviewed head ${expected} has auto-merge pending`
          : "";
  return {
    mergedAt: null,
    mergeCommitSha: null,
    pendingReason,
    block: "",
  };
}

export function automergeEffectDefinitelyAbsent(
  snapshot: LooseRecord,
  expectedHeadSha: JsonValue,
): boolean {
  const confirmation = confirmAutomergeEffectSnapshot(snapshot, expectedHeadSha, {
    requireSquashMethod: false,
  });
  const view = snapshot.view ?? {};
  const expected = normalizeSha(expectedHeadSha);
  const graphHead = normalizeSha(view.headRefOid);
  const graphMergedAt = String(view.mergedAt ?? "").trim();
  const graphState = String(view.state ?? "")
    .trim()
    .toUpperCase();
  return Boolean(
    expected &&
    graphHead === expected &&
    !graphMergedAt &&
    graphState !== "MERGED" &&
    !confirmation.block &&
    !confirmation.mergedAt &&
    !confirmation.pendingReason,
  );
}

export function automergeCommandResponseAmbiguous(attempt: LooseRecord) {
  return Boolean(
    attempt.command_error || attempt.command_result?.error || attempt.command_result?.status !== 0,
  );
}

export function automergeCommandFailure(attempt: LooseRecord) {
  if (attempt.command_error) return compactFailure(attempt.command_error);
  const result = attempt.command_result ?? {};
  return stripAnsi(
    result.stderr || result.stdout || result.error?.message || "unknown error",
  ).trim();
}

export function automergeUnconfirmedFailureDisposition(
  attempt: LooseRecord,
): "waiting" | "blocked" {
  const error =
    attempt.command_error ?? attempt.command_result?.error ?? automergeCommandFailure(attempt);
  if (ghRetryKind(error) !== "none") return "waiting";
  const failure = automergeCommandFailure(attempt);
  return DEFINITIVE_AUTOMERGE_REJECTION_PATTERNS.some((pattern) => pattern.test(failure))
    ? "blocked"
    : "waiting";
}

export function automergeAttemptReceiptOutcome(
  attempt: LooseRecord,
): "accepted" | "rejected" | "unknown" {
  const confirmation = attempt.confirmation as AutomergeEffectConfirmation | null | undefined;
  if (
    confirmation &&
    !confirmation.block &&
    (confirmation.mergedAt || confirmation.pendingReason)
  ) {
    return "accepted";
  }
  if (confirmation?.block) return "unknown";
  if (
    automergeCommandResponseAmbiguous(attempt) &&
    automergeUnconfirmedFailureDisposition(attempt) === "blocked"
  ) {
    return "rejected";
  }
  return "unknown";
}

function normalizeSha(value: JsonValue) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeCommitMessage(value: JsonValue) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function compactFailure(error: unknown) {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return stripAnsi(
    [error instanceof Error ? error.message : String(error ?? ""), record.stderr, record.stdout]
      .filter(Boolean)
      .join("\n"),
  ).trim();
}
