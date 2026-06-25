#!/usr/bin/env node

/**
 * Scoped Linear review-comment runner (dry-run by default).
 *
 * This is the BULK generalization of linear-comment-apply.mjs: it runs the identical
 * per-item review pipeline over a SCOPE — an explicit set of identifiers, a list/ledger
 * file, a Linear project, or a whole team — instead of one hard-coded identifier. Single
 * item is just scope-of-one; nothing about the per-item review changes.
 *
 *   resolveScope (read-only)  ->  for each identifier:
 *     buildItemPlan (fetch -> map -> classify -> plan -> authorize)   [from linear-comment-apply]
 *       -> resolveWriteDecision -> [--apply only] applyPlan -> readBackComment
 *
 * It is the natural vehicle for a "closeout sweep": point it at a project (or a Command
 * Central ledger) and it posts ClawSweeper's standard review comment on each still-open,
 * eligible issue and SKIPS the ones already Done / protected / excluded. It never closes an
 * issue — closing remains the evidence-gated `close` capability in authority.ts, fired only
 * by a separate, explicitly-opted-in path. This runner only ever opens the comment gate.
 *
 * Gating is identical to the single-item path and just as conservative:
 *   - DRY-RUN by default: plans every item, writes nothing, mints no token. The --json
 *     output doubles as the operator-approval artifact (it carries planHash/snapshotHash/
 *     nowIso per item) that can be fed straight back via --approvals for a live apply.
 *   - A live write requires BOTH --apply AND OPENCLAW_NOTIFY_LINEAR=1, AND per-item
 *     authorization: each item is only written if its approved planHash/snapshotHash
 *     (from --approvals) still match the live snapshot (drift gate) and the issue is
 *     eligible and the plan is not a noop. Un-approved or drifted items stay dry — one
 *     stale issue can never be force-written.
 *   - The Bearer write token is minted ONCE for the whole batch and shared (lazy: only if
 *     at least one item will actually be written).
 *
 * Secret hygiene: no token, client id, or client secret is ever logged.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  chooseScope,
  createLinearTransport,
  evaluateReviewPolicy,
  extractIdentifiers,
  LinearItemSource,
  matchIdentifier,
  mintLinearAppToken,
  resolveScope,
} from "../dist/linear/index.js";

import {
  applyPlan,
  assertReadBackConfirmed,
  buildItemPlan,
  DEFAULT_KEYCHAIN_ACCOUNT,
  NOTIFY_ENV,
  readBackComment,
  resolveAppCredentials,
  resolveReadToken,
  resolveWriteDecision,
  resolveWriteMode,
} from "./linear-comment-apply.mjs";

const DEFAULT_STALE_DAYS = 60;
const DEFAULT_CONCURRENCY = 4; // parallel READS for dry-run planning; writes stay serialized

export function parseArgs(argv) {
  const options = {
    identifiers: [],
    fromFile: "",
    listField: "",
    project: "",
    team: "",
    apply: false,
    json: false,
    approvals: "",
    limit: 0,
    rateMs: 0,
    concurrency: DEFAULT_CONCURRENCY,
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
        options.identifiers.push(requireValue(argv, ++index, arg));
        break;
      case "--identifiers":
        for (const part of requireValue(argv, ++index, arg).split(",")) {
          if (part.trim() !== "") options.identifiers.push(part.trim());
        }
        break;
      case "--from-file":
        options.fromFile = requireValue(argv, ++index, arg);
        break;
      case "--list-field":
        options.listField = requireValue(argv, ++index, arg);
        break;
      case "--project":
        options.project = requireValue(argv, ++index, arg);
        break;
      case "--team":
        options.team = requireValue(argv, ++index, arg);
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
      case "--approvals":
        options.approvals = requireValue(argv, ++index, arg);
        break;
      case "--limit":
        options.limit = positiveInt(requireValue(argv, ++index, arg), "--limit");
        break;
      case "--rate-ms":
        options.rateMs = nonNegativeInt(requireValue(argv, ++index, arg), "--rate-ms");
        break;
      case "--concurrency":
        options.concurrency = positiveInt(requireValue(argv, ++index, arg), "--concurrency");
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
  return options;
}

/**
 * Builds the ScopeSpec from CLI options, reading the --from-file ledger when given.
 * Exactly one scope source is permitted (chooseScope enforces this). A --from-file is
 * treated as an identifiers scope after extraction.
 */
