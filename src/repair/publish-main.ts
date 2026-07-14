#!/usr/bin/env node
import path from "node:path";

import { workflowActionEventsEnabled } from "../action-ledger-runtime.js";
import { publishMainCommit, type GitPublishOptions, type RebaseStrategy } from "./git-publish.js";
import { repairPublicationContentDigest, runRepairMutation } from "./repair-action-ledger.js";

type Args = {
  message: string;
  paths: string[];
  restorePaths: string[];
  maxAttempts?: number;
  pushAttempts?: number;
  rebaseStrategy?: RebaseStrategy;
  receiptKind?: string;
  bestEffortRefresh: boolean;
};

const args = parseArgs(process.argv.slice(2));
assertPublicationReceipt(args.paths, args.receiptKind);
assertPublicationActionLedgerEnabled(args.receiptKind);
const publishOptions: GitPublishOptions = {
  message: args.message,
  paths: args.paths,
  restorePaths: args.restorePaths,
  maxAttempts: args.maxAttempts,
  pushAttempts: args.pushAttempts,
  rebaseStrategy: args.rebaseStrategy,
  refreshFailureMode: args.bestEffortRefresh ? "best-effort" : "strict",
};
if (args.receiptKind) {
  const repository = String(process.env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper");
  const publicationContentSha256 = repairPublicationContentDigest(args.paths);
  runRepairMutation(
    {
      repository,
      workKey: `state-publication:${args.receiptKind}:${publicationContentSha256}`,
      sourceRevision: String(process.env.GITHUB_SHA ?? ""),
      recordPath: args.paths[0] ?? null,
      subjectKind: "workflow",
    },
    {
      kind: args.receiptKind,
      operationName: "state_publication",
      component: "publish_main",
      identity: {
        message: args.message,
        paths: [...args.paths].sort(),
        restorePaths: [...args.restorePaths].sort(),
        rebaseStrategy: args.rebaseStrategy ?? "normal",
        refreshFailureMode: publishOptions.refreshFailureMode,
        publicationContentSha256,
      },
      operation: () => publishMainCommit(publishOptions),
      outcome: (result) => (result === "committed" ? "accepted" : "rejected"),
    },
  );
} else {
  publishMainCommit(publishOptions);
}

function parseArgs(argv: readonly string[]): Args {
  const parsed: Args = { message: "", paths: [], restorePaths: [], bestEffortRefresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--message") parsed.message = requiredValue(argv, ++index, arg);
    else if (arg === "--path") parsed.paths.push(requiredValue(argv, ++index, arg));
    else if (arg === "--restore") parsed.restorePaths.push(requiredValue(argv, ++index, arg));
    else if (arg === "--max-attempts")
      parsed.maxAttempts = parsePositiveInt(requiredValue(argv, ++index, arg), arg);
    else if (arg === "--push-attempts")
      parsed.pushAttempts = parsePositiveInt(requiredValue(argv, ++index, arg), arg);
    else if (arg === "--rebase-strategy")
      parsed.rebaseStrategy = parseRebaseStrategy(requiredValue(argv, ++index, arg));
    else if (arg === "--receipt-kind")
      parsed.receiptKind = parseReceiptKind(requiredValue(argv, ++index, arg));
    else if (arg === "--best-effort-refresh") parsed.bestEffortRefresh = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.message) throw new Error("--message is required");
  if (parsed.paths.length === 0) throw new Error("At least one --path is required");
  return parsed;
}

function parseReceiptKind(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("--receipt-kind must be a bounded machine identifier");
  }
  return value;
}

function assertPublicationReceipt(paths: readonly string[], receiptKind?: string): void {
  if (receiptKind) return;
  const ledgerPaths = paths.filter(isImmutableLedgerPath);
  if (ledgerPaths.length === paths.length) return;
  if (ledgerPaths.length > 0) {
    throw new Error(
      "--receipt-kind is required when publishing a mixed ledger/non-ledger path set",
    );
  }
  throw new Error(
    "--receipt-kind is required for mutable state publication; only immutable ledger/ paths may be published without one",
  );
}

function assertPublicationActionLedgerEnabled(receiptKind?: string): void {
  if (!receiptKind) return;
  if (
    !workflowActionEventsEnabled(process.env) ||
    !String(process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT ?? "").trim() ||
    !String(process.env.GITHUB_RUN_STARTED_AT ?? "").trim()
  ) {
    throw new Error("mutable state publication requires successful action-ledger setup");
  }
}

function isImmutableLedgerPath(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === "ledger" || normalized.startsWith("ledger/");
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseRebaseStrategy(value: string): RebaseStrategy {
  if (
    value === "normal" ||
    value === "theirs" ||
    value === "apply-records" ||
    value === "reconcile-records" ||
    value === "comment-router-ledger"
  )
    return value;
  throw new Error(
    "--rebase-strategy must be normal, theirs, apply-records, reconcile-records, or comment-router-ledger",
  );
}
