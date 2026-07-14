#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  changedFilesForCommit,
  isReviewableCommitPath,
  skippedNonCodeReport,
} from "./commit-classifier.js";
import { publishCheckFromReport, splitFrontMatter } from "./commit-checks.js";
import { argBool, argNumber, argString, parseArgs, type Args } from "./clawsweeper-args.js";
import {
  codexEnv,
  codexInternalModelValues,
  codexLoginConfig,
  codexModelArgs,
  codexSensitiveEnvValues,
  PUBLIC_CODEX_MODEL,
} from "./codex-env.js";
import {
  codexProcessErrorCode,
  runCodexProcess,
  type CodexProcessResult,
} from "./codex-process.js";
import { redactCodexText } from "./codex-output-capture.js";
import {
  hydrateCommitReviewGitHubContext,
  readCommitReviewGitHubContext,
  renderCommitReviewGitHubContext,
  writeCommitReviewGitHubContext,
  type CommitReviewGitHubContext,
} from "./commit-review-context.js";
import { resolveSpawnCommand, runText } from "./command.js";
import {
  configuredRepositoryProfileFor,
  DEFAULT_TARGET_REPO,
  repositoryProfileFor,
} from "./repository-profiles.js";
import {
  commitReviewLifecycleSucceeded,
  recordCommitArtifactPrepared,
  recordCommitLifecycleEvent,
  recordCommitWorkflowEvent,
  runCommitMutation,
  type CommitLifecycleInput,
} from "./commit-action-ledger.js";
import {
  ACTION_EVENT_REASON_CODES,
  ACTION_EVENT_STATUSES,
  ACTION_EVENT_TYPES,
} from "./action-ledger.js";

export { isReviewableCommitPath } from "./commit-classifier.js";

