#!/usr/bin/env node

/**
 * Linear analysis runner — the IMPURE boundary that runs the real model (dry-run by default,
 * --analyze OFF by default). It REUSES the existing pieces end-to-end; it adds no parallel
 * system, no new schema, no host-side git collector, no clawsweeper-state cache.
 *
 *   fetchIssueByIdentifier (read)  ->  inferTargetRepo (SKIP if ambiguous; never guess/default)
 *     -> repositoryProfileFor().checkoutDir/promptNote/apply_close_rules
 *     -> [--analyze only] runCodex (sandbox:'read-only', model:'internal' so harness config
 *        governs; the MODEL runs read-only git blame/log/show, emits evidence{file,line,command,sha})
 *     -> parseDecision (harness) -> HOST re-verifies cited shas (git rev-parse/cat-file)
 *     -> deriveCloseLeaning (code-derived, advisory; forced false on any unverifiable sha)
 *     -> renderReviewContent(record, classification, {decision, closeLeaning})  [analyzer sections]
 *     -> buildItemPlan-style plan + authorize (comment gate)  [reused single-item plan]
 *     -> serializeAnalyzerRecord -> records/<workspaceSlug>/items/<key>.md   [audit, mirrors GitHub lane]
 *
 * Guardrails (all kept): --analyze OFF by default; eligible-only; gates default-closed;
 * classifier.proposesClose()===false; ONLY the comment gate may open (never close/state);
 * idempotency via the analyzer fingerprint + the cached Decision (re-plans noop). No live
 * Linear write and no live model call happen in unit tests — the exported helpers are pure and
 * the model/git/Keychain callbacks are injectable.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANALYZER_VERSION,
  analyzerFingerprint,
  classifyRecord,
  createLinearTransport,
  deriveCloseLeaning,
  evaluateReviewPolicy,
  inferTargetRepo,
  buildRepoCatalog,
  LinearItemSource,
  mapWorkspaceItem,
  needsReanalysis,
  parseLinearIdentifier,
  planReviewCommentUpsert,
  reviewCommentMutationRequest,
  serializeAnalyzerRecord,
  verifyEvidenceShas,
} from "../dist/linear/index.js";
import { isAutoCloseAllowed, repositoryProfileFor } from "../dist/repository-profiles.js";
import { runCodex } from "../dist/clawsweeper.js";

import {
  renderReviewContent,
  resolveReadToken,
  DEFAULT_KEYCHAIN_ACCOUNT,
} from "./linear-comment-apply.mjs";

const DEFAULT_STALE_DAYS = 60;
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_TIMEOUT_MS = 600_000;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function parseArgs(argv) {
  const options = {
    identifier: "",
    analyze: false,
    json: false,
    nowIso: undefined,
    staleDays: DEFAULT_STALE_DAYS,
    requiredLabels: [],
    exclusionLabels: [],
    protectedLabels: [],
    checkoutsDir: join(ROOT, ".."),
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
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
      case "--analyze":
        options.analyze = true;
        break;
      case "--dry-run":
        options.analyze = false;
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
      case "--checkouts-dir":
        options.checkoutsDir = requireValue(argv, ++index, arg);
        break;
      case "--reasoning-effort":
        options.reasoningEffort = requireValue(argv, ++index, arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = positiveInt(requireValue(argv, ++index, arg), "--timeout-ms");
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
 * Reads the generic-fallback owner rules from config/target-repositories.json so the repo
 * inference can match owner tokens (openclaw, steipete). Pure given `readFile`. Returns [] when
 * the config is absent or has no fallbacks (the static known-repo + URL paths still work).
 */
export function loadFallbackOwners(deps = {}) {
  const readFile = deps.readFileSync ?? readFileSync;
  const path = deps.configPath ?? join(ROOT, "config", "target-repositories.json");
  let parsed;
  try {
    parsed = JSON.parse(readFile(path, "utf8"));
  } catch {
    return [];
  }
  const fallbacks = Array.isArray(parsed?.generic_fallbacks) ? parsed.generic_fallbacks : [];
  return fallbacks
    .filter(
      (f) => f && typeof f.owner === "string" && typeof f.allow_repo_name_pattern === "string",
    )
    .map((f) => ({ owner: f.owner, allowRepoNamePattern: new RegExp(f.allow_repo_name_pattern) }));
}

function recordFrontMatterValue(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}:\\s*("(?:\\\\.|[^"\\\\])*")\\s*$`, "m"));
  if (!match?.[1]) return undefined;
  try {
    return String(JSON.parse(match[1]));
  } catch {
    return undefined;
  }
}

