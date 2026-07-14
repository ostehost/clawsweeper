import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertTargetValidationReceipt,
  captureTargetValidationReceipt,
  prepareTargetToolchain,
  reproduceValidationFailureAtPinnedBase,
  runAllowedValidationCommands,
} from "../../dist/repair/target-validation.js";
import { mockCommandBinEnv } from "../helpers.ts";

const TIMEOUT_MS = 15_000;

test("target dependency setup requires a Git checkout root", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-nongit-"));
  fs.writeFileSync(path.join(cwd, "package.json"), '{"scripts":{"check":"node check.js"}}\n');

  assert.throws(
    () => prepareTargetToolchain(cwd, validationOptions("npm")),
    /target validation requires a Git checkout root/,
  );
});

test("target dependency setup rejects tracked source mutation", () => {
  const cwd = gitPackageFixture();
  const npmShim = nodeCommandShim(
    `const fs = require("node:fs");
fs.writeFileSync("source.txt", "mutated\\n");
`,
    "npm-source-mutation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /target dependency setup mutated tracked source identity/,
    );
  });
  assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "mutated\n");
});

test("target dependency setup rejects new nonignored untracked files", () => {
  const cwd = gitPackageFixture();
  const npmShim = nodeCommandShim(
    `require("node:fs").writeFileSync("generated-fix.ts", "unreviewed output\\n");
`,
    "npm-untracked-source-creation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /target dependency setup mutated tracked source identity/,
    );
  });
  assert.equal(git(cwd, "ls-files", "--others", "--exclude-standard"), "generated-fix.ts");
});

test("target dependency setup permits ignored dependency output", () => {
  const cwd = gitPackageFixture();
  const npmShim = nodeCommandShim(
    `const fs = require("node:fs");
fs.mkdirSync("node_modules/example", { recursive: true });
fs.writeFileSync("node_modules/example/index.js", "generated dependency\\n");
`,
    "npm-ignored-dependency-output",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    prepareTargetToolchain(cwd, validationOptions("npm"));
  });
  assert.equal(git(cwd, "ls-files", "--others", "--exclude-standard"), "");
});

test("target dependency setup binds existing untracked file content", () => {
  const cwd = gitPackageFixture();
  fs.writeFileSync(path.join(cwd, "draft.ts"), "original draft\n");
  const npmShim = nodeCommandShim(
    `require("node:fs").writeFileSync("draft.ts", "mutated draft\\n");
`,
    "npm-untracked-content-mutation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /target dependency setup mutated tracked source identity/,
    );
  });
});

test(
  "target dependency setup binds existing untracked file modes",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    fs.writeFileSync(path.join(cwd, "draft.ts"), "draft\n");
    fs.chmodSync(path.join(cwd, "draft.ts"), 0o644);
    const npmShim = nodeCommandShim(
      `require("node:fs").chmodSync("draft.ts", 0o755);
`,
      "npm-untracked-mode-mutation",
    );

    withCommandOverrides({ npm: npmShim }, () => {
      assert.throws(
        () => prepareTargetToolchain(cwd, validationOptions("npm")),
        /target dependency setup mutated tracked source identity/,
      );
    });
  },
);

test(
  "target dependency setup binds untracked symlink target content",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    fs.appendFileSync(path.join(cwd, ".gitignore"), "ignored/\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-m", "test: ignore symlink target");
    fs.mkdirSync(path.join(cwd, "ignored"));
    fs.writeFileSync(path.join(cwd, "ignored", "draft.ts"), "original target\n");
    fs.symlinkSync("ignored/draft.ts", path.join(cwd, "draft-link.ts"));
    const npmShim = nodeCommandShim(
      `require("node:fs").writeFileSync("ignored/draft.ts", "mutated target\\n");
`,
      "npm-untracked-symlink-target-mutation",
    );

    withCommandOverrides({ npm: npmShim }, () => {
      assert.throws(
        () => prepareTargetToolchain(cwd, validationOptions("npm")),
        /target dependency setup mutated tracked source identity/,
      );
    });
  },
);

test("failed target dependency setup still reports tracked source mutation", () => {
  const cwd = gitPackageFixture();
  const npmShim = nodeCommandShim(
    `const fs = require("node:fs");
fs.writeFileSync("source.txt", "failed mutation\\n");
process.exit(7);
`,
    "npm-failed-source-mutation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /target dependency setup mutated tracked source identity/,
    );
  });
});

test(
  "target dependency setup binds tracked regular-file modes",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    const npmShim = nodeCommandShim(
      `require("node:fs").chmodSync("source.txt", 0o755);
`,
      "npm-file-mode-mutation",
    );

    withCommandOverrides({ npm: npmShim }, () => {
      assert.throws(
        () => prepareTargetToolchain(cwd, validationOptions("npm")),
        /target dependency setup mutated tracked source identity/,
      );
    });
  },
);

test("pnpm target dependency setup does not load repository-controlled pnpm hooks", () => {
  const cwd = gitPackageFixture({ packageManager: "pnpm@10.33.0" });
  fs.writeFileSync(
    path.join(cwd, ".pnpmfile.cjs"),
    `require("node:fs").writeFileSync("source.txt", "pnpmfile-ran\\n");
module.exports = { hooks: {} };
`,
  );
  git(cwd, "add", ".pnpmfile.cjs");
  git(cwd, "commit", "-m", "test: add pnpm hook");

  const corepackShim = nodeCommandShim("", "corepack-noop");
  const pnpmShim = nodeCommandShim(
    `if (!process.argv.includes("--ignore-pnpmfile")) require(require("node:path").join(process.cwd(), ".pnpmfile.cjs"));
`,
    "pnpm-hook-simulator",
  );
  withCommandOverrides({ corepack: corepackShim, pnpm: pnpmShim }, () => {
    prepareTargetToolchain(cwd, validationOptions("pnpm"));
  });

  assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "original\n");
});

