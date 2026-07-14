import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  sha256RegularFile,
  snapshotRegularFile,
} from "../../dist/repair/prepared-publication-file.js";

test("prepared publication validation snapshots exact regular-file bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-prepared-snapshot-"));
  const source = path.join(root, "transfer.bundle");
  const snapshot = path.join(root, "validated.bundle");
  try {
    fs.writeFileSync(source, "reviewed bytes\n", { mode: 0o600 });
    const receipt = snapshotRegularFile(source, snapshot);
    fs.writeFileSync(source, "replaced bytes\n", { mode: 0o600 });

    assert.equal(fs.readFileSync(snapshot, "utf8"), "reviewed bytes\n");
    assert.equal(receipt.sha256, sha256RegularFile(snapshot).sha256);
    assert.notEqual(receipt.sha256, sha256RegularFile(source).sha256);
    assert.equal(fs.statSync(snapshot).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepared publication validation rejects symbolic-link transfers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-prepared-symlink-"));
  const target = path.join(root, "target.bundle");
  const source = path.join(root, "transfer.bundle");
  try {
    fs.writeFileSync(target, "untrusted replacement\n");
    fs.symlinkSync(target, source);
    assert.throws(
      () => snapshotRegularFile(source, path.join(root, "validated.bundle")),
      /ELOOP|symbolic link|too many levels/i,
    );
    assert.throws(() => sha256RegularFile(source), /ELOOP|symbolic link|too many levels/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
