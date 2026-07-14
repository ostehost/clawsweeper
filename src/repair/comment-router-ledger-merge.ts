import { Buffer } from "node:buffer";

import {
  COMMENT_ROUTER_LEDGER_COMMAND_LIMIT,
  isProtectedCommentRouterLedgerCommand,
} from "./comment-router-ledger-policy.js";

const LEDGER_PATH = "results/comment-router.json";
const LEDGER_HARD_COMMAND_LIMIT = 10_000;
const LEDGER_MAX_BYTES = 8 * 1024 * 1024;
const COMMAND_STATUSES = new Set(["claimed", "executed", "skipped", "waiting"]);
const MERGE_RECEIPT_STATUSES = new Set(["attempted", "accepted", "unknown", "rejected"]);
const UNRESOLVED_MERGE_RECEIPT_STATUSES = new Set(["attempted", "accepted", "unknown"]);

type JsonObject = Record<string, unknown>;

type ParsedLedger = {
  updatedAt: string | null;
  commands: Map<string, JsonObject>;
};

export type CommentRouterLedgerMerge = {
  baseText: string | null;
  localText: string | null;
  remoteText: string | null;
  path?: string;
};

export function mergeCommentRouterLedgerJson(options: CommentRouterLedgerMerge): string {
  const path = options.path ?? LEDGER_PATH;
  if (path !== LEDGER_PATH) {
    throw new Error(`Unsupported comment router ledger merge path: ${path}`);
  }
  const base = parseLedger(options.baseText, `${path} base`);
  const local = parseLedger(options.localText, `${path} local`);
  const remote = parseLedger(options.remoteText, `${path} remote`);
  const keys = new Set([
    ...base.commands.keys(),
    ...local.commands.keys(),
    ...remote.commands.keys(),
  ]);
  if (keys.size > LEDGER_HARD_COMMAND_LIMIT * 3) {
    throw new Error(`${path} merge exceeds the bounded command-key limit`);
  }

  const merged = new Map<string, JsonObject>();
  for (const key of keys) {
    const selected = mergeCommand(
      key,
      base.commands.get(key),
      local.commands.get(key),
      remote.commands.get(key),
    );
    if (selected) merged.set(key, selected);
  }

  const ordered = [...merged]
    .sort(([leftKey, left], [rightKey, right]) => {
      const time = commandTime(left) - commandTime(right);
      return time || leftKey.localeCompare(rightKey);
    })
    .map(([, command]) => command);
  const protectedCommands = ordered.filter(isProtectedCommentRouterLedgerCommand);
  if (protectedCommands.length > COMMENT_ROUTER_LEDGER_COMMAND_LIMIT) {
    throw new Error(`${path} has too many protected mutation receipts to publish safely`);
  }
  const protectedKeys = new Set(protectedCommands.map(ledgerEntryKey));
  const ordinaryBudget = Math.max(
    0,
    COMMENT_ROUTER_LEDGER_COMMAND_LIMIT - protectedCommands.length,
  );
  const ordinary = ordered.filter((command) => !protectedKeys.has(ledgerEntryKey(command)));
  const retainedOrdinary = ordinaryBudget > 0 ? ordinary.slice(-ordinaryBudget) : [];
  const retainedKeys = new Set([...protectedKeys, ...retainedOrdinary.map(ledgerEntryKey)]);
  const commands = ordered.filter((command) => retainedKeys.has(ledgerEntryKey(command)));
  const updatedAt = latestTimestamp([
    base.updatedAt,
    local.updatedAt,
    remote.updatedAt,
    ...commands.map((command) => requiredString(command.processed_at, "processed_at")),
  ]);
  const content = `${JSON.stringify({ updated_at: updatedAt, commands }, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > LEDGER_MAX_BYTES) {
    throw new Error(`${path} merged ledger exceeds the bounded byte limit`);
  }
  return content;
}

function parseLedger(text: string | null, label: string): ParsedLedger {
  if (text === null) return { updatedAt: null, commands: new Map() };
  if (Buffer.byteLength(text, "utf8") > LEDGER_MAX_BYTES) {
    throw new Error(`${label} exceeds the bounded byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${label}`, { cause: error });
  }
  if (!isObject(value) || !Array.isArray(value.commands)) {
    throw new Error(`${label} must be an object with a commands array`);
  }
  if (value.commands.length > LEDGER_HARD_COMMAND_LIMIT) {
    throw new Error(`${label} exceeds the bounded command limit`);
  }
  const updatedAt = optionalTimestamp(value.updated_at, `${label} updated_at`);
  const commands = new Map<string, JsonObject>();
  for (const [index, command] of value.commands.entries()) {
    const validated = validateCommand(command, `${label} command ${index}`);
    const key = ledgerEntryKey(validated);
    if (commands.has(key)) throw new Error(`${label} contains duplicate command key ${key}`);
    commands.set(key, validated);
  }
  return { updatedAt, commands };
}

function validateCommand(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  if (!COMMAND_STATUSES.has(String(value.status ?? ""))) {
    throw new Error(`${label} has an invalid status`);
  }
  requiredTimestamp(value.processed_at, `${label} processed_at`);
  optionalNonEmptyString(value.idempotency_key, `${label} idempotency_key`);
  optionalNonEmptyString(value.comment_id, `${label} comment_id`);
  optionalNonEmptyString(value.comment_version_key, `${label} comment_version_key`);
  optionalNonEmptyString(value.comment_updated_at, `${label} comment_updated_at`);
  optionalNonEmptyString(value.repo, `${label} repo`);
  optionalNonEmptyString(value.intent, `${label} intent`);
  validateForcedReplay(value, label);
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions) || value.actions.some((action) => !isObject(action))) {
      throw new Error(`${label} actions must be an array of objects`);
    }
    for (const action of value.actions as JsonObject[]) validateAction(action, label);
    const receiptCount = (value.actions as JsonObject[]).filter(
      (action) => action.action === "merge" && action.merge_mutation_status !== undefined,
    ).length;
    if (receiptCount > 1) throw new Error(`${label} has multiple merge mutation receipts`);
  }
  // Computing the key is part of validation: ambiguous "unknown:unknown"
  // entries are not safe to union across independent workflow runs.
  ledgerEntryKey(value);
  return value;
}

function validateAction(action: JsonObject, label: string): void {
  for (const field of [
    "action",
    "status",
    "label",
    "job_path",
    "merged_at",
    "merge_commit_sha",
    "prepared_head_sha",
    "confirmation_status",
    "live_rest_state",
    "live_graphql_state",
    "dispatch_repo",
    "dispatch_workflow",
    "dispatch_event",
    "dispatch_title",
    "dispatch_mode",
    "dispatch_runner",
    "dispatch_execution_runner",
    "dispatch_model",
  ] as const) {
    const value = action[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(`${label} action ${field} must be a string or null`);
    }
  }
  if (action.merge_mutation_status === undefined) return;
  if (
    action.action !== "merge" ||
    !MERGE_RECEIPT_STATUSES.has(String(action.merge_mutation_status))
  ) {
    throw new Error(`${label} has an invalid merge mutation receipt`);
  }
}

function validateForcedReplay(command: JsonObject, label: string): void {
  const hasAttempt = command.attempt_id !== undefined && command.attempt_id !== null;
  const forced = command.forced_replay;
  if (!hasAttempt && (forced === undefined || forced === null || forced === false)) return;
  const attempt = typeof command.attempt_id === "string" ? command.attempt_id.trim() : "";
  if (
    forced !== true ||
    !attempt ||
    attempt.length > 128 ||
    /\s/.test(attempt) ||
    attempt.includes("\0")
  ) {
    throw new Error(`${label} has an invalid forced replay identity`);
  }
}

function mergeCommand(
  key: string,
  baseValue: JsonObject | undefined,
  localValue: JsonObject | undefined,
  remoteValue: JsonObject | undefined,
): JsonObject | undefined {
  assertCompatibleIdentity(key, [baseValue, localValue, remoteValue]);

  // Compaction/deletion is never evidence that an unresolved mutation became
  // safe to replay. Treat a missing descendant as the base barrier.
  const local =
    baseValue && isProtectedCommentRouterLedgerCommand(baseValue) && !localValue
      ? baseValue
      : localValue;
  const remote =
    baseValue && isProtectedCommentRouterLedgerCommand(baseValue) && !remoteValue
      ? baseValue
      : remoteValue;
  let selected: JsonObject | undefined;
  if (sameValue(local, remote)) selected = local;
  else if (sameValue(local, baseValue)) selected = remote;
  else if (sameValue(remote, baseValue)) selected = local;
  else if (!local) selected = remote;
  else if (!remote) selected = local;
  else selected = chooseConcurrentCommand(local, remote);

  const barriers = uniqueCommands([baseValue, local, remote].filter(isUnresolvedMergeBarrier));
  if (barriers.length === 0 || (selected && isUnresolvedMergeBarrier(selected))) {
    return selected && isUnresolvedMergeBarrier(selected)
      ? strongestUnresolvedBarrier([selected, ...barriers])
      : selected;
  }
  if (selected && isCausallyNewerResolution(selected, baseValue, local, remote)) {
    return selected;
  }
  return strongestUnresolvedBarrier(barriers);
}

function assertCompatibleIdentity(key: string, values: readonly (JsonObject | undefined)[]): void {
  const commands = values.filter((value): value is JsonObject => Boolean(value));
  const identities = new Set(
    commands.map((value) =>
      stableJson({
        idempotency_key: value.idempotency_key ?? null,
        comment_id: value.comment_id ?? null,
        comment_version_key: value.comment_version_key ?? null,
        comment_updated_at: value.comment_updated_at ?? null,
        repo: value.repo ?? null,
        issue_number: value.issue_number ?? null,
        intent: value.intent ?? null,
        forced_replay: value.forced_replay ?? null,
        attempt_id: value.attempt_id ?? null,
      }),
    ),
  );
  if (identities.size > 1) {
    throw new Error(`Comment router ledger key ${key} has conflicting command identities`);
  }
  const heads = new Set(
    commands.flatMap((command) => {
      const expectedHead = normalizedHash(command.expected_head_sha);
      if (expectedHead) return [expectedHead];
      if (!mergeReceiptStatus(command)) return [];
      const target = isObject(command.target) ? command.target : {};
      const fallbackHead = normalizedHash(target.head_sha);
      return fallbackHead ? [fallbackHead] : [];
    }),
  );
  if (heads.size > 1) {
    throw new Error(`Comment router ledger key ${key} has conflicting expected head SHAs`);
  }
  const bodies = new Set(
    commands
      .map((command) => normalizedHash(command.comment_body_sha256))
      .filter((value): value is string => Boolean(value)),
  );
  if (bodies.size > 1) {
    throw new Error(`Comment router ledger key ${key} has conflicting comment body digests`);
  }
}

function chooseConcurrentCommand(left: JsonObject, right: JsonObject): JsonObject {
  const rank = commandRank(left) - commandRank(right);
  if (rank !== 0) return rank > 0 ? left : right;
  const time = commandTime(left) - commandTime(right);
  if (time !== 0) return time > 0 ? left : right;
  return stableJson(left).localeCompare(stableJson(right)) >= 0 ? left : right;
}

function commandRank(command: JsonObject): number {
  const receiptRanks: Record<string, number> = {
    attempted: 1,
    unknown: 2,
    rejected: 3,
    accepted: 4,
  };
  const statusRanks: Record<string, number> = { claimed: 0, waiting: 1, skipped: 2, executed: 3 };
  return (
    (statusRanks[String(command.status)] ?? 0) * 10 +
    (receiptRanks[mergeReceiptStatus(command) ?? ""] ?? 0)
  );
}

function isCausallyNewerResolution(
  resolution: JsonObject,
  base: JsonObject | undefined,
  local: JsonObject | undefined,
  remote: JsonObject | undefined,
): boolean {
  if (!base || !isUnresolvedMergeBarrier(base)) return false;
  if (!isDefiniteResolutionOf(resolution, base)) return false;
  return (
    (sameValue(resolution, local) && sameValue(remote, base)) ||
    (sameValue(resolution, remote) && sameValue(local, base)) ||
    Boolean(
      local &&
      remote &&
      isDefiniteResolutionOf(local, base) &&
      isDefiniteResolutionOf(remote, base),
    )
  );
}

function isDefiniteResolutionOf(command: JsonObject, barrier: JsonObject): boolean {
  if (command.status !== "executed") return false;
  const mergeAction = (Array.isArray(command.actions) ? command.actions : []).find(
    (action): action is JsonObject => isObject(action) && action.action === "merge",
  );
  if (!mergeAction) return false;
  const commandReceipt = mergeReceiptStatus(command);
  const barrierReceipt = mergeReceiptStatus(barrier);
  if (
    barrierReceipt === "attempted" &&
    commandReceipt === "rejected" &&
    ["blocked", "repair_needed"].includes(String(mergeAction.status ?? ""))
  ) {
    return true;
  }
  if (isConfirmedUnmergedResolution(mergeAction, barrierReceipt, commandReceipt)) return true;
  if (!hasConfirmedMergeIdentity(command, barrier, mergeAction)) return false;
  if (
    commandReceipt === "accepted" &&
    mergeAction.status === "executed" &&
    (barrierReceipt === "attempted" || barrierReceipt === "accepted")
  ) {
    return true;
  }
  return (
    (commandReceipt === "attempted" || commandReceipt === "unknown") &&
    mergeAction.status === "skipped" &&
    (barrierReceipt === "attempted" || barrierReceipt === "unknown")
  );
}

function isConfirmedUnmergedResolution(
  action: JsonObject,
  barrierReceipt: string | null,
  commandReceipt: string | null,
): boolean {
  if (
    action.status !== "skipped" ||
    action.confirmation_status !== "confirmed_unmerged" ||
    action.live_rest_state !== "closed" ||
    action.live_graphql_state !== "CLOSED"
  ) {
    return false;
  }
  if (barrierReceipt === "attempted") {
    return ["attempted", "accepted", "unknown"].includes(String(commandReceipt ?? ""));
  }
  return Boolean(barrierReceipt && commandReceipt === barrierReceipt);
}

function hasConfirmedMergeIdentity(
  command: JsonObject,
  barrier: JsonObject,
  action: JsonObject,
): boolean {
  const expectedHead =
    normalizedHash(barrier.expected_head_sha) ?? normalizedHash(command.expected_head_sha);
  const preparedHead = normalizedHash(action.prepared_head_sha);
  const mergeCommit = normalizedHash(action.merge_commit_sha);
  const mergedAt = String(action.merged_at ?? "");
  return Boolean(
    expectedHead &&
    /^[0-9a-f]{40}$/.test(expectedHead) &&
    preparedHead === expectedHead &&
    mergeCommit &&
    /^[0-9a-f]{40}$/.test(mergeCommit) &&
    Number.isFinite(Date.parse(mergedAt)),
  );
}

function strongestUnresolvedBarrier(commands: readonly JsonObject[]): JsonObject {
  const ranks: Record<string, number> = { attempted: 1, unknown: 2, accepted: 3 };
  return commands.reduce((winner, command) => {
    const rank =
      (ranks[mergeReceiptStatus(command) ?? ""] ?? 0) -
      (ranks[mergeReceiptStatus(winner) ?? ""] ?? 0);
    if (rank !== 0) return rank > 0 ? command : winner;
    return chooseConcurrentCommand(winner, command);
  });
}

function isUnresolvedMergeBarrier(command: unknown): command is JsonObject {
  if (!isObject(command) || command.status !== "waiting") return false;
  return (Array.isArray(command.actions) ? command.actions : []).some(
    (action) =>
      isObject(action) &&
      action.action === "merge" &&
      action.status === "waiting" &&
      UNRESOLVED_MERGE_RECEIPT_STATUSES.has(String(action.merge_mutation_status ?? "")),
  );
}

function mergeReceiptStatus(command: JsonObject): string | null {
  for (const action of Array.isArray(command.actions) ? command.actions : []) {
    if (
      isObject(action) &&
      action.action === "merge" &&
      MERGE_RECEIPT_STATUSES.has(String(action.merge_mutation_status ?? ""))
    ) {
      return String(action.merge_mutation_status);
    }
  }
  return null;
}

function ledgerEntryKey(command: JsonObject): string {
  const version = optionalString(command.comment_version_key);
  const idempotency = optionalString(command.idempotency_key);
  let ordinary: string;
  if (!version && command.automation_source === "repair_loop_label_sweep" && idempotency) {
    ordinary = `idempotency:${idempotency}`;
  } else if (version) {
    ordinary = version;
  } else {
    const commentId = optionalString(command.comment_id);
    const updatedAt = optionalString(command.comment_updated_at);
    if (!commentId || !updatedAt) {
      throw new Error("Comment router ledger command lacks a durable command key");
    }
    ordinary = `${commentId}:${updatedAt}`;
  }
  const attempt = command.forced_replay === true ? optionalString(command.attempt_id) : null;
  return attempt ? `forced-replay:${JSON.stringify([ordinary, attempt])}` : ordinary;
}

function uniqueCommands(commands: readonly JsonObject[]): JsonObject[] {
  return [...new Map(commands.map((command) => [stableJson(command), command])).values()];
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function latestTimestamp(values: readonly (string | null)[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!latest || Date.parse(value) > Date.parse(latest)) latest = value;
  }
  return latest;
}

function commandTime(command: JsonObject): number {
  return Date.parse(requiredString(command.processed_at, "processed_at"));
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredTimestamp(value, label);
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error(`${label} must be a valid timestamp`);
  return timestamp;
}

function optionalNonEmptyString(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  requiredString(value, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizedHash(value: unknown): string | null {
  const hash = optionalString(value);
  return hash ? hash.toLowerCase() : null;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
