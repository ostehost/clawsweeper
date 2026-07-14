#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACTION_EVENT_SHARD_FILE_LIMITS,
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  actionIdempotencyKey,
  actionOperationId,
  readActionEventShardAt,
  readSpooledActionEvents,
  type ActionEvent,
  type ActionEventSubject,
} from "../action-ledger.js";
import {
  prepareSafeReadRoot,
  prepareSafeReadTarget,
  readDirectoryEntriesNoFollow,
  readUtf8FileNoFollow,
} from "../action-ledger-files.js";
import { flushWorkflowActionEvents, recordWorkflowPhaseEvent } from "../action-ledger-runtime.js";
import { resolveSpawnCommand } from "../command.js";
import { ghRetryKind } from "../github-retry.js";
import { slugForRepo } from "../repository-profiles.js";
import { ghErrorText } from "./github-cli.js";
import { parseArgs, repoRoot } from "./lib.js";

type JsonRecord = Record<string, unknown>;

export type FanoutMode = "hot-intake" | "normal-review" | "audit";

export interface InventoryConfig {
  owners: readonly string[];
  denyRepositories: readonly string[];
  includePrivate: boolean;
  includeArchived: boolean;
  includeForks: boolean;
  requireIssues: boolean;
}

export interface ListedRepository {
  nameWithOwner: string;
  isArchived: boolean;
  isDisabled: boolean;
  isFork: boolean;
  hasIssuesEnabled: boolean;
  visibility: string;
  defaultBranch: string;
}

export interface SelectedRepository {
  targetRepo: string;
  defaultBranch: string;
  visibility: string;
}

interface SelectionResult {
  repositories: SelectedRepository[];
  cursor: number;
  total: number;
}

interface CursorState {
  nextCursor: number;
  afterRepository: string | null;
}

interface FanoutOptions {
  mode: FanoutMode;
  limit: number;
  cursorPath: string;
  dispatchRepo: string;
  workflow: string;
  ref: string;
  dryRun: boolean;
  owners: readonly string[] | undefined;
}

interface FanoutActionLedger {
  producerComponent: string;
  operationIdentity: {
    repository: string;
    mode: FanoutMode;
    limit: number;
    cycleStartedAt: string;
  };
  subject: ActionEventSubject;
  queueStartEventId: string | null;
  lastEventId: string | null;
  nextPhaseSeq: number;
  startedAtMs: number;
  inventoryCount: number;
  selectedCount: number;
  dispatchedCount: number;
  mutationObserved: boolean;
  uncertainMutationObserved: boolean;
  failureCompletionReason:
    | "dispatch_rejected"
    | "dispatch_outcome_unknown"
    | "mutation_outcome_unknown"
    | "accepted_state_persistence_failed"
    | "accepted_receipt_write_failed"
    | null;
  failureRetryable: boolean | null;
  terminal: boolean;
}

const DEFAULT_CURSOR_DIR = join(repoRoot(), "results", "target-fanout-cursors");
const PUBLIC_INVENTORY_TOKEN = "__public__";
const RUN_EVENT_MAX_FILES = 256;
const RUN_EVENT_MAX_BYTES = 8 * 1024 * 1024;

