#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../action-ledger.js";
import { githubActionsRunUrl, parseArgs, repoRoot } from "./lib.js";
import { readJsonFile as readJson } from "./json-file.js";
import { escapeRegExp, slug } from "./text-utils.js";
import { renderClusterReport, writeClosedRecord } from "./publish-cluster-report.js";
import {
  findResultPaths,
  inferRunId,
  readArchivedClusters,
  readExistingRunRecord,
  readRunMetadata,
  readRunRecords,
  readSiblingJson,
} from "./publish-files.js";
import { formatTimestamp, normalizeRetiredRepairEnvNames, tableCell } from "./publish-markdown.js";
import {
  buildInspectionRows,
  renderBlockedReasonRows,
  renderFinalizerRows,
  renderFixFailureRows,
  renderInspectionRows,
  renderRecentClosureRows,
} from "./publish-dashboard-rows.js";
import {
  buildTrackedPrRows,
  hydrateClosureRows,
  sortNewestClosureRowFirst,
} from "./publish-tracked-rows.js";
import {
  canonicalResultPublicationDecision,
  compareResultPublicationGeneration,
  latestResultPublicationRecords,
  reviewedResultRevision,
} from "./publish-result-source.js";
import {
  flushRepairActionEvents,
  recordRepairLifecycleEvent,
  recordRepairLifecycleFailureSafely,
  type RepairLifecycleInput,
} from "./repair-action-ledger.js";
import { resolveStateJobIdentity } from "./immutable-job-handoff.js";

const DASHBOARD_START = "<!-- clawsweeper-repair-dashboard:start -->";
const DASHBOARD_END = "<!-- clawsweeper-repair-dashboard:end -->";
const CLOSE_APPLICATOR_ACTIONS = new Set([
  "close",
  "close_duplicate",
  "close_superseded",
  "close_fixed_by_candidate",
  "close_low_signal",
  "post_merge_close",
]);
const MERGE_APPLICATOR_ACTIONS = new Set(["merge_candidate", "merge_canonical"]);
const APPLICATOR_ACTIONS = new Set([...CLOSE_APPLICATOR_ACTIONS, ...MERGE_APPLICATOR_ACTIONS]);
const POST_FLIGHT_APPLY_ACTIONS = new Set(["finalize_fix_pr", "post_merge_closeout"]);
const SOURCE_JOB_PATH = /^jobs\/[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md$/;
const root = repoRoot();
const archivedClusters = readArchivedClusters(root);

const args = parseArgs(process.argv.slice(2));
const inputs = args._.length > 0 ? args._ : [path.join(root, ".clawsweeper-repair", "runs")];
const metadataByRunId = readRunMetadata(args["runs-json"]);
const trustedLegacyWorkerHeadArg = args["trusted-legacy-worker-head"];
const trustedLegacyWorkerHead =
  trustedLegacyWorkerHeadArg === undefined ? null : exactHex(trustedLegacyWorkerHeadArg, 40);
if (trustedLegacyWorkerHeadArg !== undefined && !trustedLegacyWorkerHead) {
  throw new Error("--trusted-legacy-worker-head must be an exact lowercase 40-hex commit");
}
const published: LooseRecord[] = [];

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runPublishResult();
}