test(
  "pnpm fallback restores the exact pre-install lockfile worktree state",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture({ packageManager: "pnpm@10.33.0" });
    const lockfile = path.join(cwd, "pnpm-lock.yaml");
    fs.writeFileSync(lockfile, "committed lockfile\n");
    git(cwd, "add", "pnpm-lock.yaml");
    git(cwd, "commit", "-m", "test: add lockfile");
    fs.writeFileSync(lockfile, "intentional repair edit\n");
    fs.chmodSync(lockfile, 0o600);

    const corepackShim = nodeCommandShim("", "corepack-lockfile-noop");
    const pnpmShim = nodeCommandShim(
      `const fs = require("node:fs");
fs.writeFileSync("pnpm-lock.yaml", process.argv.includes("--frozen-lockfile") ? "failed frozen rewrite\\n" : "fallback rewrite\\n");
fs.chmodSync("pnpm-lock.yaml", 0o644);
if (process.argv.includes("--frozen-lockfile")) {
  console.error("ERR_PNPM_OUTDATED_LOCKFILE");
  process.exit(1);
}
`,
      "pnpm-lockfile-fallback",
    );
    withCommandOverrides({ corepack: corepackShim, pnpm: pnpmShim }, () => {
      prepareTargetToolchain(cwd, validationOptions("pnpm"));
    });

    assert.equal(fs.readFileSync(lockfile, "utf8"), "intentional repair edit\n");
    assert.equal(fs.statSync(lockfile).mode & 0o777, 0o600);
  },
);

test("target dependency setup rejects local Git control-plane mutation", () => {
  const cwd = gitPackageFixture();
  const npmShim = nodeCommandShim(
    `require("node:child_process").execFileSync("git", ["config", "core.hooksPath", ".malicious-hooks"]);
`,
    "npm-git-config-mutation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /target dependency setup mutated tracked source identity/,
    );
  });
});

test("target dependency setup binds effective global Git configuration", () => {
  const cwd = gitPackageFixture();
  const globalConfig = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-global-git-config-")),
    "config",
  );
  fs.writeFileSync(globalConfig, "[safe]\n\tvalue = original\n");
  const npmShim = nodeCommandShim(
    `require("node:fs").appendFileSync(${JSON.stringify(globalConfig)}, "[attacker]\\n\\tvalue = changed\\n");
`,
    "npm-global-config-mutation",
  );

  withEnv("GIT_CONFIG_GLOBAL", globalConfig, () => {
    withCommandOverrides({ npm: npmShim }, () => {
      assert.throws(
        () => prepareTargetToolchain(cwd, validationOptions("npm")),
        /target dependency setup mutated tracked source identity/,
      );
    });
  });
});

test(
  "target dependency identity does not traverse resolved external hook targets",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hooks-"));
    const hookTarget = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hook-target-")),
      "pre-commit",
    );
    fs.writeFileSync(hookTarget, "#!/bin/sh\nexit 0\n");
    fs.symlinkSync(hookTarget, path.join(hooksDir, "pre-commit"));
    git(cwd, "config", "core.hooksPath", hooksDir);
    const npmShim = nodeCommandShim(
      `require("node:fs").writeFileSync(${JSON.stringify(hookTarget)}, "#!/bin/sh\\nexit 1\\n");
`,
      "npm-hook-target-mutation",
    );

    withCommandOverrides({ npm: npmShim }, () => {
      assert.doesNotThrow(() => prepareTargetToolchain(cwd, validationOptions("npm")));
    });
    assert.match(fs.readFileSync(hookTarget, "utf8"), /exit 1/);
  },
);

test("target dependency setup binds the HEAD symbolic ref at the same commit", () => {
  const cwd = gitPackageFixture();
  git(cwd, "branch", "same-commit");
  const npmShim = nodeCommandShim(
    `require("node:child_process").execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/same-commit"]);
`,
    "npm-head-symbolic-ref-mutation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /target dependency setup mutated tracked source identity/,
    );
  });
});

test(
  "target dependency setup binds git-dir indirection at the same repository",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    const externalGitDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-external-git-dir-")),
      "repository.git",
    );
    fs.renameSync(path.join(cwd, ".git"), externalGitDir);
    fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${externalGitDir}\n`);
    const alternateSpelling = `${path.dirname(externalGitDir)}${path.sep}.${path.sep}repository.git`;
    const npmShim = nodeCommandShim(
      `require("node:fs").writeFileSync(".git", ${JSON.stringify(`gitdir: ${alternateSpelling}\n`)});
`,
      "npm-git-indirection-mutation",
    );

    withCommandOverrides({ npm: npmShim }, () => {
      assert.throws(
        () => prepareTargetToolchain(cwd, validationOptions("npm")),
        /target dependency setup mutated tracked source identity/,
      );
    });
  },
);

test("target dependency setup binds loose Git replacement refs", () => {
  const cwd = gitPackageFixture();
  const replacement = replacementCommit(cwd, "replacement one");
  const npmShim = nodeCommandShim(
    `require("node:child_process").execFileSync("git", ["replace", "HEAD", ${JSON.stringify(replacement)}]);