export async function runTargetFanout(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const mode = fanoutMode(stringArg(args.mode, "hot-intake"));
  const config = readInventoryConfig();
  const options: FanoutOptions = {
    mode,
    limit: positiveNumber(stringArg(args.limit, defaultLimit(mode)), "limit"),
    cursorPath: stringArg(args["cursor-path"], join(DEFAULT_CURSOR_DIR, `${mode}.json`)),
    dispatchRepo: stringArg(args.repo, process.env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper"),
    workflow: stringArg(args.workflow, "sweep.yml"),
    ref: stringArg(args.ref, "main"),
    dryRun: Boolean(args["dry-run"]),
    owners: csvArg(args.owners),
  };

  if (args._[0] === "list" || args._[0] === "plan") {
    const repositories = await loadEligibleRepositories(config, options.owners);
    const cursorState = readCursor(options.cursorPath);
    const selection = selectRepositories(repositories, {
      limit: options.limit,
      cursor: cursorStart(repositories, cursorState),
    });
    const commands = selection.repositories.map((repository) =>
      workflowDispatchArgs(repository, options),
    );
    if (args._[0] === "list") {
      process.stdout.write(
        `${JSON.stringify({ total: repositories.length, repositories }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${JSON.stringify({ ...selection, commands }, null, 2)}\n`);
    }
    return;
  }

  const ledger = startFanoutActionLedger(options);
  let primaryError: unknown = null;
  try {
    const repositories = await loadEligibleRepositories(config, options.owners);
    const cursorState = readCursor(options.cursorPath);
    const currentCursor = cursorStart(repositories, cursorState);
    const runAttempt = positiveRunAttempt();
    let selection: SelectionResult;
    try {
      selection =
        runAttempt > 1 && !options.dryRun
          ? recoverAcceptedFanoutSelection(ledger, repositories)
          : selectRepositories(repositories, {
              limit: options.limit,
              cursor: currentCursor,
            });
    } catch (error) {
      ledger.failureCompletionReason = "dispatch_outcome_unknown";
      ledger.failureRetryable = false;
      throw error;
    }
    recordFanoutSelection(ledger, repositories.length, selection.repositories.length);
    const commands = selection.repositories.map((repository) =>
      workflowDispatchArgs(repository, options),
    );

    const dispatched: string[] = [];
    for (const [index, repository] of selection.repositories.entries()) {
      const commandArgs = commands[index];
      if (!commandArgs) continue;
      if (options.dryRun) {
        console.log(`dry-run ${commandArgs.join(" ")}`);
        recordFanoutDispatchSkipped(ledger, repository, options);
      } else {
        const acceptedCursor = cursorAfterRepository(repositories, repository.targetRepo);
        const reserveAccepted = () =>
          writeFileSyncWithDirs(
            options.cursorPath,
            cursorContent(acceptedCursor, repository.targetRepo),
          );
        if (runAttempt > 1) {
          reserveAccepted();
          recordAcceptedFanoutDispatchReplay(ledger, repository, options);
        } else {
          recordFanoutDispatch(
            ledger,
            repository,
            options,
            () => runGh(commandArgs, dispatchEnv()),
            reserveAccepted,
          );
        }
      }
      dispatched.push(repository.targetRepo);
    }

    if (!options.dryRun) {
      recordFanoutCursorPublication(
        ledger,
        options,
        selection.cursor,
        selection.repositories.at(-1)?.targetRepo ?? null,
      );
    }
    finishFanoutActionLedger(ledger, { dryRun: options.dryRun });
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: options.mode,
          total: selection.total,
          dispatched,
          next_cursor: selection.cursor,
          dry_run: options.dryRun,
          cursor_written: !options.dryRun,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    primaryError = error;
    try {
      finishFanoutActionLedger(ledger, { dryRun: options.dryRun, error });
    } catch (receiptError) {
      console.error(
        `[target-fanout] failed to record terminal action receipt: ${errorMessage(receiptError)}`,
      );
    }
  }
  let flushError: unknown = null;
  try {
    await flushWorkflowActionEvents(repoRoot());
  } catch (error) {
    flushError = error;
  }
  if (primaryError) {
    if (flushError) {
      console.error(
        `[target-fanout] failed to flush action receipts after the primary failure: ${errorMessage(flushError)}`,
      );
    }
    throw primaryError;
  }
  if (flushError) throw flushError;
}

function startFanoutActionLedger(options: FanoutOptions): FanoutActionLedger {
  const repository = options.dispatchRepo.trim().toLowerCase();
  const operationIdentity = {
    repository,
    mode: options.mode,
    limit: options.limit,
    cycleStartedAt: fanoutCycleStartedAt(),
  };
  const subject: ActionEventSubject = {
    repository,
    kind: "workflow",
    subjectId: `target-fanout-${options.mode}`,
  };
  const start = recordWorkflowPhaseEvent(repoRoot(), {
    phase: ACTION_EVENT_TYPES.queueLifecycle,
    status: ACTION_EVENT_STATUSES.started,
    reasonCode: ACTION_EVENT_REASON_CODES.selected,
    retryable: false,
    mutation: false,
    identity: { slot: "fanout_queue_start" },
    operation: "target_fanout",
    operationIdentity,
    phaseSeq: 1,
    idempotencyIdentity: { operationIdentity, slot: "fanout_queue_start" },
    component: "target_fanout",
    subject,
    attributes: {
      batch_size: options.limit,
      queue_kind: "target_fanout",
      work_kind: options.mode,
    },
    privacy: fanoutActionLedgerPrivacy(),
  });
  return {
    producerComponent: start?.producer.component ?? "target_fanout",
    operationIdentity,
    subject,
    queueStartEventId: start?.event_id ?? null,
    lastEventId: start?.event_id ?? null,
    nextPhaseSeq: 2,
    startedAtMs: Date.now(),
    inventoryCount: 0,
    selectedCount: 0,
    dispatchedCount: 0,
    mutationObserved: false,
    uncertainMutationObserved: false,
    failureCompletionReason: null,
    failureRetryable: null,
    terminal: false,
  };
}

function recordFanoutSelection(
  ledger: FanoutActionLedger,
  inventoryCount: number,
  selectedCount: number,
): void {
  ledger.inventoryCount = inventoryCount;
  ledger.selectedCount = selectedCount;
  const event = recordWorkflowPhaseEvent(repoRoot(), {
    phase: ACTION_EVENT_TYPES.queueLifecycle,
    status: ACTION_EVENT_STATUSES.queued,
    reasonCode: ACTION_EVENT_REASON_CODES.selected,
    retryable: false,
    mutation: false,
    identity: { slot: "fanout_queue_selected" },
    operation: "target_fanout",
    operationIdentity: ledger.operationIdentity,
    parentEventId: ledger.lastEventId,
    phaseSeq: nextFanoutPhaseSeq(ledger),
    idempotencyIdentity: {
      operationIdentity: ledger.operationIdentity,
      slot: "fanout_queue_selected",
    },
    component: "target_fanout",
    subject: ledger.subject,
    attributes: {
      candidate_count: inventoryCount,
      item_count: selectedCount,
      queue_depth: selectedCount,
      queue_kind: "target_fanout",
      work_kind: ledger.operationIdentity.mode,
    },
    privacy: fanoutActionLedgerPrivacy(),
  });
  ledger.lastEventId = event?.event_id ?? ledger.lastEventId;
}

function recordFanoutDispatch(
  ledger: FanoutActionLedger,
  repository: SelectedRepository,
  options: FanoutOptions,
  dispatch: () => void,
  reserveAccepted: () => void,
): void {
  const request = fanoutDispatchRequestIdentity(repository, options);
  const idempotencyIdentity = fanoutDispatchIdempotencyIdentity(ledger, request);
  if (fanoutDispatchDecision(repository, idempotencyIdentity) === "already_accepted") {
    reserveAccepted();
    recordAcceptedFanoutDispatchReplay(ledger, repository, options);
    return;
  }
  const subject: ActionEventSubject = {
    repository: repository.targetRepo,
    kind: "repository",
  };
  const attempt = recordWorkflowPhaseEvent(repoRoot(), {
    phase: ACTION_EVENT_TYPES.dispatchLifecycle,
    status: ACTION_EVENT_STATUSES.started,
    reasonCode: ACTION_EVENT_REASON_CODES.selected,
    retryable: true,
    mutation: false,
    identity: { slot: "fanout_dispatch_attempt", targetRepo: repository.targetRepo },
    operation: "target_fanout",
    operationIdentity: ledger.operationIdentity,
    parentEventId: ledger.lastEventId,
    phaseSeq: nextFanoutPhaseSeq(ledger),
    idempotencyIdentity,
    component: "target_fanout",
    subject,
    evidence: [{ kind: "fanout_dispatch_request", sha256: sha256(JSON.stringify(request)) }],
    attributes: {
      attempt: 1,
      completion_reason: "dispatch_attempted",
      dispatch_kind: fanoutDispatchKind(options.mode),
      work_kind: options.mode,
    },
    privacy: fanoutActionLedgerPrivacy(),
  });
  ledger.lastEventId = attempt?.event_id ?? ledger.lastEventId;
  try {
    dispatch();
  } catch (error) {
    const failure = fanoutDispatchFailure(error);
    const failed = recordWorkflowPhaseEvent(repoRoot(), {
      phase: ACTION_EVENT_TYPES.dispatchLifecycle,
      status:
        failure.outcome === "rejected"
          ? ACTION_EVENT_STATUSES.skipped
          : ACTION_EVENT_STATUSES.failed,
      reasonCode:
        failure.outcome === "rejected"
          ? ACTION_EVENT_REASON_CODES.notApplicable
          : ACTION_EVENT_REASON_CODES.unavailable,
      retryable: failure.retryable,
      mutation: failure.outcome === "unknown",
      identity: {
        slot: "fanout_dispatch_outcome",
        targetRepo: repository.targetRepo,
        outcome: failure.outcome,
      },
      operation: "target_fanout",
      operationIdentity: ledger.operationIdentity,
      parentEventId: attempt?.event_id ?? ledger.lastEventId,
      phaseSeq: nextFanoutPhaseSeq(ledger),
      idempotencyIdentity,
      component: "target_fanout",
      subject,
      evidence: [{ kind: "fanout_dispatch_request", sha256: sha256(JSON.stringify(request)) }],
      attributes: {
        attempt: 1,
        completion_reason:
          failure.outcome === "rejected" ? "mutation_rejected" : "dispatch_outcome_unknown",
        dispatch_kind: fanoutDispatchKind(options.mode),
        failed_count: 1,
        work_kind: options.mode,
      },
      privacy: fanoutActionLedgerPrivacy(),
    });
    ledger.lastEventId = failed?.event_id ?? ledger.lastEventId;
    ledger.failureRetryable = failure.retryable;
    if (failure.outcome === "rejected") {
      ledger.failureCompletionReason = "dispatch_rejected";
    } else {
      ledger.mutationObserved = true;
      ledger.uncertainMutationObserved = true;
      ledger.failureCompletionReason = "dispatch_outcome_unknown";
    }
    throw error;
  }
  ledger.dispatchedCount += 1;
  ledger.mutationObserved = true;
  try {
    reserveAccepted();
  } catch (error) {
    ledger.failureCompletionReason = "accepted_state_persistence_failed";
    ledger.failureRetryable = false;
    throw error;
  }
  let completed;
  try {
    completed = recordWorkflowPhaseEvent(repoRoot(), {
      phase: ACTION_EVENT_TYPES.dispatchLifecycle,
      status: ACTION_EVENT_STATUSES.dispatched,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      retryable: false,
      mutation: true,
      identity: {
        slot: "fanout_dispatch_outcome",
        targetRepo: repository.targetRepo,
        outcome: "accepted",
      },
      operation: "target_fanout",
      operationIdentity: ledger.operationIdentity,
      parentEventId: attempt?.event_id ?? ledger.lastEventId,
      phaseSeq: nextFanoutPhaseSeq(ledger),
      idempotencyIdentity,
      component: "target_fanout",
      subject,
      evidence: [{ kind: "fanout_dispatch_request", sha256: sha256(JSON.stringify(request)) }],
      attributes: {
        attempt: 1,
        completion_reason: "mutation_accepted",
        dispatch_kind: fanoutDispatchKind(options.mode),
        work_kind: options.mode,
      },
      privacy: fanoutActionLedgerPrivacy(),
    });
  } catch (error) {
    ledger.failureCompletionReason = "accepted_receipt_write_failed";
    ledger.failureRetryable = false;
    throw error;
  }
  ledger.lastEventId = completed?.event_id ?? ledger.lastEventId;
}

function fanoutDispatchDecision(
  repository: SelectedRepository,
  idempotencyIdentity: unknown,
): "dispatch" | "already_accepted" {
  const idempotencyKey = actionIdempotencyKey(idempotencyIdentity);
  const localEvents = readSpooledActionEvents(repoRoot(), repository.targetRepo);
  const events = localEvents.filter(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.dispatchLifecycle &&
      event.idempotency_key_sha256 === idempotencyKey,
  );
  if (events.some((event) => event.attributes?.completion_reason === "mutation_accepted")) {
    return "already_accepted";
  }
  const attempted = events.filter(
    (event) => event.attributes?.completion_reason === "dispatch_attempted",
  ).length;
  const rejected = events.filter(
    (event) => event.attributes?.completion_reason === "mutation_rejected",
  ).length;
  const unknown = events.some((event) =>
    ["dispatch_outcome_unknown", "mutation_outcome_unknown"].includes(
      String(event.attributes?.completion_reason ?? ""),
    ),
  );
  if (unknown || attempted > rejected) {
    throw new Error("refusing duplicate target fanout dispatch after an outcome-unknown attempt");
  }
  return "dispatch";
}

function recordAcceptedFanoutDispatchReplay(
  ledger: FanoutActionLedger,
  repository: SelectedRepository,
  options: FanoutOptions,
): void {
  const replayIdentity = {
    operationIdentity: ledger.operationIdentity,
    slot: "fanout_dispatch_recovered",
    targetRepository: repository.targetRepo,
  };
  const event = recordWorkflowPhaseEvent(repoRoot(), {
    phase: ACTION_EVENT_TYPES.dispatchLifecycle,
    status: ACTION_EVENT_STATUSES.skipped,
    reasonCode: ACTION_EVENT_REASON_CODES.alreadyProcessed,
    retryable: false,
    mutation: false,
    identity: { slot: "fanout_dispatch_replay", targetRepo: repository.targetRepo },
    operation: "target_fanout",
    operationIdentity: ledger.operationIdentity,
    parentEventId: ledger.lastEventId,
    phaseSeq: nextFanoutPhaseSeq(ledger),
    idempotencyIdentity: replayIdentity,
    component: "target_fanout",
    subject: {
      repository: repository.targetRepo,
      kind: "repository",
    },
    evidence: [
      {
        kind: "fanout_dispatch_recovery",
        sha256: sha256(JSON.stringify(replayIdentity)),
      },
    ],
    attributes: {
      completion_reason: "already_accepted",
      dispatch_kind: fanoutDispatchKind(options.mode),
      work_kind: options.mode,
    },
    privacy: fanoutActionLedgerPrivacy(),
  });
  ledger.lastEventId = event?.event_id ?? ledger.lastEventId;
  ledger.dispatchedCount += 1;
}

function recoverAcceptedFanoutSelection(
  ledger: FanoutActionLedger,
  repositories: readonly SelectedRepository[],
): SelectionResult {
  const stateRoot = String(process.env.CLAWSWEEPER_STATE_DIR ?? "").trim();
  if (!stateRoot) {
    throw new Error("target fanout rerun requires hydrated durable action ledger state");
  }
  const currentAttempt = positiveRunAttempt();
  const events = readDurableFanoutRunEvents(
    stateRoot,
    ledger.operationIdentity.repository,
    ledger.producerComponent,
    githubRunId(),
    fanoutPartitionDate(),
  ).filter(
    (event) =>
      event.operation_id ===
        actionOperationId(event.subject.repository, "target_fanout", ledger.operationIdentity) &&
      event.producer.run_attempt < currentAttempt,
  );
  if (events.length === 0) {
    throw new Error("refusing target fanout rerun without prior-attempt durable receipts");
  }
  const originalAttempt = Math.min(...events.map((event) => event.producer.run_attempt));
  const original = events.filter((event) => event.producer.run_attempt === originalAttempt);
  const selected = original.find(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.queueLifecycle &&
      event.action.status === ACTION_EVENT_STATUSES.queued,
  );
  const selectedCount = nonNegativeInteger(selected?.attributes?.item_count);
  const attempts = original.filter(
    (event) =>
      event.event_type === ACTION_EVENT_TYPES.dispatchLifecycle &&
      event.attributes?.completion_reason === "dispatch_attempted",
  );
  const accepted = original
    .filter(
      (event) =>
        event.event_type === ACTION_EVENT_TYPES.dispatchLifecycle &&
        event.attributes?.completion_reason === "mutation_accepted",
    )
    .sort((left, right) => left.phase_seq - right.phase_seq);
  if (selectedCount === 0 && attempts.length === 0 && accepted.length === 0) {
    return { repositories: [], cursor: 0, total: repositories.length };
  }
  const attemptedTargets = attempts.map((event) => event.subject.repository);
  const targets = accepted.map((event) => event.subject.repository);
  const attemptedIdentities = new Set(
    attempts.map((event) => `${event.subject.repository}\n${event.idempotency_key_sha256}`),
  );
  const acceptedIdentities = new Set(
    accepted.map((event) => `${event.subject.repository}\n${event.idempotency_key_sha256}`),
  );
  if (
    selectedCount === null ||
    selectedCount === 0 ||
    attempts.length !== selectedCount ||
    accepted.length !== selectedCount ||
    new Set(attemptedTargets).size !== selectedCount ||
    new Set(targets).size !== selectedCount ||
    attemptedIdentities.size !== selectedCount ||
    acceptedIdentities.size !== selectedCount ||
    [...acceptedIdentities].some((identity) => !attemptedIdentities.has(identity))
  ) {
    throw new Error(
      `refusing target fanout rerun without a complete accepted original batch ` +
        `(selected=${String(selectedCount)}, attempted=${attempts.length}, ` +
        `accepted=${accepted.length}, attempted_identities=${attemptedIdentities.size}, ` +
        `accepted_identities=${acceptedIdentities.size})`,
    );
  }
  const recovered = targets.map((targetRepo): SelectedRepository => {
    const current = repositories.find((repository) => repository.targetRepo === targetRepo);
    return (
      current ?? {
        targetRepo,
        defaultBranch: "",
        visibility: "UNKNOWN",
      }
    );
  });
  const lastRepository = recovered.at(-1)?.targetRepo ?? null;
  return {
    repositories: recovered,
    cursor: lastRepository === null ? 0 : cursorAfterRepository(repositories, lastRepository),
    total: repositories.length,
  };
}

function readDurableFanoutRunEvents(
  stateRoot: string,
  repository: string,
  producerComponent: string,
  runId: string,
  partitionDate: string,
): ActionEvent[] {
  const root = prepareSafeReadRoot(stateRoot, "durable target fanout action ledger");
  const [year, month, day] = partitionDate.split("-");
  const repositoryPath = [
    "ledger",
    "v1",
    "events",
    year,
    month,
    day,
    slugForRepo(repository),
    producerComponent,
  ].join("/");
  let entries;
  try {
    entries = readDirectoryEntriesNoFollow(
      root,
      repositoryPath,
      "durable target fanout run directory",
      RUN_EVENT_MAX_FILES,
    );
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const events: ActionEvent[] = [];
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`refusing unsafe durable target fanout entry: ${entry.name}`);
    }
    if (!entry.name.startsWith(`${runId}-`) || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    files += 1;
    if (files > RUN_EVENT_MAX_FILES) {
      throw new Error("durable target fanout run exceeds the shard file limit");
    }
    const relativePath = `${repositoryPath}/${entry.name}`;
    const content = readUtf8FileNoFollow(
      prepareSafeReadTarget(root, relativePath, "durable target fanout shard"),
      ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes,
    );
    bytes += Buffer.byteLength(content);
    if (bytes > RUN_EVENT_MAX_BYTES) {
      throw new Error("durable target fanout run exceeds the aggregate byte limit");
    }
    events.push(
      ...readActionEventShardAt(root, relativePath).filter(
        (event) =>
          event.producer.repository === repository &&
          event.producer.run_id === runId &&
          event.producer.job === "target-fanout" &&
          event.producer.component === producerComponent,
      ),
    );
  }
  return events;
}

