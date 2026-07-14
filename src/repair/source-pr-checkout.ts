import type { GitHubRef } from "./github-ref.js";
import { parsePullRequestUrl } from "./github-ref.js";
import type { JsonValue } from "./json-types.js";
import { runCommand as run } from "./command-runner.js";
import {
  assertNoUnsafeGitMutationConfig,
  fixedGitHubRepositoryUrl,
  trustedGitArgs,
  trustedGitContext,
  trustedGitNetworkContext,
} from "./trusted-git.js";

const gitNetworkTimeoutMs = Math.max(
  30_000,
  Number(
    process.env.CLAWSWEEPER_GIT_NETWORK_TIMEOUT_MS ??
      process.env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS ??
      5 * 60 * 1000,
  ),
);

export type SourcePullRequestCheckout = {
  branch: string;
  sourcePr: GitHubRef;
  sourceHeadSha: string;
  expectedHeadSha: string;
};

export function firstTargetSourcePullRequest(
  sourcePrs: readonly JsonValue[],
  repo: string,
): GitHubRef | null {
  for (const source of sourcePrs) {
    const parsed = parsePullRequestUrl(source);
    if (parsed?.repo === repo) return parsed;
  }
  return null;
}

export function pullRequestHeadSha(pull: JsonValue): string {
  const sha = String(pull?.head?.sha ?? "").trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : "";
}

export function checkoutSourcePullRequestHead({
  targetDir,
  repo,
  branch,
  sourcePr,
  pull,
  trustedRoot,
  token,
}: {
  targetDir: string;
  repo: string;
  branch: string;
  sourcePr: GitHubRef;
  pull: JsonValue;
  trustedRoot: string;
  token: string;
}): SourcePullRequestCheckout {
  if (sourcePr.repo !== repo) {
    throw new Error(`source PR ${sourcePr.url} is not in target repo ${repo}`);
  }

  const sourceRef = fetchSourcePullRequestHead({ targetDir, sourcePr, trustedRoot, token });
  runTrustedSourceGit({
    targetDir,
    trustedRoot,
    args: ["checkout", "-B", branch, sourceRef],
  });

  const sourceHeadSha = runTrustedSourceGit({
    targetDir,
    trustedRoot,
    args: ["rev-parse", "HEAD"],
  }).trim();
  const expectedHeadSha = pullRequestHeadSha(pull);
  if (expectedHeadSha && sourceHeadSha !== expectedHeadSha) {
    throw new Error(
      `source PR #${sourcePr.number} checkout head ${sourceHeadSha} did not match expected ${expectedHeadSha}`,
    );
  }

  return {
    branch,
    sourcePr,
    sourceHeadSha,
    expectedHeadSha,
  };
}

export function sourcePullRequestFetchSpec(number: number, branch: string): string {
  return `+refs/pull/${number}/head:${branch}`;
}

export function sourcePullRequestRemoteRef(number: number): string {
  return `refs/remotes/clawsweeper/source-pr-${number}`;
}

export function fetchSourcePullRequestHead({
  targetDir,
  sourcePr,
  trustedRoot,
  token,
}: {
  targetDir: string;
  sourcePr: GitHubRef;
  trustedRoot: string;
  token: string;
}): string {
  const sourceRef = sourcePullRequestRemoteRef(sourcePr.number);
  runTrustedSourceGit({
    targetDir,
    trustedRoot,
    token,
    network: true,
    args: [
      "fetch",
      fixedGitHubRepositoryUrl(sourcePr.repo),
      sourcePullRequestFetchSpec(sourcePr.number, sourceRef),
    ],
  });
  return sourceRef;
}

function runTrustedSourceGit({
  targetDir,
  trustedRoot,
  args,
  network = false,
  token = "",
}: {
  targetDir: string;
  trustedRoot: string;
  args: string[];
  network?: boolean;
  token?: string;
}): string {
  assertNoUnsafeGitMutationConfig({ targetDir, trustedRoot });
  const context =
    network && token
      ? trustedGitNetworkContext(trustedRoot, token)
      : trustedGitContext(trustedRoot);
  return run("git", trustedGitArgs(context, args), {
    cwd: targetDir,
    env: context.env,
    timeoutMs: gitNetworkTimeoutMs,
  });
}