interface CommitMetadata {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  authoredAt: string;
  committedAt: string;
  subject: string;
  coAuthors: string[];
  githubAuthor: string;
  githubCommitter: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CODEX_MODEL = PUBLIC_CODEX_MODEL;
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_SERVICE_TIER = "";
const COMMIT_REVIEW_CHECK_NAME = "ClawSweeper Commit Review";
const COMMIT_REVIEW_SUCCESS_RESULTS = new Set([
  "nothing_found",
  "findings",
  "inconclusive",
  "skipped_non_code",
]);
const COMMIT_REVIEW_DIAGNOSTIC_VERSION = 1;

interface CommitReviewDiagnostic {
  diagnostic_version: number;
  commit_sha: string;
  outcome: "completed" | "failed";
  failure_reason: "none" | "timeout" | "process_error" | "nonzero_exit" | "missing_report";
  exit_status: number | null;
  signal: NodeJS.Signals | null;
  stdout_capture_bytes: number;
  stderr_capture_bytes: number;
  report_produced: boolean;
}

function run(command: string, commandArgs: string[], options: { cwd?: string } = {}): string {
  return runText(command, commandArgs, { cwd: options.cwd });
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function assertSha(value: string, label = "sha"): string {
  const sha = value.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`Invalid ${label}: ${value}`);
  return sha.toLowerCase();
}

function commitLifecycle(repository: string, sha: string): CommitLifecycleInput {
  return {
    repository,
    sha,
  };
}

function repoSlug(targetRepo: string): string {
  return repositoryProfileFor(targetRepo).slug;
}

export function commitReportRelativePath(targetRepo: string, sha: string): string {
  return `records/${repoSlug(targetRepo)}/commits/${assertSha(sha)}.md`;
}

function artifactReportRelativePath(targetRepo: string, sha: string): string {
  return join(repoSlug(targetRepo), "commits", `${assertSha(sha)}.md`);
}

function stripEmailIdentity(value: string): string {
  return value
    .replace(/\s*<[^>\n]*@[^>\n]*>\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function personLabel(name: string, githubLogin: string): string {
  const login = githubLogin.trim();
  if (login && login !== "unknown") return `@${login}`;
  return stripEmailIdentity(name) || "unknown";
}

function prehydratedGitHubLogin(value: string, label: string): string {
  const login = value.trim();
  if (!login) return "";
  if (login.length > 100 || !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(login)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return login;
}

export function parseCoAuthors(body: string): string[] {
  const coAuthors: string[] = [];
  for (const match of body.matchAll(/^Co-authored-by:\s*(.+?)\s*$/gim)) {
    const value = stripEmailIdentity(match[1]?.trim() ?? "");
    if (value && !coAuthors.includes(value)) coAuthors.push(value);
  }
  return coAuthors;
}

function optionalGhJson(path: string, jq: string): string {
  try {
    return runText("gh", ["api", path, "--jq", jq], {
      maxBuffer: 1024 * 1024,
      trim: "both",
    });
  } catch {
    return "";
  }
}

export function commitMetadata(
  targetDir: string,
  targetRepo: string,
  sha: string,
  offline = false,
): CommitMetadata {
  const separator = "\x1f";
  const raw = run(
    "git",
    [
      "show",
      "-s",
      `--format=%H${separator}%P${separator}%an${separator}%ae${separator}%cn${separator}%ce${separator}%aI${separator}%cI${separator}%s${separator}%B`,
      sha,
    ],
    { cwd: targetDir },
  );
  const parts = raw.split(separator);
  const body = parts.slice(9).join(separator);
  // Offline mode (e.g. local-review) must not contact GitHub: skip the gh-api
  // author/committer hydration. `gh` uses its own configured auth, so removing
  // token env vars is not enough — the only way to honor the "no GitHub access"
  // contract is to not run `gh` at all.
  const githubAuthor = offline
    ? ""
    : optionalGhJson(`repos/${targetRepo}/commits/${sha}`, ".author.login // empty");
  const githubCommitter = offline
    ? ""
    : optionalGhJson(`repos/${targetRepo}/commits/${sha}`, ".committer.login // empty");
  return {
    sha: assertSha(parts[0] ?? sha),
    parents: (parts[1] ?? "")
      .split(/\s+/)
      .map((parent) => parent.trim())
      .filter(Boolean),
    authorName: parts[2] ?? "",
    authorEmail: parts[3] ?? "",
    committerName: parts[4] ?? "",
    committerEmail: parts[5] ?? "",
    authoredAt: parts[6] ?? "",
    committedAt: parts[7] ?? "",
    subject: parts[8] ?? "",
    coAuthors: parseCoAuthors(body),
    githubAuthor,
    githubCommitter,
  };
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlArray(values: string[]): string {
  if (!values.length) return "[]";
  return values.map((value) => `\n  - ${yamlScalar(value)}`).join("");
}

function commitDiffSummary(targetDir: string, baseSha: string, sha: string): string {
  const stat = run("git", ["diff", "--stat", "--summary", `${baseSha}..${sha}`], {
    cwd: targetDir,
  });
  const names = run("git", ["diff", "--name-status", `${baseSha}..${sha}`], { cwd: targetDir });
  return `## Diff Summary

\`\`\`
${stat || "(no stat output)"}
\`\`\`

## Changed Files

\`\`\`
${names || "(no changed files)"}
\`\`\``;
}

function promptForCommit(options: {
  targetDir: string;
  targetRepo: string;
  sha: string;
  baseSha: string;
  metadata: CommitMetadata;
  githubContext: CommitReviewGitHubContext | null;
  additionalPrompt: string;
}): string {
  const prompt = readFileSync(join(ROOT, "prompts", "review-commit.md"), "utf8");
  const coAuthors = options.metadata.coAuthors.length
    ? options.metadata.coAuthors.map((value) => `- ${value}`).join("\n")
    : "- none";
  const additionalPrompt = options.additionalPrompt.trim()
    ? `\n## Additional Manual Prompt\n\n${options.additionalPrompt.trim()}\n`
    : "";
  const githubContext = options.githubContext
    ? `\n${renderCommitReviewGitHubContext(options.githubContext)}\n`
    : "";
  return `${prompt}

## Commit Under Review

- Target repo: ${options.targetRepo}
- Commit SHA: ${options.sha}
- Base SHA: ${options.baseSha}
- Range: ${options.baseSha}..${options.sha}
- Subject: ${options.metadata.subject}
- Author: ${personLabel(options.metadata.authorName, options.metadata.githubAuthor)}
- Committer: ${personLabel(options.metadata.committerName, options.metadata.githubCommitter)}
- GitHub author: ${options.metadata.githubAuthor || "unknown"}
- GitHub committer: ${options.metadata.githubCommitter || "unknown"}
- Authored at: ${options.metadata.authoredAt}
- Committed at: ${options.metadata.committedAt}
- Co-authors:
${coAuthors}

${githubContext}
${commitDiffSummary(options.targetDir, options.baseSha, options.sha)}
${additionalPrompt}`;
}

function stripMarkdownFence(markdown: string): string {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? (match[1]?.trim() ?? trimmed) : trimmed;
}

function failureReport(options: {
  targetRepo: string;
  sha: string;
  baseSha: string;
  metadata: CommitMetadata;
  detail: string;
  timeout: boolean;
}): string {
  return `---
sha: ${options.sha}
parent: ${options.baseSha}
repository: ${options.targetRepo}
author: ${yamlScalar(personLabel(options.metadata.authorName, options.metadata.githubAuthor))}
committer: ${yamlScalar(personLabel(options.metadata.committerName, options.metadata.githubCommitter))}
github_author: ${yamlScalar(options.metadata.githubAuthor || "unknown")}
github_committer: ${yamlScalar(options.metadata.githubCommitter || "unknown")}
co_authors: ${options.metadata.coAuthors.length ? yamlArray(options.metadata.coAuthors) : "[]"}
commit_authored_at: ${yamlScalar(options.metadata.authoredAt)}
commit_committed_at: ${yamlScalar(options.metadata.committedAt)}
result: failed
confidence: low
highest_severity: none
check_conclusion: ${options.timeout ? "timed_out" : "neutral"}
reviewed_at: ${new Date().toISOString()}
---

# Commit ${options.sha.slice(0, 12)}

Commit review failed before a reliable report could be produced.

## Failure

\`\`\`
${options.detail}
\`\`\`
`;
}

function ensureCommitReportTimestamps(markdown: string, metadata: CommitMetadata): string {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return markdown;
  const fields = [
    ["commit_authored_at", yamlScalar(metadata.authoredAt)],
    ["commit_committed_at", yamlScalar(metadata.committedAt)],
  ] as const;
  let frontMatter = match[1] ?? "";
  for (const [key, value] of fields) {
    const line = `${key}: ${value}`;
    const pattern = new RegExp(`^${key}:.*$`, "m");
    frontMatter = pattern.test(frontMatter)
      ? frontMatter.replace(pattern, line)
      : frontMatter.replace(/^result:/m, `${line}\nresult:`);
  }
  return markdown.replace(/^---\n[\s\S]*?\n---/, `---\n${frontMatter}\n---`);
}

function runCodex(options: {
  targetDir: string;
  targetRepo: string;
  sha: string;
  baseSha: string;
  metadata: CommitMetadata;
  githubContext: CommitReviewGitHubContext | null;
  model: string;
  reasoningEffort: string;
  sandboxMode: string;
  serviceTier: string;
  timeoutMs: number;
  workDir: string;
  additionalPrompt: string;
  extraCodexConfig?: readonly string[];
}): string {
  const lifecycle = commitLifecycle(options.targetRepo, options.sha);
  ensureDir(options.workDir);
  const diagnosticPath = join(options.workDir, `${options.sha}.diagnostic.json`);
  const captureDir = mkdtempSync(join(tmpdir(), "clawsweeper-commit-review-"));
  const rawOutputPath = join(captureDir, `${options.sha}.md`);
  const stdoutPath = join(captureDir, `${options.sha}.jsonl`);
  const stderrPath = join(captureDir, `${options.sha}.stderr.log`);
  const prompt = promptForCommit({
    targetDir: options.targetDir,
    targetRepo: options.targetRepo,
    sha: options.sha,
    baseSha: options.baseSha,
    metadata: options.metadata,
    githubContext: options.githubContext,
    additionalPrompt: options.additionalPrompt,
  });
  const codexConfig = [
    `model_reasoning_effort="${options.reasoningEffort}"`,
    codexLoginConfig(),
    'approval_policy="never"',
    ...(options.extraCodexConfig ?? []),
  ];
  recordCommitLifecycleEvent(lifecycle, {
    type: ACTION_EVENT_TYPES.reviewStarted,
    status: ACTION_EVENT_STATUSES.started,
    reasonCode: ACTION_EVENT_REASON_CODES.selected,
    mutation: false,
    component: "commit_review",
    state: "started",
    reviewMode: "commit_review",
    eventIdentity: { sha: options.sha },
  });
  if (options.serviceTier) codexConfig.splice(1, 0, `service_tier="${options.serviceTier}"`);
  const processEnv = codexEnv();
  const redactionSecrets = [
    ...new Set([...codexSensitiveEnvValues(process.env), ...codexInternalModelValues()]),
  ].filter((value) => value.length >= 6);
  let result: CodexProcessResult;
  let report = "";
  try {
    result = runCodexProcess({
      args: [
        "exec",
        ...codexModelArgs(options.model),
        ...codexConfig.flatMap((config) => ["-c", config]),
        "-C",
        options.targetDir,
        "--output-last-message",
        rawOutputPath,
        "--json",
        "--sandbox",
        options.sandboxMode,
        "-",
      ],
      cwd: options.targetDir,
      env: processEnv,
      input: prompt,
      stdoutPath,
      stderrPath,
      timeoutMs: options.timeoutMs,
      redactValues: redactionSecrets,
    });
    if (existsSync(rawOutputPath)) {
      report = redactCommitReviewText(readFileSync(rawOutputPath, "utf8"), redactionSecrets);
    }
    const diagnostic = commitReviewDiagnostic({
      sha: options.sha,
      result,
      reportProduced: report.length > 0,
      stdoutPath,
      stderrPath,
    });
    writeFileSync(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    recordCommitArtifactPrepared(lifecycle, {
      path: diagnosticPath,
      kind: "commit_review_diagnostic",
      logKind: "diagnostic",
    });
    if (diagnostic.outcome === "failed") {
      const timeout = diagnostic.failure_reason === "timeout";
      const detail = commitReviewFailureDetail(diagnostic);
      recordCommitLifecycleEvent(lifecycle, {
        type: ACTION_EVENT_TYPES.reviewFailed,
        status: ACTION_EVENT_STATUSES.failed,
        reasonCode: timeout
          ? ACTION_EVENT_REASON_CODES.timeout
          : ACTION_EVENT_REASON_CODES.exception,
        mutation: false,
        component: "commit_review",
        state: "failed",
        reviewMode: "commit_review",
        eventIdentity: {
          sha: options.sha,
          errorKind: diagnostic.failure_reason,
        },
      });
      return failureReport({
        targetRepo: options.targetRepo,
        sha: options.sha,
        baseSha: options.baseSha,
        metadata: options.metadata,
        detail,
        timeout,
      });
    }
    recordCommitLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.reviewCompleted,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      mutation: false,
      component: "commit_review",
      state: "completed",
      reviewMode: "commit_review",
      eventIdentity: { sha: options.sha },
    });
    return stripMarkdownFence(report);
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
}

function redactCommitReviewText(value: string, secrets: readonly string[]): string {
  return redactCodexText(value, secrets);
}

function commitReviewDiagnostic(options: {
  sha: string;
  result: CodexProcessResult;
  reportProduced: boolean;
  stdoutPath: string;
  stderrPath: string;
}): CommitReviewDiagnostic {
  const timedOut = codexProcessErrorCode(options.result.error) === "ETIMEDOUT";
  const failureReason = timedOut
    ? "timeout"
    : options.result.error
      ? "process_error"
      : options.result.status !== 0
        ? "nonzero_exit"
        : !options.reportProduced
          ? "missing_report"
          : "none";
  return {
    diagnostic_version: COMMIT_REVIEW_DIAGNOSTIC_VERSION,
    commit_sha: options.sha,
    outcome: failureReason === "none" ? "completed" : "failed",
    failure_reason: failureReason,
    exit_status: options.result.status,
    signal: options.result.signal,
    stdout_capture_bytes: fileSize(options.stdoutPath),
    stderr_capture_bytes: fileSize(options.stderrPath),
    report_produced: options.reportProduced,
  };
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function commitReviewFailureDetail(diagnostic: CommitReviewDiagnostic): string {
  return [
    `reason: ${diagnostic.failure_reason}`,
    `exit_status: ${diagnostic.exit_status ?? "unknown"}`,
    `signal: ${diagnostic.signal ?? "none"}`,
    `stdout_capture_bytes: ${diagnostic.stdout_capture_bytes}`,
    `stderr_capture_bytes: ${diagnostic.stderr_capture_bytes}`,
    `report_produced: ${diagnostic.report_produced}`,
  ].join("\n");
}

function reviewCommand(args: Args): void {
  const targetRepo = argString(args, "target_repo", DEFAULT_TARGET_REPO);
  const targetDir = resolve(
    argString(args, "target_dir", repositoryProfileFor(targetRepo).checkoutDir),
  );
  const sha = assertSha(argString(args, "commit_sha", ""));
  const lifecycle = commitLifecycle(targetRepo, sha);
  const deferWorkflowCompletion = argBool(args, "defer_workflow_completion");
  recordCommitWorkflowEvent(lifecycle, "started");
  try {
    const githubContextPath = argString(args, "github_context", "");
    const githubContext = githubContextPath
      ? readCommitReviewGitHubContext(resolve(githubContextPath), {
          targetRepo,
          sha,
        })
      : null;
    const prehydratedGitHubMetadata =
      argBool(args, "prehydrated_github_metadata") || githubContext !== null;
    const metadata = commitMetadata(targetDir, targetRepo, sha, prehydratedGitHubMetadata);
    if (githubContext) {
      metadata.githubAuthor = githubContext.github_author;
      metadata.githubCommitter = githubContext.github_committer;
    } else if (prehydratedGitHubMetadata) {
      metadata.githubAuthor = prehydratedGitHubLogin(
        argString(args, "github_author", ""),
        "GitHub author login",
      );
      metadata.githubCommitter = prehydratedGitHubLogin(
        argString(args, "github_committer", ""),
        "GitHub committer login",
      );
    }
    const baseSha = assertSha(argString(args, "base_sha", metadata.parents[0] ?? ""), "base sha");
    const reportDir = resolve(argString(args, "report_dir", "records"));
    const artifactMode = argBool(args, "artifact_mode");
    const outputPath = artifactMode
      ? join(reportDir, artifactReportRelativePath(targetRepo, sha))
      : resolve(commitReportRelativePath(targetRepo, sha));
    const additionalPrompt = argString(
      args,
      "additional_prompt",
      process.env.COMMIT_SWEEPER_ADDITIONAL_PROMPT ?? "",
    );
    const markdown = ensureCommitReportTimestamps(
      runCodex({
        targetDir,
        targetRepo,
        sha,
        baseSha,
        metadata,
        githubContext,
        model: argString(args, "codex_model", DEFAULT_CODEX_MODEL),
        reasoningEffort: argString(args, "codex_reasoning_effort", DEFAULT_REASONING_EFFORT),
        sandboxMode: argString(args, "codex_sandbox", "danger-full-access"),
        serviceTier: argString(args, "codex_service_tier", DEFAULT_SERVICE_TIER),
        timeoutMs: argNumber(args, "codex_timeout_ms", 1_800_000),
        workDir: resolve(argString(args, "work_dir", join(reportDir, ".codex"))),
        additionalPrompt,
      }),
      metadata,
    );
    ensureDir(dirname(outputPath));
    writeFileSync(outputPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
    recordCommitArtifactPrepared(lifecycle, {
      path: outputPath,
      kind: "commit_review_report",
    });
    const reportResult = commitReviewReportResult(outputPath);
    if (
      argBool(args, "require_publishable_report") &&
      !COMMIT_REVIEW_SUCCESS_RESULTS.has(reportResult)
    ) {
      throw new Error(`commit review report result is not publishable: ${reportResult}`);
    }
    if (!deferWorkflowCompletion) {
      recordCommitWorkflowEvent(lifecycle, "completed");
      recordCommitWorkflowEvent(lifecycle, "finalized");
    }
    console.log(outputPath);
  } catch (error) {
    if (!deferWorkflowCompletion) {
      recordCommitWorkflowEvent(lifecycle, "failed", error);
      recordCommitWorkflowEvent(lifecycle, "finalized");
    }
    throw error;
  }
}

function hydrateGitHubContextCommand(args: Args): void {
  const targetRepo = argString(args, "target_repo", DEFAULT_TARGET_REPO);
  const targetDir = resolve(
    argString(args, "target_dir", repositoryProfileFor(targetRepo).checkoutDir),
  );
  const sha = assertSha(argString(args, "commit_sha", ""));
  const outputPath = resolve(argString(args, "output", `${sha}.github-context.json`));
  ensureDir(dirname(outputPath));
  writeCommitReviewGitHubContext(
    outputPath,
    hydrateCommitReviewGitHubContext({
      targetDir,
      targetRepo,
      sha,
    }),
  );
  console.log(outputPath);
}

// GitHub credential env vars scrubbed before the offline local-review engine runs.
// Covers both gh enterprise aliases (GH_ENTERPRISE_TOKEN and GITHUB_ENTERPRISE_TOKEN),
// since gh honors either; this is belt-and-suspenders with the empty GH_CONFIG_DIR set
// per run.
export const LOCAL_REVIEW_SCRUBBED_TOKEN_ENV: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "COMMIT_SWEEPER_TARGET_GH_TOKEN",
  "CLAWSWEEPER_PROOF_INSPECTION_TOKEN",
];
export const LOCAL_REVIEW_WEB_SEARCH_CONFIG = 'web_search="disabled"';

// `git status --porcelain` of a checkout (empty string = clean). Shared by the offline
// committed-range review paths (commit-sweeper `local-review` and clawsweeper `--local-range`)
// so both enforce the same "review COMMITTED work on a clean checkout" contract.
export function dirtyWorktree(targetDir: string): string {
  return run("git", ["status", "--porcelain"], { cwd: targetDir }).trim();
}

// Withhold every GitHub credential from an offline review engine. Shared by the offline
// committed-range review paths so neither can leak a token to the engine it spawns.
export function scrubGitHubCredentialEnv(): void {
  for (const tokenVar of LOCAL_REVIEW_SCRUBBED_TOKEN_ENV) {
    delete process.env[tokenVar];
  }
}

// Point `gh` at an empty config dir so an offline reviewer finds no cached credentials —
// token-env deletion alone can't stop gh's own configured auth. Shared by the offline
// review paths. `parentDir` keeps the empty dir inside a run dir (cleaned with the run);
// omit it for a throwaway temp dir. Returns the dir set on GH_CONFIG_DIR.
export function isolateGitHubConfigDir(parentDir?: string): string {
  let ghEmptyConfig: string;
  if (parentDir) {
    ghEmptyConfig = join(parentDir, ".gh-empty");
    mkdirSync(ghEmptyConfig, { recursive: true });
  } else {
    ghEmptyConfig = mkdtempSync(join(tmpdir(), "cs-gh-empty-"));
  }
  process.env.GH_CONFIG_DIR = ghEmptyConfig;
  return ghEmptyConfig;
}

export function localReviewAdditionalPrompt(
  baseSha: string,
  headSha: string,
  baseBranch: string,
): string {
  return `This is a LOCAL pre-PR review of the COMMITTED range ${baseSha.slice(0, 8)}..${headSha.slice(0, 8)} (your branch vs ${baseBranch}) on a clean checkout — no staged or untracked changes. Review code correctness, bugs, and security; ignore PR metadata. This review is offline: do not run gh, use web search, access URLs, or make any network request. Use only the local checkout and git history.`;
}

// Local, offline pre-PR review of a whole branch: reviews the committed range
// merge-base(base, HEAD)..HEAD as a single unit, reusing the Commit Sweeper engine.
// Conforms to the #253 replacement spec: clean checkout, unique run dir, no GitHub
// token, and reject unsupported repos (never fall back to a foreign profile).
function localReviewCommand(args: Args): void {
  const targetDir = resolve(argString(args, "target_dir", "."));
  const baseBranch = argString(args, "base", "main");
  const reportDir = resolve(
    argString(args, "report_dir", join(homedir(), ".clawsweeper-local-reviews")),
  );

  // Spec: genuinely offline — withhold every GitHub credential from the review engine.
  scrubGitHubCredentialEnv();

  // Spec: committed-range review requires a clean checkout (no hidden staged/untracked work).
  const dirtyTree = dirtyWorktree(targetDir);
  if (dirtyTree) {
    console.error(`[local-review] working tree not clean — commit or stash first:\n${dirtyTree}`);
    process.exit(1);
  }

  const targetRepo =
    argString(args, "target_repo", "") ||
    run("git", ["remote", "get-url", "origin"], { cwd: targetDir })
      .replace(/.*github\.com[:/]/, "")
      .replace(/\.git\s*$/, "")
      .trim();

  // Spec: reject unsupported repos — never silently fall back to a foreign profile.
  const profile = configuredRepositoryProfileFor(targetRepo);
  if (!profile) {
    console.error(
      `[local-review] no review profile for '${targetRepo}'. Add a repository profile, or pass --target-repo <known-repo>.`,
    );
    process.exit(1);
  }
  const profileSlug = profile.slug;

  // Range = merge-base(base, HEAD)..HEAD — the whole branch, reviewed as one unit.
  const headSha = run("git", ["rev-parse", "HEAD"], { cwd: targetDir }).trim();
  const baseSha = run("git", ["merge-base", baseBranch, "HEAD"], { cwd: targetDir }).trim();
  if (!baseSha || baseSha === headSha) {
    console.error(`[local-review] no commits on HEAD beyond ${baseBranch} — nothing to review.`);
    process.exit(1);
  }

  const metadata = commitMetadata(targetDir, targetRepo, headSha, true);

  // Spec: unique per-run dir so concurrent runs never collide on result paths.
  const runDir = join(reportDir, `run-${headSha.slice(0, 8)}-${Date.now()}-${process.pid}`);
  ensureDir(runDir);

  // Spec: hard-enforce no GitHub access. The review prompt suggests `gh` for issue
  // refs, and `gh` uses its own configured auth (token-env deletion can't stop it),
  // so point it at an empty config dir — any `gh` the spawned reviewer runs finds
  // no cached credentials. Belt-and-suspenders with Codex's read-only sandbox.
  isolateGitHubConfigDir(runDir);

  const additionalPrompt = localReviewAdditionalPrompt(baseSha, headSha, baseBranch);

  console.error(
    `[local-review] repo=${targetRepo} profile=${profileSlug} base=${baseBranch} range=${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}`,
  );

  const markdown = ensureCommitReportTimestamps(
    runCodex({
      targetDir,
      targetRepo,
      sha: headSha,
      baseSha,
      metadata,
      githubContext: null,
      model: argString(args, "codex_model", DEFAULT_CODEX_MODEL),
      reasoningEffort: argString(args, "codex_reasoning_effort", DEFAULT_REASONING_EFFORT),
      sandboxMode: argString(args, "codex_sandbox", "read-only"),
      serviceTier: argString(args, "codex_service_tier", DEFAULT_SERVICE_TIER),
      timeoutMs: argNumber(args, "codex_timeout_ms", 1_800_000),
      workDir: runDir,
      additionalPrompt,
      extraCodexConfig: [LOCAL_REVIEW_WEB_SEARCH_CONFIG],
    }),
    metadata,
  );

  const outputPath = join(runDir, "local-review.md");
  writeFileSync(outputPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
  console.error(`[local-review] report written to ${outputPath}`);
  console.log(outputPath);
}

function commitShasArg(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((sha) => sha.trim())
    .filter(Boolean)
    .map((sha) => assertSha(sha));
}

function classifyCommand(args: Args): void {
  const targetRepo = argString(args, "target_repo", DEFAULT_TARGET_REPO);
  const targetDir = resolve(
    argString(args, "target_dir", repositoryProfileFor(targetRepo).checkoutDir),
  );
  const artifactDir = resolve(argString(args, "artifact_dir", "skipped-commit-artifacts"));
  const commits = commitShasArg(argString(args, "commit_shas", ""));
  const review: string[] = [];
  const skipped: string[] = [];
  for (const sha of commits) {
    const metadata = commitMetadata(targetDir, targetRepo, sha);
    const changedFiles = changedFilesForCommit(targetDir, sha, metadata.parents);
    if (changedFiles.some(isReviewableCommitPath)) {
      review.push(sha);
      continue;
    }
    const outputPath = join(artifactDir, artifactReportRelativePath(targetRepo, sha));
    ensureDir(dirname(outputPath));
    writeFileSync(
      outputPath,
      skippedNonCodeReport({ targetRepo, sha, metadata, changedFiles }),
      "utf8",
    );
    skipped.push(sha);
  }
  console.log(JSON.stringify({ review, skipped }, null, 2));
}

function publishCheckCommand(args: Args): void {
  const targetRepo = argString(args, "target_repo", DEFAULT_TARGET_REPO);
  const reportRepo = argString(
    args,
    "report_repo",
    process.env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper",
  );
  const reportRevision = argString(args, "report_revision", "main");
  const reportPath = argString(args, "report_path", "");
  if (!reportPath) throw new Error("Missing --report-path");
  const markdown = readFileSync(reportPath, "utf8");
  const { frontMatter } = splitFrontMatter(markdown);
  const sha = assertSha(argString(args, "commit_sha", frontMatter.sha ?? ""));
  const reportRelativePath =
    argString(args, "report_relative_path", "") || commitReportRelativePath(targetRepo, sha);
  const lifecycle = commitLifecycle(targetRepo, sha);
  const continueWorkflow = argBool(args, "continue_workflow");
  if (!continueWorkflow) recordCommitWorkflowEvent(lifecycle, "started");
  try {
    runCommitMutation(lifecycle, {
      kind: "commit_check_publication",
      identity: {
        targetRepo,
        reportRepo,
        reportRevision,
        reportRelativePath,
        sha,
        checkName: argString(args, "check_name", COMMIT_REVIEW_CHECK_NAME),
        reportSha256: createHash("sha256").update(markdown).digest("hex"),
      },
      operation: () =>
        publishCheckFromReport({
          targetRepo,
          reportRepo,
          reportRevision,
          reportPath,
          reportRelativePath,
          sha,
          checkName: argString(args, "check_name", COMMIT_REVIEW_CHECK_NAME),
        }),
    });
    if (!continueWorkflow) {
      recordCommitWorkflowEvent(lifecycle, "completed");
      recordCommitWorkflowEvent(lifecycle, "finalized");
    }
  } catch (error) {
    if (!continueWorkflow) {
      recordCommitWorkflowEvent(lifecycle, "failed", error);
      recordCommitWorkflowEvent(lifecycle, "finalized");
    }
    throw error;
  }
}

function finishReviewCommand(args: Args): void {
  const targetRepo = argString(args, "target_repo", DEFAULT_TARGET_REPO);
  const sha = assertSha(argString(args, "commit_sha", ""));
  const lifecycle = commitLifecycle(targetRepo, sha);
  const reviewOutcome = argString(args, "review_outcome", "unknown");
  const checkOutcome = argString(args, "check_outcome", "unknown");
  const checksRequested = argBool(args, "checks_requested");
  const reportPath = argString(args, "report_path", "");
  const reportResult = commitReviewReportResult(reportPath);
  if (argBool(args, "start_workflow")) recordCommitWorkflowEvent(lifecycle, "started");
  if (
    commitReviewLifecycleSucceeded({
      reviewOutcome,
      checkOutcome,
      checksRequested,
      reportResult,
    })
  ) {
    recordCommitWorkflowEvent(lifecycle, "completed");
  } else {
    recordCommitWorkflowEvent(
      lifecycle,
      "failed",
      new Error(
        argString(
          args,
          "error_kind",
          `review=${reviewOutcome},report=${reportResult},checks_requested=${checksRequested},check=${checkOutcome}`,
        ),
      ),
    );
  }
  recordCommitWorkflowEvent(lifecycle, "finalized");
}

function attestReviewCommand(args: Args): void {
  const targetRepo = argString(args, "target_repo", DEFAULT_TARGET_REPO);
  const sha = assertSha(argString(args, "commit_sha", ""));
  const reportPath = resolve(argString(args, "report_path", ""));
  const lifecycle = commitLifecycle(targetRepo, sha);
  try {
    if (!existsSync(reportPath)) throw new Error("commit review report is missing");
    const markdown = readFileSync(reportPath, "utf8");
    const { frontMatter } = splitFrontMatter(markdown);
    if (assertSha(String(frontMatter.sha ?? "")) !== sha) {
      throw new Error("commit review report SHA does not match the attested commit");
    }
    if (
      String(frontMatter.repository ?? "")
        .trim()
        .toLowerCase() !== targetRepo.toLowerCase()
    ) {
      throw new Error("commit review report repository does not match the attested target");
    }
    const reportResult = commitReviewReportResult(reportPath);
    if (!COMMIT_REVIEW_SUCCESS_RESULTS.has(reportResult)) {
      throw new Error(`commit review report result is not publishable: ${reportResult}`);
    }
    recordCommitArtifactPrepared(lifecycle, {
      path: reportPath,
      kind: "commit_review_report",
    });
    recordCommitLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.reviewCompleted,
      status: ACTION_EVENT_STATUSES.completed,
      reasonCode: ACTION_EVENT_REASON_CODES.completed,
      mutation: false,
      component: "commit_review_attestor",
      state: "attested",
      reviewMode: "commit_review",
      eventIdentity: { sha, reportResult },
    });
  } catch (error) {
    recordCommitLifecycleEvent(lifecycle, {
      type: ACTION_EVENT_TYPES.reviewFailed,
      status: ACTION_EVENT_STATUSES.failed,
      reasonCode: ACTION_EVENT_REASON_CODES.validationFailed,
      mutation: false,
      component: "commit_review_attestor",
      state: "attestation_failed",
      reviewMode: "commit_review",
      eventIdentity: { sha },
    });
    throw error;
  }
}

function commitReviewReportResult(reportPath: string): string {
  if (!reportPath || !existsSync(reportPath)) return "missing";
  try {
    const { frontMatter } = splitFrontMatter(readFileSync(reportPath, "utf8"));
    return (
      String(frontMatter.result ?? "missing")
        .trim()
        .toLowerCase() || "missing"
    );
  } catch {
    return "invalid";
  }
}

function collectMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdownFiles(path));
    else if (entry.isFile() && path.endsWith(".md")) files.push(path);
  }
  return files;
}

interface CommitReportSummary {
  path: string;
  sha: string;
  repository: string;
  author: string;
  result: string;
  confidence: string;
  highestSeverity: string;
  checkConclusion: string;
  commitAuthoredAt: string;
  commitCommittedAt: string;
  reviewedAt: string;
  sortTime: number;
}

interface CommitFindingDispatch {
  sha: string;
  targetRepo: string;
  reportPath: string;
  reportUrl: string;
  reportRevision: string;
  reportSha256: string;
  highestSeverity: string;
  checkConclusion: string;
}

function parseDateMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseCommitReportSince(value: string, now = new Date()): Date {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^last\s+/, "");
  if (!trimmed) throw new Error("Missing --since value");
  const match = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)(?:\s+ago)?$/,
  );
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2] ?? "";
    const multiplier = unit.startsWith("m")
      ? 60_000
      : unit.startsWith("h")
        ? 60 * 60_000
        : unit.startsWith("d")
          ? 24 * 60 * 60_000
          : 7 * 24 * 60 * 60_000;
    return new Date(now.getTime() - amount * multiplier);
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed);
  throw new Error(`Invalid --since value: ${value}`);
}