function recordFanoutDispatchSkipped(
  ledger: FanoutActionLedger,
  repository: SelectedRepository,
  options: FanoutOptions,
): void {
  const request = fanoutDispatchRequestIdentity(repository, options);
  const event = recordWorkflowPhaseEvent(repoRoot(), {
    phase: ACTION_EVENT_TYPES.dispatchLifecycle,
    status: ACTION_EVENT_STATUSES.skipped,
    reasonCode: ACTION_EVENT_REASON_CODES.dryRun,
    retryable: false,
    mutation: false,
    identity: { slot: "fanout_dispatch_skipped", targetRepo: repository.targetRepo },
    operation: "target_fanout",
    operationIdentity: ledger.operationIdentity,
    parentEventId: ledger.lastEventId,
    phaseSeq: nextFanoutPhaseSeq(ledger),
    idempotencyIdentity: {
      operationIdentity: ledger.operationIdentity,
      slot: "fanout_dispatch",
      request,
    },
    component: "target_fanout",
    subject: {
      repository: repository.targetRepo,
      kind: "repository",
    },
    evidence: [{ kind: "fanout_dispatch_request", sha256: sha256(JSON.stringify(request)) }],
    attributes: {
      attempt: 1,
      completion_reason: "dry_run",
      dispatch_kind: fanoutDispatchKind(options.mode),
      work_kind: options.mode,
    },
    privacy: fanoutActionLedgerPrivacy(),
  });
  ledger.lastEventId = event?.event_id ?? ledger.lastEventId;
}