/**
 * Reconstructs the analyzer fingerprint from a persisted audit record. Missing, unreadable,
 * legacy, or malformed records deliberately return undefined so the safe fallback is to run
 * analysis again rather than trust an incomplete cache key.
 */
export function loadPersistedAnalyzerFingerprint(recordPath, deps = {}) {
  const readFile = deps.readFileSync ?? readFileSync;
  let markdown;
  try {
    markdown = readFile(deps.path ?? join(ROOT, recordPath), "utf8");
  } catch {
    return undefined;
  }
  const snapshotHash = recordFrontMatterValue(markdown, "snapshot_hash")?.trim();
  const repoHEAD = recordFrontMatterValue(markdown, "repo_head")?.trim();
  const modelId = recordFrontMatterValue(markdown, "model_id")?.trim();
  const analyzerVersion = recordFrontMatterValue(markdown, "analyzer_version")?.trim();
  if (!snapshotHash || !repoHEAD || !modelId || !analyzerVersion) return undefined;
  return analyzerFingerprint({ snapshotHash, repoHEAD, modelId, analyzerVersion });
}

/** Collects the issue's repo-bearing URLs from its url, attachments, and description. Pure. */
export function collectIssueUrls(hydrated) {
  const urls = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim() !== "") urls.push(v.trim());
  };
  // GitHub URLs in attachments and description are the strong signal; the Linear self-url is
  // intentionally NOT included (it is never a github.com URL, so it is inert anyway).
  for (const att of hydrated.attachments ?? []) push(att?.url);
  if (typeof hydrated.description === "string") {
    for (const m of hydrated.description.matchAll(/https?:\/\/github\.com\/\S+/gi)) push(m[0]);
  }
  return urls;
}

/**
 * Builds the repo-inference item (labels, title, urls) from a hydrated Linear issue. Pure.
 */
export function repoInferenceItemFor(hydrated) {
  return {
    labels: (hydrated.issue?.labels ?? []).map((l) => l.name ?? ""),
    title: hydrated.issue?.title ?? "",
    urls: collectIssueUrls(hydrated),
  };
}

/** Workspace admins and owners are treated as maintainer-authored. */
export function isMaintainerAuthored(hydrated) {
  return hydrated.creator?.admin === true || hydrated.creator?.owner === true;
}

/** Stable, non-PII author identity for prompts and audit records. */
export function creatorIdentity(hydrated) {
  return hydrated.creator?.name?.trim() || hydrated.creator?.id?.trim() || "linear";
}

/**
 * Maps a hydrated Linear issue + resolved profile into the Linear-shaped Item/ItemContext/GitInfo
 * the harness consumes as plain data. The Item is read-only; runCodex with our own `prompt`
 * bypasses buildReviewPrompt entirely, so the GitHub-shaped fields are inert scaffolding.
 */
export function buildHarnessInputs(hydrated, profile, mainSha) {
  const issue = hydrated.issue ?? {};
  const { number } = parseLinearIdentifier(issue.identifier);
  const item = {
    repo: profile.targetRepo,
    number,
    kind: "issue",
    title: issue.title ?? "",
    url: issue.url ?? "",
    createdAt: issue.createdAt ?? "",
    updatedAt: issue.updatedAt ?? "",
    author: creatorIdentity(hydrated),
    authorAssociation: isMaintainerAuthored(hydrated) ? "MEMBER" : "NONE",
    labels: (issue.labels ?? []).map((l) => l.name ?? ""),
  };
  const context = {
    issue: {
      identifier: issue.identifier,
      title: issue.title,
      description: hydrated.description ?? "",
    },
    comments: hydrated.comments ?? [],
    timeline: [],
  };
  const git = { mainSha, releaseStateComplete: false, latestRelease: null };
  return { item, context, git };
}

/**
 * Builds the read-only analysis prompt for the Codex sandbox. Linear-shaped wording; instructs
 * the model to run its OWN read-only git blame/log/show and cite evidence{file,line,command,sha}.
 * Pure (deterministic in its inputs).
 */