async function runPublishResult() {
  let commandError: unknown = null;
  try {
    for (const input of inputs) {
      for (const resultPath of findResultPaths(path.resolve(input))) {
        const record = publishResult(resultPath);
        published.push(record);
      }
    }

    writeAggregateApplyReport();
    recordAggregatePreparation("apply_report");
    if (args["write-dashboard"]) {
      updateDashboard();
      recordAggregatePreparation("repair_dashboard");
    }

    console.log(JSON.stringify({ published: published.length, records: published }, null, 2));
  } catch (error) {
    commandError = error;
    recordRepairLifecycleFailureSafely(aggregateLifecycle("publish_result"), {
      component: "publish_result",
      operation: "publication",
      phase: "publish",
      error,
    });
  }

  try {
    await flushRepairActionEvents();
  } catch (error) {
    if (commandError) {
      console.error(
        `[action-ledger] failed to finalize result publication receipts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } else {
      commandError = error;
    }
  }
  if (commandError) throw commandError;
}

function publishResult(resultPath: string) {
  const runDir = path.dirname(resultPath);
  const result = readJson(resultPath);
  const applyReport = readSiblingJson(runDir, "apply-report.json") ?? { actions: [] };
  const postFlightReport = readSiblingJson(runDir, "post-flight-report.json") ?? { actions: [] };
  const fixReport = readSiblingJson(runDir, "fix-execution-report.json") ?? { actions: [] };
  const clusterPlan = readSiblingJson(runDir, "cluster-plan.json");
  const sealedSource = readSealedPublishedSource(
    runDir,
    result,
    clusterPlan,
    resultPath,
    trustedLegacyWorkerHead,
  );
  const sourceContext = sealedSource?.frontmatter ?? null;
  const reviewedTargetRevision = resultPublicationSourceRevision(
    result,
    clusterPlan,
    sourceContext,
    resultPath,
  );
  const runId = String(args["run-id"] ?? inferRunId(resultPath) ?? "");
  const metadata = runId ? metadataByRunId.get(runId) : undefined;
  const previousRecord = runId ? readExistingRunRecord(root, runId) : null;
  const runUrl =
    String(args["run-url"] ?? metadata?.url ?? "") ||
    previousRecord?.run_url ||
    (runId ? githubActionsRunUrl(runId) : null);
  const headSha = String(
    args["head-sha"] ?? metadata?.headSha ?? metadata?.head_sha ?? previousRecord?.head_sha ?? "",
  );
  const workflowConclusion = String(
    args.conclusion ?? metadata?.conclusion ?? previousRecord?.workflow_conclusion ?? "",
  );
  const workflowStatus = String(metadata?.status ?? previousRecord?.workflow_status ?? "");
  const workflowCreatedAt = publicationTimestamp(
    args["workflow-created-at"] ??
      metadata?.createdAt ??
      metadata?.created_at ??
      previousRecord?.workflow_created_at,
    "--workflow-created-at",
  );
  const producerAttempt = publicationPositiveInteger(
    args["producer-attempt"] ??
      metadata?.runAttempt ??
      metadata?.run_attempt ??
      previousRecord?.producer_attempt,
    "--producer-attempt",
  );
  const repo = String(result.repo ?? "unknown/unknown");
  const owner = repo.split("/")[0] || "unknown";
  const clusterId = String(result.cluster_id ?? path.basename(runDir));
  const applyActions = uniquePlainActionRows(
    [
      ...(applyReport.actions ?? []),
      ...(postFlightReport.actions ?? [])
        .filter(isPostFlightApplyAction)
        .map(postFlightToApplyAction),
    ].filter(isApplicatorAction),
  );
  const fixActions = (fixReport.actions ?? []).map(sanitizeFixAction);
  const report = {
    repo,
    cluster_id: clusterId,
    mode: result.mode ?? null,
    run_id: runId || null,
    run_url: runUrl,
    head_sha: headSha || null,
    workflow_conclusion: workflowConclusion || null,
    workflow_status: workflowStatus || null,
    post_flight_outcome: postFlightReport.outcome ?? null,
    post_flight_detail: postFlightReport.detail ?? null,
    workflow_created_at: workflowCreatedAt,
    workflow_updated_at:
      metadata?.updatedAt ?? metadata?.updated_at ?? previousRecord?.workflow_updated_at ?? null,
    producer_attempt: producerAttempt,
    result_status: result.status ?? null,
    source_job: sealedSource?.sourceJob ?? null,
    source_state_revision: sealedSource?.stateRevision ?? null,
    source_job_sha256: sealedSource?.jobSha256 ?? null,
    source_provenance: sealedSource?.provenance ?? null,
    source_worker_revision: sealedSource?.workerHeadSha ?? null,
    published_at: new Date().toISOString(),
    canonical: result.canonical ?? null,
    canonical_issue: result.canonical_issue ?? null,
    canonical_pr: result.canonical_pr ?? null,
    summary: result.summary ?? "",
    actions: summarizeActions(result.actions),
    action_counts: countBy(result.actions ?? [], (action: JsonValue) =>
      String(action.action ?? "unknown"),
    ),
    action_status_counts: countBy(result.actions ?? [], (action: JsonValue) =>
      String(action.status ?? "unknown"),
    ),
    fix_counts: countBy(fixActions, (action: JsonValue) => String(action.status ?? "unknown")),
    apply_counts: countBy(applyActions, (action: JsonValue) => String(action.status ?? "unknown")),
    needs_human: Array.isArray(result.needs_human) ? result.needs_human : [],
    fix_actions: fixActions,
    apply_actions: applyActions.map(sanitizeApplyAction),
  };

  const reportDir = path.join(root, "results", owner);
  fs.mkdirSync(reportDir, { recursive: true });
  const existingRecords = readRunRecords(root);
  const canonicalDecision = canonicalResultPublicationDecision(report, existingRecords);
  const canonicalPublicationStatus = canonicalDecision.publish ? "published" : "stale_noop";
  Object.assign(report, {
    canonical_publication_status: canonicalPublicationStatus,
    canonical_publication_reason: canonicalDecision.reason,
    canonical_superseded_by_run_id: canonicalDecision.supersededByRunId,
  });
  if (canonicalDecision.publish) {
    fs.writeFileSync(
      path.join(reportDir, `${slug(clusterId)}.md`),
      renderClusterReport(report),
      "utf8",
    );
  }

  const runDirOut = path.join(root, "results", "runs");
  fs.mkdirSync(runDirOut, { recursive: true });
  const replaceRunRecord =
    !previousRecord || compareResultPublicationGeneration(report, previousRecord) >= 0;
  if (runId && replaceRunRecord) {
    fs.writeFileSync(
      path.join(runDirOut, `${runId}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  }

  if (canonicalDecision.publish) {
    for (const action of report.apply_actions.filter(
      (action: JsonValue) => action.status === "executed",
    )) {
      writeClosedRecord({ report, action, owner, root });
    }
  }

  recordRepairLifecycleEvent(
    {
      repository: repo,
      workKey: `${repo}:${clusterId}`,
      clusterId,
      sourceRevision: reviewedTargetRevision,
      recordPath: path.posix.join("results", owner, `${slug(clusterId)}.md`),
    },
    {
      type: ACTION_EVENT_TYPES.publicationLifecycle,
      status: canonicalDecision.publish
        ? ACTION_EVENT_STATUSES.completed
        : ACTION_EVENT_STATUSES.skipped,
      reasonCode: canonicalDecision.publish
        ? ACTION_EVENT_REASON_CODES.completed
        : ACTION_EVENT_REASON_CODES.stale,
      mutation: false,
      component: "publish_result",
      operation: "publication",
      state: canonicalDecision.publish ? "prepared" : "stale_noop",
      publicationKind: "cluster_result",
      eventIdentity: {
        publicationKind: "cluster_result",
        runId: runId || clusterId,
        state: canonicalDecision.publish ? "prepared" : "stale_noop",
      },
    },
  );

  return {
    cluster_id: report.cluster_id,
    run_id: report.run_id,
    result_status: report.result_status,
    workflow_conclusion: report.workflow_conclusion,
    canonical_publication_status: canonicalPublicationStatus,
    canonical_superseded_by_run_id: canonicalDecision.supersededByRunId,
    run_record_status: replaceRunRecord ? "published" : "stale_noop",
    fix_counts: report.fix_counts,
    apply_counts: report.apply_counts,
  };
}

function publicationTimestamp(value: unknown, label: string): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return text;
}

function publicationPositiveInteger(value: unknown, label: string): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a safe positive integer`);
  }
  return parsed;
}

export function resultPublicationSourceRevision(
  result: LooseRecord,
  clusterPlan: LooseRecord | null,
  sourceContext: LooseRecord | null,
  resultPath = "result.json",
): string | null {
  const revision = reviewedResultRevision(result, clusterPlan, sourceContext);
  if (revision || !resultPublicationRequiresExactRevision(result, sourceContext)) {
    return revision;
  }
  throw new Error(`repair result is missing one exact reviewed target revision: ${resultPath}`);
}

function resultPublicationRequiresExactRevision(
  result: LooseRecord,
  sourceContext: LooseRecord | null,
): boolean {
  if (String(result.canonical_pr ?? "").trim()) return true;

  const source = String(sourceContext?.source ?? "").trim();
  if (
    ["clawsweeper_commit", "issue_implementation", "pr-repair-intake", "pr_automerge"].includes(
      source,
    )
  ) {
    return true;
  }
  return [
    "source_issue_revision_sha256",
    "expected_head_sha",
    "commit_sha",
    "expected_source_revision",
    "reviewed_sha",
  ].some((key) => sourceContext?.[key] !== undefined);
}

export function readSealedPublishedSource(
  runDir: string,
  result: LooseRecord,
  clusterPlan: LooseRecord | null,
  resultPath = "result.json",
  trustedLegacyWorkerHead: string | null = null,
  stateRoot?: string,
): {
  sourceJob: string;
  stateRevision: string | null;
  jobSha256: string | null;
  frontmatter: LooseRecord | null;
  provenance: "sealed_immutable_job" | "trusted_legacy_worker";
  workerHeadSha: string | null;
} | null {
  const plannedSourceJob = String(clusterPlan?.source_job ?? "").trim();
  const identityPath = path.join(runDir, "source-job.json");
  const sourceJobPath = path.join(runDir, "source-job.md");
  const hasIdentity = fs.existsSync(identityPath);
  const hasJob = fs.existsSync(sourceJobPath);
  if (!hasIdentity && !hasJob && !plannedSourceJob) {
    throw new Error(`repair result is missing sealed source job provenance: ${resultPath}`);
  }
  if (!hasIdentity && !hasJob && trustedLegacyWorkerHead) {
    if (!SOURCE_JOB_PATH.test(plannedSourceJob)) {
      throw new Error(`trusted legacy source job path is invalid: ${resultPath}`);
    }
    return {
      sourceJob: plannedSourceJob,
      stateRevision: null,
      jobSha256: null,
      frontmatter: null,
      provenance: "trusted_legacy_worker",
      workerHeadSha: trustedLegacyWorkerHead,
    };
  }
  if (!hasIdentity || !hasJob) {
    throw new Error(`repair result is missing sealed source job provenance: ${resultPath}`);
  }

  const identity = readJson(identityPath);
  const identityKeys = Object.keys(identity).sort();
  const expectedKeys = ["job_sha256", "schema_version", "source_job", "state_revision"];
  if (JSON.stringify(identityKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`sealed source job identity has unexpected fields: ${resultPath}`);
  }
  const sourceJob = String(identity.source_job ?? "").trim();
  const stateRevision = exactHex(identity.state_revision, 40);
  const jobSha256 = exactHex(identity.job_sha256, 64);
  if (
    identity.schema_version !== 1 ||
    !SOURCE_JOB_PATH.test(sourceJob) ||
    (plannedSourceJob && plannedSourceJob !== sourceJob) ||
    !stateRevision ||
    !jobSha256
  ) {
    throw new Error(`sealed source job identity is invalid: ${resultPath}`);
  }
  const immutableJob = resolveStateJobIdentity({
    jobPath: sourceJob,
    stateRevision,
    jobSha256,
    ...(stateRoot === undefined ? {} : { stateRoot }),
  });
  const sealedJobBytes = fs.readFileSync(sourceJobPath);
  const actualJobSha256 = createHash("sha256").update(sealedJobBytes).digest("hex");
  if (
    actualJobSha256 !== immutableJob.jobSha256 ||
    !sealedJobBytes.equals(Buffer.from(immutableJob.job.raw, "utf8"))
  ) {
    throw new Error(`sealed source job SHA-256 mismatch: ${resultPath}`);
  }

  const frontmatter = immutableJob.job.frontmatter;
  const expectedRepo = String(result.repo ?? clusterPlan?.repo ?? "");
  const expectedClusterId = String(result.cluster_id ?? clusterPlan?.cluster_id ?? "");
  if (
    String(frontmatter.repo ?? "") !== expectedRepo ||
    String(frontmatter.cluster_id ?? "") !== expectedClusterId ||
    (clusterPlan?.repo !== undefined && String(clusterPlan.repo) !== expectedRepo) ||
    (clusterPlan?.cluster_id !== undefined && String(clusterPlan.cluster_id) !== expectedClusterId)
  ) {
    throw new Error(`sealed source job does not match the repair result target: ${resultPath}`);
  }
  return {
    sourceJob,
    stateRevision,
    jobSha256,
    frontmatter,
    provenance: "sealed_immutable_job",
    workerHeadSha: null,
  };
}

function exactHex(value: unknown, length: 40 | 64): string | null {
  const normalized = String(value ?? "").trim();
  return new RegExp(`^[a-f0-9]{${length}}$`).test(normalized) ? normalized : null;
}

function updateDashboard() {
  const readmePath = path.join(root, "docs", "repair", "README.md");
  if (!fs.existsSync(readmePath)) return;
  const readme = fs.readFileSync(readmePath, "utf8");
  const records = readRunRecords(root);
  const allLatestByCluster = latestResultPublicationRecords(records).sort(sortNewestRecordFirst);
  const latestByCluster = allLatestByCluster.filter(
    (record: JsonValue) => !archivedClusters.has(record.cluster_id),
  );
  const archivedLatestByCluster = allLatestByCluster.filter((record: JsonValue) =>
    archivedClusters.has(record.cluster_id),
  );
  const trackedPrRows = buildTrackedPrRows(records, MERGE_APPLICATOR_ACTIONS);
  const latestApplyRows = latestByCluster.flatMap((record: JsonValue) =>
    (record.apply_actions ?? [])
      .filter(isApplicatorAction)
      .map((action: JsonValue) => ({ record, action })),
  );
  const latestFixRows = latestByCluster.flatMap((record: JsonValue) =>
    (record.fix_actions ?? []).map((action: JsonValue) => ({ record, action })),
  );
  const fixRows = uniqueFixRows(
    records.flatMap((record: JsonValue) =>
      (record.fix_actions ?? []).map((action: JsonValue) => ({ record, action })),
    ),
  );
  const applyRows = uniqueActionRows(
    records.flatMap((record: JsonValue) =>
      (record.apply_actions ?? [])
        .filter(isApplicatorAction)
        .map((action: JsonValue) => ({ record, action })),
    ),
  );
  const executedRows = applyRows.filter((row: JsonValue) => row.action.status === "executed");
  const closedRows = executedRows.filter((row: JsonValue) =>
    CLOSE_APPLICATOR_ACTIONS.has(String(row.action.action ?? "")),
  );
  const mergedRows = executedRows.filter((row: JsonValue) =>
    MERGE_APPLICATOR_ACTIONS.has(String(row.action.action ?? "")),
  );
  const closureRows = hydrateClosureRows(closedRows).sort(sortNewestClosureRowFirst);
  const blockedRows = applyRows.filter((row: JsonValue) => row.action.status === "blocked");
  const skippedRows = applyRows.filter((row: JsonValue) => row.action.status === "skipped");
  const latestBlockedRows = latestApplyRows.filter(
    (row: JsonValue) => row.action.status === "blocked",
  );
  const latestSkippedRows = latestApplyRows.filter(
    (row: JsonValue) => row.action.status === "skipped",
  );
  const latestFailedFixRows = latestFixRows.filter((row: JsonValue) =>
    ["blocked", "failed"].includes(String(row.action.status ?? "")),
  );
  const needsHumanRows = latestByCluster.filter(
    (record: JsonValue) => (record.needs_human ?? []).length > 0,
  );
  const inspectionRows = buildInspectionRows({
    latestByCluster,
    latestFailedFixRows,
    latestBlockedRows,
    latestSkippedRows,
  });
  const finalizerReport = readFinalizerReport();
  const cleanClusters = latestByCluster.filter(
    (record: JsonValue) =>
      record.workflow_conclusion === "success" &&
      (record.needs_human ?? []).length === 0 &&
      (record.fix_actions ?? []).every(
        (action: JsonValue) => !["blocked", "failed"].includes(action.status),
      ) &&
      (record.apply_actions ?? []).every(
        (action: JsonValue) => !["blocked", "failed"].includes(action.status),
      ),
  );
  const workflowState = latestByCluster.some(
    (record: JsonValue) => record.workflow_conclusion === "failure",
  )
    ? "Failed clusters need inspection"
    : latestFailedFixRows.length > 0
      ? "Fix execution needs repair"
      : latestBlockedRows.length > 0
        ? "Blocked actions need triage"
        : needsHumanRows.length > 0
          ? "Human review needed"
          : "Clean";
  const mutationRows = applyRows.filter((row: JsonValue) =>
    ["executed", "blocked", "skipped"].includes(String(row.action.status ?? "")),
  );
  const duplicateCloses = countRows(
    closedRows,
    (row: JsonValue) => row.action.classification === "duplicate",
  );
  const supersededCloses = countRows(
    closedRows,
    (row: JsonValue) => row.action.classification === "superseded",
  );
  const fixedByCandidateCloses = countRows(
    closedRows,
    (row: JsonValue) => row.action.classification === "fixed_by_candidate",
  );
  const lowSignalCloses = countRows(
    closedRows,
    (row: JsonValue) => row.action.classification === "low_signal",
  );
  const totals = {
    clusters: latestByCluster.length,
    archivedClusters: archivedLatestByCluster.length,
    runs: records.length,
    success: latestByCluster.filter((record: JsonValue) => record.workflow_conclusion === "success")
      .length,
    failure: latestByCluster.filter((record: JsonValue) => record.workflow_conclusion === "failure")
      .length,
    cancelled: latestByCluster.filter(
      (record: JsonValue) => record.workflow_conclusion === "cancelled",
    ).length,
    cleanClusters: cleanClusters.length,
    closed: closedRows.length,
    merged: mergedRows.length,
    trackedPrs: trackedPrRows.length,
    openTrackedPrs: countRows(trackedPrRows, (row: JsonValue) => row.state === "open"),
    closedUnmergedTrackedPrs: countRows(
      trackedPrRows,
      (row: JsonValue) => row.state === "closed" && !row.merged,
    ),
    blocked: blockedRows.length,
    skipped: skippedRows.length,
    fixAttempts: fixRows.length,
    fixExecuted: countRows(fixRows, (row: JsonValue) => row.action.status === "executed"),
    fixFailed: countRows(fixRows, (row: JsonValue) => row.action.status === "failed"),
    fixBlocked: countRows(fixRows, (row: JsonValue) => row.action.status === "blocked"),
    latestFixProblemClusters: new Set(
      latestFailedFixRows.map((row: JsonValue) => row.record.cluster_id),
    ).size,
    needsHumanClusters: needsHumanRows.length,
    mutationAttempts: mutationRows.length,
    duplicateCloses,
    supersededCloses,
    fixedByCandidateCloses,
    lowSignalCloses,
  };
  const dashboard = `## Dashboard

Last dashboard update: ${formatTimestamp(new Date().toISOString())}

${DASHBOARD_START}
State: ${workflowState}

Scope: ${totals.clusters} active latest cluster reports. ${totals.archivedClusters} policy-archived cluster(s) are excluded from health stats; run attempts are tracked as audit history only.

| Metric | Count | Rate |
| --- | ---: | ---: |
${renderMetricRow("Latest clusters reviewed", totals.clusters, "100%")}
${renderMetricRow("Policy-archived clusters", totals.archivedClusters, "audit")}
${renderMetricRow("Clean completed clusters", totals.cleanClusters, percent(totals.cleanClusters, totals.clusters))}
${renderMetricRow("Needs-human clusters", totals.needsHumanClusters, percent(totals.needsHumanClusters, totals.clusters))}
${renderMetricRow("Latest successful clusters", totals.success, percent(totals.success, totals.clusters))}
${renderMetricRow("Latest failed clusters", totals.failure, percent(totals.failure, totals.clusters))}
${renderMetricRow("Latest cancelled clusters", totals.cancelled, percent(totals.cancelled, totals.clusters))}
${renderMetricRow("Run attempts archived", totals.runs, "audit")}
${renderMetricRow("Fix action attempts", totals.fixAttempts, "audit")}
${renderMetricRow("Fix actions executed", totals.fixExecuted, percent(totals.fixExecuted, totals.fixAttempts))}
${renderMetricRow("Fix actions failed", totals.fixFailed, percent(totals.fixFailed, totals.fixAttempts))}
${renderMetricRow("Fix actions blocked", totals.fixBlocked, percent(totals.fixBlocked, totals.fixAttempts))}
${renderMetricRow("Latest clusters with fix failures", totals.latestFixProblemClusters, percent(totals.latestFixProblemClusters, totals.clusters))}
${renderMetricRow("Distinct PRs touched", totals.trackedPrs, "100%")}
${renderMetricRow("Open PRs tracked", totals.openTrackedPrs, percent(totals.openTrackedPrs, totals.trackedPrs))}
${renderMetricRow(
  "Closed unmerged PRs tracked",
  totals.closedUnmergedTrackedPrs,
  percent(totals.closedUnmergedTrackedPrs, totals.trackedPrs),
)}
${renderMetricRow("Completed close actions", totals.closed, percent(totals.closed, totals.mutationAttempts))}
${renderMetricRow("Completed merge actions", totals.merged, percent(totals.merged, totals.mutationAttempts))}
${renderMetricRow("Duplicate closes", totals.duplicateCloses, percent(totals.duplicateCloses, totals.closed))}
${renderMetricRow("Superseded closes", totals.supersededCloses, percent(totals.supersededCloses, totals.closed))}
${renderMetricRow(
  "Fixed-by-candidate closes",
  totals.fixedByCandidateCloses,
  percent(totals.fixedByCandidateCloses, totals.closed),
)}
${renderMetricRow("Low-signal PR closes", totals.lowSignalCloses, percent(totals.lowSignalCloses, totals.closed))}
${renderMetricRow("Blocked mutation attempts", totals.blocked, percent(totals.blocked, totals.mutationAttempts))}
${renderMetricRow("Skipped mutation attempts", totals.skipped, percent(totals.skipped, totals.mutationAttempts))}

### Clusters Needing Inspection

| Cluster | State | Source job | Reason | Report | Run |
| --- | --- | --- | --- | --- | --- |
${renderInspectionRows(inspectionRows.slice(0, 25))}

### Fix Failure Queue

| Cluster | Status | Target | Branch/PR | Reason | Run |
| --- | --- | --- | --- | --- | --- |
${renderFixFailureRows(latestFailedFixRows.slice(0, 25))}

### Top Blocked Reasons

| Reason | Latest count | Example cluster |
| --- | ---: | --- |
${renderBlockedReasonRows([...latestBlockedRows, ...latestSkippedRows])}

### Open PR Finalizer Queue

| PR | Title | Cluster | Branch | Blockers | Next action |
| --- | --- | --- | --- | --- | --- |
${renderFinalizerRows(finalizerReport)}

### Latest ClawSweeper Repair Closures

| Target | Type | Title | Closed | Action | Cluster | Report | Run |
| --- | --- | --- | --- | --- | --- | --- | --- |
${renderRecentClosureRows(closureRows.slice(0, 25))}
${DASHBOARD_END}`;

  let updated;
  const markerPattern = new RegExp(
    `${escapeRegExp(DASHBOARD_START)}[\\s\\S]*?${escapeRegExp(DASHBOARD_END)}`,
  );
  if (markerPattern.test(readme)) {
    updated = readme.replace(
      /## Dashboard[\s\S]*?## How It Works/,
      `${dashboard}\n\n## How It Works`,
    );
  } else if (/## How It Works/.test(readme)) {
    updated = readme.replace(/## How It Works/, `${dashboard}\n\n## How It Works`);
  } else {
    updated = `${readme.trim()}\n\n${dashboard}\n`;
  }
  fs.writeFileSync(readmePath, updated, "utf8");
}

