import { runCommand as run } from "./command-runner.js";
import { commitTreeSha } from "./reviewed-publication.js";
import {
  assertNoUnsafeGitMutationConfig,
  trustedGitArgs,
  trustedGitContext,
} from "./trusted-git.js";
import { uniqueStrings } from "./validation-command-utils.js";

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

export function compactGeneratedBranchHistory({
  targetDir,
  baseRef,
  expectedHead,
  expectedTree,
  message,
  trustedRoot,
  trailers = [],
}: {
  targetDir: string;
  baseRef: string;
  expectedHead: string;
  expectedTree: string;
  message: string;
  trustedRoot: string;
  trailers?: readonly string[];
}): GeneratedBranchCompaction {
  assertNoUnsafeGitMutationConfig({ targetDir, trustedRoot });
  const trustedGit = trustedGitContext(trustedRoot);
  const git = (args: string[]) =>
    run("git", trustedGitArgs(trustedGit, args), {
      cwd: targetDir,
      env: trustedGit.env,
    });
  const status = git(["status", "--porcelain", "--ignore-submodules=none"]).trim();
  if (status) {
    throw new Error("cannot compact generated branch history with worktree changes");
  }

  const baseSha = git(["rev-parse", baseRef]).trim();
  const previousHead = git(["rev-parse", "HEAD"]).trim();
  if (previousHead !== expectedHead) {
    throw new Error("cannot compact a branch head that differs from the reviewed commit");
  }
  const previousTree = commitTreeSha({ targetDir, commit: previousHead });
  if (previousTree !== expectedTree) {
    throw new Error("cannot compact a branch tree that differs from the reviewed tree");
  }
  const previousCommitCount = Number(
    git(["rev-list", "--count", `${baseSha}..${previousHead}`]).trim(),
  );
  if (!Number.isInteger(previousCommitCount) || previousCommitCount <= 1) {
    return {
      status: "unchanged",
      commit: previousHead,
      previous_commit_count: previousCommitCount,
    };
  }

  const changedFiles = git(["diff", "--name-only", baseSha, previousHead]).trim();
  if (!changedFiles) {
    return {
      status: "unchanged",
      commit: previousHead,
      previous_commit_count: previousCommitCount,
    };
  }

  git(["reset", "--soft", baseSha]);
  const commitArgs = ["commit", "-m", message];
  for (const trailer of uniqueStrings([...trailers])) commitArgs.push("-m", trailer);
  git(commitArgs);

  const commit = git(["rev-parse", "HEAD"]).trim();
  const compactedTree = commitTreeSha({ targetDir, commit });
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
}
