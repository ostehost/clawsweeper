#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "../action-ledger.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import { parseArgs, parseJob } from "./lib.js";
import {
  flushRepairActionEvents,
  recordRepairLifecycleEvent,
  recordRepairLifecycleFailureSafely,
  repairHttpMutationOutcome,
  repairSourceRevision,
  runRepairMutationAsync,
  type RepairLifecycleInput,
} from "./repair-action-ledger.js";

export type ActionWorkKind = "issue_to_pr" | "pr_repair" | "repair_cluster";

export function actionWorkKind(frontmatter: LooseRecord): ActionWorkKind {
  if (
    frontmatter.job_intent === "implement_issue" ||
    frontmatter.source === "issue_implementation"
  ) {
    return "issue_to_pr";
  }
  if (
    frontmatter.job_intent === "automerge_pr" ||
    frontmatter.job_intent === "pr_repair" ||
    frontmatter.source === "pr_automerge" ||
    String(frontmatter.cluster_id ?? "").startsWith("automerge-") ||
    String(frontmatter.cluster_id ?? "").startsWith("repair-pr-")
  ) {
    return "pr_repair";
  }
  return "repair_cluster";
}

export function actionSourceUrl(job: ReturnType<typeof parseJob>): string {
  const explicit = job.raw.match(
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+/,
  )?.[0];
  if (explicit) return explicit;
  const repo = String(job.frontmatter.repo ?? "");
  const ref = [...(job.frontmatter.canonical ?? []), ...(job.frontmatter.candidates ?? [])][0];
  const number = String(ref ?? "").replace(/^#/, "");
  return repo && /^\d+$/.test(number) ? `https://github.com/${repo}/issues/${number}` : "";
}

export function actionWorkKey(frontmatter: LooseRecord): string {
  return `${String(frontmatter.repo ?? "")}:${String(frontmatter.cluster_id ?? "")}`;
}

export function actionSessionOwner(env: NodeJS.ProcessEnv = process.env): string {
  const owner = String(env.CLAWSWEEPER_CRABFLEET_OWNER ?? "").trim();
  if (!owner) throw new Error("action session requires a configured CrabFleet owner");
  return owner;
}

export function actionRunUrl(env: NodeJS.ProcessEnv = process.env): string {
  const server = String(env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const repository = String(env.GITHUB_REPOSITORY ?? "");
  const runId = String(env.GITHUB_RUN_ID ?? "");
  return repository && runId ? `${server}/${repository}/actions/runs/${runId}` : "";
}

export function actionSessionRemoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = String(env.CLAWSWEEPER_ACTION_SESSION_REMOTE ?? "").trim();
  if (explicit) return explicit === "1";
  return String(env.CLAWSWEEPER_STEERABLE_CODEX ?? "").trim() === "1";
}

export async function withActionSessionReceiptFinalization<T>(
  operation: () => Promise<T>,
  options: {
    flush?: () => Promise<unknown>;
    report?: (message: string) => void;
  } = {},
): Promise<T> {
  let result: T | undefined;
  let primaryError: unknown;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }

  try {
    await (options.flush ?? flushRepairActionEvents)();
  } catch (error) {
    if (!operationFailed) throw error;
    (options.report ?? console.error)(
      `[action-ledger] failed to finalize action session receipts after the primary failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (operationFailed) throw primaryError;
  return result as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === "register") {
    await registerActionSession(String(args._[1] ?? ""), {
      skipRepairReceipt: args["skip-repair-receipt"] === true,
    });
    return;
  }
  if (command === "update") {
    await updateActionSession({
      state: String(args.state ?? ""),
      phase: String(args.phase ?? ""),
      summary: String(args.summary ?? ""),
      completionReason: String(args["completion-reason"] ?? ""),
    });
    return;
  }
  throw new Error(
    "usage: action-session register <job.md> | update --state <state> --phase <phase> --summary <summary>",
  );
}

export async function registerActionSession(
  jobPath: string,
  options: { skipRepairReceipt?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  if (!jobPath) throw new Error("action-session register requires a job path");
  const job = parseJob(jobPath);
  const lifecycle = actionSessionLifecycle(job);
  await withActionSessionReceiptFinalization(async () => {
    try {
      const remoteEnabled = actionSessionRemoteEnabled();
      const sourceUrl = actionSourceUrl(job);
      const metadata: LooseRecord = {
        remoteEnabled,
        repository: lifecycle.repository,
        workKey: lifecycle.workKey,
        workKind: actionWorkKind(job.frontmatter),
        clusterId: lifecycle.clusterId,
        sourceRevision: lifecycle.sourceRevision,
        sourceUrl,
        runUrl: actionRunUrl(),
        registeredAt: new Date().toISOString(),
      };
      writeActionSessionMetadata(metadata);
      if (!options.skipRepairReceipt) {
        recordRepairLifecycleEvent(lifecycle, {
          type: ACTION_EVENT_TYPES.repairQueue,
          status: ACTION_EVENT_STATUSES.queued,
          reasonCode: ACTION_EVENT_REASON_CODES.accepted,
          mutation: false,
          component: "action_session",
          state: "queued",
          phase: "queue",
          workKind: actionWorkKind(job.frontmatter),
        });
      }

      if (remoteEnabled) {
        const fetchImpl = options.fetchImpl ?? fetch;
        const serviceToken = requiredEnv("CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN");
        const baseUrl = String(
          process.env.CLAWSWEEPER_CRABFLEET_URL ?? "https://crabfleet.openclaw.ai",
        ).replace(/\/+$/, "");
        const url = `${baseUrl}/api/openclaw/action-sessions`;
        const requestBody = {
          workKey: actionWorkKey(job.frontmatter),
          workKind: actionWorkKind(job.frontmatter),
          owner: actionSessionOwner(),
          repo: String(job.frontmatter.repo ?? ""),
          branch: String(job.frontmatter.target_branch ?? process.env.GITHUB_REF_NAME ?? ""),
          sourceUrl,
          runUrl: actionRunUrl(),
          purpose:
            actionWorkKind(job.frontmatter) === "issue_to_pr"
              ? "Convert issue to pull request"
              : actionWorkKind(job.frontmatter) === "pr_repair"
                ? "Repair pull request"
                : "Review and repair related GitHub items",
          summary: `GitHub Actions work for ${String(job.frontmatter.cluster_id ?? job.relativePath)}`,
        };
        const response = await runRepairMutationAsync(lifecycle, {
          kind: "crabfleet_session_register",
          identity: {
            url,
            workKey: actionWorkKey(job.frontmatter),
            workKind: actionWorkKind(job.frontmatter),
            repo: String(job.frontmatter.repo ?? ""),
          },
          component: "action_session",
          operationName: "session",
          operation: () =>
            fetchImpl(url, {
              method: "POST",
              headers: {
                authorization: `Bearer ${serviceToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(requestBody),
            }),
          outcome: repairHttpMutationOutcome,
        });
        const responseText = await response.text();
        let body: LooseRecord;
        try {
          body = JSON.parse(responseText) as LooseRecord;
        } catch {
          throw new Error(
            `CrabFleet action session registration returned invalid JSON (${response.status})`,
          );
        }
        if (!response.ok) {
          throw new Error(
            `CrabFleet action session registration failed (${response.status}): ${String(body.error ?? "unknown error")}`,
          );
        }
        const session = body.session as LooseRecord;
        const sessionId = String(session?.id ?? "");
        const agentToken = String(body.agentToken ?? "");
        const runnerPtyUrl = String(body.runnerPtyUrl ?? "");
        if (!sessionId || !agentToken || !runnerPtyUrl) {
          throw new Error("CrabFleet action session response is missing session credentials");
        }
        const workStateUrl =
          String(body.workStateUrl ?? "") ||
          `${baseUrl}/api/agent/interactive-sessions/${encodeURIComponent(sessionId)}/work-state`;
        const browserUrl =
          String(body.browserUrl ?? "") || `${baseUrl}/?session=${encodeURIComponent(sessionId)}`;
        console.log(`::add-mask::${agentToken}`);
        console.log(`::add-mask::${runnerPtyUrl}`);
        writeGitHubEnv({
          CLAWSWEEPER_CRABFLEET_SESSION_ID: sessionId,
          CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: agentToken,
          CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL: runnerPtyUrl,
          CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: workStateUrl,
          CLAWSWEEPER_CRABFLEET_BROWSER_URL: browserUrl,
        });
        Object.assign(metadata, { sessionId, browserUrl });
        writeActionSessionMetadata(metadata);
        recordRepairLifecycleEvent(lifecycle, {
          type: ACTION_EVENT_TYPES.sessionRegistered,
          status: ACTION_EVENT_STATUSES.registered,
          reasonCode: ACTION_EVENT_REASON_CODES.accepted,
          mutation: true,
          component: "action_session",
          operation: "session",
          state: "registered",
          workKind: actionWorkKind(job.frontmatter),
          idempotencySlot: "session_registration",
        });
        console.log(`CrabFleet action session: ${browserUrl}`);
      }
    } catch (error) {
      recordRepairLifecycleFailureSafely(lifecycle, {
        component: "action_session",
        operation: "session",
        phase: "register",
        workKind: actionWorkKind(job.frontmatter),
        error,
      });
      throw error;
    }
  });
}

