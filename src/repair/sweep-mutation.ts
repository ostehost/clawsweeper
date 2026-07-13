import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

import {
  ACTION_EVENT_SHARD_FILE_LIMITS,
  ACTION_EVENT_TYPES,
  actionIdempotencyKey,
  actionLedgerJson,
  readActionEventShardAt,
  readSpooledActionEvents,
  type ActionEvent,
} from "../action-ledger.js";
import {
  prepareSafeReadRoot,
  prepareSafeReadTarget,
  readDirectoryEntriesNoFollow,
  readUtf8FileNoFollow,
} from "../action-ledger-files.js";
import { slugForRepo } from "../repository-profiles.js";
import {
  repairActionLedgerRoot,
  repairMutationIdempotencyIdentity,
  runRepairMutation,
  type RepairLifecycleInput,
} from "./repair-action-ledger.js";
import { repoRoot } from "./paths.js";
import { sleepMs } from "./timing.js";

const DEFINITE_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 406, 407, 410, 411, 413, 414, 415, 416, 417, 421, 422, 426, 428, 431,
  451,
]);
const REACTION_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_DURABLE_LEDGER_DIRECTORIES = 4_096;
const MAX_DURABLE_LEDGER_FILES = 8_192;
const MAX_DURABLE_LEDGER_BYTES = 64 * 1024 * 1024;

export type SweepMutationRequest =
  | {
      type: "reaction-add";
      repository: string;
      itemNumber: number;
      content: string;
      maxAttempts?: number;
    }
  | {
      type: "reaction-delete";
      repository: string;
      itemNumber: number;
      reactionId: number;
      maxAttempts?: number;
    }
  | {
      type: "comment-delete";
      repository: string;
      itemNumber: number;
      commentId: number;
      maxAttempts?: number;
    }
  | {
      type: "workflow-dispatch";
      repository: string;
      workflow: string;
      ref: string;
      fields: Readonly<Record<string, string>>;
      targetRepository?: string;
      itemNumber?: number;
      businessKey: string;
    }
  | {
      type: "repository-dispatch";
      repository: string;
      eventType: string;
      payloadPath: string;
      targetRepository?: string;
      itemNumber?: number;
      businessKey: string;
    };

export type SweepMutationResult = {
  outcome: "accepted" | "rejected";
  attempts: number;
};

export type SweepWireRunner = (
  args: readonly string[],
) => Pick<SpawnSyncReturns<string>, "error" | "status" | "stderr" | "stdout">;

export type SweepMutationDependencies = {
  runWire?: SweepWireRunner;
  sleep?: (milliseconds: number) => void;
};

export function executeSweepMutation(
  request: SweepMutationRequest,
  dependencies: SweepMutationDependencies = {},
): SweepMutationResult {
  validateRequest(request);
  const descriptor = mutationDescriptor(request);
  const lifecycle = mutationLifecycle(request, descriptor.payloadSha256);
  const mutationOptions = {
    kind: descriptor.kind,
    operationName: "sweep_caller_mutation",
    component: "sweep_caller",
    identity: descriptor.identity,
  } as const;

  if (descriptor.nonIdempotent) {
    assertDispatchCanStart(lifecycle, mutationOptions);
  }

  const runWire = dependencies.runWire ?? defaultWireRunner;
  const sleep = dependencies.sleep ?? sleepMs;
  const attempts = descriptor.nonIdempotent ? 1 : reactionAttempts(request);
  let lastError: SweepWireError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      runRepairMutation(lifecycle, {
        ...mutationOptions,
        knownNoMutation: isDefiniteRejection,
        operation: () => runMutationWire(descriptor.args, runWire),
      });
      return { outcome: "accepted", attempts: attempt };
    } catch (error) {
      const wireError = asSweepWireError(error);
      lastError = wireError;
      if (descriptor.acceptedRejections.has(wireError.status ?? -1)) {
        return { outcome: "rejected", attempts: attempt };
      }
      if (
        descriptor.nonIdempotent ||
        isDefiniteRejection(wireError) ||
        attempt >= attempts ||
        !isRetryableReactionError(wireError)
      ) {
        throw wireError;
      }
      sleep(retryDelayMs(attempt));
    }
  }

  throw lastError ?? new Error("sweep mutation failed without an attempt");
}

export function sweepMutationPayloadDigest(value: unknown): string {
  return createHash("sha256").update(actionLedgerJson(value)).digest("hex");
}

type MutationDescriptor = {
  args: string[];
  kind: string;
  identity: Readonly<Record<string, unknown>>;
  payloadSha256: string;
  nonIdempotent: boolean;
  acceptedRejections: ReadonlySet<number>;
};