function recordFanoutCursorPublication(
  ledger: FanoutActionLedger,
  options: FanoutOptions,
  cursor: number,
  afterRepository: string | null,
): void {
  const content = cursorContent(cursor, afterRepository);
  const cursorSha256 = sha256(content);
  const idempotencyIdentity = {
    operationIdentity: ledger.operationIdentity,
    slot: "fanout_cursor_publication",
    cursorSha256,
  };
  const subject: ActionEventSubject = {
    repository: ledger.operationIdentity.repository,
    kind: "publication",
    subjectId: `target-fanout-cursor-${options.mode}`,
  };
  const attempt = recordWorkflowPhaseEvent(repoRoot(), {
    phase: ACTION_EVENT_TYPES.publicationLifecycle,
    status: ACTION_EVENT_STATUSES.started,
    reasonCode: ACTION_EVENT_REASON_CODES.selected,
    retryable: true,
    mutation: false,
    identity: { slot: "fanout_cursor_publication_attempt" },
    operation: "target_fanout",
    operationIdentity: ledger.operationIdentity,
    parentEventId: ledger.lastEventId,
    phaseSeq: nextFanoutPhaseSeq(ledger),
    idempotencyIdentity,
    component: "target_fanout",
    subject,
    evidence: [{ kind: "fanout_cursor_state", sha256: cursorSha256 }],
    attributes: {
      completion_reason: "mutation_attempted",
      publication_kind: "target_fanout_cursor",
      work_kind: options.mode,
    },
    privacy: fanoutActionLedgerPrivacy(),
  });
  ledger.lastEventId = attempt?.event_id ?? ledger.lastEventId;
  try {
    writeFileSyncWithDirs(options.cursorPath, content);
  } catch (error) {
    const failed = recordWorkflowPhaseEvent(repoRoot(), {
      phase: ACTION_EVENT_TYPES.publicationLifecycle,
      status: ACTION_EVENT_STATUSES.failed,
      reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
      retryable: false,
      mutation: true,
      identity: { slot: "fanout_cursor_publication_outcome", outcome: "unknown" },
      operation: "target_fanout",
      operationIdentity: ledger.operationIdentity,
      parentEventId: attempt?.event_id ?? ledger.lastEventId,
      phaseSeq: nextFanoutPhaseSeq(ledger),
      idempotencyIdentity,
      component: "target_fanout",
      subject,
      evidence: [{ kind: "fanout_cursor_state", sha256: cursorSha256 }],
      attributes: {
        completion_reason: "mutation_outcome_unknown",
        failed_count: 1,
        publication_kind: "target_fanout_cursor",
        work_kind: options.mode,
      },
      privacy: fanoutActionLedgerPrivacy(),
    });
    ledger.lastEventId = failed?.event_id ?? ledger.lastEventId;
    ledger.mutationObserved = true;
    ledger.uncertainMutationObserved = true;
    ledger.failureCompletionReason = "mutation_outcome_unknown";
    ledger.failureRetryable = false;
    throw error;
  }
  const completed = recordWorkflowPhaseEvent(repoRoot(), {
    phase: ACTION_EVENT_TYPES.publicationLifecycle,
    status: ACTION_EVENT_STATUSES.completed,
    reasonCode: ACTION_EVENT_REASON_CODES.completed,
    retryable: false,
    mutation: true,
    identity: { slot: "fanout_cursor_publication_outcome", outcome: "accepted" },
    operation: "target_fanout",
    operationIdentity: ledger.operationIdentity,
    parentEventId: attempt?.event_id ?? ledger.lastEventId,
    phaseSeq: nextFanoutPhaseSeq(ledger),
    idempotencyIdentity,
    component: "target_fanout",
    subject,
    evidence: [{ kind: "fanout_cursor_state", sha256: cursorSha256 }],
    attributes: {
      completion_reason: "mutation_accepted",
      publication_kind: "local_artifact",
      work_kind: options.mode,
    },
    privacy: fanoutActionLedgerPrivacy(),
  });
  ledger.lastEventId = completed?.event_id ?? ledger.lastEventId;
  ledger.mutationObserved = true;
}