export function buildAnalysisPrompt(hydrated, profile, mainSha) {
  const issue = hydrated.issue ?? {};
  const attachmentUrls = (hydrated.attachments ?? [])
    .map((attachment) => attachment?.url)
    .filter((url) => typeof url === "string" && url.trim() !== "");
  return [
    "You are ClawSweeper reviewing a Linear issue against a local source checkout, READ-ONLY.",
    "",
    `Target repo: ${profile.targetRepo}`,
    `Repository policy: ${profile.promptNote}`,
    `Current main SHA: ${mainSha}`,
    "",
    `Issue: ${issue.identifier} — ${issue.title ?? ""}`,
    `URL: ${issue.url ?? ""}`,
    `Creator: ${creatorIdentity(hydrated)}${isMaintainerAuthored(hydrated) ? " (workspace maintainer)" : ""}`,
    "",
    "Description:",
    (hydrated.description ?? "(none)").trim(),
    "",
    "Attachments:",
    attachmentUrls.length > 0 ? attachmentUrls.join("\n") : "(none)",
    "",
    "Run read-only git (git blame/log/show) inside the sandbox to gather provenance. For every",
    "evidence item, cite the concrete file, line, the git command you ran, and the commit sha.",
    "Do not modify the tree. Emit a decision strictly matching the provided output schema.",
    "ClawSweeper proposes only; it never closes. closeReason must come from the schema enum.",
  ].join("\n");
}