function mutationDescriptor(request: SweepMutationRequest): MutationDescriptor {
  if (request.type === "reaction-add") {
    const payloadSha256 = sweepMutationPayloadDigest({ content: request.content });
    return {
      args: [
        "api",
        "--method",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${request.repository}/issues/${request.itemNumber}/reactions`,
        "-f",
        `content=${request.content}`,
      ],
      kind: "sweep_reaction_add",
      identity: {
        repository: request.repository,
        itemNumber: request.itemNumber,
        content: request.content,
        payloadSha256,
      },
      payloadSha256,
      nonIdempotent: false,
      acceptedRejections: new Set([422]),
    };
  }
  if (request.type === "reaction-delete") {
    const payloadSha256 = sweepMutationPayloadDigest({ reactionId: request.reactionId });
    return {
      args: [
        "api",
        "--method",
        "DELETE",
        "-H",
        "Accept: application/vnd.github+json",
        `repos/${request.repository}/issues/${request.itemNumber}/reactions/${request.reactionId}`,
      ],
      kind: "sweep_reaction_delete",
      identity: {
        repository: request.repository,
        itemNumber: request.itemNumber,
        reactionId: request.reactionId,
        payloadSha256,
      },
      payloadSha256,
      nonIdempotent: false,
      acceptedRejections: new Set([404]),
    };
  }
  if (request.type === "comment-delete") {
    const payloadSha256 = sweepMutationPayloadDigest({ commentId: request.commentId });
    return {
      args: [
        "api",
        "--method",
        "DELETE",
        `repos/${request.repository}/issues/comments/${request.commentId}`,
      ],
      kind: "sweep_comment_delete",
      identity: {
        repository: request.repository,
        itemNumber: request.itemNumber,
        commentId: request.commentId,
        payloadSha256,
      },
      payloadSha256,
      nonIdempotent: false,
      acceptedRejections: new Set([404]),
    };
  }
  if (request.type === "workflow-dispatch") {
    const fields = Object.entries(request.fields).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const payloadSha256 = sweepMutationPayloadDigest(Object.fromEntries(fields));
    return {
      args: [
        "workflow",
        "run",
        request.workflow,
        "--repo",
        request.repository,
        "--ref",
        request.ref,
        ...fields.flatMap(([name, value]) => ["-f", `${name}=${value}`]),
      ],
      kind: "sweep_workflow_dispatch",
      identity: {
        repository: request.repository,
        workflow: request.workflow,
        ref: request.ref,
        targetRepository: request.targetRepository ?? null,
        itemNumber: request.itemNumber ?? null,
        businessKey: request.businessKey,
        payloadSha256,
      },
      payloadSha256,
      nonIdempotent: true,
      acceptedRejections: new Set(),
    };
  }

  const payload = readDispatchPayload(request.payloadPath);
  const payloadEventType = String((payload as { event_type?: unknown }).event_type ?? "");
  if (payloadEventType !== request.eventType) {
    throw new Error("repository dispatch payload event_type does not match --event-type");
  }
  const payloadSha256 = sweepMutationPayloadDigest(payload);
  return {
    args: [
      "api",
      "--method",
      "POST",
      `repos/${request.repository}/dispatches`,
      "--input",
      request.payloadPath,
    ],
    kind: "sweep_repository_dispatch",
    identity: {
      repository: request.repository,
      eventType: request.eventType,
      targetRepository: request.targetRepository ?? null,
      itemNumber: request.itemNumber ?? null,
      businessKey: request.businessKey,
      payloadSha256,
    },
    payloadSha256,
    nonIdempotent: true,
    acceptedRejections: new Set(),
  };
}

function mutationLifecycle(
  request: SweepMutationRequest,
  payloadSha256: string,
): RepairLifecycleInput {
  const targetRepository =
    "targetRepository" in request && request.targetRepository
      ? request.targetRepository
      : request.repository;
  const itemNumber = "itemNumber" in request ? request.itemNumber : undefined;
  return {
    repository: targetRepository,
    workKey: `sweep-caller:${request.type}:${payloadSha256}`,
    ...(itemNumber ? { number: itemNumber } : {}),
    subjectKind: itemNumber ? "issue" : "workflow",
  };
}

function assertDispatchCanStart(
  lifecycle: RepairLifecycleInput,
  options: { kind: string; identity: unknown; operationName: string },
): void {
  // Published receipts block normal reruns. A hard runner loss before receipt publication
  // remains at-least-once delivery, so callers must target downstream-safe workflows.
  const idempotencyKey = actionIdempotencyKey(
    repairMutationIdempotencyIdentity(lifecycle, options),
  );
  const stateRoot = String(process.env.CLAWSWEEPER_STATE_DIR ?? "").trim();
  if (!stateRoot) {
    throw new Error("non-idempotent sweep dispatch requires hydrated durable action ledger state");
  }
  const producerRepository = String(process.env.GITHUB_REPOSITORY ?? "").trim();
  requiredRepository(producerRepository);
  const events = [
    ...readSpooledActionEvents(repairActionLedgerRoot(), lifecycle.repository),
    ...readDurableDispatchEvents(stateRoot, producerRepository, idempotencyKey),
  ].filter(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.repairMutation &&
      event.idempotency_key_sha256 === idempotencyKey,
  );
  const attempted = events.filter(
    (event) => event.attributes?.completion_reason === "mutation_attempted",
  ).length;
  const rejected = events.filter(
    (event) => event.attributes?.completion_reason === "mutation_rejected",
  ).length;
  const acceptedOrUnknown = events.some((event) =>
    ["mutation_accepted", "mutation_outcome_unknown", "mutation_observed"].includes(
      String(event.attributes?.completion_reason ?? ""),
    ),
  );
  if (acceptedOrUnknown || attempted > rejected) {
    throw new Error(
      "refusing duplicate non-idempotent sweep dispatch after an accepted or outcome-unknown attempt",
    );
  }
}

function runMutationWire(args: readonly string[], runWire: SweepWireRunner): void {
  const result = runWire(args);
  if (result.status === 0) return;
  throw wireFailure(result);
}

function defaultWireRunner(args: readonly string[]) {
  return spawnSync("gh", args, {
    cwd: repoRoot(),
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      CLICOLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

class SweepWireError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(message: string, options: { status?: number | null; code?: string } = {}) {
    super(message);
    this.name = "SweepWireError";
    this.status = options.status ?? null;
    this.code = options.code ?? "";
  }
}

function wireFailure(
  result: Pick<SpawnSyncReturns<string>, "error" | "status" | "stderr" | "stdout">,
): SweepWireError {
  const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n");
  const status = githubStatus(detail);
  const code = String((result.error as NodeJS.ErrnoException | undefined)?.code ?? "");
  const category =
    status != null
      ? `HTTP ${status}`
      : code
        ? `transport ${code}`
        : result.status != null
          ? `exit ${result.status}`
          : "transport failure";
  return new SweepWireError(`GitHub mutation failed (${category})`, { status, code });
}

function asSweepWireError(error: unknown): SweepWireError {
  if (error instanceof SweepWireError) return error;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code ?? "")
      : "";
  return new SweepWireError("GitHub mutation failed (unknown)", { code });
}

function isDefiniteRejection(error: unknown): boolean {
  if (!(error instanceof SweepWireError)) return false;
  return (
    DEFINITE_REJECTION_STATUSES.has(error.status ?? -1) ||
    error.code === "ENOENT" ||
    error.code === "EACCES"
  );
}

function isRetryableReactionError(error: SweepWireError): boolean {
  return (
    REACTION_RETRYABLE_STATUSES.has(error.status ?? -1) ||
    error.status == null ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(error.code)
  );
}

function githubStatus(detail: string): number | null {
  const match = detail.match(/\b(?:HTTP|status(?: code)?)\s*:?\s*(\d{3})\b/i);
  return match?.[1] ? Number(match[1]) : null;
}

function reactionAttempts(request: SweepMutationRequest): number {
  if (
    request.type !== "reaction-add" &&
    request.type !== "reaction-delete" &&
    request.type !== "comment-delete"
  ) {
    return 1;
  }
  const attempts = request.maxAttempts ?? 3;
  return Math.max(1, Math.min(6, Math.floor(attempts)));
}

function retryDelayMs(attempt: number): number {
  return Math.min(10_000, 1_000 * 2 ** (attempt - 1));
}

function readDispatchPayload(filePath: string): unknown {
  const resolved = fs.realpathSync.native(pathParent(filePath));
  const safeRoot = prepareSafeReadRoot(resolved, "repository dispatch payload");
  const target = prepareSafeReadTarget(safeRoot, pathBase(filePath), "repository dispatch payload");
  const value = JSON.parse(readUtf8FileNoFollow(target, MAX_PAYLOAD_BYTES)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("repository dispatch payload must be a JSON object");
  }
  return value;
}

function readDurableDispatchEvents(
  stateRoot: string,
  repository: string,
  idempotencyKey: string,
): ActionEvent[] {
  const root = prepareSafeReadRoot(stateRoot, "durable sweep action ledger");
  const eventRoot = "ledger/v1/events";
  const repositoryDirectory = slugForRepo(repository.toLowerCase());
  const matching: ActionEvent[] = [];
  let directories = 0;
  let files = 0;
  let bytes = 0;

  const list = (relativePath: string) => {
    directories += 1;
    if (directories > MAX_DURABLE_LEDGER_DIRECTORIES) {
      throw new Error("durable sweep action ledger exceeds the directory scan limit");
    }
    try {
      return readDirectoryEntriesNoFollow(root, relativePath, "durable sweep action ledger", 512);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  };
  const directoryNames = (relativePath: string, pattern: RegExp) =>
    list(relativePath)
      .map((entry) => {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
          throw new Error(`refusing unsafe durable sweep action ledger entry: ${entry.name}`);
        }
        if (!entry.isDirectory() || !pattern.test(entry.name)) return null;
        return entry.name;
      })
      .filter((entry): entry is string => entry !== null)
      .sort()
      .reverse();

  for (const year of directoryNames(eventRoot, /^\d{4}$/)) {
    for (const month of directoryNames(`${eventRoot}/${year}`, /^\d{2}$/)) {
      for (const day of directoryNames(`${eventRoot}/${year}/${month}`, /^\d{2}$/)) {
        const repoPath = `${eventRoot}/${year}/${month}/${day}/${repositoryDirectory}`;
        for (const producer of directoryNames(repoPath, /^[A-Za-z0-9_.-]+$/)) {
          const producerPath = `${repoPath}/${producer}`;
          for (const entry of list(producerPath)) {
            if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
              throw new Error(`refusing unsafe durable sweep action ledger entry: ${entry.name}`);
            }
            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
            files += 1;
            if (files > MAX_DURABLE_LEDGER_FILES) {
              throw new Error("durable sweep action ledger exceeds the file scan limit");
            }
            const relativePath = `${producerPath}/${entry.name}`;
            const content = readUtf8FileNoFollow(
              prepareSafeReadTarget(root, relativePath, "durable sweep action ledger shard"),
              ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes,
            );
            bytes += Buffer.byteLength(content);
            if (bytes > MAX_DURABLE_LEDGER_BYTES) {
              throw new Error("durable sweep action ledger exceeds the byte scan limit");
            }
            if (!content.includes(idempotencyKey)) continue;
            matching.push(
              ...readActionEventShardAt(root, relativePath).filter(
                (event) => event.idempotency_key_sha256 === idempotencyKey,
              ),
            );
          }
        }
      }
    }
  }
  return matching;
}

function pathParent(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separator < 0 ? "." : filePath.slice(0, separator) || "/";
}

function pathBase(filePath: string): string {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separator < 0 ? filePath : filePath.slice(separator + 1);
}

function isNotFound(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function validateRequest(request: SweepMutationRequest): void {
  requiredRepository(request.repository);
  if ("itemNumber" in request && request.itemNumber !== undefined) {
    positiveInteger(request.itemNumber, "item number");
  }
  if (request.type === "reaction-add") {
    if (
      !["eyes", "+1", "-1", "laugh", "confused", "heart", "hooray", "rocket"].includes(
        request.content,
      )
    ) {
      throw new Error("unsupported reaction content");
    }
  } else if (request.type === "reaction-delete") {
    positiveInteger(request.reactionId, "reaction id");
  } else if (request.type === "comment-delete") {
    positiveInteger(request.commentId, "comment id");
  } else if (request.type === "workflow-dispatch") {
    if (!/^[A-Za-z0-9_./-]+\.ya?ml$/.test(request.workflow)) {
      throw new Error("invalid workflow name");
    }
    if (!/^[A-Za-z0-9_./-]+$/.test(request.ref)) throw new Error("invalid workflow ref");
    for (const name of Object.keys(request.fields)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
        throw new Error(`invalid workflow field name: ${name}`);
      }
    }
  } else if (!/^[A-Za-z0-9_.-]{1,100}$/.test(request.eventType)) {
    throw new Error("invalid repository dispatch event type");
  }
  if ("targetRepository" in request && request.targetRepository) {
    requiredRepository(request.targetRepository);
  }
  if ("businessKey" in request) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.businessKey)) {
      throw new Error("business key must be a bounded machine identifier");
    }
  }
}

function requiredRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("invalid GitHub repository");
  }
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}