function finishFanoutActionLedger(
  ledger: FanoutActionLedger,
  options: { dryRun: boolean; error?: unknown },
): void {
  if (ledger.terminal) return;
  const failed = options.error !== undefined;
  const event = recordWorkflowPhaseEvent(repoRoot(), {
    phase: ACTION_EVENT_TYPES.queueLifecycle,
    status: failed ? ACTION_EVENT_STATUSES.failed : ACTION_EVENT_STATUSES.completed,
    reasonCode: failed
      ? ACTION_EVENT_REASON_CODES.exception
      : options.dryRun
        ? ACTION_EVENT_REASON_CODES.dryRun
        : ACTION_EVENT_REASON_CODES.completed,
    retryable:
      failed &&
      !ledger.mutationObserved &&
      !ledger.uncertainMutationObserved &&
      (ledger.failureRetryable ?? true),
    mutation: ledger.mutationObserved || ledger.uncertainMutationObserved,
    identity: { slot: "fanout_queue_terminal", outcome: failed ? "failed" : "completed" },
    operation: "target_fanout",
    operationIdentity: ledger.operationIdentity,
    parentEventId: ledger.lastEventId ?? ledger.queueStartEventId,
    phaseSeq: 1_000_000,
    idempotencyIdentity: {
      operationIdentity: ledger.operationIdentity,
      slot: "fanout_queue_terminal",
    },
    component: "target_fanout",
    subject: ledger.subject,
    attributes: {
      candidate_count: ledger.inventoryCount,
      item_count: ledger.selectedCount,
      processed_count: ledger.dispatchedCount,
      failed_count: failed ? 1 : 0,
      skipped_count: options.dryRun ? ledger.selectedCount : 0,
      duration_ms: Math.max(0, Date.now() - ledger.startedAtMs),
      partial: failed && (ledger.mutationObserved || ledger.uncertainMutationObserved),
      completion_reason: failed
        ? (ledger.failureCompletionReason ?? "failed")
        : options.dryRun
          ? "dry_run"
          : "completed",
      queue_kind: "target_fanout",
      work_kind: ledger.operationIdentity.mode,
    },
    privacy: fanoutActionLedgerPrivacy(),
  });
  ledger.lastEventId = event?.event_id ?? ledger.lastEventId;
  ledger.terminal = true;
}