export async function updateActionSession(
  {
    state,
    phase,
    summary,
    completionReason,
  }: {
    state: string;
    phase: string;
    summary: string;
    completionReason: string;
  },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const metadata = readActionSessionMetadata();
  const lifecycle = actionSessionLifecycleFromMetadata(metadata);
  await withActionSessionReceiptFinalization(async () => {
    try {
      recordRepairLifecycleEvent(lifecycle, {
        type: repairEventType(state, phase, completionReason),
        status: repairEventStatus(state),
        reasonCode: sessionEventReason(state),
        mutation: false,
        component: "action_session",
        state,
        phase,
        workKind: String(metadata.workKind ?? ""),
      });
      if (metadata.remoteEnabled === true) {
        const url = requiredEnv("CLAWSWEEPER_CRABFLEET_WORK_STATE_URL");
        const token = requiredEnv("CLAWSWEEPER_CRABFLEET_AGENT_TOKEN");
        const requestBody = {
          state,
          phase,
          summary,
          ...(completionReason ? { completionReason } : {}),
        };
        const response = await runRepairMutationAsync(lifecycle, {
          kind: "crabfleet_session_update",
          identity: {
            url,
            sessionId: String(metadata.sessionId ?? ""),
            request: requestBody,
          },
          component: "action_session",
          operationName: "session",
          operation: () =>
            (options.fetchImpl ?? fetch)(url, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(requestBody),
            }),
          outcome: repairHttpMutationOutcome,
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `CrabFleet work-state update failed (${response.status}): ${text.slice(0, 300)}`,
          );
        }
        recordRepairLifecycleEvent(lifecycle, {
          type: sessionEventType(state),
          status: sessionEventStatus(state),
          reasonCode: sessionEventReason(state),
          mutation: true,
          component: "action_session",
          operation: "session",
          state,
          phase,
          workKind: String(metadata.workKind ?? ""),
          idempotencySlot: `session_state:${state}:${phase}`,
        });
      }
    } catch (error) {
      recordRepairLifecycleFailureSafely(lifecycle, {
        component: "action_session",
        operation: "session",
        phase,
        workKind: String(metadata.workKind ?? ""),
        error,
      });
      throw error;
    }
  });
}

