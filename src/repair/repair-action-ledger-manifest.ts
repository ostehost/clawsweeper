import { createHash } from "node:crypto";

import { actionLedgerJson, readActionEventShardAt, type ActionEvent } from "../action-ledger.js";
import {
  ACTION_EVENT_SHARD_IMPORT_LIMITS,
  readValidatedActionEventShardBatch,
  type ExpectedActionEventProducer,
} from "../action-ledger-runtime.js";
import { repoRoot } from "./paths.js";
import { flushRepairActionEvents } from "./repair-action-ledger.js";

const REPAIR_ACTION_LEDGER_MANIFEST_SCHEMA = "clawsweeper.repair-action-ledger-manifest";
const REPAIR_ACTION_LEDGER_MANIFEST_VERSION = 1;
const REPAIR_ACTION_LEDGER_MANIFEST_MAX_BYTES = 256 * 1024;
const REPAIR_ACTION_LEDGER_LANE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

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
): Promise<RepairActionLedgerManifest> {
  assertRepairActionLedgerLane(lane);
  const outputRoot = repairActionLedgerOutputRoot();
  const eventPaths = (await flushRepairActionEvents()).sort();
  if (eventPaths.length === 0) {
    throw new Error(`repair action ledger lane ${lane} finalized no event shards`);
  }
  if (eventPaths.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles) {
    throw new Error(
      `repair action ledger manifest exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles} event paths`,
    );
  }
  const events = eventPaths.flatMap((relativePath) =>
    readActionEventShardAt(outputRoot, relativePath),
  );
  if (events.length === 0) {
    throw new Error(`repair action ledger lane ${lane} finalized empty event shards`);
  }
  const producer = events[0]!.producer;
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
    manifest.event_paths.length === 0 ||
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
  const actual = batch.eventPaths;
  if (JSON.stringify(actual) !== JSON.stringify(manifest.event_paths)) {
    const expected = new Set(manifest.event_paths);
    const actualSet = new Set(actual);
    const missing = manifest.event_paths.filter((relativePath) => !actualSet.has(relativePath));
    const extra = actual.filter((relativePath) => !expected.has(relativePath));
    throw new Error(
      `repair action ledger manifest shard set mismatch: missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`,
    );
  }
  for (const event of batch.events) {
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

export function serializeRepairActionLedgerManifest(manifest: RepairActionLedgerManifest): string {
  return `${actionLedgerJson(manifest)}\n`;
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