function nextFanoutPhaseSeq(ledger: FanoutActionLedger): number {
  const phaseSeq = ledger.nextPhaseSeq;
  ledger.nextPhaseSeq += 1;
  return phaseSeq;
}

function fanoutDispatchRequestIdentity(
  repository: SelectedRepository,
  options: FanoutOptions,
): {
  dispatchRepository: string;
  targetRepository: string;
  targetBranch: string;
  mode: FanoutMode;
  dispatchKind: "repository_dispatch" | "workflow_dispatch";
  workflow?: string;
  ref?: string;
} {
  return {
    dispatchRepository: options.dispatchRepo.toLowerCase(),
    targetRepository: repository.targetRepo,
    targetBranch: repository.defaultBranch || "main",
    mode: options.mode,
    dispatchKind: fanoutDispatchKind(options.mode),
    ...(options.mode === "audit" ? { workflow: options.workflow, ref: options.ref } : {}),
  };
}

function fanoutDispatchIdempotencyIdentity(
  ledger: FanoutActionLedger,
  request: ReturnType<typeof fanoutDispatchRequestIdentity>,
) {
  const { targetBranch: _targetBranch, ...stableRequest } = request;
  return {
    operationIdentity: ledger.operationIdentity,
    slot: "fanout_dispatch",
    request: stableRequest,
  };
}

