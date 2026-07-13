import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("hydrate-state restores durable notification checkpoints", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-state-"));
  const state = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(path.join(state, "notifications"), { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(
    path.join(state, "notifications", "clawsweeper-event-ledger.json"),
    '{"version":1,"notifications":[]}\n',
  );

  try {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/hydrate-state.ts"), "--state-dir", state, "--worktree", worktree],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(
        path.join(worktree, "notifications", "clawsweeper-event-ledger.json"),
        "utf8",
      ),
      '{"version":1,"notifications":[]}\n',
    );
    assert.match(result.stdout, /"notifications"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
