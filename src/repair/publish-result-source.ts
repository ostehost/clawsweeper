import type { LooseRecord } from "./json-types.js";
import { parsePullRequestUrl } from "./github-ref.js";
import { repairSourceRevision } from "./repair-action-ledger.js";

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
