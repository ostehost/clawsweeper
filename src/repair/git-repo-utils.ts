import fs from "node:fs";
import path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { runCommandResult } from "./command-runner.js";
import {
  assertNoUnsafeGitMutationConfig,
  trustedGitArgs,
  trustedGitContext,
} from "./trusted-git.js";
import { uniqueStrings } from "./validation-command-utils.js";

const gitNetworkTimeoutMs = Math.max(
  30_000,
  Number(
    process.env.CLAWSWEEPER_GIT_NETWORK_TIMEOUT_MS ??
      process.env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS ??
      5 * 60 * 1000,
  ),
);
const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000;

type TargetDir = {
  targetDir: string;
};

export type GitFetch = (args: string[], targetDir: string) => void;

type TargetBranch = TargetDir & {
  branch: string;
};

type TargetBaseBranch = TargetDir & {
  baseBranch: string;
  gitFetch?: GitFetch | undefined;
};

type TrustedTargetBaseBranch = TargetBaseBranch & {
  trustedRoot: string;
};

export type RebaseOntoBaseResult = {
  status: "already-current" | "rebased" | "conflicts";
  base_ref: string;
  base_sha: string;
  previous_head: string;
  current_head: string;
  detail?: string;
};

export type CompleteRebaseResult = {
  status: "not-in-progress" | "continued";
  previous_head: string;
  current_head: string;
  detail?: string;
};

export function currentHead(targetDir: string): string {
  return gitOutput(["rev-parse", "HEAD"], { targetDir }).trim();
}