function commitReportTime(frontMatter: Record<string, string | string[] | undefined>): number {
  return (
    parseDateMs(frontMatter.commit_committed_at as string | undefined) ??
    parseDateMs(frontMatter.commit_authored_at as string | undefined) ??
    parseDateMs(frontMatter.reviewed_at as string | undefined) ??
    0
  );
}

function readCommitReportSummary(path: string): CommitReportSummary | undefined {
  const markdown = readFileSync(path, "utf8");
  const { frontMatter } = splitFrontMatter(markdown);
  const sha = frontMatter.sha;
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return undefined;
  return {
    path,
    sha,
    repository: frontMatter.repository ?? "unknown",
    author: frontMatter.author ?? "unknown",
    result: frontMatter.result ?? "unknown",
    confidence: frontMatter.confidence ?? "unknown",
    highestSeverity: frontMatter.highest_severity ?? "unknown",
    checkConclusion: frontMatter.check_conclusion ?? "unknown",
    commitAuthoredAt: frontMatter.commit_authored_at ?? "",
    commitCommittedAt: frontMatter.commit_committed_at ?? "",
    reviewedAt: frontMatter.reviewed_at ?? "",
    sortTime: commitReportTime(frontMatter),
  };
}

function isCommitReportPath(path: string): boolean {
  return /(^|\/)commits\/[0-9a-f]{40}\.md$/i.test(path.replaceAll("\\", "/"));
}

