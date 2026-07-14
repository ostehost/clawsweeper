import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertCommitTree, commitTreeSha, exactCommitRefspec } from "./reviewed-publication.js";

test("exact commit refspec publishes the reviewed commit even after HEAD moves", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publication-"));
  const targetDir = path.join(root, "target");
  const remoteDir = path.join(root, "remote.git");
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(targetDir);
  git(targetDir, "init", "-b", "main");
  git(targetDir, "config", "user.name", "ClawSweeper");
  git(targetDir, "config", "user.email", "clawsweeper@example.com");
  fs.writeFileSync(path.join(targetDir, "value.txt"), "reviewed\n");
  git(targetDir, "add", "value.txt");
  git(targetDir, "commit", "-m", "reviewed");
  const reviewedCommit = git(targetDir, "rev-parse", "HEAD").trim();
  const reviewedTree = commitTreeSha({ targetDir, commit: reviewedCommit });

  fs.writeFileSync(path.join(targetDir, "value.txt"), "unreviewed\n");
  git(targetDir, "commit", "-am", "move head");
  assert.notEqual(git(targetDir, "rev-parse", "HEAD").trim(), reviewedCommit);

  git(root, "init", "--bare", remoteDir);
  git(
    targetDir,
    "push",
    remoteDir,
    exactCommitRefspec({ commit: reviewedCommit, targetRef: "refs/heads/reviewed" }),
  );
  assert.equal(git(remoteDir, "rev-parse", "refs/heads/reviewed").trim(), reviewedCommit);
  assertCommitTree({ targetDir, commit: reviewedCommit, expectedTree: reviewedTree });
});

test("reviewed tree lookup ignores replacement refs and malformed publication refs", () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-tree-proof-"));
  test.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  git(targetDir, "init", "-b", "main");
  git(targetDir, "config", "user.name", "ClawSweeper");
  git(targetDir, "config", "user.email", "clawsweeper@example.com");
  fs.writeFileSync(path.join(targetDir, "value.txt"), "first\n");
  git(targetDir, "add", "value.txt");
  git(targetDir, "commit", "-m", "first");
  const first = git(targetDir, "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(targetDir, "value.txt"), "second\n");
  git(targetDir, "commit", "-am", "second");
  const second = git(targetDir, "rev-parse", "HEAD").trim();
  const secondTree = git(targetDir, "rev-parse", "HEAD^{tree}").trim();
  git(targetDir, "replace", second, first);

  assert.equal(commitTreeSha({ targetDir, commit: second }), secondTree);
  assert.throws(
    () => exactCommitRefspec({ commit: second, targetRef: "refs/heads/.hidden" }),
    /target ref is missing or malformed/,
  );
  assert.throws(
    () => exactCommitRefspec({ commit: "HEAD", targetRef: "refs/heads/safe" }),
    /commit is missing or malformed/,
  );
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
