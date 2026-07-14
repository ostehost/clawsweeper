import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readText } from "../helpers.ts";

import {
  firstTargetSourcePullRequest,
  pullRequestHeadSha,
  sourcePullRequestFetchSpec,
  sourcePullRequestRemoteRef,
} from "../../dist/repair/source-pr-checkout.js";

test("selects the first source PR from the target repo", () => {
  assert.deepEqual(
    firstTargetSourcePullRequest(
      ["https://github.com/other/repo/pull/9", "https://github.com/openclaw/openclaw/pull/74134"],
      "openclaw/openclaw",
    ),
    {
      repo: "openclaw/openclaw",
      number: 74134,
      url: "https://github.com/openclaw/openclaw/pull/74134",
    },
  );
});

test("ignores missing and cross-repo source PRs", () => {
  assert.equal(
    firstTargetSourcePullRequest(
      ["#74134", "https://github.com/other/repo/pull/74134"],
      "openclaw/openclaw",
    ),
    null,
  );
});

test("builds a forced pull-head fetch ref for replacement branches", () => {
  assert.equal(
    sourcePullRequestFetchSpec(74134, sourcePullRequestRemoteRef(74134)),
    "+refs/pull/74134/head:refs/remotes/clawsweeper/source-pr-74134",
  );
});

test("extracts only full pull request head SHAs", () => {
  assert.equal(
    pullRequestHeadSha({
      head: { sha: "0123456789abcdef0123456789abcdef01234567" },
    }),
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(pullRequestHeadSha({ head: { sha: "abc" } }), "");
  assert.equal(pullRequestHeadSha({}), "");
});

test("source PR fetch and materialization use isolated trusted Git contexts", () => {
  const source = readText(path.join(process.cwd(), "src/repair/source-pr-checkout.ts"));
  const checkoutStart = source.indexOf("export function checkoutSourcePullRequestHead(");
  const fetchStart = source.indexOf("export function fetchSourcePullRequestHead(");
  const helperStart = source.indexOf("function runTrustedSourceGit(");
  assert.ok(checkoutStart >= 0 && fetchStart > checkoutStart && helperStart > fetchStart);

  const checkout = source.slice(checkoutStart, fetchStart);
  const fetch = source.slice(fetchStart, helperStart);
  const helper = source.slice(helperStart);
  assert.match(checkout, /runTrustedSourceGit\(\{/);
  assert.match(checkout, /args: \["checkout", "-B", branch, sourceRef\]/);
  assert.match(fetch, /fixedGitHubRepositoryUrl\(sourcePr\.repo\)/);
  assert.match(fetch, /network: true/);
  assert.doesNotMatch(fetch, /"origin"/);
  assert.match(helper, /assertNoUnsafeGitMutationConfig\(\{ targetDir, trustedRoot \}\)/);
  assert.match(helper, /network && token[\s\S]*?\? trustedGitNetworkContext/);
  assert.match(helper, /: trustedGitContext\(trustedRoot\)/);
  assert.match(helper, /env: context\.env/);
});

test("initial target clone uses a fixed URL without mutating global Git auth", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const cloneStart = source.indexOf("function cloneTargetCheckout(");
  const cloneEnd = source.indexOf("function setupGitIdentity(", cloneStart);
  assert.ok(cloneStart >= 0 && cloneEnd > cloneStart);

  const clone = source.slice(cloneStart, cloneEnd);
  assert.match(clone, /trustedGitNetworkContext\(workRoot, token\)/);
  assert.match(clone, /trustedGitContext\(workRoot\)/);
  assert.match(clone, /trustedGitArgs\(context, bloblessCloneArgs\(repo, targetDir\)\)/);
  assert.match(clone, /fixedGitHubRepositoryUrl\(repo\)/);
  assert.match(clone, /env: context\.env/);
  assert.doesNotMatch(clone, /setupGitHubCredentialHelper|auth.*setup-git|ghEnv\(\)/);
});

test("post-clone target fetches use the authenticated fixed GitHub URL", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const helperStart = source.indexOf("function fetchTargetRepository(");
  const helperEnd = source.indexOf("function currentGitHubToken(", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);

  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /runTrustedGitNetwork\(/);
  assert.match(
    helper,
    /networkArgs\[remoteIndexes\[0\]!\] = fixedGitHubRepositoryUrl\(String\(result\.repo\)\)/,
  );
  assert.match(helper, /runTrustedGitNetwork\(\["fetch", \.\.\.networkArgs\], cwd\)/);
  assert.match(source, /gitFetch: fetchTargetRepository/);
  assert.match(
    source,
    /fetchTargetRepository\(\s*\["origin", `\+refs\/heads\/\$\{branch\}:refs\/remotes\/origin\/\$\{branch\}`\]/,
  );
  assert.doesNotMatch(source, /runGitNetwork\(\s*\[\s*"fetch"/);
  assert.doesNotMatch(source, /\["fetch", "origin"/);
});

test("existing target checkout cleanliness is probed through trusted Git", () => {
  const source = readText(path.join(process.cwd(), "src/repair/execute-fix-artifact.ts"));
  const ensureStart = source.indexOf("function ensureTargetCheckout(");
  const ensureEnd = source.indexOf("function cloneTargetCheckout(", ensureStart);
  assert.ok(ensureStart >= 0 && ensureEnd > ensureStart);

  const ensure = source.slice(ensureStart, ensureEnd);
  assert.match(ensure, /runTrustedGitMutation\(\["status", "--porcelain"\], targetDir\)\.trim\(\)/);
  assert.doesNotMatch(ensure, /run\("git", \["status", "--porcelain"\]/);
});