`,
    "npm-loose-replace-ref-mutation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /target dependency setup mutated tracked source identity/,
    );
  });
  assert.match(git(cwd, "show-ref"), /refs\/replace\//);
});

test("target dependency setup binds packed Git replacement refs", () => {
  const cwd = gitPackageFixture();
  const firstReplacement = replacementCommit(cwd, "replacement one");
  const secondReplacement = replacementCommit(cwd, "replacement two");
  git(cwd, "replace", "HEAD", firstReplacement);
  git(cwd, "pack-refs", "--all", "--prune");
  const npmShim = nodeCommandShim(
    `const cp = require("node:child_process");
cp.execFileSync("git", ["replace", "-f", "HEAD", ${JSON.stringify(secondReplacement)}]);
cp.execFileSync("git", ["pack-refs", "--all", "--prune"]);
`,
    "npm-packed-replace-ref-mutation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /target dependency setup mutated tracked source identity/,
    );
  });
  assert.match(fs.readFileSync(path.join(cwd, ".git", "packed-refs"), "utf8"), /refs\/replace\//);
});

test("target dependency setup binds Git history and operation control state", () => {
  const statePaths = [
    "MERGE_HEAD",
    "rebase-merge/head-name",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "sequencer/todo",
    "info/sparse-checkout",
    "info/grafts",
    "objects/info/alternates",
  ];
  for (const gitPath of statePaths) {
    const cwd = gitPackageFixture();
    const head = git(cwd, "rev-parse", "HEAD");
    const externalObjects = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawsweeper-alternate-objects-"),
    );
    const content =
      gitPath === "objects/info/alternates"
        ? `${externalObjects}\n`
        : gitPath === "rebase-merge/head-name"
          ? "refs/heads/main\n"
          : gitPath === "sequencer/todo"
            ? `pick ${head} test\n`
            : gitPath === "info/sparse-checkout"
              ? "source.txt\n"
              : `${head}\n`;
    const npmShim = nodeCommandShim(
      `const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const target = cp.execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", ${JSON.stringify(gitPath)}], { encoding: "utf8" }).trim();
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, ${JSON.stringify(content)});
`,
      `npm-git-state-${gitPath.replace(/[^A-Za-z0-9]/g, "-")}`,
    );

    withCommandOverrides({ npm: npmShim }, () => {
      assert.throws(
        () => prepareTargetToolchain(cwd, validationOptions("npm")),
        /target dependency setup mutated tracked source identity/,
        gitPath,
      );
    });
  }
});

test("target dependency setup accepts valid tracked names beginning with two dots", () => {
  const cwd = gitPackageFixture();
  fs.writeFileSync(path.join(cwd, "..cache"), "valid in-checkout path\n");
  git(cwd, "add", "..cache");
  git(cwd, "commit", "-m", "test: add two-dot filename");
  const npmShim = nodeCommandShim("", "npm-two-dot-path-noop");

  withCommandOverrides({ npm: npmShim }, () => {
    prepareTargetToolchain(cwd, validationOptions("npm"));
  });
});

test(
  "target dependency setup still rejects parent-traversing symlinks",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    const externalFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-external-source-")),
      "source.txt",
    );
    fs.writeFileSync(externalFile, "outside checkout\n");
    fs.symlinkSync(path.relative(cwd, externalFile), path.join(cwd, "escaping-source"));

    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /untracked target symlink escapes checkout/,
    );
  },
);

test("target dependency setup rejects hidden tracked index flags", () => {
  const cwd = gitPackageFixture();
  const npmShim = nodeCommandShim(
    `require("node:child_process").execFileSync("git", ["update-index", "--skip-worktree", "source.txt"]);
`,
    "npm-index-mutation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /rejects hidden tracked index flags/,
    );
  });
});

test(
  "target dependency setup binds tracked symlink targets inside the checkout",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    const ignoredDir = path.join(cwd, "ignored");
    fs.mkdirSync(ignoredDir);
    fs.writeFileSync(path.join(ignoredDir, "source.txt"), "original target\n");
    fs.appendFileSync(path.join(cwd, ".gitignore"), "ignored/\n");
    fs.symlinkSync("ignored/source.txt", path.join(cwd, "linked-source.txt"));
    git(cwd, "add", ".gitignore", "linked-source.txt");
    git(cwd, "commit", "-m", "test: add tracked symlink");

    const npmShim = nodeCommandShim(
      `require("node:fs").writeFileSync("ignored/source.txt", "mutated target\\n");
`,
      "npm-symlink-target-mutation",
    );
    withCommandOverrides({ npm: npmShim }, () => {
      assert.throws(
        () => prepareTargetToolchain(cwd, validationOptions("npm")),
        /target dependency setup mutated tracked source identity/,
      );
    });
  },
);

test("target dependency setup binds initialized submodule worktrees", () => {
  const submodule = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-submodule-"));
  initializeGitRepository(submodule);
  fs.writeFileSync(path.join(submodule, "source.txt"), "submodule original\n");
  git(submodule, "add", ".");
  git(submodule, "commit", "-m", "test: initialize submodule");

  const cwd = gitPackageFixture();
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", submodule, "vendor/sub");
  git(cwd, "commit", "-m", "test: add submodule");
  const npmShim = nodeCommandShim(
    `require("node:fs").writeFileSync("vendor/sub/source.txt", "submodule mutated\\n");