function reportsCommand(args: Args): void {
  const recordsDir = resolve(argString(args, "records_dir", "records"));
  const since = typeof args.since === "string" ? parseCommitReportSince(args.since).getTime() : 0;
  const repository = argString(args, "repo", "");
  const author = argString(args, "author", "").toLowerCase();
  const findingsOnly = argBool(args, "findings");
  const nonCleanOnly = argBool(args, "non_clean");
  const json = argBool(args, "json");
  const reports = collectMarkdownFiles(recordsDir)
    .filter(isCommitReportPath)
    .map(readCommitReportSummary)
    .filter((report): report is CommitReportSummary => Boolean(report))
    .filter((report) => !since || report.sortTime >= since)
    .filter((report) => !repository || report.repository === repository)
    .filter((report) => !author || report.author.toLowerCase().includes(author))
    .filter((report) => !findingsOnly || report.result === "findings")
    .filter(
      (report) =>
        !nonCleanOnly ||
        (report.result !== "nothing_found" && report.result !== "skipped_non_code"),
    )
    .sort((left, right) => right.sortTime - left.sortTime || left.sha.localeCompare(right.sha));

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  if (!reports.length) {
    console.log("No commit reports matched.");
    return;
  }

  console.log(`Found ${reports.length} commit report(s).`);
  for (const report of reports) {
    const time =
      report.commitCommittedAt || report.commitAuthoredAt || report.reviewedAt || "unknown";
    console.log(
      [
        report.sha.slice(0, 12),
        report.result.padEnd(16),
        report.highestSeverity.padEnd(8),
        report.checkConclusion.padEnd(9),
        time,
        report.author,
        relative(process.cwd(), report.path),
      ].join("  "),
    );
  }
}

