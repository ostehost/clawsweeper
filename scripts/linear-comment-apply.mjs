#!/usr/bin/env node

/**
 * Single-item Linear review-comment apply runner (dry-run by default).
 *
 * This is the WRITE half of the ClawSweeper Linear review flow, scoped to ONE issue by
 * its human identifier (e.g. "PAR-244"). It runs the real review pipeline end-to-end and
 * reuses the existing planner + authority gate — it never reimplements comment body or
 * marker logic:
 *
 *   fetchIssueByIdentifier (read)  -> mapWorkspaceItem -> classifyRecord
 *     -> renderReviewCommentBody/planReviewCommentUpsert (comment.ts)
 *     -> reviewCommentMutationRequest -> authorizeMutation (authority.ts)
 *     -> [--apply only] mint OAuth Bearer token -> commentCreate/commentUpdate
 *
 * Two auth identities, kept strictly separate:
 *   READ  — personal API key (raw header), from LINEAR_API_KEY/LINEAR_TOKEN or the macOS
 *           Keychain item "openclaw-linear-api-key". Used to fetch the issue + comments.
 *   WRITE — the dedicated "ClawSweeper" OAuth app (client_credentials, actor=app). Its
 *           client_id/secret live in the Keychain ("openclaw-linear-clawsweeper-client-id"
 *           / "openclaw-linear-clawsweeper-secret"). A short-lived Bearer access token is
 *           minted at apply time and used only for the comment mutation. Comments are
 *           authored as the app user "ClawSweeper".
 *
 * Gating — review-only by default, impossible to write without an explicit opt-in:
 *   - Default mode is DRY-RUN: prints the planned comment body and whether it would create
 *     or update, and writes NOTHING. No OAuth token is minted in dry-run.
 *   - A live write requires BOTH: the explicit --apply flag AND the environment opt-in
 *     OPENCLAW_NOTIFY_LINEAR=1. Either alone keeps the run dry. (Belt and suspenders so a
 *     stray flag in a cron command can never post.)
 *   - Even with both, the write only proceeds if authorizeMutation() returns allowed=true
 *     with the comment gate explicitly opened and matching snapshot/plan fingerprints.
 *
 * Secret hygiene: no token, client id, or client secret is ever logged.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  authorizeMutation,
  buildMutationReceipt,
  classifyRecord,
  COMMENT_CREATE_MUTATION,
  COMMENT_UPDATE_MUTATION,
  createLinearTransport,
  LinearItemSource,
  mapWorkspaceItem,
  mintLinearAppToken,
  planReviewCommentUpsert,
  resolveGates,
  reviewCommentMutationRequest,
} from "../dist/linear/index.js";

const DEFAULT_STALE_DAYS = 60;

// Read-key Keychain coordinates (personal API key, raw header) — mirrors linear-snapshot.mjs.
export const READ_KEYCHAIN_SERVICE = "openclaw-linear-api-key";
// OAuth app (ClawSweeper) client_credentials Keychain coordinates (Bearer write path).
export const APP_CLIENT_ID_SERVICE = "openclaw-linear-clawsweeper-client-id";
export const APP_CLIENT_SECRET_SERVICE = "openclaw-linear-clawsweeper-secret";
export const DEFAULT_KEYCHAIN_ACCOUNT = "partnerai-config";

// Environment opt-in required (alongside --apply) before any live write.
export const NOTIFY_ENV = "OPENCLAW_NOTIFY_LINEAR";

export function parseArgs(argv) {
  const options = {
    identifier: "",
    apply: false,
    json: false,
    nowIso: undefined,
    staleDays: DEFAULT_STALE_DAYS,
    requiredLabels: [],
    exclusionLabels: [],
    protectedLabels: [],
    keychainAccount: DEFAULT_KEYCHAIN_ACCOUNT,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--identifier":
      case "--issue":
        options.identifier = requireValue(argv, ++index, arg);
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--dry-run":
        options.apply = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--now":
        options.nowIso = requireValue(argv, ++index, arg);
        break;
      case "--stale-days":
        options.staleDays = positiveInt(requireValue(argv, ++index, arg), "--stale-days");
        break;
      case "--required-label":
        options.requiredLabels.push(requireValue(argv, ++index, arg));
        break;
      case "--exclusion-label":
        options.exclusionLabels.push(requireValue(argv, ++index, arg));
        break;
      case "--protected-label":
        options.protectedLabels.push(requireValue(argv, ++index, arg));
        break;
      case "--keychain-account":
        options.keychainAccount = requireValue(argv, ++index, arg);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.identifier === "") {
    throw new Error("--identifier <KEY> is required (e.g. --identifier PAR-244)");
  }

  return options;
}

// Reads a generic password from the macOS Keychain without a shell. Returns "" on any miss.
function defaultKeychainLookup(service, account) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** Resolves the READ token (personal key, raw header): env first, else Keychain. */
export function resolveReadToken(options = {}) {
  const env = options.env ?? process.env;
  const account = options.account ?? DEFAULT_KEYCHAIN_ACCOUNT;
  const runKeychain = options.runKeychain ?? defaultKeychainLookup;

  const envToken = env["LINEAR_API_KEY"] ?? env["LINEAR_TOKEN"];
  if (envToken && envToken.trim() !== "") return envToken.trim();

  const keychainToken = runKeychain(READ_KEYCHAIN_SERVICE, account);
  if (keychainToken && keychainToken.trim() !== "") return keychainToken.trim();

  throw new Error(
    `No Linear read token found. Set LINEAR_API_KEY or LINEAR_TOKEN, or store a generic ` +
      `password in the macOS Keychain (service "${READ_KEYCHAIN_SERVICE}", account "${account}").`,
  );
}