`,
    "npm-submodule-mutation",
  );

  withCommandOverrides({ npm: npmShim }, () => {
    assert.throws(
      () => prepareTargetToolchain(cwd, validationOptions("npm")),
      /target dependency setup mutated tracked source identity/,
    );
  });
});

test("target validation receipts bind a clean committed checkout", () => {
  const cwd = gitPackageFixture();
  fs.mkdirSync(path.join(cwd, "node_modules", "example"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "node_modules", "example", "index.js"), "ignored output\n");
  const receipt = captureTargetValidationReceipt(cwd);

  assert.equal(receipt.headSha, git(cwd, "rev-parse", "HEAD"));
  assert.equal(receipt.headTreeSha, git(cwd, "rev-parse", "HEAD^{tree}"));
  assert.equal(Object.isFrozen(receipt), true);
  assert.doesNotThrow(() => assertTargetValidationReceipt(cwd, receipt));
  assert.throws(
    () =>
      assertTargetValidationReceipt(cwd, {
        headSha: receipt.headSha,
        headTreeSha: receipt.headTreeSha,
      }),
    /receipt is invalid or expired/,
  );
});

test("target validation receipts compare raw worktree bytes with the committed blob", () => {
  const cwd = gitPackageFixture();
  fs.writeFileSync(path.join(cwd, "source.txt"), "validated but uncommitted\n");

  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /raw tracked bytes differ from HEAD: source\.txt/,
  );
});

test("target validation receipts accept clean declarative attribute transformations", () => {
  const cwd = gitPackageFixture();
  fs.writeFileSync(
    path.join(cwd, ".gitattributes"),
    "source.txt text eol=crlf\nidentified.txt ident\nencoded.txt working-tree-encoding=UTF-16LE\n",
  );
  fs.writeFileSync(path.join(cwd, "source.txt"), "line one\nline two\n");
  fs.writeFileSync(path.join(cwd, "identified.txt"), "$Id$\n");
  fs.writeFileSync(path.join(cwd, "encoded.txt"), Buffer.from("encoded content\n", "utf16le"));
  git(cwd, "add", ".gitattributes", "source.txt", "identified.txt", "encoded.txt");
  git(cwd, "commit", "-m", "test: add clean checkout transformations");
  fs.rmSync(path.join(cwd, "source.txt"));
  fs.rmSync(path.join(cwd, "identified.txt"));
  fs.rmSync(path.join(cwd, "encoded.txt"));
  git(cwd, "checkout-index", "--force", "--", "source.txt", "identified.txt", "encoded.txt");
  git(cwd, "add", "source.txt", "identified.txt", "encoded.txt");

  assert.match(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), /\r\n/);
  assert.match(fs.readFileSync(path.join(cwd, "identified.txt"), "utf8"), /\$Id: [a-f0-9]+ \$/);
  assert.notEqual(
    git(cwd, "hash-object", "--no-filters", "source.txt"),
    git(cwd, "rev-parse", "HEAD:source.txt"),
  );
  assert.notEqual(
    git(cwd, "hash-object", "--no-filters", "encoded.txt"),
    git(cwd, "rev-parse", "HEAD:encoded.txt"),
  );
  assert.equal(git(cwd, "status", "--porcelain=v1"), "");
  assert.doesNotThrow(() => captureTargetValidationReceipt(cwd));
});

test("target validation receipts reject lossy ident-equivalent worktree bytes", () => {
  const cwd = gitPackageFixture();
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "identified.txt ident\n");
  fs.writeFileSync(path.join(cwd, "identified.txt"), "$Id$\n");
  git(cwd, "add", ".gitattributes", "identified.txt");
  git(cwd, "commit", "-m", "test: add ident expansion");
  fs.rmSync(path.join(cwd, "identified.txt"));
  git(cwd, "checkout-index", "--force", "--", "identified.txt");
  const object = git(cwd, "rev-parse", "HEAD:identified.txt");
  const forged =
    object === "f".repeat(object.length) ? "e".repeat(object.length) : "f".repeat(object.length);
  fs.writeFileSync(path.join(cwd, "identified.txt"), `$Id: ${forged} $\n`);
  git(cwd, "add", "identified.txt");

  assert.equal(git(cwd, "status", "--porcelain=v1"), "");
  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /raw tracked bytes differ from HEAD: identified\.txt/,
  );
});

test("target validation receipts reconstruct SHA-256 checkout transformations", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-sha256-"));
  try {
    execFileSync("git", ["init", "-b", "main", "--object-format=sha256"], {
      cwd,
      stdio: "pipe",
    });
  } catch {
    t.skip("installed Git does not support SHA-256 repositories");
    return;
  }
  git(cwd, "config", "user.email", "clawsweeper@example.invalid");
  git(cwd, "config", "user.name", "ClawSweeper Test");
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "source.txt text eol=crlf\n");
  fs.writeFileSync(path.join(cwd, "source.txt"), "sha256 checkout\n");
  git(cwd, "add", ".gitattributes", "source.txt");
  git(cwd, "commit", "-m", "test: initialize sha256 checkout");
  fs.rmSync(path.join(cwd, "source.txt"));
  git(cwd, "checkout-index", "--force", "--", "source.txt");
  git(cwd, "add", "source.txt");

  assert.equal(git(cwd, "status", "--porcelain=v1"), "");
  assert.doesNotThrow(() => captureTargetValidationReceipt(cwd));
});

test("target validation receipts reject ambient global custom filters", () => {
  const filterDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-trusted-filter-"));
  const filter = path.join(filterDir, "filter.js");
  const globalConfig = path.join(filterDir, "gitconfig");
  fs.writeFileSync(
    filter,
    `process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(process.argv[2] === "clean" ? "CANONICAL-PUBLISHED\\n" : "WORKTREE-VALIDATED\\n");
});
`,
  );
  execFileSync("git", [
    "config",
    "--file",
    globalConfig,
    "filter.trusted.clean",
    `${process.execPath} ${filter} clean`,
  ]);
  execFileSync("git", [
    "config",
    "--file",
    globalConfig,
    "filter.trusted.smudge",
    `${process.execPath} ${filter} smudge`,
  ]);
  execFileSync("git", ["config", "--file", globalConfig, "filter.trusted.required", "true"]);

  withEnv("GIT_CONFIG_GLOBAL", globalConfig, () => {
    const cwd = gitPackageFixture();
    fs.writeFileSync(path.join(cwd, ".gitattributes"), "source.txt filter=trusted\n");
    fs.writeFileSync(path.join(cwd, "source.txt"), "WORKTREE-VALIDATED\n");
    git(cwd, "add", ".gitattributes", "source.txt");
    git(cwd, "commit", "-m", "test: add trusted global filter");
    fs.rmSync(path.join(cwd, "source.txt"));
    git(cwd, "checkout-index", "--force", "--", "source.txt");

    assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "WORKTREE-VALIDATED\n");
    assert.equal(git(cwd, "show", "HEAD:source.txt"), "CANONICAL-PUBLISHED");
    assert.equal(git(cwd, "status", "--porcelain=v1"), "");
    assert.throws(
      () => captureTargetValidationReceipt(cwd),
      /rejects filtered worktree path: source\.txt/,
    );
  });
});

test("target validation receipts reject ambient LFS filters without running drivers", () => {
  const filterDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-lfs-filter-"));
  const filter = path.join(filterDir, "filter.js");
  const globalConfig = path.join(filterDir, "gitconfig");
  const invocationLog = path.join(filterDir, "invocations.log");
  const worktreeBytes = Buffer.from("LFS-WORKTREE-CONTENT\n");
  const pointer = [
    "version https://git-lfs.github.com/spec/v1",
    `oid sha256:${createHash("sha256").update(worktreeBytes).digest("hex")}`,
    `size ${worktreeBytes.length}`,
    "",
  ].join("\n");
  fs.writeFileSync(
    filter,
    `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(invocationLog)}, process.argv[2] + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(process.argv[2] === "clean" ? ${JSON.stringify(pointer)} : ${JSON.stringify(worktreeBytes.toString("utf8"))});
});
`,
  );
  execFileSync("git", [
    "config",
    "--file",
    globalConfig,
    "filter.lfs.clean",
    `${process.execPath} ${filter} clean`,
  ]);
  execFileSync("git", [
    "config",
    "--file",
    globalConfig,
    "filter.lfs.smudge",
    `${process.execPath} ${filter} smudge`,
  ]);
  execFileSync("git", ["config", "--file", globalConfig, "filter.lfs.required", "true"]);

  withEnv("GIT_CONFIG_GLOBAL", globalConfig, () => {
    const cwd = gitPackageFixture();
    fs.writeFileSync(path.join(cwd, ".gitattributes"), "source.txt filter=lfs\n");
    fs.writeFileSync(path.join(cwd, "source.txt"), worktreeBytes);
    git(cwd, "add", ".gitattributes", "source.txt");
    git(cwd, "commit", "-m", "test: add pointer-verified LFS content");
    fs.rmSync(path.join(cwd, "source.txt"));
    git(cwd, "checkout-index", "--force", "--", "source.txt");
    assert.equal(git(cwd, "status", "--porcelain=v1"), "");
    assert.equal(git(cwd, "show", "HEAD:source.txt"), pointer.trim());

    fs.writeFileSync(invocationLog, "");
    assert.throws(
      () => captureTargetValidationReceipt(cwd),
      /rejects filtered worktree path: source\.txt/,
    );
    assert.equal(
      fs.readFileSync(invocationLog, "utf8"),
      "",
      "receipt proof must not execute ambient LFS drivers",
    );
  });
});

test("target validation receipts reject repository-local info attributes", () => {
  const cwd = gitPackageFixture();
  const attributes = git(
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/attributes",
  );
  fs.mkdirSync(path.dirname(attributes), { recursive: true });
  fs.writeFileSync(attributes, "source.txt ident\n");

  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /rejects repository-local info\/attributes/,
  );
});

test("target validation receipts reject local core.attributesFile", () => {
  const cwd = gitPackageFixture();
  const attributes = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-local-attributes-")),
    "attributes",
  );
  fs.writeFileSync(attributes, "source.txt ident\n");
  git(cwd, "config", "core.attributesFile", attributes);

  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /unsafe local Git config: core\.attributesfile/,
  );
});

test(
  "target validation receipts reject a local fsmonitor that hides dirty tracked bytes",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fsmonitor-"));
    const hookPath = path.join(hookDir, "fsmonitor.sh");
    fs.writeFileSync(hookPath, "#!/bin/sh\nprintf 'stable-token\\0'\n", { mode: 0o755 });
    git(cwd, "config", "core.fsmonitor", hookPath);
    git(cwd, "status", "--porcelain=v1");
    fs.writeFileSync(path.join(cwd, "source.txt"), "BBBBBBB\n");

    assert.equal(
      git(cwd, "status", "--porcelain=v1"),
      "",
      "the malicious fsmonitor fixture must hide the tracked mutation",
    );
    assert.throws(
      () => captureTargetValidationReceipt(cwd),
      /unsafe local Git config: core\.fsmonitor/,
    );
  },
);

test("target validation receipts reject clean filters that publish different bytes", () => {
  const cwd = gitPackageFixture();
  const filter = nodeCommandShim(
    `process.stdin.resume();