function actionSessionLifecycle(job: ReturnType<typeof parseJob>): RepairLifecycleInput {
  return {
    repository: String(job.frontmatter.repo ?? ""),
    workKey: actionWorkKey(job.frontmatter),
    clusterId: String(job.frontmatter.cluster_id ?? ""),
    sourceRevision: repairSourceRevision(job.frontmatter),
  };
}

function actionSessionLifecycleFromMetadata(metadata: LooseRecord): RepairLifecycleInput {
  return {
    repository: String(metadata.repository ?? ""),
    workKey: String(metadata.workKey ?? ""),
    clusterId: String(metadata.clusterId ?? ""),
    sourceRevision: String(metadata.sourceRevision ?? ""),
  };
}

function actionSessionMetadataPath(): string {
  return (
    process.env.CLAWSWEEPER_ACTION_SESSION_METADATA?.trim() ||
    path.join(".clawsweeper-repair", "action-session.json")
  );
}

function readActionSessionMetadata(): LooseRecord {
  return JSON.parse(fs.readFileSync(actionSessionMetadataPath(), "utf8")) as LooseRecord;
}

function writeActionSessionMetadata(metadata: LooseRecord): void {
  const metadataPath = actionSessionMetadataPath();
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

function sessionEventType(state: string) {
  const normalized = state.trim().toLowerCase();
  if (normalized === "completed") return ACTION_EVENT_TYPES.sessionCompleted;
  if (normalized === "blocked" || normalized === "failed") return ACTION_EVENT_TYPES.sessionBlocked;
  if (normalized === "cancelled") return ACTION_EVENT_TYPES.sessionCancelled;
  return ACTION_EVENT_TYPES.sessionPhaseChanged;
}

function sessionEventStatus(state: string) {
  const normalized = state.trim().toLowerCase();
  if (normalized === "completed") return ACTION_EVENT_STATUSES.completed;
  if (normalized === "blocked" || normalized === "failed") return ACTION_EVENT_STATUSES.blocked;
  if (normalized === "cancelled") return ACTION_EVENT_STATUSES.cancelled;
  return ACTION_EVENT_STATUSES.inProgress;
}

function sessionEventReason(state: string) {
  const normalized = state.trim().toLowerCase();
  if (normalized === "completed") return ACTION_EVENT_REASON_CODES.completed;
  if (normalized === "blocked" || normalized === "failed")
    return ACTION_EVENT_REASON_CODES.workflowFailed;
  if (normalized === "cancelled") return ACTION_EVENT_REASON_CODES.cancelled;
  return ACTION_EVENT_REASON_CODES.stateChanged;
}

function repairEventType(state: string, phase: string, completionReason: string) {
  const normalizedState = state.trim().toLowerCase();
  const normalizedPhase = phase.trim().toLowerCase();
  if (normalizedState === "blocked" || normalizedState === "failed")
    return ACTION_EVENT_TYPES.repairFailed;
  if (normalizedPhase.includes("post_flight")) return ACTION_EVENT_TYPES.repairPostflight;
  if (normalizedPhase.includes("plan") || completionReason === "plan_complete")
    return ACTION_EVENT_TYPES.repairPlan;
  if (normalizedPhase === "done") return ACTION_EVENT_TYPES.repairPublish;
  return ACTION_EVENT_TYPES.repairQueue;
}

function repairEventStatus(state: string) {
  const normalized = state.trim().toLowerCase();
  if (normalized === "completed") return ACTION_EVENT_STATUSES.completed;
  if (normalized === "blocked" || normalized === "failed") return ACTION_EVENT_STATUSES.failed;
  if (normalized === "cancelled") return ACTION_EVENT_STATUSES.cancelled;
  return ACTION_EVENT_STATUSES.inProgress;
}

function writeGitHubEnv(values: Record<string, string>): void {
  const envPath = requiredEnv("GITHUB_ENV");
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${key} contains a newline`);
    fs.appendFileSync(envPath, `${key}=${value}\n`, "utf8");
  }
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: JsonValue) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