export function buildScopeSpec(options, deps = {}) {
  const readFile = deps.readFileSync ?? readFileSync;
  let identifiers = [...options.identifiers];

  if ((options.fromFile ?? "") !== "") {
    let parsed;
    try {
      parsed = JSON.parse(readFile(options.fromFile, "utf8"));
    } catch (error) {
      throw new Error(
        `failed to read --from-file ${options.fromFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const extractOptions = options.listField !== "" ? { listField: options.listField } : {};
    const fromFile = extractIdentifiers(parsed, extractOptions);
    if (fromFile.length === 0) {
      throw new Error(
        `--from-file ${options.fromFile} yielded no Linear identifiers` +
          (options.listField !== "" ? ` under list field "${options.listField}"` : ""),
      );
    }
    identifiers = identifiers.concat(fromFile);
  }

  return chooseScope({
    identifiers,
    project: options.project,
    team: options.team,
  });
}

function validateHash(hash, label) {
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`${label} must be a 64-character sha256 hex hash`);
  }
}

/**
 * Loads a per-item approvals map (identifier -> approved fingerprints) from a reviewed
 * dry-run. Accepts this runner's own --json output (an object with `items`) or a bare
 * array of per-item summaries / receipts. An entry needs identifier + planHash +
 * snapshotHash; nowIso is carried through so the live plan recomputes identically.
 */
export function loadApprovals(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? raw?.entries ?? []);
  const map = new Map();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = matchIdentifier(entry.identifier ?? entry.key ?? "");
    if (id === null) continue;
    const planHash = pickHash(entry, "planHash");
    const snapshotHash = pickHash(entry, "snapshotHash");
    if (planHash === "" || snapshotHash === "") continue;
    validateHash(planHash, `approvals planHash for ${id}`);
    validateHash(snapshotHash, `approvals snapshotHash for ${id}`);
    const nowIso = typeof entry.nowIso === "string" ? entry.nowIso.trim() : "";
    map.set(id, {
      approvedPlanHash: planHash,
      approvedSnapshotHash: snapshotHash,
      ...(nowIso !== "" ? { nowIso } : {}),
      source: "approvals-file",
    });
  }
  return map;
}

function pickHash(entry, key) {
  const direct = entry[key];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim().toLowerCase();
  const receipt = entry.receipt;
  if (typeof receipt === "object" && receipt !== null) {
    const value = receipt[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().toLowerCase();
  }
  return "";
}

/** Mints ONE short-lived Bearer transport for the whole batch. Token is never logged. */
async function mintWriteTransport(appCreds, deps = {}) {
  const minted = await mintLinearAppToken({
    clientId: appCreds.clientId,
    clientSecret: appCreds.clientSecret,
    scope: "read,write",
    ...(deps.mintEndpoint ? { endpoint: deps.mintEndpoint } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return createLinearTransport({
    token: minted.accessToken,
    auth: "bearer",
    ...(deps.graphqlEndpoint ? { endpoint: deps.graphqlEndpoint } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

/**
 * Per-item secret-free summary; planHash/snapshotHash/nowIso make it re-feedable as
 * approvals. Two distinct signals, deliberately not conflated:
 *   - `actionable` — intrinsic to the item: it is eligible for review AND the plan is not a
 *     noop, so there is a real comment to post. This is the closeout picture a dry-run shows.
 *   - `authorized` — the approval handshake: the plan/snapshot fingerprints matched an
 *     operator approval (from --approvals). Empty in a plain dry-run.
 *   - `wouldWrite` — a LIVE run actually writes iff actionable AND authorized.
 */
export function summarizeItem(result, decision) {
  const actionable = result.classification.eligible && result.plan.action !== "noop";
  // Project-agnostic review policy: the routing label + next step ClawSweeper PROPOSES for
  // this item. Read-only here (reporting); applying labels is the inert future path.
  const policy = evaluateReviewPolicy(result.classification, result.record);
  return {
    identifier: result.record.identifier,
    disposition: result.classification.disposition,
    eligible: result.classification.eligible,
    action: result.plan.action,
    actionable,
    authorized: result.authorization.allowed,
    wouldWrite: actionable && result.authorization.allowed,
    routingLabel: policy.routingLabel,
    proposedLabels: policy.proposedLabels,
    suggestedNextStep: policy.suggestedNextStep,
    writeDecision: decision.reason,
    planHash: result.plan.planHash,
    snapshotHash: result.record.snapshotHash,
    nowIso: result.nowIso,
    receipt: result.receipt,
  };
}

/**
 * Aggregates per-item results into the run report. `byDisposition` and the intent/outcome
 * counters make the closeout picture legible at a glance: how many eligible items would get
 * a comment vs how many are skipped because they're already Done / protected / excluded.
 */
export function aggregate(items, resolution, mode) {
  const byDisposition = {};
  const byRoutingLabel = {};
  let eligible = 0;
  let actionable = 0;
  let authorized = 0;
  let wouldWrite = 0;
  let applied = 0;
  let errors = 0;
  for (const item of items) {
    if (item.error) {
      errors += 1;
      continue;
    }
    byDisposition[item.disposition] = (byDisposition[item.disposition] ?? 0) + 1;
    const routing = item.routingLabel ?? "(none)";
    byRoutingLabel[routing] = (byRoutingLabel[routing] ?? 0) + 1;
    if (item.eligible) eligible += 1;
    if (item.actionable) actionable += 1;
    if (item.authorized) authorized += 1;
    if (item.wouldWrite) wouldWrite += 1;
    if (item.applied) applied += 1;
  }
  return {
    scope: {
      kind: resolution.kind,
      ...(resolution.matchedTeam ? { team: resolution.matchedTeam } : {}),
      ...(resolution.matchedProjects ? { projects: resolution.matchedProjects } : {}),
      resolvedCount: resolution.identifiers.length,
    },
    mode: mode.live ? "apply" : "dry-run",
    modeReason: mode.reason,
    counts: {
      total: items.length,
      eligible,
      actionable,
      authorized,
      wouldWrite,
      applied,
      errors,
      byDisposition,
      byRoutingLabel,
    },
    items,
  };
}

// Runs `worker` over `inputs` with at most `limit` in flight; preserves input order.
async function mapPool(inputs, limit, worker) {
  const results = Array.from({ length: inputs.length });
  let next = 0;
  async function run() {
    while (next < inputs.length) {
      const current = next;
      next += 1;
      results[current] = await worker(inputs[current], current);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, inputs.length); i += 1) runners.push(run());
  await Promise.all(runners);
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function itemOptionsFor(identifier, options, approval) {
  return {
    identifier,
    nowIso: approval?.nowIso ?? options.nowIso,
    staleDays: options.staleDays,
    requiredLabels: options.requiredLabels,
    exclusionLabels: options.exclusionLabels,
    protectedLabels: options.protectedLabels,
    approval: approval ?? null,
  };
}

function printHuman(report) {
  const out = [];
  const s = report.scope;
  const scopeDesc =
    s.kind === "team"
      ? `team ${s.team}`
      : s.kind === "project"
        ? `project(s) ${(s.projects ?? []).map((p) => `${p.name} [${p.teamKey}]`).join(", ")}`
        : `${s.resolvedCount} identifier(s)`;
  out.push(`Scope:        ${s.kind} — ${scopeDesc}`);
  out.push(`Resolved:     ${s.resolvedCount} issue(s)`);
  out.push(`Mode:         ${report.mode} — ${report.modeReason}`);
  out.push("");
  out.push("Dispositions:");
  for (const [disp, n] of Object.entries(report.counts.byDisposition).sort()) {
    out.push(`  ${disp.padEnd(16)} ${n}`);
  }
  out.push("");
  out.push("Proposed routing labels:");
  for (const [label, n] of Object.entries(report.counts.byRoutingLabel ?? {}).sort()) {
    out.push(`  ${label.padEnd(34)} ${n}`);
  }
  out.push("");
  out.push(`Eligible:     ${report.counts.eligible}`);
  out.push(`Actionable:   ${report.counts.actionable}  (eligible + a real comment to post)`);
  out.push(`Authorized:   ${report.counts.authorized}  (approved via --approvals)`);
  out.push(`Would write:  ${report.counts.wouldWrite}  (actionable AND authorized)`);
  if (report.mode === "apply") out.push(`Applied:      ${report.counts.applied}`);
  if (report.counts.errors > 0) out.push(`Errors:       ${report.counts.errors}`);
  if (report.mode === "dry-run" && report.counts.actionable > 0 && report.counts.authorized === 0) {
    out.push("");
    out.push(
      "Note: re-feed this run's --json as --approvals (with --apply + " +
        `${NOTIFY_ENV}=1) to authorize the ${report.counts.actionable} actionable item(s).`,
    );
  }
  out.push("");
  out.push("Per item:");
  for (const item of report.items) {
    if (item.error) {
      out.push(`  ✗ ${item.identifier.padEnd(10)} ERROR: ${item.error}`);
      continue;
    }
    const mark = item.applied ? "✓" : item.actionable ? "→" : "·";
    const label = item.routingLabel ? ` label=${item.routingLabel}` : "";
    out.push(
      `  ${mark} ${item.identifier.padEnd(10)} ${item.disposition.padEnd(16)} action=${item.action}${label}` +
        (item.applied ? " (applied)" : ""),
    );
  }
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

  let source;
  let resolution;
  let approvals = new Map();
  try {
    const readToken = resolveReadToken({ account: options.keychainAccount });
    source = new LinearItemSource(createLinearTransport({ token: readToken }));
    const spec = buildScopeSpec(options);
    resolution = await resolveScope(source, spec);
    if (options.approvals !== "") {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(options.approvals, "utf8"));
      } catch (error) {
        throw new Error(
          `failed to read --approvals ${options.approvals}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      approvals = loadApprovals(parsed);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  let identifiers = resolution.identifiers;
  if (options.limit > 0) identifiers = identifiers.slice(0, options.limit);

  // Phase 1: plan every item (read-only), bounded-concurrency.
  const planned = await mapPool(identifiers, options.concurrency, async (identifier) => {
    try {
      const result = await buildItemPlan(
        source,
        itemOptionsFor(identifier, options, approvals.get(identifier)),
      );
      const decision = resolveWriteDecision(result, mode);
      return { identifier, result, decision, summary: summarizeItem(result, decision) };
    } catch (error) {
      return { identifier, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Phase 2: live writes, SERIALIZED + rate-limited, sharing ONE minted Bearer token.
  let writeTransport = null;
  let appCreds = null;
  const ensureWriteTransport = async () => {
    if (writeTransport === null) {
      appCreds = resolveAppCredentials({ account: options.keychainAccount });
      writeTransport = await mintWriteTransport(appCreds);
    }
    return writeTransport;
  };

  const items = [];
  for (const entry of planned) {
    if (entry.error) {
      items.push({ identifier: entry.identifier, error: entry.error });
      continue;
    }
    const summary = entry.summary;
    let didWrite = false;

    if (entry.decision.write) {
      didWrite = true;
      try {
        await ensureWriteTransport();
        summary.applyResult = await applyPlan(entry.result.plan, appCreds, {
          transport: writeTransport,
        });
        summary.readback = await readBackComment(source, entry.identifier, entry.result.plan);
        assertReadBackConfirmed(summary.readback);
        summary.applied = true;
      } catch (error) {
        summary.applied = false;
        summary.applyError = error instanceof Error ? error.message : String(error);
        // Honesty: if the comment mutation itself succeeded but read-back failed, a comment
        // WAS posted — applied=false must not read as "nothing was written". Flag it so the
        // report distinguishes a failed write from an unconfirmed-but-landed one.
        summary.writtenUnconfirmed = summary.applyResult !== undefined && !summary.applyResult.noop;
        process.exitCode = 1;
      }
    } else {
      summary.applied = false;
    }

    if (didWrite && options.rateMs > 0) await sleep(options.rateMs);
    items.push(summary);
  }

  const report = aggregate(items, resolution, mode);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(printHuman(report));
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

function nonNegativeInt(value, flag) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return Number(value);
}

function usage() {
  return `Usage: node scripts/linear-review-apply.mjs <scope> [options]

Runs ClawSweeper's review pipeline over a SCOPE of Linear issues. Dry-run by default
(plans + reports, writes nothing). The same per-item pipeline as the single-item path —
this only generalizes WHICH issues. It posts the standard review comment; it never closes.

Scope (provide exactly one):
  --identifier <KEY>         A Linear identifier, e.g. PAR-244 (repeatable)
  --identifiers a,b,c        Comma-separated identifiers
  --from-file <path>         JSON list/ledger; pulls each record's identifier
  --list-field <key>         Container key in --from-file to read (e.g. order, linear_done)
  --project <name|id>        Every issue in a Linear project (name is case-insensitive)
  --team <KEY>               Every issue in a team

Review options:
  --now <iso>                ISO 8601 "now" for staleness (default: current time)
  --stale-days <n>           Staleness threshold in days (default: ${DEFAULT_STALE_DAYS})
  --required-label <label>   Require one of these labels (repeatable)
  --exclusion-label <label>  Skip items with this label (repeatable)
  --protected-label <label>  Mark items with this label protected (repeatable)
  --limit <n>                Cap to the first n resolved issues
  --concurrency <n>          Parallel READS while planning (default: ${DEFAULT_CONCURRENCY})

Apply options (live write — review-only unless ALL hold):
  --apply                    Opt in to LIVE comment writes (also needs ${NOTIFY_ENV}=1)
  --approvals <path>         Per-item approved hashes from a reviewed dry-run (--json output)
  --rate-ms <n>              Delay between live writes in ms (default: 0)
  --json                     Emit the JSON run report (feedable as --approvals)
  --keychain-account <a>     Keychain account for credentials (default: ${DEFAULT_KEYCHAIN_ACCOUNT})
  --help, -h                 Show this help

Examples:
  # Read-only closeout review of a project (writes nothing):
  node scripts/linear-review-apply.mjs --project "Command Central" --json

  # Review the Command Central ledger's tracked items (the .order list):
  node scripts/linear-review-apply.mjs --from-file research/cc-work-ledger.json --json

  # Live apply over a reviewed-and-approved dry-run (both gates required):
  ${NOTIFY_ENV}=1 node scripts/linear-review-apply.mjs --team PAR --apply \\
    --approvals ./par-dry-run.json --rate-ms 400`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
