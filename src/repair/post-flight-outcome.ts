import type { JsonValue, LooseRecord } from "./json-types.js";

const SUCCESSFUL_POST_FLIGHT_STATUSES = new Set(["executed", "published", "ready"]);
const AUDITED_NO_PR_SOURCE_REASONS = new Set([
  "Codex produced no target repo changes; treating this allow_no_pr artifact as an audited no-PR outcome",
  "prepared replacement branch has no changes versus base after repair",
  "replacement branch has no changes versus base after repair",
]);

export function postFlightExitCode(report: LooseRecord): number {
  const actions = Array.isArray(report.actions) ? report.actions : [];
  const effectiveActions = effectivePostFlightActions(actions);
  const dryRun = report.dry_run === true;
  const auditedNoPrTerminal =
    effectiveActions.length === 1 && isAuditedCommitFindingNoPrOutcome(report, effectiveActions[0]);
  return effectiveActions.length > 0 &&
    effectiveActions.every((action: JsonValue) => {
      const status = String(action?.status ?? "");
      return (
        SUCCESSFUL_POST_FLIGHT_STATUSES.has(status) ||
        (dryRun && status === "planned") ||
        (auditedNoPrTerminal && action === effectiveActions[0])
      );
    })
    ? 0
    : 1;
}

function isAuditedCommitFindingNoPrOutcome(report: LooseRecord, action: JsonValue): boolean {
  return (
    report.dry_run === false &&
    report.job_intent === "commit_finding" &&
    report.source === "clawsweeper_commit" &&
    /^[0-9a-f]{40}$/i.test(String(report.commit_sha ?? "")) &&
    report.allow_no_pr === true &&
    action?.action === "finalize_fix_pr" &&
    action?.source_action === "open_fix_pr" &&
    action?.source_status === "skipped" &&
    action?.status === "skipped" &&
    AUDITED_NO_PR_SOURCE_REASONS.has(String(action?.source_reason ?? ""))
  );
}

function effectivePostFlightActions(actions: JsonValue[]): JsonValue[] {
  const finalFixIndex = actions.findLastIndex(
    (action: JsonValue) => action?.action === "finalize_fix_pr",
  );
  if (finalFixIndex < 0) return actions;

  const finalFix = actions[finalFixIndex];
  if (finalFix?.source_action !== "open_fix_pr") return actions;

  return actions.filter((action: JsonValue, index: number) => {
    if (index >= finalFixIndex) return true;
    return !(
      action?.action === "finalize_fix_pr" &&
      action?.source_action === "repair_contributor_branch" &&
      action?.status === "skipped" &&
      ["blocked", "failed", "skipped"].includes(String(action?.source_status ?? ""))
    );
  });
}