/** Default git-backed sha verifier for the mapped checkout: `git cat-file -e <sha>^{commit}`. */
export function makeGitShaVerifier(checkoutDir, deps = {}) {
  const exec = deps.execFileSync ?? execFileSync;
  return (sha) => {
    if (typeof sha !== "string" || !/^[0-9a-fA-F]{7,40}$/.test(sha.trim())) return false;
    try {
      exec("git", ["cat-file", "-e", `${sha.trim()}^{commit}`], {
        cwd: checkoutDir,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  };
}

/** Reads the checkout HEAD sha. Pure given `exec`. */
export function readRepoHead(checkoutDir, deps = {}) {
  const exec = deps.execFileSync ?? execFileSync;
  return exec("git", ["rev-parse", "HEAD"], { cwd: checkoutDir, encoding: "utf8" }).trim();
}

/**
 * Maps a parsed harness Decision into the AnalyzerDecision slice the pure analyzer consumes.
 * Field names mirror the schema exactly; PR-only fields are simply not read for issues.
 */
export function toAnalyzerDecision(decision) {
  return {
    decision: decision.decision,
    closeReason: decision.closeReason,
    confidence: decision.confidence,
    changeSummary: decision.changeSummary ?? "",
    evidence: (decision.evidence ?? []).map((e) => ({
      label: e.label ?? "",
      detail: e.detail ?? "",
      file: e.file ?? null,
      line: e.line ?? null,
      command: e.command ?? null,
      sha: e.sha ?? null,
    })),
    reproductionStatus: decision.reproductionStatus ?? "",
    reproductionAssessment: decision.reproductionAssessment ?? "",
    workReason: decision.workReason ?? "",
    bestSolution: decision.bestSolution ?? "",
    ...(decision.rootCauseCluster ? { rootCauseCluster: decision.rootCauseCluster } : {}),
  };
}

/**
 * The full per-item analysis pipeline, with EVERY impure dependency injected so unit tests run
 * it with fakes (no live model, no live git, no live Linear). Returns a secret-free summary +
 * the serialized record body. `--analyze` gates whether `runModel` is actually called; when off
 * (or when the item is ineligible / the repo is ambiguous), it returns a dry skip with no model
 * call and writes nothing.
 */
export async function analyzeItem(hydrated, options, deps) {
  const nowIso = options.nowIso || new Date().toISOString();
  const record = mapWorkspaceItem(hydrated);
  const classification = classifyRecord(record, {
    nowIso,
    staleDays: options.staleDays ?? DEFAULT_STALE_DAYS,
    requiredLabels: options.requiredLabels ?? [],
    exclusionLabels: options.exclusionLabels ?? [],
    protectedLabels: options.protectedLabels ?? [],
  });

  const base = { identifier: record.identifier, disposition: classification.disposition };

  // Eligible-only: never analyze closed / protected / excluded / not-ready items.
  if (!classification.eligible) {
    return { ...base, analyzed: false, skipped: `ineligible (${classification.disposition})` };
  }

  // Repo inference — SKIP on ambiguous; never guess, never DEFAULT_TARGET_REPO.
  const inference = inferTargetRepo(deps.repoInferenceItem, deps.catalog);
  if (inference.repo === null) {
    return { ...base, analyzed: false, skipped: `repo ambiguous: ${inference.reasons.join("; ")}` };
  }
  // repositoryProfileFor throws on an unknown repo — but inference only yields known/allowed
  // repos, so this is safe. Honor per-repo apply_close_rules (openclaw/* never auto-close issues
  // except implemented_on_main).
  const profile = repositoryProfileFor(inference.repo);

  const repoHead = deps.repoHead;
  const modelId = deps.modelId ?? "internal";
  const fingerprint = analyzerFingerprint({
    snapshotHash: record.snapshotHash,
    repoHEAD: repoHead,
    modelId,
    analyzerVersion: ANALYZER_VERSION,
  });

  // Idempotency: skip the model when the fingerprint is unchanged from the persisted record.
  if (!needsReanalysis(deps.persistedFingerprint, fingerprint)) {
    return {
      ...base,
      analyzed: false,
      skipped: "fingerprint unchanged — no re-analysis needed",
      fingerprint,
      via: inference.via,
      repo: inference.repo,
    };
  }

  // --analyze gate: dry-run never calls the model.
  if (!options.analyze) {
    return {
      ...base,
      analyzed: false,
      skipped: "dry-run (default; pass --analyze to run the model)",
      repo: inference.repo,
      via: inference.via,
      fingerprint,
    };
  }

  // IMPURE: run the read-only model. `runModel` returns a parsed harness Decision.
  const decision = await deps.runModel({ profile, repoHead });
  const analyzerDecision = toAnalyzerDecision(decision);

  // HOST re-verifies cited shas; any unverifiable sha forces closeLeaning=false.
  const shaVerification = verifyEvidenceShas(analyzerDecision, deps.verifySha);
  const closeLeaning = deriveCloseLeaning({
    decision: analyzerDecision,
    profile,
    kind: "issue",
    maintainerAuthored: deps.maintainerAuthored ?? isMaintainerAuthored(hydrated),
    shaVerification,
  });

  // Render the comment body from the CACHED deterministic Decision (planHash noops on re-plan).
  const content = renderReviewContent(record, classification, {
    decision: analyzerDecision,
    closeLeaning,
  });
  const plan = planReviewCommentUpsert({
    issueId: record.id,
    key: record.key,
    content,
    existingComments: hydrated.comments ?? [],
  });
  const request = reviewCommentMutationRequest(plan, record.snapshotHash);

  // Persist the audit record (mirrors the GitHub lane). action_taken is always "reviewed" —
  // analysis NEVER mutates issue state; only the comment gate may ever open downstream.
  const policy = evaluateReviewPolicy(classification, record);
  const recordBody = serializeAnalyzerRecord(
    {
      decision: analyzerDecision.decision,
      close_reason: analyzerDecision.closeReason,
      confidence: analyzerDecision.confidence,
      type: "issue",
      author: creatorIdentity(hydrated),
      action_taken: "reviewed",
      reviewed_at: nowIso,
      item_updated_at: record.updatedAt,
      review_comment_synced_at: "",
      review_policy: policy.routingLabel ?? policy.ruleId,
      identifier: record.identifier,
      url: record.url,
      snapshot_hash: record.snapshotHash,
      model_id: modelId,
      analyzer_version: ANALYZER_VERSION,
      repo_head: repoHead,
      close_leaning: String(closeLeaning.closeLeaning),
    },
    plan.body,
  );

  return {
    ...base,
    analyzed: true,
    repo: inference.repo,
    via: inference.via,
    fingerprint,
    closeLeaning: closeLeaning.closeLeaning,
    closeLeaningReasons: closeLeaning.reasons,
    autoCloseAllowed: isAutoCloseAllowed(profile, "issue", analyzerDecision.closeReason),
    closeReason: analyzerDecision.closeReason,
    shaVerification,
    planAction: plan.action,
    planHash: plan.planHash,
    snapshotHash: record.snapshotHash,
    request,
    recordPath: record.recordPath,
    recordBody,
    nowIso,
  };
}

/** Writes the audit record to records/<workspaceSlug>/items/<key>.md. Live-write side effect. */
export function writeAnalyzerRecord(summary, deps = {}) {
  const write = deps.writeFileSync ?? writeFileSync;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const path = join(ROOT, summary.recordPath);
  mkdir(dirname(path), { recursive: true });
  write(path, summary.recordBody, "utf8");
  return path;
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
  if (options.identifier === "") {
    console.error("--identifier is required");
    process.exitCode = 2;
    return;
  }

  let summary;
  try {
    const readToken = resolveReadToken({ account: options.keychainAccount });
    const source = new LinearItemSource(createLinearTransport({ token: readToken }));
    const hydrated = await source.fetchIssueByIdentifier(options.identifier);
    if (hydrated === null) {
      throw new Error(`no Linear issue found for identifier "${options.identifier}"`);
    }

    const catalog = buildRepoCatalog(loadFallbackOwners());
    const repoInferenceItem = repoInferenceItemFor(hydrated);
    const persistedFingerprint = loadPersistedAnalyzerFingerprint(
      mapWorkspaceItem(hydrated).recordPath,
    );

    // Resolve the checkout dir lazily — only when the repo is known and --analyze is on do we
    // touch git or the model. analyzeItem itself decides whether to call runModel.
    const inference = inferTargetRepo(repoInferenceItem, catalog);
    let runModelDeps = {};
    if (inference.repo !== null && options.analyze) {
      const profile = repositoryProfileFor(inference.repo);
      const checkoutDir = join(options.checkoutsDir, profile.checkoutDir);
      const repoHead = readRepoHead(checkoutDir);
      runModelDeps = {
        repoHead,
        verifySha: makeGitShaVerifier(checkoutDir),
        runModel: async ({ profile: p, repoHead: head }) => {
          const { item, context, git } = buildHarnessInputs(hydrated, p, head);
          const prompt = buildAnalysisPrompt(hydrated, p, git.mainSha || head);
          const decision = runCodex({
            item,
            context,
            git,
            model: "internal",
            openclawDir: checkoutDir,
            reasoningEffort: options.reasoningEffort,
            sandboxMode: "read-only",
            serviceTier: "",
            timeoutMs: options.timeoutMs,
            workDir: join(ROOT, ".artifacts", "linear-analyze"),
            prompt,
          });
          return decision;
        },
      };
    } else if (inference.repo !== null) {
      // Dry-run still computes the fingerprint; supply a HEAD without calling the model.
      const profile = repositoryProfileFor(inference.repo);
      const checkoutDir = join(options.checkoutsDir, profile.checkoutDir);
      try {
        runModelDeps = { repoHead: readRepoHead(checkoutDir) };
      } catch {
        runModelDeps = { repoHead: "unknown" };
      }
    }

    summary = await analyzeItem(hydrated, options, {
      catalog,
      repoInferenceItem,
      repoHead: runModelDeps.repoHead ?? "unknown",
      verifySha: runModelDeps.verifySha,
      runModel: runModelDeps.runModel,
      modelId: "internal",
      persistedFingerprint,
    });

    if (summary.analyzed && summary.recordBody) {
      summary.recordWritten = writeAnalyzerRecord(summary);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    // Drop the large recordBody from the JSON to keep the receipt compact.
    const { recordBody: _drop, ...rest } = summary;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log(printHuman(summary));
  }
}

function printHuman(s) {
  const out = [];
  out.push(`Item:        ${s.identifier}`);
  out.push(`Disposition: ${s.disposition}`);
  out.push(`Repo:        ${s.repo ?? "(none)"}${s.via ? ` (via ${s.via})` : ""}`);
  out.push(`Analyzed:    ${s.analyzed}`);
  if (s.skipped) out.push(`Skipped:     ${s.skipped}`);
  if (s.analyzed) {
    out.push(`Close reason:  ${s.closeReason}`);
    out.push(`Close-leaning: ${s.closeLeaning} (advisory — ClawSweeper never closes)`);
    out.push(`Plan action:   ${s.planAction}`);
    if (s.shaVerification) {
      out.push(
        `Shas:          cited=${s.shaVerification.citedShas.length} verified=${s.shaVerification.verifiedShas.length} unverifiable=${s.shaVerification.unverifiableShas.length}`,
      );
    }
    if (s.recordWritten) out.push(`Record:        ${s.recordWritten}`);
  }
  return out.join("\n");
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
  return `Usage: node scripts/linear-analyze.mjs --identifier <KEY> [options]

Runs ClawSweeper's analysis layer for ONE Linear issue. --analyze is OFF by default (dry-run:
infers the repo, classifies, and reports what WOULD run — no model call, no write). With
--analyze it runs the read-only Codex review harness against the mapped local checkout, the
host re-verifies cited shas, derives the advisory closeLeaning hint, renders the review body,
and persists an audit record. It NEVER closes and never mutates Linear state.

Options:
  --identifier <KEY>         Linear identifier, e.g. PAR-244 (required)
  --analyze                  Run the read-only model (default: dry-run, no model call)
  --now <iso>                ISO 8601 "now" for staleness (default: current time)
  --stale-days <n>           Staleness threshold in days (default: ${DEFAULT_STALE_DAYS})
  --required-label <label>   Require one of these labels (repeatable)
  --exclusion-label <label>  Skip items with this label (repeatable)
  --protected-label <label>  Mark items with this label protected (repeatable)
  --checkouts-dir <path>     Parent dir holding per-repo checkouts (default: repo parent)
  --reasoning-effort <e>     Codex reasoning effort (default: ${DEFAULT_REASONING_EFFORT})
  --timeout-ms <n>           Model timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --keychain-account <a>     Keychain account for the read key (default: ${DEFAULT_KEYCHAIN_ACCOUNT})
  --json                     Emit the JSON summary
  --help, -h                 Show this help`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