process.stdout.write("PUBLISHED-MALICIOUS\\n");
`,
    "git-clean-filter",
  );
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "source.txt filter=lie\n");
  fs.writeFileSync(path.join(cwd, "source.txt"), "VALIDATED-SAFE\n");
  git(cwd, "config", "filter.lie.clean", `${process.execPath} ${filter}`);
  git(cwd, "config", "filter.lie.smudge", "cat");
  git(cwd, "add", ".gitattributes", "source.txt");
  git(cwd, "commit", "-m", "test: add deceptive clean filter");

  assert.equal(git(cwd, "status", "--porcelain=v1"), "");
  assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "VALIDATED-SAFE\n");
  assert.equal(git(cwd, "show", "HEAD:source.txt"), "PUBLISHED-MALICIOUS");
  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /unsafe local Git config: filter\.lie\.(?:clean|smudge)/,
  );
});

test("target validation receipts do not trust Git info excludes", () => {
  const cwd = gitPackageFixture();
  const infoExclude = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  fs.appendFileSync(infoExclude, "hidden-helper.ts\n");
  fs.writeFileSync(path.join(cwd, "hidden-helper.ts"), "validated but unpublished\n");

  assert.equal(git(cwd, "status", "--porcelain=v1"), "");
  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /requires no untracked source files: hidden-helper\.ts/,
  );
});

test(
  "target validation receipts reject untracked paths before traversing their contents",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-receipt-outside-"));
    fs.symlinkSync(outside, path.join(cwd, "untracked-proof"));

    assert.throws(
      () => captureTargetValidationReceipt(cwd),
      /requires no untracked source files: untracked-proof/,
    );
  },
);

test(
  "target validation receipts bound ignored content reached through tracked symlinks",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    const ignored = path.join(cwd, "ignored");
    fs.mkdirSync(ignored);
    fs.appendFileSync(path.join(cwd, ".gitignore"), "ignored/\n");
    fs.symlinkSync("ignored/payload.bin", path.join(cwd, "proof.bin"));
    git(cwd, "add", ".gitignore", "proof.bin");
    git(cwd, "commit", "-m", "test: add bounded ignored symlink target");
    fs.closeSync(fs.openSync(path.join(ignored, "payload.bin"), "w"));
    fs.truncateSync(path.join(ignored, "payload.bin"), 256 * 1024 * 1024 + 1);

    assert.throws(
      () => captureTargetValidationReceipt(cwd),
      /target worktree identity exceeds the per-file byte budget/,
    );
  },
);

test("target validation receipts reject repository-controlled global excludes", () => {
  const cwd = gitPackageFixture();
  const excludes = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-local-excludes-")),
    "exclude",
  );
  fs.writeFileSync(excludes, "hidden-helper.ts\n");
  git(cwd, "config", "core.excludesFile", excludes);
  fs.writeFileSync(path.join(cwd, "hidden-helper.ts"), "validated but unpublished\n");

  assert.equal(git(cwd, "status", "--porcelain=v1"), "");
  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /unsafe local Git config: core\.excludesfile/,
  );
});

test("target validation receipts reject self-hidden untracked ignore files", () => {
  const cwd = gitPackageFixture();
  fs.mkdirSync(path.join(cwd, "generated"));
  fs.writeFileSync(path.join(cwd, "generated", ".gitignore"), "*\n");
  fs.writeFileSync(path.join(cwd, "generated", "helper.ts"), "validated but unpublished\n");

  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /requires no untracked source files: generated\/\.gitignore/,
  );
});

test("target validation receipts accept clean uninitialized gitlinks", () => {
  const { cwd, gitlink } = uninitializedGitlinkReceiptFixture();

  assert.equal(fs.existsSync(path.join(gitlink, ".git")), false);
  if (fs.existsSync(gitlink)) assert.deepEqual(fs.readdirSync(gitlink), []);
  assert.doesNotThrow(() => captureTargetValidationReceipt(cwd));
});

test("target validation receipts reject nonempty uninitialized gitlinks", () => {
  const { cwd, gitlink } = uninitializedGitlinkReceiptFixture();
  fs.mkdirSync(gitlink, { recursive: true });
  fs.writeFileSync(path.join(gitlink, "unpublished-helper.ts"), "unpublished helper\n");

  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /uninitialized gitlink is not empty: vendor\/sub/,
  );
});

test(
  "target validation receipts reject broken gitlink symlinks",
  { skip: process.platform === "win32" },
  () => {
    const { cwd, gitlink } = uninitializedGitlinkReceiptFixture();
    fs.rmSync(gitlink, { force: true, recursive: true });
    fs.symlinkSync("missing-gitlink-target", gitlink);

    assert.throws(
      () => captureTargetValidationReceipt(cwd),
      /uninitialized gitlink has wrong type: vendor\/sub/,
    );
  },
);

test(
  "target validation receipts reject gitlinks symlinked to empty directories",
  { skip: process.platform === "win32" },
  () => {
    const { cwd, gitlink } = uninitializedGitlinkReceiptFixture();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-empty-gitlink-"));
    fs.rmSync(gitlink, { force: true, recursive: true });
    fs.symlinkSync(empty, gitlink);

    assert.throws(
      () => captureTargetValidationReceipt(cwd),
      /uninitialized gitlink has wrong type: vendor\/sub/,
    );
  },
);

test(
  "target validation receipts reject absent gitlinks below symlinked parents",
  { skip: process.platform === "win32" },
  () => {
    const { cwd, gitlink } = uninitializedGitlinkReceiptFixture();
    const parent = path.dirname(gitlink);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitlink-parent-"));
    fs.rmSync(parent, { force: true, recursive: true });
    fs.symlinkSync(outside, parent);

    assert.throws(
      () => captureTargetValidationReceipt(cwd),
      /requires no untracked source files: vendor/,
    );
  },
);

test("target validation receipts reject initialized gitlinks at a different commit", () => {
  const { cwd, gitlink } = gitlinkReceiptFixture();
  fs.writeFileSync(path.join(gitlink, "source.txt"), "second commit\n");
  git(gitlink, "add", "source.txt");
  git(gitlink, "commit", "-m", "test: advance initialized gitlink");
  git(cwd, "config", "submodule.vendor/sub.ignore", "all");

  assert.equal(git(cwd, "status", "--porcelain=v1"), "");
  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /gitlink HEAD differs from indexed commit: vendor\/sub/,
  );
});

test("target validation receipts recursively reject dirty ignored gitlinks", () => {
  const { cwd, gitlink } = gitlinkReceiptFixture();
  git(cwd, "config", "submodule.vendor/sub.ignore", "all");
  fs.writeFileSync(path.join(gitlink, "source.txt"), "dirty ignored content\n");

  assert.equal(git(cwd, "status", "--porcelain=v1"), "");
  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /raw tracked bytes differ from HEAD: source\.txt/,
  );
});

test("target validation receipts reject active Git operations and locks", () => {
  const states = [
    { path: "MERGE_HEAD", kind: "file" },
    { path: "rebase-merge/head-name", kind: "file" },
    { path: "CHERRY_PICK_HEAD", kind: "file" },
    { path: "REVERT_HEAD", kind: "file" },
    { path: "BISECT_LOG", kind: "file" },
    { path: "sequencer/todo", kind: "file" },
    { path: "index.lock", kind: "file" },
    { path: "refs/heads/main.lock", kind: "file" },
  ];
  for (const state of states) {
    const cwd = gitPackageFixture();
    const statePath = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", state.path);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${git(cwd, "rev-parse", "HEAD")}\n`);

    assert.throws(
      () => captureTargetValidationReceipt(cwd),
      /rejects active Git (?:operation|lock)/,
      state.path,
    );
  }
});