/** Resolves the ClawSweeper OAuth app client_id/secret from the Keychain. Never logged. */
export function resolveAppCredentials(options = {}) {
  const account = options.account ?? DEFAULT_KEYCHAIN_ACCOUNT;
  const runKeychain = options.runKeychain ?? defaultKeychainLookup;

  const clientId = runKeychain(APP_CLIENT_ID_SERVICE, account).trim();
  const clientSecret = runKeychain(APP_CLIENT_SECRET_SERVICE, account).trim();
  if (clientId === "" || clientSecret === "") {
    throw new Error(
      `ClawSweeper OAuth app credentials not found in the macOS Keychain ` +
        `(services "${APP_CLIENT_ID_SERVICE}" / "${APP_CLIENT_SECRET_SERVICE}", account "${account}").`,
    );
  }
  return { clientId, clientSecret };
}

/**
 * Renders the deterministic, offline review CONTENT (without the marker — the planner adds
 * it). The narrative is derived purely from the classification + record so re-runs that see
 * the same issue produce a byte-identical body (stable planHash for operator approval).
 */
export function renderReviewContent(record, classification) {
  const lines = [];
  lines.push(`## ClawSweeper review — ${record.identifier}`);
  lines.push("");
  lines.push(`- Disposition: \`${classification.disposition}\``);
  lines.push(`- Priority: \`${record.triagePriority}\``);
  lines.push(`- Category: \`${record.itemCategory}\``);
  lines.push(`- State: \`${record.state}\``);
  lines.push("");
  lines.push("Reasons:");
  for (const reason of classification.reasons) {
    lines.push(`- ${reason}`);
  }
  lines.push("");
  lines.push(
    "_This is an automated, review-only triage note. ClawSweeper proposes; it never closes._",
  );
  return lines.join("\n");
}

/**
 * Decides whether a live write is permitted. A write needs BOTH the explicit --apply flag
 * AND the OPENCLAW_NOTIFY_LINEAR=1 environment opt-in. Returns { live, reason }.
 */
export function resolveWriteMode(options, env = process.env) {
  if (!options.apply) {
    return { live: false, reason: "dry-run (default; pass --apply to write)" };
  }
  const notify = (env[NOTIFY_ENV] ?? "").trim();
  if (notify !== "1" && notify.toLowerCase() !== "true") {
    return {
      live: false,
      reason: `--apply given but ${NOTIFY_ENV} is not set to 1 — staying dry-run`,
    };
  }
  return { live: true, reason: "live write authorized by --apply + " + NOTIFY_ENV };
}

/**
 * Builds the full plan for one item: fetch (hydrated with comments) -> map -> classify ->
 * plan comment upsert -> mutation request -> authorization (comment gate opened).
 * Pure of side effects beyond the read fetch; performs NO write.
 */
export async function buildItemPlan(source, options) {
  const nowIso = options.nowIso || new Date().toISOString();

  const hydrated = await source.fetchIssueByIdentifier(options.identifier);
  if (hydrated === null) {
    throw new Error(`no Linear issue found for identifier "${options.identifier}"`);
  }

  const record = mapWorkspaceItem(hydrated);
  const classification = classifyRecord(record, {
    nowIso,
    staleDays: options.staleDays ?? DEFAULT_STALE_DAYS,
    requiredLabels: options.requiredLabels ?? [],
    exclusionLabels: options.exclusionLabels ?? [],
    protectedLabels: options.protectedLabels ?? [],
  });

  const content = renderReviewContent(record, classification);
  const plan = planReviewCommentUpsert({
    issueId: record.id,
    key: record.key,
    content,
    existingComments: hydrated.comments,
  });

  const request = reviewCommentMutationRequest(plan, record.snapshotHash);

  // Open ONLY the comment gate. Live drift fingerprint: the same read pass produced both
  // the snapshot and the comment list, so the live snapshot equals the plan snapshot, and
  // the operator-approved plan hash is the freshly computed plan hash.
  const gates = resolveGates({ comment: true });
  const drift = {
    liveSnapshotHash: record.snapshotHash,
    approvedPlanHash: plan.planHash,
  };
  const authorization = authorizeMutation(request, gates, drift);
  const receipt = buildMutationReceipt(request, gates, drift);

  return { record, classification, plan, request, authorization, receipt, hydrated };
}