export function runGitCommand(
  args: string[],
  {
    targetDir,
    timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    env = process.env,
  }: TargetDir & { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): SpawnSyncReturns<string> {
  return runCommandResult("git", args, {
    cwd: targetDir,
    env,
    timeoutMs,
  });
}

export function isAncestor({
  targetDir,
  ancestor,
  descendant,
}: TargetDir & { ancestor: string; descendant: string }): boolean {
  const child = runGitCommand(["merge-base", "--is-ancestor", ancestor, descendant], {
    targetDir,
  });
  return child.status === 0;
}

export function remoteBranchExists(options: TargetBranch): boolean {
  return Boolean(remoteBranchSha(options));
}

export function remoteBranchSha({ targetDir, branch }: TargetBranch): string {
  const child = runGitCommand(["ls-remote", "--heads", "origin", branch], {
    targetDir,
    timeoutMs: gitNetworkTimeoutMs,
  });
  if (child.status !== 0) return "";
  const sha = child.stdout.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : "";
}

export function branchHasBaseDiff({
  targetDir,
  baseBranch,
  gitFetch: trustedFetch,
}: TargetBaseBranch): boolean {
  const range = `origin/${baseBranch}...HEAD`;
  const first = runGitCommand(["diff", "--name-only", range], { targetDir });
  if (first.status === 0) return Boolean(first.stdout.trim());
  const detail = `${first.stderr ?? ""}\n${first.stdout ?? ""}`;
  if (!/no merge base/i.test(detail)) throw new Error(detail.trim());

  fetchDeeperHistory({ targetDir, baseBranch, gitFetch: trustedFetch });
  const retry = runGitCommand(["diff", "--name-only", range], { targetDir });
  if (retry.status === 0) return Boolean(retry.stdout.trim());
  const retryDetail = `${retry.stderr ?? ""}\n${retry.stdout ?? ""}`;
  if (/no merge base/i.test(retryDetail)) return true;
  throw new Error(retryDetail.trim());
}

export function ensureMergeBaseAvailable({
  targetDir,
  baseBranch,
  gitFetch: trustedFetch,
}: TargetBaseBranch): string {
  fetchGit(targetDir, ["origin", `${baseBranch}:refs/remotes/origin/${baseBranch}`], trustedFetch);
  const baseRef = `origin/${baseBranch}`;
  const first = runGitCommand(["merge-base", baseRef, "HEAD"], { targetDir });
  if (first.status === 0 && first.stdout.trim()) return first.stdout.trim();

  fetchDeeperHistory({ targetDir, baseBranch, gitFetch: trustedFetch });
  const retry = runGitCommand(["merge-base", baseRef, "HEAD"], { targetDir });
  if (retry.status === 0 && retry.stdout.trim()) return retry.stdout.trim();

  const detail = `${retry.stderr ?? ""}\n${retry.stdout ?? ""}`.trim();
  throw new Error(detail || `no merge base between ${baseRef} and HEAD`);
}

export function rebaseOntoBase(options: TrustedTargetBaseBranch): RebaseOntoBaseResult {
  const { targetDir, baseBranch, trustedRoot } = options;
  const gitFetch: GitFetch =
    options.gitFetch ??
    ((args, cwd) => {
      assertNoUnsafeGitMutationConfig({ targetDir: cwd, trustedRoot });
      const fetchContext = trustedGitContext(trustedRoot);
      gitOutput(trustedGitArgs(fetchContext, ["fetch", ...args]), {
        targetDir: cwd,
        env: fetchContext.env,
        timeoutMs: gitNetworkTimeoutMs,
      });
    });
  ensureMergeBaseAvailable({ ...options, gitFetch });
  assertNoUnsafeGitMutationConfig({ targetDir, trustedRoot });
  const context = trustedGitContext(trustedRoot);
  const trustedOutput = (args: string[]) =>
    gitOutput(trustedGitArgs(context, args), { targetDir, env: context.env }).trim();
  const baseRef = `origin/${baseBranch}`;
  const baseSha = trustedOutput(["rev-parse", baseRef]);
  const previousHead = trustedOutput(["rev-parse", "HEAD"]);
  const ancestor = runGitCommand(
    trustedGitArgs(context, ["merge-base", "--is-ancestor", baseRef, "HEAD"]),
    { targetDir, env: context.env },
  );
  if (ancestor.status === 0) {
    return {
      status: "already-current",
      base_ref: baseRef,
      base_sha: baseSha,
      previous_head: previousHead,
      current_head: previousHead,
    };
  }

  const child = runGitCommand(trustedGitArgs(context, ["rebase", baseRef]), {
    targetDir,
    env: context.env,
  });
  const detail = `${child.stderr ?? ""}\n${child.stdout ?? ""}`.trim();
  if (child.status === 0) {
    return {
      status: "rebased",
      base_ref: baseRef,
      base_sha: baseSha,
      previous_head: previousHead,
      current_head: trustedOutput(["rev-parse", "HEAD"]),
      detail,
    };
  }
  if (hasRebaseInProgress(targetDir) || unmergedPaths(targetDir).length > 0) {
    return {
      status: "conflicts",
      base_ref: baseRef,
      base_sha: baseSha,
      previous_head: previousHead,
      current_head: trustedOutput(["rev-parse", "HEAD"]),
      detail,
    };
  }
  throw new Error(detail || `git rebase ${baseRef} failed`);
}

export function completeRebaseIfResolved({
  targetDir,
  trustedRoot,
}: TargetDir & { trustedRoot: string }): CompleteRebaseResult {
  assertNoUnsafeGitMutationConfig({ targetDir, trustedRoot });
  const context = trustedGitContext(trustedRoot);
  const gitArgsPrefix = context.argsPrefix;
  const gitEnv = context.env;
  const previousHead = gitOutput([...gitArgsPrefix, "rev-parse", "HEAD"], {
    targetDir,
    env: gitEnv,
  }).trim();
  if (!hasRebaseInProgress(targetDir)) {
    return {
      status: "not-in-progress",
      previous_head: previousHead,
      current_head: previousHead,
    };
  }

  const resolvedPaths = unmergedPaths(targetDir);
  assertNoConflictMarkers({ targetDir, paths: resolvedPaths });
  if (resolvedPaths.length > 0) {
    gitOutput([...gitArgsPrefix, "--literal-pathspecs", "add", "--", ...resolvedPaths], {
      targetDir,
      env: gitEnv,
    });
  }
  const unresolved = unmergedPaths(targetDir);
  if (unresolved.length > 0) {
    throw new Error(`rebase conflicts remain unresolved: ${unresolved.join(", ")}`);
  }
  let detail = "";
  while (hasRebaseInProgress(targetDir)) {
    const child = runGitCommand(
      [...gitArgsPrefix, "-c", "core.editor=true", "rebase", "--continue"],
      {
        targetDir,
        env: gitEnv,
      },
    );
    detail = `${detail}\n${child.stderr ?? ""}\n${child.stdout ?? ""}`.trim();
    if (child.status !== 0) {
      const remaining = unmergedPaths(targetDir);
      if (remaining.length > 0) {
        throw new Error(`rebase produced additional conflicts: ${remaining.join(", ")}`);
      }
      throw new Error(detail || "git rebase --continue failed");
    }
  }

  return {
    status: "continued",
    previous_head: previousHead,
    current_head: gitOutput([...gitArgsPrefix, "rev-parse", "HEAD"], {
      targetDir,
      env: gitEnv,
    }).trim(),
    detail,
  };
}

function assertNoConflictMarkers({ targetDir, paths }: TargetDir & { paths: string[] }): void {
  const unresolved = paths.filter((filePath) => {
    const absolute = path.join(targetDir, filePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return false;
    const text = fs.readFileSync(absolute, "utf8");
    return /^<{7} |^={7}$|^>{7} /m.test(text);
  });
  if (unresolved.length > 0) {
    throw new Error(`rebase conflicts remain unresolved: ${unresolved.join(", ")}`);
  }
}

export function hasRebaseInProgress(targetDir: string): boolean {
  const gitDir = gitOutput(["rev-parse", "--git-dir"], { targetDir }).trim();
  const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(targetDir, gitDir);
  return (
    fs.existsSync(path.join(absoluteGitDir, "rebase-merge")) ||
    fs.existsSync(path.join(absoluteGitDir, "rebase-apply"))
  );
}

export function unmergedPaths(targetDir: string): string[] {
  const child = runGitCommand(["diff", "--name-only", "--diff-filter=U", "-z"], { targetDir });
  if (child.status !== 0) return [];
  return child.stdout.split("\0").filter(Boolean);
}

function fetchDeeperHistory({
  targetDir,
  baseBranch,
  gitFetch: trustedFetch,
}: TargetBaseBranch): void {
  const shallow = runGitCommand(["rev-parse", "--is-shallow-repository"], {
    targetDir,
  }).stdout.trim();
  if (shallow === "true" || fs.existsSync(path.join(targetDir, ".git", "shallow"))) {
    fetchGit(targetDir, ["--unshallow", "origin"], trustedFetch);
  } else {
    fetchGit(targetDir, ["origin", "--prune"], trustedFetch);
  }
  fetchGit(targetDir, ["origin", `${baseBranch}:refs/remotes/origin/${baseBranch}`], trustedFetch);
}

function fetchGit(targetDir: string, args: string[], trustedFetch?: GitFetch): void {
  if (trustedFetch) {
    trustedFetch(args, targetDir);
    return;
  }
  gitOutput(["fetch", ...args], { targetDir, timeoutMs: gitNetworkTimeoutMs });
}

export function gitChangedFiles(targetDir: string, baseBranch: string): string[] {
  const baseRef = `origin/${baseBranch}`;
  const committed = gitOutput(["diff", "--name-only", `${baseRef}...HEAD`], { targetDir })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommitted = gitOutput(["status", "--porcelain"], { targetDir })
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^.. /, ""))
    .map((line) => line.split(" -> ").pop())
    .filter(Boolean);
  return uniqueStrings([...committed, ...uncommitted]);
}

export function gitLsFiles(targetDir: string): string[] {
  return gitOutput(["ls-files"], { targetDir })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitOutput(
  args: string[],
  options: TargetDir & { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): string {
  const child = runGitCommand(args, options);
  if (child.status === 0) return child.stdout ?? "";
  const detail = [child.stderr, child.stdout].filter(Boolean).join("\n").trim();
  throw new Error(detail || `git exited ${child.status ?? `with signal ${child.signal}`}`);
}
