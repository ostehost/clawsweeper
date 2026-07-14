import type { LooseRecord } from "./json-types.js";
import { parsePullRequestUrl } from "./github-ref.js";
import { repairSourceRevision } from "./repair-action-ledger.js";

export type CanonicalResultPublicationDecision = {
  publish: boolean;
  reason: "first_generation" | "newer_generation" | "stale_generation";
  supersededByRunId: string | null;
};

export function reviewedResultRevision(
  result: LooseRecord,
  clusterPlan: LooseRecord | null,
  sourceContext: LooseRecord | null = null,
): string | null {
  const canonicalPr = String(result.canonical_pr ?? "").trim();
  const canonicalRevision = canonicalPullRequestRevision(result, clusterPlan);
  if (canonicalPr && !canonicalRevision) return null;
  const revisions = [
    canonicalRevision,
    exactRevision(repairSourceRevision(sourceContext ?? {})),
  ].filter((revision): revision is string => Boolean(revision));
  return new Set(revisions).size === 1 ? revisions[0]! : null;
}

export function canonicalResultPublicationDecision(
  candidate: LooseRecord,
  records: LooseRecord[],
): CanonicalResultPublicationDecision {
  const repo = normalizedText(candidate.repo).toLowerCase();
  const clusterId = normalizedText(candidate.cluster_id);
  const current = latestResultPublicationRecords(records).find(
    (record) =>
      normalizedText(record.repo).toLowerCase() === repo &&
      normalizedText(record.cluster_id) === clusterId,
  );
  if (!current) {
    return {
      publish: true,
      reason: "first_generation",
      supersededByRunId: null,
    };
  }
  if (compareResultPublicationGeneration(candidate, current) > 0) {
    return {
      publish: true,
      reason: "newer_generation",
      supersededByRunId: null,
    };
  }
  return {
    publish: false,
    reason: "stale_generation",
    supersededByRunId: normalizedText(current.run_id) || null,
  };
}

export function latestResultPublicationRecords(records: LooseRecord[]): LooseRecord[] {
  const latest = new Map<string, LooseRecord>();
  for (const record of records) {
    const repo = normalizedText(record.repo).toLowerCase();
    const clusterId = normalizedText(record.cluster_id);
    if (!repo || !clusterId) continue;
    const key = `${repo}:${clusterId}`;
    const current = latest.get(key);
    if (!current || compareResultPublicationGeneration(record, current) > 0) {
      latest.set(key, record);
    }
  }
  return [...latest.values()];
}

export function compareResultPublicationGeneration(
  candidate: LooseRecord,
  current: LooseRecord,
): number {
  const candidateCreatedAt = timestamp(candidate.workflow_created_at);
  const currentCreatedAt = timestamp(current.workflow_created_at);
  if (
    candidateCreatedAt !== null &&
    currentCreatedAt !== null &&
    candidateCreatedAt !== currentCreatedAt
  ) {
    return candidateCreatedAt < currentCreatedAt ? -1 : 1;
  }

  const candidateRunId = positiveIntegerText(candidate.run_id);
  const currentRunId = positiveIntegerText(current.run_id);
  const runId = compareIntegerText(candidateRunId, currentRunId);
  if (runId !== 0) return runId;

  if (candidateRunId && currentRunId && candidateRunId === currentRunId) {
    const producerAttempt = compareIntegerText(
      positiveIntegerText(candidate.producer_attempt),
      positiveIntegerText(current.producer_attempt),
    );
    if (producerAttempt !== 0) return producerAttempt;
  }

  if (candidateCreatedAt === null && currentCreatedAt === null) {
    return compareTimestamps(candidate.published_at, current.published_at);
  }
  if (candidateCreatedAt === null) return -1;
  if (currentCreatedAt === null) return 1;
  return 0;
}

function canonicalPullRequestRevision(
  result: LooseRecord,
  clusterPlan: LooseRecord | null,
): string | null {
  const resultRepo = String(result.repo ?? "")
    .trim()
    .toLowerCase();
  const canonicalNumber = canonicalPullRequestNumber(result.canonical_pr, resultRepo);
  if (!canonicalNumber || !Array.isArray(clusterPlan?.items)) return null;
  const matches = clusterPlan.items.filter(
    (item: LooseRecord) =>
      String(item?.kind ?? "") === "pull_request" &&
      githubItemNumber(item?.ref ?? item?.number) === canonicalNumber &&
      (!resultRepo ||
        String(item?.repo ?? "")
          .trim()
          .toLowerCase() === resultRepo),
  );
  if (matches.length !== 1) return null;
  return exactRevision(matches[0]?.pull_request?.head_sha);
}

function canonicalPullRequestNumber(value: unknown, resultRepo: string): number | null {
  if (!resultRepo) return null;
  const normalized = String(value ?? "").trim();
  const shorthand = normalized.match(/^#?([1-9][0-9]*)$/);
  if (shorthand) return Number(shorthand[1]);
  const pullRequest = parsePullRequestUrl(normalized);
  if (!pullRequest || pullRequest.repo.toLowerCase() !== resultRepo) return null;
  return pullRequest.number;
}

function githubItemNumber(value: unknown): number | null {
  const normalized = String(value ?? "").trim();
  const match =
    normalized.match(/^#?([1-9][0-9]*)$/) ??
    normalized.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/([1-9][0-9]*)$/i);
  const number = Number(match?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function exactRevision(value: unknown): string | null {
  const revision = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) ? revision : null;
}

function compareTimestamps(left: unknown, right: unknown): number {
  const leftTimestamp = timestamp(left);
  const rightTimestamp = timestamp(right);
  if (leftTimestamp === rightTimestamp) return 0;
  if (leftTimestamp === null) return -1;
  if (rightTimestamp === null) return 1;
  return leftTimestamp < rightTimestamp ? -1 : 1;
}

function timestamp(value: unknown): number | null {
  const text = normalizedText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareIntegerText(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : 1;
}

function positiveIntegerText(value: unknown): string | null {
  const text = normalizedText(value);
  return /^[1-9][0-9]*$/.test(text) ? text : null;
}

function normalizedText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