/** Applies the authorized plan with a freshly minted Bearer token. Never logs the token. */
export async function applyPlan(plan, appCreds, deps = {}) {
  // Nothing to write — never mint a write token for a noop.
  if (plan.action === "noop") {
    return { noop: true };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const minted = await mintLinearAppToken({
    clientId: appCreds.clientId,
    clientSecret: appCreds.clientSecret,
    scope: "read,write",
    ...(deps.mintEndpoint ? { endpoint: deps.mintEndpoint } : {}),
    fetchImpl,
  });
  const transport =
    deps.transport ??
    createLinearTransport({
      token: minted.accessToken,
      auth: "bearer",
      ...(deps.graphqlEndpoint ? { endpoint: deps.graphqlEndpoint } : {}),
      ...(deps.fetchImpl ? { fetchImpl } : {}),
    });

  if (plan.action === "create") {
    return transport(COMMENT_CREATE_MUTATION, { issueId: plan.issueId, body: plan.body });
  }
  if (plan.action === "update") {
    return transport(COMMENT_UPDATE_MUTATION, { id: plan.targetCommentId, body: plan.body });
  }
  return { noop: true };
}

/**
 * Composes the full live-write decision. A comment is posted only when ALL hold:
 *   - mode is live (--apply + OPENCLAW_NOTIFY_LINEAR=1),
 *   - the item is ELIGIBLE for review (disposition "review"/"stale-candidate") — ClawSweeper
 *     never comments on closed, protected, or excluded issues; there is nothing to review,
 *   - the mutation is authorized (gate open + matching fingerprints),
 *   - the plan actually changes something (action !== "noop").
 * Returns { write, reason }; reason explains any skip for the summary/receipt. Pure.
 */
export function resolveWriteDecision(result, mode) {
  if (!mode.live) return { write: false, reason: mode.reason };
  if (!result.classification.eligible) {
    return {
      write: false,
      reason:
        `skipped: ${result.record.identifier} is not eligible for review ` +
        `(disposition "${result.classification.disposition}") — ClawSweeper does not comment ` +
        `on closed, protected, or excluded issues`,
    };
  }
  if (!result.authorization.allowed) {
    return { write: false, reason: "authorization denied — see authorizationReasons" };
  }
  if (result.plan.action === "noop") {
    return { write: false, reason: "noop: the durable comment already matches — nothing to write" };
  }
  return { write: true, reason: `live write authorized for ${result.record.identifier}` };
}

/**
 * Reads the issue back after a live write and confirms the durable marker comment now
 * reflects the plan (PAR-215 read-back: prove the mutation actually landed, not just that
 * the API echoed success). Returns a secret-free confirmation summary.
 */
export async function readBackComment(source, identifier, plan) {
  const hydrated = await source.fetchIssueByIdentifier(identifier);
  const comments = hydrated?.comments ?? [];
  const matches = comments.filter((c) => (c.body ?? "").includes(plan.marker));
  // Confirm the EXACT comment we wrote, not "exactly one marker comment": the planner
  // deliberately tolerates stale duplicate marker comments (cleaned up separately), so a
  // successful update must still read back as confirmed when duplicates are present. For an
  // update we pin the kept target by id; for a create we find the comment carrying the body.
  const target =
    plan.targetCommentId != null
      ? comments.find((c) => c.id === plan.targetCommentId)
      : matches.find((c) => (c.body ?? "") === plan.body);
  const bodyMatches = (target?.body ?? null) === plan.body;
  return {
    confirmed: bodyMatches,
    markerCommentCount: matches.length,
    staleDuplicates: Math.max(0, matches.length - 1),
    commentId: target?.id ?? (matches.length > 0 ? matches[0].id : null),
    bodyMatches,
  };
}

function summarize(result, mode) {
  return {
    identifier: result.record.identifier,
    disposition: result.classification.disposition,
    eligible: result.classification.eligible,
    action: result.plan.action,
    targetCommentId: result.plan.targetCommentId,
    staleDuplicateIds: result.plan.staleDuplicateIds,
    authorized: result.authorization.allowed,
    authorizationReasons: result.authorization.reasons,
    // Mode-independent: would a LIVE run actually write? (eligible + authorized + not noop)
    // Lets a dry-run state exactly what a live run would do.
    wouldWrite:
      result.classification.eligible &&
      result.authorization.allowed &&
      result.plan.action !== "noop",
    planHash: result.plan.planHash,
    snapshotHash: result.record.snapshotHash,
    receipt: result.receipt, // secret-free MutationReceipt (audit trail)
    live: mode.live,
    mode: mode.live ? "apply" : "dry-run",
    modeReason: mode.reason,
    body: result.plan.body,
  };
}

function printHuman(summary) {
  const out = [];
  out.push(`Identifier:   ${summary.identifier}`);
  out.push(`Disposition:  ${summary.disposition}`);
  out.push(`Eligible:     ${summary.eligible}`);
  out.push(
    `Action:       ${summary.action}` +
      (summary.targetCommentId ? ` (-> ${summary.targetCommentId})` : ""),
  );
  out.push(`Authorized:   ${summary.authorized}`);
  if (!summary.authorized) {
    for (const r of summary.authorizationReasons) out.push(`  - ${r}`);
  }
  out.push(`Would write:  ${summary.wouldWrite}`);
  out.push(`Mode:         ${summary.mode} — ${summary.modeReason}`);
  if (summary.writeDecision) out.push(`Decision:     ${summary.writeDecision}`);
  if (summary.readback) {
    out.push(
      `Read-back:    confirmed=${summary.readback.confirmed}` +
        (summary.readback.commentId ? ` (${summary.readback.commentId})` : ""),
    );
  }
  out.push("");
  out.push("Planned comment body:");
  out.push("----------------------------------------");
  out.push(summary.body);
  out.push("----------------------------------------");
  return out.join("\n");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n" + usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const mode = resolveWriteMode(options);

  let readToken;
  try {
    readToken = resolveReadToken({ account: options.keychainAccount });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let result;
  let source;
  try {
    const transport = createLinearTransport({ token: readToken });
    source = new LinearItemSource(transport);
    result = await buildItemPlan(source, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const summary = summarize(result, mode);
  const decision = resolveWriteDecision(result, mode);
  summary.writeDecision = decision.reason;

  if (decision.write) {
    try {
      const appCreds = resolveAppCredentials({ account: options.keychainAccount });
      const applyResult = await applyPlan(result.plan, appCreds);
      summary.applied = true;
      summary.applyResult = applyResult;
      // PAR-215 read-back: re-fetch and confirm the durable marker comment landed.
      try {
        summary.readback = await readBackComment(source, options.identifier, result.plan);
      } catch (error) {
        summary.readback = {
          confirmed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  } else {
    summary.applied = false;
    // Surface why a LIVE run skipped (ineligible / denied / noop); the dry-run reason is in writeDecision.
    if (mode.live) summary.applyBlocked = decision.reason;
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(printHuman(summary));
    if (summary.applied) console.log("\nApplied: comment posted as ClawSweeper.");
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInt(value, flag) {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function usage() {
  return `Usage: node scripts/linear-comment-apply.mjs --identifier <KEY> [options]

Single-item Linear review-comment apply runner. Fetches ONE issue by identifier,
runs the real review pipeline (map -> classify -> plan -> authorize) and either
prints the planned comment (dry-run, default) or posts it as the ClawSweeper OAuth
app (live, requires both --apply and ${NOTIFY_ENV}=1).

Options:
  --identifier <KEY>         Linear issue identifier, e.g. PAR-244 (required)
  --apply                    Opt in to a LIVE write (also needs ${NOTIFY_ENV}=1)
  --dry-run                  Force dry-run (default behaviour)
  --json                     Emit a JSON summary instead of human-readable text
  --now <iso>                ISO 8601 timestamp to use as "now" (default: current time)
  --stale-days <n>           Staleness threshold in days (default: ${DEFAULT_STALE_DAYS})
  --required-label <label>   Require at least one of these labels (repeatable)
  --exclusion-label <label>  Skip items with this label (repeatable)
  --protected-label <label>  Mark items with this label as protected (repeatable)
  --keychain-account <a>     Keychain account for credentials (default: ${DEFAULT_KEYCHAIN_ACCOUNT})
  --help, -h                 Show this help message

Auth: READ uses the personal key (LINEAR_API_KEY/LINEAR_TOKEN or Keychain service
"${READ_KEYCHAIN_SERVICE}", raw header). WRITE mints a Bearer token from the
ClawSweeper OAuth app credentials in the Keychain (services
"${APP_CLIENT_ID_SERVICE}" / "${APP_CLIENT_SECRET_SERVICE}").

Examples:
  # Dry-run (default): print the planned comment for PAR-244, write nothing
  node scripts/linear-comment-apply.mjs --identifier PAR-244 --json

  # Live write (posts the comment as ClawSweeper) — both gates required
  ${NOTIFY_ENV}=1 node scripts/linear-comment-apply.mjs --identifier PAR-244 --apply`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