function writeAggregateApplyReport() {
  const records = readRunRecords(root);
  const rows = records.flatMap((record: JsonValue) =>
    (record.apply_actions ?? []).filter(isApplicatorAction).map((action: JsonValue) =>
      normalizeReportRow({
        repo: record.repo,
        run_id: record.run_id,
        run_url: record.run_url,
        cluster_id: record.cluster_id,
        published_at: record.published_at,
        ...action,
      }),
    ),
  );
  fs.writeFileSync(
    path.join(root, "repair-apply-report.json"),
    `${JSON.stringify(uniquePlainActionRows(rows), null, 2)}\n`,
    "utf8",
  );
}

function recordAggregatePreparation(publicationKind: string) {
  recordRepairLifecycleEvent(aggregateLifecycle(publicationKind), {
    type:
      publicationKind === "repair_dashboard"
        ? ACTION_EVENT_TYPES.dashboardLifecycle
        : ACTION_EVENT_TYPES.publicationLifecycle,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    mutation: false,
    component: "publish_result",
    operation: "publication",
    state: "prepared",
    publicationKind,
    eventIdentity: {
      publicationKind,
      runId: String(args["run-id"] ?? "latest"),
      state: "prepared",
    },
  });
}

function aggregateLifecycle(publicationKind: string, recordPath?: string): RepairLifecycleInput {
  const repository = String(process.env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper");
  const runId = String(args["run-id"] ?? process.env.GITHUB_RUN_ID ?? "local");
  return {
    repository,
    workKey: `${repository}:${publicationKind}:${runId}`,
    clusterId: `publication-${publicationKind}`,
    sourceRevision: String(args["head-sha"] ?? process.env.GITHUB_SHA ?? ""),
    ...(recordPath ? { recordPath } : {}),
  };
}

function summarizeActions(actions: LooseRecord[]) {
  return (Array.isArray(actions) ? actions : []).map((action: JsonValue) => ({
    target: action.target ?? null,
    action: action.action ?? null,
    status: action.status ?? null,
    classification: action.classification ?? null,
    canonical: action.canonical ?? action.duplicate_of ?? null,
    candidate_fix: action.candidate_fix ?? null,
    reason: normalizeNullableText(action.reason),
  }));
}

function sanitizeApplyAction(action: LooseRecord) {
  return {
    target: action.target ?? null,
    action: action.action ?? null,
    status: action.status ?? null,
    classification: action.classification ?? null,
    canonical: action.canonical ?? null,
    candidate_fix: action.candidate_fix ?? null,
    title: action.title ?? action.target_title ?? action.pr_title ?? null,
    idempotency_key: action.idempotency_key ?? null,
    reason: normalizeNullableText(action.reason),
    merged_at: action.merged_at ?? null,
    merge_commit_sha: action.merge_commit_sha ?? null,
    live_state: action.live_state ?? null,
    live_updated_at: action.live_updated_at ?? null,
  };
}

function sanitizeFixAction(action: LooseRecord) {
  return {
    action: action.action ?? null,
    status: action.status ?? null,
    target: action.target ?? null,
    pr: action.pr ?? action.pr_url ?? null,
    branch: action.branch ?? action.head_branch ?? null,
    source_action: action.source_action ?? null,
    source_status: action.source_status ?? null,
    repair_strategy: action.repair_strategy ?? null,
    reason: normalizeNullableText(action.reason),
    title: action.title ?? null,
    url: action.url ?? action.pr_url ?? null,
  };
}

function isApplicatorAction(action: LooseRecord) {
  return APPLICATOR_ACTIONS.has(String(action?.action ?? ""));
}

function isPostFlightApplyAction(action: LooseRecord) {
  const actionName = String(action?.action ?? "");
  if (!POST_FLIGHT_APPLY_ACTIONS.has(actionName)) return false;
  if (actionName === "finalize_fix_pr") return Boolean(action?.pr);
  return Boolean(action?.target);
}

function postFlightToApplyAction(action: LooseRecord) {
  if (String(action.action ?? "") === "post_merge_closeout") {
    return {
      target: action.target,
      action: action.source_action ?? "post_merge_close",
      status: action.status,
      classification: "post_merge_closeout",
      canonical: action.canonical ?? null,
      candidate_fix: action.candidate_fix ?? null,
      title: action.title ?? null,
      reason: normalizeNullableText(action.reason),
      merged_at: null,
      merge_commit_sha: action.merge_commit_sha ?? null,
      live_state: action.live_state ?? null,
      live_updated_at: null,
    };
  }
  return {
    target: action.pr,
    action: "merge_canonical",
    status: action.status,
    classification: "fix_pr",
    title: action.title ?? null,
    reason: normalizeNullableText(action.reason),
    merged_at: action.merged_at ?? null,
    merge_commit_sha: action.merge_commit_sha ?? null,
    live_state: action.status === "executed" ? "merged" : null,
    live_updated_at: null,
  };
}

function normalizeNullableText(value: JsonValue) {
  if (typeof value !== "string") return value ?? null;
  return normalizeRetiredRepairEnvNames(value);
}

function normalizeReportRow(row: LooseRecord): LooseRecord {
  const normalized: LooseRecord = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = typeof value === "string" ? normalizeRetiredRepairEnvNames(value) : value;
  }
  return normalized;
}