test("target validation receipts reject active replacement refs on a clean checkout", () => {
  const cwd = gitPackageFixture();
  const original = git(cwd, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(cwd, "source.txt"), "replacement tree\n");
  git(cwd, "add", "source.txt");
  git(cwd, "commit", "-m", "test: create replacement tree");
  const replacement = git(cwd, "rev-parse", "HEAD");
  git(cwd, "reset", "--hard", original);
  git(cwd, "replace", original, replacement);
  git(cwd, "reset", "--hard", "HEAD");
  const normalTree = git(cwd, "rev-parse", "HEAD^{tree}");
  const rawTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  }).trim();

  assert.equal(git(cwd, "status", "--porcelain=v1"), "");
  assert.notEqual(normalTree, rawTree);
  assert.throws(() => captureTargetValidationReceipt(cwd), /rejects active Git replace refs/);
});

test("target validation receipts reject legacy grafts", () => {
  const cwd = gitPackageFixture();
  const grafts = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/grafts");
  fs.mkdirSync(path.dirname(grafts), { recursive: true });
  fs.writeFileSync(grafts, `${git(cwd, "rev-parse", "HEAD")}\n`);

  assert.throws(() => captureTargetValidationReceipt(cwd), /rejects legacy Git grafts/);
});

test("target validation receipts reject repository-controlled hooks paths without traversing them", () => {
  const cwd = gitPackageFixture();
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-external-hooks-"));
  fs.symlinkSync(path.parse(hooks).root, path.join(hooks, "recursive-external-root"));
  git(cwd, "config", "core.hooksPath", hooks);

  assert.throws(
    () => captureTargetValidationReceipt(cwd),
    /unsafe local Git config: core\.hookspath/,
  );
});

