import type { LooseRecord } from "./json-types.js";

export function reviewedResultRevision(
  result: LooseRecord,
  clusterPlan: LooseRecord | null,
): string | null {
  for (const value of [
    result.reviewed_sha,
    result.head_sha,
    result.canonical?.pull_request?.head_sha,
    result.canonical_item?.pull_request?.head_sha,
    clusterPlan?.expected_head_sha,
    clusterPlan?.source_revision,
  ]) {
    const revision = String(value ?? "").trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(revision)) return revision;
  }
  return null;
}
