import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  changedFilesFromNameOnlyZ,
  enforceRepairContract,
  repairContract,
  validateRepairContractShape,
} from "../../dist/repair/repair-contract.js";

test("repair contract is explicit and ignores incomplete likely_files", () => {
  assert.equal(repairContract({ likely_files: ["src/a.ts"] }), null);
  assert.equal(repairContract({ repair_contract: null }), null);
  assert.deepEqual(
    repairContract({
      likely_files: ["src/a.ts"],
      repair_contract: { must_touch: ["src/a.ts"], match: "any" },
    }),
    { mustTouch: ["src/a.ts"], match: "any" },
  );
});

test("repair contract validates schema-level shape", () => {
  assert.deepEqual(validateRepairContractShape({}), []);
  assert.deepEqual(validateRepairContractShape({ repair_contract: null }), []);
  assert.deepEqual(
    validateRepairContractShape({
      repair_contract: { must_touch: ["src/a.ts"], match: "any" },
    }),
    [],
  );
  assert.match(
    validateRepairContractShape({
      repair_contract: { must_touch: ["../secret"], match: "one", scope: "every_checkpoint" },
    }).join("\n"),
    /unsafe path|match must be any or all|scope is not allowed/,
  );
  assert.match(
    validateRepairContractShape({
      repair_contract: { must_touch: ["src/a.ts"] },
    }).join("\n"),
    /match must be any or all/,
  );
  assert.match(
    validateRepairContractShape({
      repair_contract: { must_touch: ["src/a.ts", 7], match: "any", extra: true },
    }).join("\n"),
    /entries must be strings|extra is not allowed/,
  );
  assert.match(
    validateRepairContractShape({
      deterministic_rebase_only: true,
      repair_contract: { must_touch: ["src/a.ts"], match: "any" },
    }).join("\n"),
    /incompatible with deterministic_rebase_only/,
  );
});

test("name-only z parser preserves spaces", () => {
  assert.deepEqual(changedFilesFromNameOnlyZ("src/file with space.ts\0docs/guide.md\0"), [
    "src/file with space.ts",
    "docs/guide.md",
  ]);
});

test("final repair contract supports any, all, and directory semantics", () => {
  assert.doesNotThrow(() =>
    enforceRepairContract({
      changedFiles: ["src/a.ts", "docs/review.md"],
      fixArtifact: {
        repair_contract: { must_touch: ["src/a.ts", "src/c.ts"], match: "any" },
      },
    }),
  );
  assert.doesNotThrow(() =>
    enforceRepairContract({
      changedFiles: ["src/a.ts", "src/c.ts", "test/review-fix.test.ts"],
      fixArtifact: {
        repair_contract: { must_touch: ["src/a.ts", "src/c.ts"], match: "all" },
      },
    }),
  );
  assert.doesNotThrow(() =>
    enforceRepairContract({
      changedFiles: ["src/repair/a.ts"],
      fixArtifact: { repair_contract: { must_touch: ["src/repair"], match: "all" } },
    }),
  );
  assert.throws(
    () =>
      enforceRepairContract({
        changedFiles: ["docs/review.md"],
        fixArtifact: {
          repair_contract: { must_touch: ["src/a.ts", "src/c.ts"], match: "any" },
        },
      }),
    /repair contract rejected final repair tree.*missing=src\/a\.ts, src\/c\.ts/,
  );
});

test("later checkpoint files do not invalidate a cumulative repair", () => {
  assert.doesNotThrow(() =>
    enforceRepairContract({
      changedFiles: ["src/a.ts", "test/a.test.ts", "docs/base-sync.md"],
      fixArtifact: { repair_contract: { must_touch: ["src/a.ts"], match: "all" } },
    }),
  );
});

test("git final-tree integration ignores paths changed only by the latest base", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-repair-contract-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "ClawSweeper Test");
    git("config", "user.email", "clawsweeper@example.invalid");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export const value = 1;\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const initial = git("rev-parse", "HEAD");

    git("checkout", "-qb", "latest-base");
    writeFileSync(join(root, "src/a.ts"), "export const value = 2;\n");
    git("add", ".");
    git("commit", "-qm", "upstream change");
    const latestBase = git("rev-parse", "HEAD");

    git("checkout", "-qb", "repaired");
    writeFileSync(join(root, "src/a.ts"), "export const value = 3;\n");
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test/review-fix.test.ts"), "// later review checkpoint\n");
    git("add", ".");
    git("commit", "-qm", "repair plus review fix");

    const changedFiles = changedFilesFromNameOnlyZ(
      execFileSync("git", ["diff", "--name-only", "-z", `${latestBase}..HEAD`], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    assert.doesNotThrow(() =>
      enforceRepairContract({
        changedFiles,
        fixArtifact: { repair_contract: { must_touch: ["src/a.ts"], match: "all" } },
      }),
    );
    git("checkout", "-qb", "unrelated", initial);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/review.md"), "unrelated repair\n");
    git("add", ".");
    git("commit", "-qm", "unrelated repair");
    git("rebase", "-q", "latest-base");
    const unrelatedFiles = changedFilesFromNameOnlyZ(
      execFileSync("git", ["diff", "--name-only", "-z", `${latestBase}..HEAD`], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    assert.deepEqual(unrelatedFiles, ["docs/review.md"]);
    assert.throws(
      () =>
        enforceRepairContract({
          changedFiles: unrelatedFiles,
          fixArtifact: { repair_contract: { must_touch: ["src/a.ts"], match: "all" } },
        }),
      /repair contract rejected final repair tree/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