test(
  "pinned-base reproduction ignores poisoned global checkout hooks",
  { skip: process.platform === "win32" },
  () => {
    const cwd = gitPackageFixture();
    const pinnedBaseRef = git(cwd, "rev-parse", "HEAD");
    const baseOptions = validationOptions("npm", { installTargetDeps: false });
    const poisonRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawsweeper-poisoned-validation-git-"),
    );
    const hooks = path.join(poisonRoot, "hooks");
    const marker = path.join(poisonRoot, "post-checkout-ran");
    const globalConfig = path.join(poisonRoot, "global-config");
    fs.mkdirSync(hooks);
    const hook = path.join(hooks, "post-checkout");
    fs.writeFileSync(hook, `#!/bin/sh\nprintf ran > "${marker}"\nexit 79\n`);
    fs.chmodSync(hook, 0o700);
    git(poisonRoot, "config", "--file", globalConfig, "core.hooksPath", hooks);

    withEnv("GIT_CONFIG_GLOBAL", globalConfig, () => {
      assert.equal(
        reproduceValidationFailureAtPinnedBase({
          commands: ["git diff --check"],
          targetDir: cwd,
          options: {
            ...baseOptions,
            pinnedBaseRef,
            toolchain: { ...baseOptions.toolchain, baseValidationCommands: [] },
          },
        }),
        null,
      );
    });
    assert.equal(fs.existsSync(marker), false);
  },
);

test("target validation commands cannot mutate the bound checkout", () => {
  const cwd = gitPackageFixture({
    scripts: {
      "check:mutate": `node -e "require('node:fs').writeFileSync('source.txt', 'validation mutation\\n')"`,
    },
  });
  attachOrigin(cwd);

  assert.throws(
    () =>
      runAllowedValidationCommands(
        ["pnpm check:mutate"],
        cwd,
        validationOptions("pnpm", { installTargetDeps: false }),
      ),
    /target dependency setup mutated tracked source identity/,
  );
});