function copyArtifactsCommand(args: Args): void {
  const artifactDir = resolve(argString(args, "artifact_dir", "commit-artifacts"));
  const recordsDir = resolve(argString(args, "records_dir", "records"));
  let copied = 0;
  for (const file of collectMarkdownFiles(artifactDir)) {
    const relativePath = relative(artifactDir, file);
    const destination = join(recordsDir, relativePath);
    ensureDir(dirname(destination));
    writeFileSync(destination, readFileSync(file, "utf8"), "utf8");
    copied += 1;
  }
  console.log(`copied=${copied}`);
}

function boolString(value: string): boolean {
  return /^(?:true|1|yes|on)$/i.test(value.trim());
}

function githubRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  return repository && runId ? `${server}/${repository}/actions/runs/${runId}` : "";
}

function commitFindingDispatchKey(dispatch: CommitFindingDispatch, reportRepo: string): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        targetRepo: dispatch.targetRepo,
        sha: dispatch.sha,
        reportRepo,
        reportPath: dispatch.reportPath,
        reportSha256: dispatch.reportSha256,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `commit-finding-${digest}`;
}

function dispatchPayload(dispatch: CommitFindingDispatch, reportRepo: string): string {
  return `${JSON.stringify({
    event_type: "clawsweeper_commit_finding",
    client_payload: {
      payload_version: 2,
      dispatch_key: commitFindingDispatchKey(dispatch, reportRepo),
      target_repo: dispatch.targetRepo,
      commit_sha: dispatch.sha,
      report_repo: reportRepo,
      report_path: dispatch.reportPath,
      report_url: dispatch.reportUrl,
      report_revision: dispatch.reportRevision,
      report_sha256: dispatch.reportSha256,
      highest_severity: dispatch.highestSeverity,
      check_conclusion: dispatch.checkConclusion,
      source_run_url: githubRunUrl(),
      enabled: true,
    },
  })}\n`;
}

