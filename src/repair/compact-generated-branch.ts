import { runCommand as run } from "./command-runner.js";
import {
  runRepairMutation,
  type RepairLifecycleInput,
  type RepairMutationOutcome,
} from "./repair-action-ledger.js";
import {
  assertNoUnsafeGitMutationConfig,
  trustedGitArgs,
  trustedGitContext,
} from "./trusted-git.js";
import { uniqueStrings } from "./validation-command-utils.js";

const LOCAL_LINEAGE_OPERATION = "repair_local_lineage";

type GitCommitCommand = (args: string[]) => void;
type GitCommand = (args: string[]) => string;

export type GeneratedBranchCompaction =
  | {
      status: "unchanged";
      commit: string;
      previous_commit_count: number;
    }
  | {
      status: "compacted";
      commit: string;
      previous_head: string;
      previous_commit_count: number;
    };

type LocalCheckpointCommit =
  | {
      status: "unchanged";
      commit: string;
    }
  | {
      status: "committed";
      commit: string;
    };

export function commitGeneratedCheckpointIfNeeded({
  targetDir,
  message,
  trailers = [],
  checkpoint,
  lifecycle,
  component = "execute_fix",
  commitCommand,
  trustedRoot,
}: {
  targetDir: string;
  message: string;
  trailers?: readonly string[];
  checkpoint: string;
  lifecycle: RepairLifecycleInput;
  component?: string;
  commitCommand?: GitCommitCommand;
  trustedRoot?: string;
}): string {
  const git = gitCommandForTarget(targetDir, trustedRoot);
  const normalizedTrailers = uniqueStrings([...trailers]);
  const previousHead = git(["rev-parse", "HEAD"]).trim();
  const previousTree = git(["rev-parse", `${previousHead}^{tree}`]).trim();
  const status = git(["status", "--porcelain", "--ignore-submodules=none"]).trim();
  if (status) git(["add", "--all"]);
  const checkpointTree = status ? git(["write-tree"]).trim() : previousTree;
  let deferredError: unknown;
  let hasDeferredError = false;

  const result = runRepairMutation<LocalCheckpointCommit>(lifecycle, {
    kind: "local_checkpoint_commit",
    identity: {
      checkpoint,
      parentHead: previousHead,
      tree: checkpointTree,
      message,
      trailers: normalizedTrailers,
    },
    operationName: LOCAL_LINEAGE_OPERATION,
    component,
    outcome: localMutationOutcome,
    knownNoMutation: () => readHeadSafely(targetDir, git) === previousHead,
    operation: () => {
      if (!status) return { status: "unchanged", commit: previousHead };
      const commitArgs = ["commit", "-m", message];
      for (const trailer of normalizedTrailers) commitArgs.push("-m", trailer);
      try {
        runCommit(targetDir, commitArgs, commitCommand ?? git);
        return {
          status: "committed",
          commit: git(["rev-parse", "HEAD"]).trim(),
        };
      } catch (error) {
        const observedHead = readHeadSafely(targetDir, git);
        if (observedHead && observedHead !== previousHead) {
          deferredError = error;
          hasDeferredError = true;
          return { status: "committed", commit: observedHead };
        }
        throw error;
      }
    },
  });

  if (hasDeferredError) throw deferredError;
  return result.status === "committed" ? result.commit : "";
}