test("target validation commands cannot create later-stageable untracked files", () => {
  const cwd = gitPackageFixture({
    scripts: {
      "check:create-untracked": `node -e "require('node:fs').writeFileSync('generated-fix.ts', 'validation output\\n')"`,
    },
  });
  fs.writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(cwd, "add", "pnpm-lock.yaml");
  git(cwd, "commit", "-m", "test: add pnpm lockfile");
  attachOrigin(cwd);

  assert.throws(
    () =>
      runAllowedValidationCommands(
        ["pnpm check:create-untracked"],
        cwd,
        validationOptions("pnpm", { installTargetDeps: false }),
      ),
    /target dependency setup mutated tracked source identity/,
  );
  assert.equal(git(cwd, "ls-files", "--others", "--exclude-standard"), "generated-fix.ts");
});

test("failed mutating validation fallbacks still verify source identity", () => {
  const cwd = gitPackageFixture({
    scripts: {
      "check:changed": "node check.js",
      "test:serial": "node test.js",
    },
  });
  fs.mkdirSync(path.join(cwd, "test"));
  fs.writeFileSync(path.join(cwd, "test", "example.test.ts"), "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "test: add base test");
  attachOrigin(cwd);
  fs.writeFileSync(path.join(cwd, "test", "example.test.ts"), "export const value = 2;\n");
  git(cwd, "add", "test/example.test.ts");
  git(cwd, "commit", "-m", "test: change test");
  const pnpmShim = nodeCommandShim(
    `const fs = require("node:fs");
if (process.argv.includes("check:changed")) {
  console.error("no output for 1000ms");
  process.exit(1);
}
if (process.argv.includes("test:serial")) {
  fs.writeFileSync("source.txt", "fallback mutation\\n");
  console.error("fallback failed after mutation");
  process.exit(7);
}
`,
    "pnpm-failed-mutating-fallback",
  );
  const options = {
    ...validationOptions("pnpm", { installTargetDeps: false }),
    targetRepo: "openclaw/openclaw",
    toolchain: {
      packageManager: "pnpm" as const,
      baseValidationCommands: [],
      changedGate: {
        command: "pnpm check:changed",
        requiredScript: "check:changed",
      },
    },
  };

  withCommandOverrides({ pnpm: pnpmShim }, () => {
    assert.throws(
      () => runAllowedValidationCommands(["pnpm check:changed"], cwd, options),
      /target dependency setup mutated tracked source identity/,
    );
  });
  assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "fallback mutation\n");
});

function gitPackageFixture({ packageManager, scripts = { check: "node check.js" } } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-integrity-"));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ scripts, ...(packageManager ? { packageManager } : {}) }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(cwd, "source.txt"), "original\n");
  initializeGitRepository(cwd);
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "test: initialize fixture");
  return cwd;
}

function initializeGitRepository(cwd: string) {
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.email", "clawsweeper@example.invalid");
  git(cwd, "config", "user.name", "ClawSweeper Test");
}

function replacementCommit(cwd: string, message: string) {
  const tree = git(cwd, "rev-parse", "HEAD^{tree}");
  return git(cwd, "commit-tree", tree, "-m", message);
}

function gitlinkReceiptFixture() {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-gitlink-source-"));
  initializeGitRepository(source);
  fs.writeFileSync(path.join(source, "source.txt"), "gitlink original\n");
  git(source, "add", "source.txt");
  git(source, "commit", "-m", "test: initialize receipt gitlink");

  const cwd = gitPackageFixture();
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", source, "vendor/sub");
  git(cwd, "commit", "-m", "test: add receipt gitlink");
  return { cwd, gitlink: path.join(cwd, "vendor", "sub") };
}

function uninitializedGitlinkReceiptFixture() {
  const { cwd: source } = gitlinkReceiptFixture();
  const cloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-uninitialized-clone-"));
  const cwd = path.join(cloneRoot, "checkout");
  execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", "clone", "--no-recurse-submodules", source, cwd],
    { encoding: "utf8" },
  );
  return { cwd, gitlink: path.join(cwd, "vendor", "sub") };
}

function attachOrigin(cwd: string) {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-origin-"));
  git(origin, "init", "--bare");
  git(cwd, "remote", "add", "origin", origin);
  git(cwd, "push", "-u", "origin", "main:main");
}

function validationOptions(
  packageManager: "npm" | "pnpm",
  overrides: { installTargetDeps?: boolean } = {},
) {
  return {
    allowExpensiveValidation: false,
    installTargetDeps: overrides.installTargetDeps ?? true,
    installTimeoutMs: TIMEOUT_MS,
    setupTimeoutMs: TIMEOUT_MS,
    strictTargetValidation: false,
    targetRepo: "openclaw/example",
    toolchain: {
      packageManager,
      baseValidationCommands: [packageManager === "npm" ? "npm run check" : "pnpm check"],
      changedGate: null,
    },
  };
}

function nodeCommandShim(source: string, name: string) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `clawsweeper-${name}-`));
  const scriptPath = path.join(binDir, `${name}.js`);
  fs.writeFileSync(scriptPath, source);
  return scriptPath;
}

function withCommandOverrides(commands: Record<string, string>, callback: () => void) {
  const previous: Record<string, string | undefined> = {};
  for (const [command, commandPath] of Object.entries(commands)) {
    for (const [key, value] of Object.entries(mockCommandBinEnv(command, commandPath))) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
  }
  try {
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withEnv(name: string, value: string, callback: () => void) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    callback();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