function workflowDispatchArgs(
  dispatch: CommitFindingDispatch,
  reportRepo: string,
  workflow: string,
): string[] {
  return [
    "workflow",
    "run",
    workflow,
    "--repo",
    "PLACEHOLDER",
    "-f",
    "enabled=true",
    "-f",
    `target_repo=${dispatch.targetRepo}`,
    "-f",
    `commit_sha=${dispatch.sha}`,
    "-f",
    `dispatch_key=${commitFindingDispatchKey(dispatch, reportRepo)}`,
    "-f",
    "payload_version=2",
    "-f",
    `report_repo=${reportRepo}`,
    "-f",
    `report_path=${dispatch.reportPath}`,
    "-f",
    `report_url=${dispatch.reportUrl}`,
    "-f",
    `report_revision=${dispatch.reportRevision}`,
    "-f",
    `report_sha256=${dispatch.reportSha256}`,
  ];
}

function dispatchFailureError(
  options: { dispatch: CommitFindingDispatch; repairRepo: string },
  result: { stdout?: string | null; stderr?: string | null; error?: Error },
): Error & { stdout: string; stderr: string } {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const detail = stderr || stdout || result.error?.message || "unknown gh error";
  return Object.assign(
    new Error(`failed to dispatch ${options.dispatch.sha} to ${options.repairRepo}: ${detail}`),
    { stdout, stderr },
  );
}

