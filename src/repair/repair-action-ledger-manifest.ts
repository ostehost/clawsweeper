import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

import {
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionLedgerJson,
  readActionEventShardAt,
  type ActionEvent,
} from "../action-ledger.js";
import { splitFrontMatter } from "../commit-checks.js";
import { recoverCommitMutationOutcomes } from "../commit-action-ledger.js";
import {
  ACTION_EVENT_SHARD_IMPORT_LIMITS,
  readValidatedActionEventShardBatch,
  workflowActionProducer,
  type ExpectedActionEventProducer,
} from "../action-ledger-runtime.js";
import { repoRoot } from "./paths.js";
import { flushRepairActionEvents } from "./repair-action-ledger.js";

const REPAIR_ACTION_LEDGER_MANIFEST_SCHEMA = "clawsweeper.repair-action-ledger-manifest";
const REPAIR_ACTION_LEDGER_MANIFEST_VERSION = 1;
const REPAIR_ACTION_LEDGER_MANIFEST_MAX_BYTES = 256 * 1024;
const REPAIR_ACTION_LEDGER_LANE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const COMMIT_REVIEW_REPORT_MAX_BYTES = 4 * 1024 * 1024;
const COMMAND_EVENT_TYPE_PREFIX = "command.";

type RepairActionLedgerManifestIdentity = {
  schema: typeof REPAIR_ACTION_LEDGER_MANIFEST_SCHEMA;
  schema_version: typeof REPAIR_ACTION_LEDGER_MANIFEST_VERSION;
  lane: string;
  repository: string;
  sha: string;
  workflow: string;
  job: string;
  run_id: string;
  run_attempt: number;
  event_paths: string[];
};

type RepairActionLedgerProducerIdentity = Pick<
  ActionEvent["producer"],
  "repository" | "sha" | "workflow" | "job" | "run_id" | "run_attempt"
>;

export type RepairActionLedgerManifest = RepairActionLedgerManifestIdentity & {
  manifest_sha256: string;
};

export async function finalizeRepairActionLedgerManifest(
  lane: string,
  options: { allowEmpty?: boolean; preserveOpenWorkflows?: boolean } = {},
): Promise<RepairActionLedgerManifest> {
  assertRepairActionLedgerLane(lane);
  const outputRoot = repairActionLedgerOutputRoot();
  recoverCommitMutationOutcomes();
  const finalizedPaths = await flushRepairActionEvents(
    options.preserveOpenWorkflows === true ? { preserveOpenWorkflows: true } : {},
  );
  const repairShards = repairActionLedgerShards(outputRoot, finalizedPaths);
  const eventPaths = repairShards.map((shard) => shard.relativePath).sort();
  if (eventPaths.length === 0 && options.allowEmpty !== true) {
    throw new Error(`repair action ledger lane ${lane} finalized no event shards`);
  }
  if (eventPaths.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles) {
    throw new Error(
      `repair action ledger manifest exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles} event paths`,
    );
  }
  const totalShardBytes = repairShards.reduce(
    (total, shard) =>
      total +
      Buffer.byteLength(
        `${shard.events.map((event) => actionLedgerJson(event)).join("\n")}\n`,
        "utf8",
      ),
    0,
  );
  if (totalShardBytes > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalBytes) {
    throw new Error(
      `repair action ledger manifest exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalBytes} total shard bytes`,
    );
  }
  const events = repairShards.flatMap((shard) => shard.events);
  if (eventPaths.length > 0 && events.length === 0) {
    throw new Error(`repair action ledger lane ${lane} finalized empty event shards`);
  }
  const currentProducer = workflowActionProducer("repair_manifest");
  const producer =
    events[0]?.producer ??
    ({
      repository: currentProducer.repository,
      sha: currentProducer.sha,
      workflow: currentProducer.workflow,
      job: currentProducer.job,
      run_id: currentProducer.runId,
      run_attempt: currentProducer.runAttempt,
    } satisfies RepairActionLedgerProducerIdentity);
  for (const event of events) assertManifestProducerIdentity(event, producer);
  const identity: RepairActionLedgerManifestIdentity = {
    schema: REPAIR_ACTION_LEDGER_MANIFEST_SCHEMA,
    schema_version: REPAIR_ACTION_LEDGER_MANIFEST_VERSION,
    lane,
    repository: producer.repository,
    sha: producer.sha,
    workflow: producer.workflow,
    job: producer.job,
    run_id: producer.run_id,
    run_attempt: producer.run_attempt,
    event_paths: eventPaths,
  };
  return {
    ...identity,
    manifest_sha256: repairActionLedgerManifestSha256(identity),
  };
}