function fanoutDispatchKind(mode: FanoutMode): "repository_dispatch" | "workflow_dispatch" {
  return mode === "audit" ? "workflow_dispatch" : "repository_dispatch";
}

function fanoutActionLedgerPrivacy() {
  return {
    classification: "internal" as const,
    redactionVersion: "v1",
    fieldsDropped: [
      "client_payload",
      "command_arguments",
      "credentials",
      "cursor_path",
      "raw_url",
      "token",
    ],
  };
}

function fanoutCycleStartedAt(): string {
  const value = String(process.env.GITHUB_RUN_STARTED_AT ?? "").trim();
  return value || "1970-01-01T00:00:00Z";
}

function cursorContent(cursor: number, afterRepository: string | null): string {
  return `${JSON.stringify(
    {
      next_cursor: cursor,
      ...(afterRepository ? { after_repository: afterRepository } : {}),
    },
    null,
    2,
  )}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fanoutDispatchFailure(error: unknown): {
  outcome: "rejected" | "unknown";
  retryable: boolean;
} {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code ?? "")
      : "";
  if (code === "ENOENT" || code === "EACCES") {
    return { outcome: "rejected", retryable: false };
  }
  const rejected =
    /\b(?:HTTP|status(?: code)?)\s*:?\s*(?:400|401|403|404|405|406|407|410|411|413|414|415|416|417|421|422|426|428|431|451)\b/i.test(
      ghErrorText(error),
    );
  return {
    outcome: rejected ? "rejected" : "unknown",
    retryable: rejected && ghRetryKind(error) !== "none",
  };
}

export function readInventoryConfig(
  filePath = join(repoRoot(), "config", "target-repositories.json"),
): InventoryConfig {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const config = record(parsed, "target repository config");
  const inventory = record(config.target_inventory, "target_inventory");
  return {
    owners: stringArray(inventory.owners, "target_inventory.owners").map((owner) =>
      owner.toLowerCase(),
    ),
    denyRepositories: stringArray(
      inventory.deny_repositories,
      "target_inventory.deny_repositories",
    ).map((repo) => repo.toLowerCase()),
    includePrivate: booleanValue(inventory.include_private, false),
    includeArchived: booleanValue(inventory.include_archived, false),
    includeForks: booleanValue(inventory.include_forks, false),
    requireIssues: booleanValue(inventory.require_issues, true),
  };
}

export async function loadEligibleRepositories(
  config: InventoryConfig,
  owners = config.owners,
): Promise<SelectedRepository[]> {
  const repositories: ListedRepository[] = [];
  for (const owner of owners) {
    const listed = listOwnerRepositories(owner);
    repositories.push(...listed);
  }
  return filterEligibleRepositories(repositories, config);
}

export function filterEligibleRepositories(
  repositories: readonly ListedRepository[],
  config: InventoryConfig,
): SelectedRepository[] {
  const denied = new Set(config.denyRepositories.map((repo) => repo.toLowerCase()));
  return repositories
    .filter((repository) => !repository.isDisabled)
    .filter((repository) => config.includeArchived || !repository.isArchived)
    .filter((repository) => config.includeForks || !repository.isFork)
    .filter((repository) => config.includePrivate || repository.visibility === "PUBLIC")
    .filter((repository) => !config.requireIssues || repository.hasIssuesEnabled)
    .filter((repository) => repository.defaultBranch !== "")
    .filter((repository) => !denied.has(repository.nameWithOwner.toLowerCase()))
    .sort((left, right) => left.nameWithOwner.localeCompare(right.nameWithOwner))
    .map((repository) => ({
      targetRepo: repository.nameWithOwner.toLowerCase(),
      defaultBranch: repository.defaultBranch,
      visibility: repository.visibility,
    }));
}

export function selectRepositories(
  repositories: readonly SelectedRepository[],
  options: { limit: number; cursor: number },
): SelectionResult {
  if (repositories.length === 0) return { repositories: [], cursor: 0, total: 0 };
  const limit = Math.max(1, Math.min(options.limit, repositories.length));
  const start = normalizeCursor(options.cursor, repositories.length);
  const selected: SelectedRepository[] = [];
  for (let offset = 0; offset < limit; offset += 1) {
    selected.push(repositories[(start + offset) % repositories.length] as SelectedRepository);
  }
  return {
    repositories: selected,
    cursor: (start + limit) % repositories.length,
    total: repositories.length,
  };
}

function listOwnerRepositories(owner: string): ListedRepository[] {
  const env = inventoryEnv(owner);
  if (!env) {
    console.error(`[target-fanout] skipping ${owner}: missing inventory token`);
    return [];
  }
  const output = runGh(
    [
      "repo",
      "list",
      owner,
      "--limit",
      "1000",
      "--json",
      "nameWithOwner,isArchived,isFork,hasIssuesEnabled,visibility,defaultBranchRef",
    ],
    env,
  );
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`gh repo list ${owner} did not return an array`);
  return parsed.map((entry, index) => listedRepository(entry, `${owner}[${index}]`));
}

function listedRepository(value: unknown, label: string): ListedRepository {
  const repo = record(value, label);
  const branch =
    repo.defaultBranchRef === null
      ? {}
      : record(repo.defaultBranchRef, `${label}.defaultBranchRef`);
  return {
    nameWithOwner: stringValue(repo.nameWithOwner, `${label}.nameWithOwner`),
    isArchived: booleanValue(repo.isArchived, false),
    isDisabled: false,
    isFork: booleanValue(repo.isFork, false),
    hasIssuesEnabled: booleanValue(repo.hasIssuesEnabled, false),
    visibility: stringValue(repo.visibility, `${label}.visibility`).toUpperCase(),
    defaultBranch: typeof branch.name === "string" ? branch.name : "",
  };
}

function workflowDispatchArgs(repository: SelectedRepository, options: FanoutOptions): string[] {
  if (options.mode !== "audit") {
    return [
      "api",
      `repos/${options.dispatchRepo}/dispatches`,
      "-f",
      "event_type=clawsweeper_target_sweep",
      "-f",
      `client_payload[target_repo]=${repository.targetRepo}`,
      "-f",
      `client_payload[target_branch]=${repository.defaultBranch || "main"}`,
      "-f",
      `client_payload[hot_intake]=${options.mode === "hot-intake" ? "true" : "false"}`,
      "-f",
      "client_payload[batch_size]=1",
      "-f",
      "client_payload[shard_count]=1",
    ];
  }
  const args = [
    "workflow",
    "run",
    options.workflow,
    "--repo",
    options.dispatchRepo,
    "--ref",
    options.ref,
    "-f",
    `target_repo=${repository.targetRepo}`,
  ];
  args.push("-f", "audit_dashboard=true");
  return args;
}

function readCursor(cursorPath: string): CursorState {
  if (!existsSync(cursorPath)) return { nextCursor: 0, afterRepository: null };
  const parsed = JSON.parse(readFileSync(cursorPath, "utf8")) as unknown;
  const cursor = record(parsed, "cursor");
  const nextCursor =
    typeof cursor.next_cursor === "number" && Number.isInteger(cursor.next_cursor)
      ? cursor.next_cursor
      : 0;
  const afterRepository =
    typeof cursor.after_repository === "string" &&
    /^[^/\s]+\/[^/\s]+$/.test(cursor.after_repository)
      ? cursor.after_repository.toLowerCase()
      : null;
  return { nextCursor, afterRepository };
}

function writeFileSyncWithDirs(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content);
}

function runGh(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const childEnv = { ...process.env, ...env, NO_COLOR: "1", CLICOLOR: "0" };
  const cwd = repoRoot();
  const command = resolveSpawnCommand("gh", args, { cwd, env: childEnv });
  return execFileSync(command.command, command.args, {
    cwd,
    encoding: "utf8",
    env: childEnv,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  }).trimEnd();
}

function inventoryEnv(owner: string): NodeJS.ProcessEnv | null {
  const key = `CLAWSWEEPER_INVENTORY_TOKEN_${owner.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  const token = process.env[key] || process.env.CLAWSWEEPER_INVENTORY_TOKEN;
  if (token === PUBLIC_INVENTORY_TOKEN) return publicInventoryEnv();
  if (token) return { GH_TOKEN: token, GITHUB_TOKEN: token };
  if (process.env.GITHUB_ACTIONS === "true") return null;
  return publicInventoryEnv();
}

function publicInventoryEnv(): NodeJS.ProcessEnv {
  const token =
    process.env.CLAWSWEEPER_PUBLIC_INVENTORY_TOKEN ||
    process.env.CLAWSWEEPER_DISPATCH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN;
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
}

function dispatchEnv(): NodeJS.ProcessEnv {
  const token =
    process.env.CLAWSWEEPER_DISPATCH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { GH_TOKEN: token } : {};
}

function fanoutMode(value: string): FanoutMode {
  if (value === "hot-intake" || value === "normal-review" || value === "audit") return value;
  throw new Error(`unsupported fanout mode: ${value}`);
}

export function defaultLimit(mode: FanoutMode): string {
  if (mode === "hot-intake") return "10";
  if (mode === "normal-review") return "6";
  return "12";
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${label} must be positive`);
  return parsed;
}

function positiveRunAttempt(): number {
  const raw = String(process.env.GITHUB_RUN_ATTEMPT ?? "").trim();
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("GITHUB_RUN_ATTEMPT must be a positive integer");
  }
  return value;
}

function githubRunId(): string {
  const value = String(process.env.GITHUB_RUN_ID ?? "").trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
    throw new Error("GITHUB_RUN_ID must be a bounded machine identifier");
  }
  return value;
}

function fanoutPartitionDate(): string {
  const value = String(process.env.GITHUB_RUN_STARTED_AT ?? "").trim();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("GITHUB_RUN_STARTED_AT must be a valid timestamp");
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

function cursorStart(repositories: readonly SelectedRepository[], cursor: CursorState): number {
  if (cursor.afterRepository) {
    return cursorAfterRepository(repositories, cursor.afterRepository);
  }
  return repositories.length === 0 ? 0 : normalizeCursor(cursor.nextCursor, repositories.length);
}

function cursorAfterRepository(
  repositories: readonly SelectedRepository[],
  repository: string,
): number {
  if (repositories.length === 0) return 0;
  const exact = repositories.findIndex((candidate) => candidate.targetRepo === repository);
  if (exact >= 0) return (exact + 1) % repositories.length;
  const successor = repositories.findIndex(
    (candidate) => candidate.targetRepo.localeCompare(repository) > 0,
  );
  return successor >= 0 ? successor : 0;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function normalizeCursor(cursor: number, length: number): number {
  return ((cursor % length) + length) % length;
}

function csvArg(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => stringValue(entry, `${label}[${index}]`));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} must be a non-empty string`);
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runTargetFanout(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