function dispatchCommitFinding(options: {
  dispatch: CommitFindingDispatch;
  mode: string;
  reportRepo: string;
  repairRepo: string;
  workflow: string;
}): void {
  const commandArgs =
    options.mode === "repository_dispatch"
      ? ["api", `repos/${options.repairRepo}/dispatches`, "--method", "POST", "--input", "-"]
      : workflowDispatchArgs(options.dispatch, options.reportRepo, options.workflow).map((arg) =>
          arg === "PLACEHOLDER" ? options.repairRepo : arg,
        );
  const lifecycle = commitLifecycle(options.dispatch.targetRepo, options.dispatch.sha);
  const dispatchKey = commitFindingDispatchKey(options.dispatch, options.reportRepo);
  runCommitMutation(lifecycle, {
    kind: "commit_finding_dispatch",
    identity: {
      dispatchKey,
      repairRepo: options.repairRepo,
      workflow: options.workflow,
      mode: options.mode,
      reportRepo: options.reportRepo,
      dispatch: options.dispatch,
    },
    operation: () => {
      const invocation = resolveSpawnCommand("gh", commandArgs, { env: process.env });
      const result = spawnSync(invocation.command, invocation.args, {
        input:
          options.mode === "repository_dispatch"
            ? dispatchPayload(options.dispatch, options.reportRepo)
            : undefined,
        encoding: "utf8",
        env: process.env,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      if (result.status !== 0) throw dispatchFailureError(options, result);
      return result;
    },
  });
}

function dispatchFindingsCommand(args: Args): void {
  const enabled = argString(args, "enabled", "true");
  if (!boolString(enabled)) {
    writeCommitPublicationOutput("dispatch_count", "0");
    console.log("commit finding dispatch disabled");
    return;
  }

  const artifactDir = resolve(argString(args, "artifact_dir", "commit-artifacts"));
  const repairRepo = argString(args, "repair_repo", "openclaw/clawsweeper");
  const dispatchMode = argString(args, "dispatch_mode", "workflow_dispatch");
  const repairWorkflow = argString(args, "repair_workflow", "repair-commit-finding-intake.yml");
  const reportRepo = argString(args, "report_repo", "openclaw/clawsweeper-state");
  const reportRevision = assertSha(argString(args, "report_revision", ""), "report revision");
  const reportBaseUrl = argString(
    args,
    "report_base_url",
    `https://github.com/${reportRepo}/blob/${reportRevision}`,
  );
  const dryRun = argBool(args, "dry_run");
  const dispatches: CommitFindingDispatch[] = [];

  for (const file of collectMarkdownFiles(artifactDir).filter(isCommitReportPath)) {
    const markdown = readFileSync(file, "utf8");
    const { frontMatter } = splitFrontMatter(markdown);
    if (frontMatter.result !== "findings") continue;
    const sha = frontMatter.sha;
    const targetRepo = frontMatter.repository;
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha) || !targetRepo) continue;
    const artifactRelativePath = relative(artifactDir, file).replaceAll("\\", "/");
    const reportPath = `records/${artifactRelativePath}`;
    dispatches.push({
      sha: sha.toLowerCase(),
      targetRepo,
      reportPath,
      reportUrl: `${reportBaseUrl.replace(/\/$/, "")}/${reportPath}`,
      reportRevision,
      reportSha256: createHash("sha256").update(markdown).digest("hex"),
      highestSeverity: frontMatter.highest_severity ?? "unknown",
      checkConclusion: frontMatter.check_conclusion ?? "neutral",
    });
  }

  if (!dispatches.length) {
    writeCommitPublicationOutput("dispatch_count", "0");
    console.log("No commit finding reports to dispatch.");
    return;
  }

  let dispatchCount = 0;
  for (const dispatch of dispatches) {
    if (dryRun) {
      if (dispatchMode === "repository_dispatch") {
        console.log(dispatchPayload(dispatch, reportRepo).trim());
      } else {
        const commandArgs = workflowDispatchArgs(dispatch, reportRepo, repairWorkflow).map((arg) =>
          arg === "PLACEHOLDER" ? repairRepo : arg,
        );
        console.log(`gh ${commandArgs.join(" ")}`);
      }
    } else {
      dispatchCommitFinding({
        dispatch,
        mode: dispatchMode,
        reportRepo,
        repairRepo,
        workflow: repairWorkflow,
      });
      dispatchCount += 1;
      console.log(`dispatched ${dispatch.targetRepo}@${dispatch.sha} to ${repairRepo}`);
    }
  }
  writeCommitPublicationOutput("dispatch_count", String(dryRun ? 0 : dispatchCount));
}

