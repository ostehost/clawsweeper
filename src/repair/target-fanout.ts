#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
  type ActionEventSubject,
} from "../action-ledger.js";
import { flushWorkflowActionEvents, recordWorkflowPhaseEvent } from "../action-ledger-runtime.js";
import { resolveCommand } from "../command.js";
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
  operationIdentity: {
    repository: string;
    mode: FanoutMode;
    limit: number;
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
  uncertainCompletionReason: "dispatch_outcome_unknown" | "mutation_outcome_unknown" | null;
  terminal: boolean;
}

const DEFAULT_CURSOR_DIR = join(repoRoot(), "results", "target-fanout-cursors");
const PUBLIC_INVENTORY_TOKEN = "__public__";

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
    const selection = selectRepositories(repositories, {
      limit: options.limit,
      cursor: readCursor(options.cursorPath),
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
    const selection = selectRepositories(repositories, {
      limit: options.limit,
      cursor: readCursor(options.cursorPath),
    });
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
        recordFanoutDispatch(ledger, repository, options, () => runGh(commandArgs, dispatchEnv()));
      }
      dispatched.push(repository.targetRepo);
    }

    if (!options.dryRun) {
      recordFanoutCursorPublication(ledger, options, selection.cursor);
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
    uncertainCompletionReason: null,
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
): void {
  const request = fanoutDispatchRequestIdentity(repository, options);
  const idempotencyIdentity = {
    operationIdentity: ledger.operationIdentity,
    slot: "fanout_dispatch",
    request,
  };
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
    const failed = recordWorkflowPhaseEvent(repoRoot(), {
      phase: ACTION_EVENT_TYPES.dispatchLifecycle,
      status: ACTION_EVENT_STATUSES.failed,
      reasonCode: ACTION_EVENT_REASON_CODES.unavailable,
      retryable: false,
      mutation: true,
      identity: {
        slot: "fanout_dispatch_outcome",
        targetRepo: repository.targetRepo,
        outcome: "failed",
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
        completion_reason: "dispatch_outcome_unknown",
        dispatch_kind: fanoutDispatchKind(options.mode),
        failed_count: 1,
        work_kind: options.mode,
      },
      privacy: fanoutActionLedgerPrivacy(),
    });
    ledger.lastEventId = failed?.event_id ?? ledger.lastEventId;
    ledger.mutationObserved = true;
    ledger.uncertainMutationObserved = true;
    ledger.uncertainCompletionReason = "dispatch_outcome_unknown";
    throw error;
  }
  const completed = recordWorkflowPhaseEvent(repoRoot(), {
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
  ledger.lastEventId = completed?.event_id ?? ledger.lastEventId;
  ledger.dispatchedCount += 1;
  ledger.mutationObserved = true;
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
): void {
  const content = cursorContent(cursor);
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
    ledger.uncertainCompletionReason = "mutation_outcome_unknown";
    throw error;
  }
  const completed = recordWorkflowPhaseEvent(repoRoot(), {
    phase: ACTION_EVENT_TYPES.publicationLifecycle,
    status: ACTION_EVENT_STATUSES.published,
    reasonCode: ACTION_EVENT_REASON_CODES.published,
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
      publication_kind: "target_fanout_cursor",
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
    retryable: failed && !ledger.mutationObserved && !ledger.uncertainMutationObserved,
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
        ? (ledger.uncertainCompletionReason ?? "failed")
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

function cursorContent(cursor: number): string {
  return `${JSON.stringify({ next_cursor: cursor }, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function readCursor(cursorPath: string): number {
  if (!existsSync(cursorPath)) return 0;
  const parsed = JSON.parse(readFileSync(cursorPath, "utf8")) as unknown;
  const cursor = record(parsed, "cursor");
  return typeof cursor.next_cursor === "number" && Number.isInteger(cursor.next_cursor)
    ? cursor.next_cursor
    : 0;
}

function writeFileSyncWithDirs(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content);
}

function runGh(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const childEnv = { ...process.env, ...env, NO_COLOR: "1", CLICOLOR: "0" };
  const command = resolveCommand("gh", args, childEnv);
  return execFileSync(command.command, command.args, {
    encoding: "utf8",
    env: childEnv,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
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