export function parseRepairActionLedgerManifest(
  content: string,
  expectedLane: string,
  expectedProducer: ExpectedActionEventProducer,
  options: { allowEmpty?: boolean } = {},
): RepairActionLedgerManifest {
  assertRepairActionLedgerLane(expectedLane);
  if (Buffer.byteLength(content, "utf8") > REPAIR_ACTION_LEDGER_MANIFEST_MAX_BYTES) {
    throw new Error(
      `repair action ledger manifest exceeds ${REPAIR_ACTION_LEDGER_MANIFEST_MAX_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("repair action ledger manifest is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("repair action ledger manifest must be an object");
  }
  const manifest = value as Partial<RepairActionLedgerManifest>;
  const keys = Object.keys(manifest).sort();
  const expectedKeys = [
    "event_paths",
    "job",
    "lane",
    "manifest_sha256",
    "repository",
    "run_attempt",
    "run_id",
    "schema",
    "schema_version",
    "sha",
    "workflow",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error("repair action ledger manifest keys are invalid");
  }
  if (
    manifest.schema !== REPAIR_ACTION_LEDGER_MANIFEST_SCHEMA ||
    manifest.schema_version !== REPAIR_ACTION_LEDGER_MANIFEST_VERSION ||
    manifest.lane !== expectedLane ||
    typeof manifest.repository !== "string" ||
    typeof manifest.sha !== "string" ||
    typeof manifest.workflow !== "string" ||
    typeof manifest.job !== "string" ||
    typeof manifest.run_id !== "string" ||
    !Number.isSafeInteger(manifest.run_attempt) ||
    !Array.isArray(manifest.event_paths) ||
    (manifest.event_paths.length === 0 && options.allowEmpty !== true) ||
    manifest.event_paths.some((relativePath) => typeof relativePath !== "string") ||
    typeof manifest.manifest_sha256 !== "string"
  ) {
    throw new Error("repair action ledger manifest identity is invalid");
  }
  const eventPaths = manifest.event_paths as string[];
  const canonicalPaths = [...new Set(eventPaths)].sort();
  if (
    canonicalPaths.length !== eventPaths.length ||
    canonicalPaths.some((relativePath, index) => relativePath !== eventPaths[index])
  ) {
    throw new Error("repair action ledger manifest paths must be sorted and unique");
  }
  const parsed = manifest as RepairActionLedgerManifest;
  const { manifest_sha256: manifestSha256, ...identity } = parsed;
  if (
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    repairActionLedgerManifestSha256(identity) !== manifestSha256
  ) {
    throw new Error("repair action ledger manifest digest is invalid");
  }
  if (`${actionLedgerJson(parsed)}\n` !== content) {
    throw new Error("repair action ledger manifest is not canonical");
  }
  assertExpectedProducer(parsed, expectedProducer);
  return parsed;
}

export function assertRepairActionLedgerManifestSource(
  sourceRoot: string,
  manifest: RepairActionLedgerManifest,
): void {
  const batch = readValidatedActionEventShardBatch(sourceRoot);
  const repairShards = repairActionLedgerShards(sourceRoot, batch.eventPaths);
  const actual = repairShards.map((shard) => shard.relativePath).sort();
  if (JSON.stringify(actual) !== JSON.stringify(manifest.event_paths)) {
    const expected = new Set(manifest.event_paths);
    const actualSet = new Set(actual);
    const missing = manifest.event_paths.filter((relativePath) => !actualSet.has(relativePath));
    const extra = actual.filter((relativePath) => !expected.has(relativePath));
    throw new Error(
      `repair action ledger manifest shard set mismatch: missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`,
    );
  }
  for (const event of repairShards.flatMap((shard) => shard.events)) {
    assertManifestProducerIdentity(event, {
      repository: manifest.repository,
      sha: manifest.sha,
      workflow: manifest.workflow,
      job: manifest.job,
      run_id: manifest.run_id,
      run_attempt: manifest.run_attempt,
    });
  }
}

export function assertCommitReviewReportArtifact(
  sourceRoot: string,
  manifest: RepairActionLedgerManifest,
  options: {
    reportPath: string;
    repository: string;
    sha: string;
  },
): void {
  assertRepairActionLedgerManifestSource(sourceRoot, manifest);
  const repository = options.repository.trim().toLowerCase();
  const sha = options.sha.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error("expected commit review repository is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("expected commit review SHA is invalid");
  }
  if (manifest.lane !== `commit-review-${sha}`) {
    throw new Error("commit review report lane does not match the expected SHA");
  }

  const reportStat = lstatSync(options.reportPath);
  if (
    !reportStat.isFile() ||
    reportStat.size < 1 ||
    reportStat.size > COMMIT_REVIEW_REPORT_MAX_BYTES
  ) {
    throw new Error("commit review report file is invalid");
  }
  const report = readFileSync(options.reportPath);
  const { frontMatter } = splitFrontMatter(report.toString("utf8"));
  const reportRepository =
    typeof frontMatter.repository === "string" ? frontMatter.repository.trim().toLowerCase() : "";
  const reportSha = typeof frontMatter.sha === "string" ? frontMatter.sha.trim().toLowerCase() : "";
  if (reportRepository !== repository || reportSha !== sha) {
    throw new Error("commit review report frontmatter does not match the planned target");
  }

  const reportEvents = manifest.event_paths
    .flatMap((relativePath) => readActionEventShardAt(sourceRoot, relativePath))
    .filter(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.reviewLogPublication &&
        event.action.status === ACTION_EVENT_STATUSES.completed &&
        event.action.mutation === false &&
        event.attributes?.state === "prepared" &&
        event.attributes?.publication_kind === "commit_review_report",
    );
  if (reportEvents.length !== 1) {
    throw new Error("commit review ledger must contain exactly one prepared report event");
  }
  const reportEvent = reportEvents[0]!;
  if (
    reportEvent.subject.repository.trim().toLowerCase() !== repository ||
    reportEvent.subject.kind !== "commit" ||
    reportEvent.subject.subject_id !== `commit-${sha}` ||
    reportEvent.subject.source_revision?.trim().toLowerCase() !== sha
  ) {
    throw new Error("commit review ledger report target does not match the planned target");
  }
  const evidence = reportEvent.evidence ?? [];
  const reportSha256 = createHash("sha256").update(report).digest("hex");
  if (
    evidence.length !== 1 ||
    evidence[0]?.kind !== "commit_review_report" ||
    evidence[0].sha256 !== reportSha256
  ) {
    throw new Error("commit review report digest does not match the immutable ledger");
  }
}

export function serializeRepairActionLedgerManifest(manifest: RepairActionLedgerManifest): string {
  return `${actionLedgerJson(manifest)}\n`;
}

function repairActionLedgerShards(
  root: string,
  eventPaths: readonly string[],
): { relativePath: string; events: ActionEvent[] }[] {
  const repairShards = eventPaths
    .map((relativePath) => ({
      relativePath,
      events: readActionEventShardAt(root, relativePath),
    }))
    .filter(({ events }) => events.some(repairActionEvent));
  for (const shard of repairShards) {
    if (!shard.events.every(repairActionEvent)) {
      throw new Error(
        `repair action ledger shard mixes command and non-command events: ${shard.relativePath}`,
      );
    }
  }
  return repairShards;
}

function repairActionEvent(event: ActionEvent): boolean {
  return !event.event_type.startsWith(COMMAND_EVENT_TYPE_PREFIX);
}

function repairActionLedgerOutputRoot(): string {
  return (
    process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim() ||
    `${repoRoot()}/.clawsweeper-repair/action-ledger-state`
  );
}

function assertManifestProducerIdentity(
  event: ActionEvent,
  expected: RepairActionLedgerProducerIdentity,
): void {
  const mismatched = (
    [
      ["repository", event.producer.repository, expected.repository],
      ["sha", event.producer.sha, expected.sha],
      ["workflow", event.producer.workflow, expected.workflow],
      ["job", event.producer.job, expected.job],
      ["run_id", event.producer.run_id, expected.run_id],
      ["run_attempt", event.producer.run_attempt, expected.run_attempt],
    ] as const
  ).find(([, actual, wanted]) => actual !== wanted);
  if (mismatched) {
    throw new Error(
      `repair action ledger finalized mixed producer runs for ${mismatched[0]}: ${mismatched[1]} != ${mismatched[2]}`,
    );
  }
}

function assertExpectedProducer(
  manifest: RepairActionLedgerManifest,
  expected: ExpectedActionEventProducer,
): void {
  const mismatched = (
    [
      ["repository", manifest.repository, expected.repository],
      ["sha", manifest.sha, expected.sha],
      ["workflow", manifest.workflow, expected.workflow],
      ["job", manifest.job, expected.job],
      ["run_id", manifest.run_id, expected.runId],
      ["run_attempt", manifest.run_attempt, expected.runAttempt],
    ] as const
  ).find(([, actual, wanted]) => actual !== wanted);
  if (mismatched) {
    throw new Error(
      `repair action ledger manifest identity mismatch for ${mismatched[0]}: expected ${mismatched[2]}, got ${mismatched[1]}`,
    );
  }
}

function assertRepairActionLedgerLane(lane: string): void {
  if (!REPAIR_ACTION_LEDGER_LANE_PATTERN.test(lane)) {
    throw new Error(`invalid repair action ledger lane: ${lane}`);
  }
}

function repairActionLedgerManifestSha256(identity: RepairActionLedgerManifestIdentity): string {
  return createHash("sha256").update(actionLedgerJson(identity)).digest("hex");
}