function dispatchContinuationCommand(args: Args): void {
  const repository = argString(
    args,
    "repository",
    process.env.GITHUB_REPOSITORY ?? "openclaw/clawsweeper",
  );
  const workflow = argString(args, "workflow", "commit-review.yml");
  const targetRepo = argString(args, "target_repo", DEFAULT_TARGET_REPO);
  const afterSha = assertSha(argString(args, "after_sha", argString(args, "commit_sha", "")));
  const beforeValue = argString(args, "before_sha", "").trim();
  const beforeSha = beforeValue ? assertSha(beforeValue, "before sha") : "";
  const commitOffset = argNumber(args, "commit_offset", 0);
  if (!Number.isSafeInteger(commitOffset) || commitOffset < 0) {
    throw new Error("Invalid --commit-offset");
  }
  const createChecks = argBool(args, "create_checks");
  const additionalPrompt = argString(
    args,
    "additional_prompt",
    process.env.COMMIT_SWEEPER_ADDITIONAL_PROMPT ?? "",
  );
  const continuationIdentity = {
    repository,
    workflow,
    targetRepo,
    afterSha,
    beforeSha: beforeSha || null,
    commitOffset,
    createChecks,
    additionalPromptSha256: createHash("sha256").update(additionalPrompt).digest("hex"),
  };
  const continuationKey = `commit-review-continuation-${createHash("sha256")
    .update(JSON.stringify(continuationIdentity))
    .digest("hex")
    .slice(0, 24)}`;
  const commandArgs = [
    "workflow",
    "run",
    workflow,
    "--repo",
    repository,
    "-f",
    "enabled=true",
    "-f",
    `target_repo=${targetRepo}`,
    "-f",
    `commit_sha=${afterSha}`,
    "-f",
    `before_sha=${beforeSha}`,
    "-f",
    `commit_offset=${commitOffset}`,
    "-f",
    `create_checks=${createChecks ? "true" : "false"}`,
    "-f",
    `additional_prompt=${additionalPrompt}`,
    "-f",
    `continuation_key=${continuationKey}`,
  ];
  runCommitMutation(commitLifecycle(targetRepo, afterSha), {
    kind: "commit_review_continuation_dispatch",
    identity: {
      ...continuationIdentity,
      continuationKey,
    },
    operation: () => {
      const invocation = resolveSpawnCommand("gh", commandArgs, { env: process.env });
      const result = spawnSync(invocation.command, invocation.args, {
        encoding: "utf8",
        env: process.env,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      if (result.status !== 0) {
        const detail =
          result.stderr || result.stdout || result.error?.message || "unknown gh error";
        throw new Error(`failed to dispatch commit review continuation: ${detail}`);
      }
      return result;
    },
  });
  console.log(
    `dispatched commit review continuation for ${targetRepo}@${afterSha} at offset ${commitOffset}`,
  );
}

function writeCommitPublicationOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(output, `${name}=${value}\n`, "utf8");
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const command = args._[0] ?? "review";
  if (command === "review") reviewCommand(args);
  else if (command === "hydrate-github-context") hydrateGitHubContextCommand(args);
  else if (command === "classify") classifyCommand(args);
  else if (command === "publish-check") publishCheckCommand(args);
  else if (command === "finish-review") finishReviewCommand(args);
  else if (command === "attest-review") attestReviewCommand(args);
  else if (command === "reports") reportsCommand(args);
  else if (command === "copy-artifacts") copyArtifactsCommand(args);
  else if (command === "dispatch-findings") dispatchFindingsCommand(args);
  else if (command === "dispatch-continuation") dispatchContinuationCommand(args);
  else if (command === "local-review") localReviewCommand(args);
  else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
