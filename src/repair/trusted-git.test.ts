import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNoUnsafeGitMutationConfig,
  fixedGitHubRepositoryUrl,
  trustedGitArgs,
  trustedGitContext,
  trustedGitNetworkContext,
} from "./trusted-git.js";

test("fixed GitHub repository URLs reject alternate hosts and URL syntax", () => {
  assert.equal(
    fixedGitHubRepositoryUrl("openclaw/openclaw"),
    "https://github.com/openclaw/openclaw.git",
  );
  for (const repository of [
    "https://evil.example/openclaw/openclaw",
    "openclaw/openclaw?token=leak",
    "openclaw/../evil",
    "openclaw@evil.example/repo",
  ]) {
    assert.throws(() => fixedGitHubRepositoryUrl(repository), /valid GitHub repository name/);
  }
});

test("trusted Git commit disables planted hooks and scrubs inherited credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-trusted-git-"));
  const targetDir = path.join(root, "target");
  const trustedRoot = path.join(root, "control");
  const hookMarker = path.join(root, "hook-ran");
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(targetDir);
  fs.mkdirSync(trustedRoot);

  git(targetDir, "init", "-b", "main");
  git(targetDir, "config", "user.name", "ClawSweeper");
  git(targetDir, "config", "user.email", "clawsweeper@example.com");
  const hookPath = path.join(targetDir, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\nprintf '%s' "$GITHUB_TOKEN" > '${hookMarker}'\n`, {
    mode: 0o700,
  });
  fs.writeFileSync(path.join(targetDir, "value.txt"), "safe\n");
  git(targetDir, "add", "value.txt");

  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "must-not-reach-hook";
  try {
    const context = trustedGitContext(trustedRoot);
    assert.equal(context.env.GITHUB_TOKEN, undefined);
    execFileSync("git", trustedGitArgs(context, ["commit", "-m", "safe"]), {
      cwd: targetDir,
      env: context.env,
      encoding: "utf8",
    });
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
  assert.equal(fs.existsSync(hookMarker), false);
});

test("trusted Git control files are recreated and askpass rejects non-GitHub prompts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-trusted-control-"));
  const trustedRoot = path.join(root, "control");
  const escaped = path.join(root, "escaped");
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(trustedRoot);
  fs.mkdirSync(escaped);

  const first = trustedGitContext(trustedRoot);
  const controlRoot = path.dirname(String(first.env.GIT_CONFIG_GLOBAL));
  fs.writeFileSync(String(first.env.GIT_CONFIG_GLOBAL), "[credential]\nhelper = planted\n");
  fs.writeFileSync(path.join(controlRoot, "empty-hooks", "pre-push"), "planted\n");
  fs.rmSync(controlRoot, { recursive: true, force: true });
  fs.symlinkSync(escaped, controlRoot);

  const network = trustedGitNetworkContext(trustedRoot, "test-token");
  assert.equal(fs.lstatSync(controlRoot).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(String(network.env.GIT_CONFIG_GLOBAL), "utf8"), "");
  assert.deepEqual(fs.readdirSync(path.join(controlRoot, "empty-hooks")), []);

  const askpassScript = path.join(controlRoot, "askpass.cjs");
  const rejected = spawnSync(
    process.execPath,
    [askpassScript, "Password for 'https://evil.example/repo.git':"],
    { env: network.env, encoding: "utf8" },
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, "");
  const deceptive = spawnSync(
    process.execPath,
    [askpassScript, "Password for 'https://evil.example/github.com/openclaw/openclaw.git':"],
    { env: network.env, encoding: "utf8" },
  );
  assert.notEqual(deceptive.status, 0);
  assert.equal(deceptive.stdout, "");
  assert.equal(
    execFileSync(
      process.execPath,
      [askpassScript, "Password for 'https://x-access-token@github.com/openclaw/openclaw.git':"],
      { env: network.env, encoding: "utf8" },
    ).trim(),
    "test-token",
  );
});

test("trusted Git rejects command-valued and exclusion local config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-trusted-config-"));
  const targetDir = path.join(root, "target");
  const trustedRoot = path.join(root, "control");
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(targetDir);
  fs.mkdirSync(trustedRoot);
  git(targetDir, "init", "-b", "main");
  git(targetDir, "config", "filter.planted.process", "touch planted");
  git(targetDir, "config", "core.excludesFile", path.join(root, "exclude"));

  assert.throws(
    () => assertNoUnsafeGitMutationConfig({ targetDir, trustedRoot }),
    /core\.excludesfile|filter\.planted\.process/,
  );
});

test("trusted Git rejects worktree filter config before its driver can run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-worktree-config-"));
  const targetDir = path.join(root, "target");
  const trustedRoot = path.join(root, "control");
  const filterPath = path.join(root, "filter.cjs");
  const markerPath = path.join(root, "filter-ran");
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(targetDir);
  fs.mkdirSync(trustedRoot);
  git(targetDir, "init", "-b", "main");
  git(targetDir, "config", "user.name", "ClawSweeper");
  git(targetDir, "config", "user.email", "clawsweeper@example.com");
  fs.writeFileSync(path.join(targetDir, ".gitattributes"), "value.txt filter=planted\n");
  fs.writeFileSync(path.join(targetDir, "value.txt"), "committed\n");
  git(targetDir, "add", ".gitattributes", "value.txt");
  git(targetDir, "commit", "-m", "initial");

  fs.writeFileSync(
    filterPath,
    'require("node:fs").writeFileSync(process.argv[2], "ran"); process.stdin.pipe(process.stdout);\n',
  );
  git(targetDir, "config", "extensions.worktreeConfig", "true");
  git(
    targetDir,
    "config",
    "--worktree",
    "filter.planted.clean",
    `"${process.execPath}" "${filterPath}" "${markerPath}"`,
  );
  fs.writeFileSync(path.join(targetDir, "value.txt"), "dirty\n");

  assert.throws(
    () => assertNoUnsafeGitMutationConfig({ targetDir, trustedRoot }),
    /filter\.planted\.clean/,
  );
  assert.equal(fs.existsSync(markerPath), false);
  git(targetDir, "hash-object", "--path=value.txt", "value.txt");
  assert.equal(fs.existsSync(markerPath), true, "fixture filter must be executable by Git");
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