export function compactGeneratedBranchHistory({
  targetDir,
  baseRef,
  expectedHead,
  expectedTree,
  message,
  trustedRoot,
  trailers = [],
  lifecycle,
  component = "execute_fix",
  commitCommand,
}: {
  targetDir: string;
  baseRef: string;
  expectedHead?: string;
  expectedTree?: string;
  message: string;
  trustedRoot?: string;
  trailers?: readonly string[];
  lifecycle: RepairLifecycleInput;
  component?: string;
  commitCommand?: GitCommitCommand;
}): GeneratedBranchCompaction {
  const git = gitCommandForTarget(targetDir, trustedRoot);
  const status = git(["status", "--porcelain", "--ignore-submodules=none"]).trim();
  const baseSha = git(["rev-parse", baseRef]).trim();
  const previousHead = git(["rev-parse", "HEAD"]).trim();
  if (expectedHead && previousHead !== expectedHead) {
    throw new Error("cannot compact a branch head that differs from the reviewed commit");
  }
  const previousTree = git(["rev-parse", `${previousHead}^{tree}`]).trim();
  if (expectedTree && previousTree !== expectedTree) {
    throw new Error("cannot compact a branch tree that differs from the reviewed tree");
  }
  const previousCommitCount = Number(
    git(["rev-list", "--count", `${baseSha}..${previousHead}`]).trim(),
  );
  const changedFiles = git(["diff", "--name-only", baseSha, previousHead]).trim();
  const normalizedTrailers = uniqueStrings([...trailers]);
  let deferredError: unknown;
  let hasDeferredError = false;

  const result = runRepairMutation<GeneratedBranchCompaction>(lifecycle, {
    kind: "generated_history_compaction",
    identity: {
      base: baseSha,
      previousHead,
      tree: previousTree,
      message,
      trailers: normalizedTrailers,
    },
    operationName: LOCAL_LINEAGE_OPERATION,
    component,
    outcome: localMutationOutcome,
    knownNoMutation: () => readHeadSafely(targetDir, git) === previousHead,
    operation: () => {
      if (status) {
        throw new Error("cannot compact generated branch history with worktree changes");
      }
      if (!Number.isInteger(previousCommitCount) || previousCommitCount <= 1 || !changedFiles) {
        return {
          status: "unchanged",
          commit: previousHead,
          previous_commit_count: previousCommitCount,
        };
      }

      git(["reset", "--soft", baseSha]);
      const commitArgs = ["commit", "-m", message];
      for (const trailer of normalizedTrailers) commitArgs.push("-m", trailer);
      try {
        runCommit(targetDir, commitArgs, commitCommand ?? git);
        const commit = git(["rev-parse", "HEAD"]).trim();
        const compactedTree = git(["rev-parse", `${commit}^{tree}`]).trim();
        if (compactedTree !== previousTree) {
          throw new Error("generated branch compaction changed the reviewed tree");
        }
        if (git(["status", "--porcelain", "--ignore-submodules=none"]).trim()) {
          throw new Error("generated branch compaction left worktree changes");
        }
        return {
          status: "compacted",
          commit,
          previous_head: previousHead,
          previous_commit_count: previousCommitCount,
        };
      } catch (error) {
        const observedHead = readHeadSafely(targetDir, git);
        if (observedHead && observedHead !== previousHead && observedHead !== baseSha) {
          deferredError = error;
          hasDeferredError = true;
          return {
            status: "compacted",
            commit: observedHead,
            previous_head: previousHead,
            previous_commit_count: previousCommitCount,
          };
        }
        throw error;
      }
    },
  });

  if (hasDeferredError) throw deferredError;
  return result;
}

function localMutationOutcome(
  result: LocalCheckpointCommit | GeneratedBranchCompaction,
): RepairMutationOutcome {
  return result.status === "unchanged" ? "rejected" : "accepted";
}

function runCommit(targetDir: string, args: string[], commitCommand?: GitCommitCommand): void {
  if (commitCommand) {
    commitCommand(args);
    return;
  }
  run("git", args, { cwd: targetDir });
}

function readHeadSafely(targetDir: string, git?: GitCommand): string | null {
  try {
    return (
      (git
        ? git(["rev-parse", "HEAD"])
        : run("git", ["rev-parse", "HEAD"], { cwd: targetDir })
      ).trim() || null
    );
  } catch {
    return null;
  }
}

function gitCommandForTarget(targetDir: string, trustedRoot?: string): GitCommand {
  if (!trustedRoot) {
    return (args: string[]) => run("git", args, { cwd: targetDir });
  }
  assertNoUnsafeGitMutationConfig({ targetDir, trustedRoot });
  const context = trustedGitContext(trustedRoot);
  return (args: string[]) =>
    run("git", trustedGitArgs(context, args), {
      cwd: targetDir,
      env: context.env,
    });
}
