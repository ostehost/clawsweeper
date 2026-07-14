export type CommitFindingReportReadResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: string };

export function missingCommitFindingReport(reportRepo: string, reportPath: string) {
  return {
    ok: false,
    reason: `report ${reportRepo}:${reportPath} is not available on main`,
  } satisfies CommitFindingReportReadResult;
}

export function isMissingGithubContentError(message: string): boolean {
  return /\b(?:HTTP 404|status code 404|Not Found \(HTTP 404\))\b/i.test(message);
}
