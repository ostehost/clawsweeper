#!/usr/bin/env node
import type { JsonValue, LooseRecord } from "./json-types.js";
import fs from "node:fs";
import path from "node:path";
import { ghRetryKind, ghRetryWaitMs } from "../github-retry.js";
import { DEFAULT_TARGET_REPO } from "./constants.js";
import { ghErrorText, ghJsonWithRetry, ghText } from "./github-cli.js";
import { parseArgs, repoRoot } from "./lib.js";
import {
  runRepairMutation,
  type RepairLifecycleInput,
  type RepairMutationOptions,
} from "./repair-action-ledger.js";
import { replacementSourceLabelCopyable } from "./replacement-labels.js";
import { sleepMs } from "./timing.js";

const DEFAULT_HEAD_PREFIX = "clawsweeper/";

const args = parseArgs(process.argv.slice(2));
const repo = String(args.repo ?? process.env.CLAWSWEEPER_TARGET_REPO ?? DEFAULT_TARGET_REPO);
const headPrefix = String(args["head-prefix"] ?? DEFAULT_HEAD_PREFIX);
const execute = Boolean(args.execute);
const limit = Number(args.limit ?? 200);
const reportPath = path.resolve(
  String(args.report ?? path.join(repoRoot(), ".artifacts", "replacement-label-cleanup.json")),
);

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  throw new Error(`repo must be owner/repo, got ${repo}`);
}
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
  throw new Error("--limit must be an integer from 1 through 1000");
}
if (execute && process.env.CLAWSWEEPER_ALLOW_EXECUTE !== "1") {
  throw new Error("refusing to remove labels: CLAWSWEEPER_ALLOW_EXECUTE must be 1");
}

const pulls = listOpenReplacementPullRequests();
const rows = pulls.map(classifyPullRequest);
if (execute) {
  for (const row of rows) {
    removeLabels(row);
  }
}

const report = {
  status: execute ? "applied" : "dry_run",
  repo,
  head_prefix: headPrefix,
  generated_at: new Date().toISOString(),
  execute,
  totals: {
    open_replacement_prs: rows.length,
    prs_with_denied_source_labels: rows.filter((row) => row.denied_source_labels.length > 0).length,
    prs_with_lifecycle_cleanup: rows.filter((row) => row.lifecycle_cleanup_labels.length > 0)
      .length,
    labels_removed: rows.reduce((sum, row) => sum + row.removed_labels.length, 0),
    remove_failures: rows.reduce((sum, row) => sum + row.remove_failures.length, 0),
  },
  prs: rows,
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

function listOpenReplacementPullRequests(): LooseRecord[] {
  const fields = ["number", "title", "url", "author", "headRefName", "labels"].join(",");
  const pulls = ghJsonWithRetry<JsonValue[]>([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    fields,
  ]);
  return pulls.filter(
    (pull) =>
      isRecord(pull) &&
      String(pull.headRefName ?? "").startsWith(headPrefix) &&
      String((pull.author as LooseRecord | undefined)?.login ?? "") === "app/clawsweeper",
  ) as LooseRecord[];
}

function classifyPullRequest(pull: LooseRecord) {
  const labels = labelNames(pull.labels);
  const denied = labels.filter((label) => !replacementSourceLabelCopyable(label));
  return {
    number: Number(pull.number),
    url: String(pull.url ?? ""),
    title: String(pull.title ?? ""),
    head_ref: String(pull.headRefName ?? ""),
    labels,
    denied_source_labels: denied,
    lifecycle_cleanup_labels: denied.filter(isLifecycleCleanupLabel),
    removed_labels: [] as string[],
    remove_failures: [] as LooseRecord[],
  };
}

function removeLabels(row: ReturnType<typeof classifyPullRequest>) {
  for (const label of row.lifecycle_cleanup_labels) {
    try {
      runLabelMutationWithRetry(
        replacementLabelLifecycle(row, label),
        {
          kind: "pull_request_label_remove",
          identity: {
            repository: repo,
            number: row.number,
            label,
            headRef: row.head_ref,
          },
          component: "cleanup_replacement_labels",
        },
        ["pr", "edit", String(row.number), "--repo", repo, "--remove-label", label],
      );
      row.removed_labels.push(label);
    } catch (error) {
      row.remove_failures.push({
        label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) =>
      isRecord(label) ? String(label.name ?? "").trim() : String(label ?? "").trim(),
    )
    .filter(Boolean);
}

function isLifecycleCleanupLabel(label: string): boolean {
  const key = label.trim().toLowerCase();
  return key === "stale" || key.startsWith("close:");
}

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function replacementLabelLifecycle(
  row: ReturnType<typeof classifyPullRequest>,
  label: string,
): RepairLifecycleInput {
  return {
    repository: repo,
    workKey: `label-housekeeping:replacement:${repo}#${row.number}:${label}`,
    number: row.number,
    subjectKind: "pull_request",
  };
}

function runLabelMutationWithRetry(
  lifecycle: RepairLifecycleInput,
  options: Omit<RepairMutationOptions<string>, "operation" | "knownNoMutation">,
  ghArgs: string[],
): string {
  const attempts = githubMutationRetryAttempts();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runRepairMutation(lifecycle, {
        ...options,
        knownNoMutation: githubMutationRejectedBeforeWrite,
        operation: () => ghText(ghArgs),
      });
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      if (attempt >= attempts || retryKind === "none" || githubMutationRejectedBeforeWrite(error)) {
        throw error;
      }
      sleepMs(ghRetryWaitMs(retryKind, attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function githubMutationRetryAttempts(): number {
  const configured = process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
  if (configured == null || configured.trim() === "") return 6;
  const attempts = Number(configured);
  return Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 6;
}

function githubMutationRejectedBeforeWrite(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code ?? "")
      : "";
  if (code === "ENOENT" || code === "EACCES") return true;
  return /\b(?:HTTP|status(?: code)?)\s*:?\s*(?:400|401|403|404|405|406|407|410|411|413|414|415|416|417|421|422|426|428|431|451)\b/i.test(
    ghErrorText(error),
  );
}