function sortNewestRecordFirst(left: JsonValue, right: JsonValue) {
  return compareResultPublicationGeneration(right, left);
}

function countRows(rows: LooseRecord[], predicate: (row: LooseRecord) => boolean) {
  return rows.filter(predicate).length;
}

function readFinalizerReport() {
  const filePath = path.join(root, "results", "finalize-open-prs.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function uniqueActionRows(rows: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const row of rows) {
    const record = row.record ?? row;
    const action = row.action ?? row;
    const key = [record.repo, action.target, action.action].join(":");
    const previous = byKey.get(key);
    if (!previous || preferActionRow(row, previous)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function uniquePlainActionRows(rows: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const row of rows) {
    const key = [row.repo, row.cluster_id, row.target, row.action].join(":");
    const previous = byKey.get(key);
    if (!previous || preferActionRow(row, previous)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function uniqueFixRows(rows: LooseRecord[]) {
  const byKey = new Map<string, LooseRecord>();
  for (const row of rows) {
    const record = row.record ?? row;
    const action = row.action ?? row;
    const key = [
      record.repo,
      record.cluster_id,
      action.action,
      action.target,
      action.pr,
      action.branch,
      action.repair_strategy,
      action.source_action,
    ].join(":");
    const previous = byKey.get(key);
    if (!previous || preferActionRow(row, previous)) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function preferActionRow(candidate: LooseRecord, previous: JsonValue) {
  const candidateRecord =
    candidate.record && typeof candidate.record === "object" ? candidate.record : candidate;
  const previousRecord =
    previous.record && typeof previous.record === "object" ? previous.record : previous;
  const candidateAction =
    candidate.action && typeof candidate.action === "object" ? candidate.action : candidate;
  const previousAction =
    previous.action && typeof previous.action === "object" ? previous.action : previous;
  const candidateRank = actionStatusRank(candidateAction.status);
  const previousRank = actionStatusRank(previousAction.status);
  if (candidateRank !== previousRank) return candidateRank > previousRank;
  return (
    String(candidateRecord.published_at ?? "").localeCompare(
      String(previousRecord.published_at ?? ""),
    ) > 0
  );
}

function actionStatusRank(status: string) {
  switch (status) {
    case "executed":
      return 6;
    case "merged":
      return 6;
    case "failed":
      return 5;
    case "blocked":
      return 4;
    case "skipped":
      return 3;
    case "planned":
      return 2;
    default:
      return 1;
  }
}

function renderMetricRow(metric: string, count: JsonValue, rate: string) {
  return `| ${tableCell(metric)} | ${count} | ${tableCell(rate)} |`;
}

function percent(count: JsonValue, total: JsonValue) {
  if (!total) return "0.0%";
  return `${((Number(count) / Number(total)) * 100).toFixed(1)}%`;
}

function countBy(values: LooseRecord[], keyFn: (value: LooseRecord) => string) {
  const out: Record<string, number> = {};
  for (const value of Array.isArray(values) ? values : []) {
    const key = keyFn(value);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
