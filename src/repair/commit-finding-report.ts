import { createHash } from "node:crypto";

export type CommitFindingReportReadResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: string };

export function assertCommitFindingReportRevision(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("report revision must be an exact lowercase 40-hex commit SHA");
  }
  return value;
}

export function assertCommitFindingReportSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("report SHA-256 must be an exact lowercase 64-hex digest");
  }
  return value;
}

export function commitFindingReportSha256(reportBytes: Uint8Array): string {
  return createHash("sha256").update(reportBytes).digest("hex");
}

export function verifyCommitFindingReport(reportBytes: Uint8Array, expectedSha256: string): string {
  const expected = assertCommitFindingReportSha256(expectedSha256);
  const actual = commitFindingReportSha256(reportBytes);
  if (actual !== expected) {
    throw new Error(`commit finding report SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
  return Buffer.from(reportBytes).toString("utf8");
}

export function immutableCommitFindingReportUrl(
  reportRepo: string,
  reportPath: string,
  reportRevision: string,
): string {
  const revision = assertCommitFindingReportRevision(reportRevision);
  return `https://github.com/${reportRepo}/blob/${revision}/${reportPath}`;
}

export function missingCommitFindingReport(
  reportRepo: string,
  reportPath: string,
  reportRevision: string,
) {
  return {
    ok: false,
    reason: `report ${reportRepo}:${reportPath} is not available at ${reportRevision}`,
  } satisfies CommitFindingReportReadResult;
}

export function isMissingGithubContentError(message: string): boolean {
  return /\b(?:HTTP 404|status code 404|Not Found \(HTTP 404\))\b/i.test(message);
}
