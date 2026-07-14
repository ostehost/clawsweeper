import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand as run } from "./command-runner.js";
import {
  ensureMergeBaseAvailable,
  gitChangedFiles,
  gitLsFiles,
  isAncestor,
  type GitFetch,
} from "./git-repo-utils.js";
import { parsePullRequestUrl } from "./github-ref.js";
import type { JsonValue, LooseRecord } from "./json-types.js";
import {
  assertNoUnsafeGitMutationConfig,
  trustedGitArgs,
  trustedGitContext,
} from "./trusted-git.js";
import {
  resolveTargetRepoToolchain,
  type TargetChangedGate,
  type TargetRepoToolchain,
} from "./target-toolchain-config.js";
import { compactText } from "./text-utils.js";
import {
  isExpensivePnpmValidation,
  isTestFile,
  looksLikePathArgument,
  packageScriptRequirement,
  parseAllowedValidationCommand,
  stripEnvPrefix,
  uniqueStrings,
  vitestPathFilterIndexes,
} from "./validation-command-utils.js";

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_TARGET_SETUP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TARGET_INSTALL_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_TARGET_VALIDATION_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_TARGET_PNPM = "pnpm@10.33.0";
const MAX_BOUND_HOOK_ENTRIES = 256;
const MAX_BOUND_HOOK_BYTES = 2 * 1024 * 1024;
const MAX_TARGET_IDENTITY_ENTRIES = 100_000;
const MAX_TARGET_IDENTITY_BYTES = 1024 * 1024 * 1024;
const MAX_TARGET_IDENTITY_FILE_BYTES = 256 * 1024 * 1024;
const TARGET_IDENTITY_DEADLINE_MS = 60_000;
const PNPM_PACKAGE_MANAGER_PATTERN =
  /^pnpm@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+sha(1|224|256|384|512)\.([a-f0-9]+))?$/;

export type TargetValidationOptions = {
  additionalValidationCommands?: string[];
  allowExpensiveValidation: boolean;
  installTimeoutMs?: number;
  installTargetDeps: boolean;
  skipOpenClawChangedGate?: boolean;
  strictTargetValidation: boolean;
  targetRepo: string;
  setupTimeoutMs?: number;
  validationTimeoutMs?: number;
  pinnedBaseRef?: string;
  gitFetch?: GitFetch;
  /**
   * Optional override of the per-repo toolchain (package manager, base validation
   * commands, changed gate). If omitted, it is resolved from
   * config/target-repositories.json via `resolveTargetRepoToolchain(targetRepo)`.
   * Tests inject this directly to avoid touching the config file.
   */
  toolchain?: TargetRepoToolchain;
};

export type RepairDeltaValidationPlan = {
  commands: string[];
  options: TargetValidationOptions;
  scope: "changed-surface" | "repair-delta-docs";
  changed_files: string[];
  reason: string;
};

export type ExternalBaseValidationBlocker = {
  paths: string[];
  reason: string;
};

export function classifyExternalBaseValidationFailure({
  targetDir,
  pinnedBaseRef,
  repairBaseRef,
  repairDeltaPaths,
  error,
  baseError,
}: {
  targetDir: string;
  pinnedBaseRef: string;
  repairBaseRef: string | null;
  repairDeltaPaths?: string[];
  error: unknown;
  baseError: unknown;
}): ExternalBaseValidationBlocker | null {
  if (!repairBaseRef || !baseError) return null;
  const trackedAtBase = new Set(
    splitGitLines(run("git", ["ls-tree", "-r", "--name-only", pinnedBaseRef], { cwd: targetDir })),
  );
  const referencedPaths = referencedTrackedPaths(String((error as Error)?.message ?? error), {
    targetDir,
    trackedAtBase,
  });
  if (referencedPaths.length === 0) return null;
  const baseReferencedPaths = referencedTrackedPaths(
    String((baseError as Error)?.message ?? baseError),
    { targetDir, trackedAtBase },
  );
  if (
    baseReferencedPaths.length !== referencedPaths.length ||
    referencedPaths.some((file) => !baseReferencedPaths.includes(file))
  ) {
    return null;
  }
  if (
    normalizedValidationFailure(String((error as Error)?.message ?? error), trackedAtBase) !==
    normalizedValidationFailure(String((baseError as Error)?.message ?? baseError), trackedAtBase)
  ) {
    return null;
  }

  const changedFromBase = new Set(
    splitGitLines(
      run("git", ["diff", "--name-only", `${pinnedBaseRef}..HEAD`], { cwd: targetDir }),
    ),
  );
  const repairDelta = new Set(
    repairDeltaPaths ??
      splitGitLines(
        run("git", ["diff", "--name-only", `${repairBaseRef}..HEAD`], { cwd: targetDir }),
      ),
  );
  if (referencedPaths.some((file) => changedFromBase.has(file) || repairDelta.has(file))) {
    return null;
  }

  return {
    paths: referencedPaths,
    reason: "validation failed only in base-identical files outside the repair delta",
  };
}

export function reproduceValidationFailureAtPinnedBase({
  commands,
  targetDir,
  options,
  baseBranch = DEFAULT_BASE_BRANCH,
}: {
  commands: LooseRecord[];
  targetDir: string;
  options: TargetValidationOptions;
  baseBranch?: string;
}): unknown | null {
  if (!options.pinnedBaseRef) return null;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.pinnedBaseRef)) return null;
  let changedFromPinnedBase: string[];
  try {
    changedFromPinnedBase = gitChangedFilesFromRef(targetDir, options.pinnedBaseRef);
  } catch {
    return null;
  }
  if (changedFromPinnedBase.some(isDependencyOrToolchainInputPath)) return null;
  if (fs.existsSync(path.join(targetDir, "node_modules")) && !options.installTargetDeps)
    return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-base-validation-"));
  const checkout = path.join(root, "target");
  const templates = path.join(root, "templates");
  fs.mkdirSync(templates);
  try {
    const cloneContext = trustedGitContext(root);
    run(
      "git",
      trustedGitArgs(cloneContext, [
        "clone",
        `--template=${templates}`,
        "--shared",
        "--no-checkout",
        targetDir,
        checkout,
      ]),
      { cwd: root, env: cloneContext.env },
    );
    assertNoUnsafeGitMutationConfig({ targetDir: checkout, trustedRoot: root });
    const checkoutContext = trustedGitContext(root);
    run("git", trustedGitArgs(checkoutContext, ["checkout", "--detach", options.pinnedBaseRef]), {
      cwd: checkout,
      env: checkoutContext.env,
    });
    try {
      prepareTargetToolchain(checkout, options);
    } catch {
      return null;
    }
    try {
      runAllowedValidationCommands(
        commands,
        checkout,
        { ...options, installTargetDeps: false },
        baseBranch,
      );
      return null;
    } catch (error) {
      return error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isDependencyOrToolchainInputPath(filePath: string) {
  const name = path.posix.basename(filePath);
  return (
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|deno\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|Gemfile(?:\.lock)?|composer\.(?:json|lock)|requirements(?:-[^.]+)?\.txt)$/i.test(
      name,
    ) || /^(?:\.nvmrc|\.node-version|\.tool-versions|mise\.toml)$/i.test(name)
  );
}

export function prepareTargetToolchain(cwd: string, options: TargetValidationOptions) {
  if (!options.installTargetDeps) return;
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return;
  const sourceIdentity = targetSourceIdentity(cwd);

  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const toolchain = getToolchain(options);
  const validationEnv = targetValidationEnv();
  const setupTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_SETUP_TIMEOUT_MS",
    options.setupTimeoutMs ?? DEFAULT_TARGET_SETUP_TIMEOUT_MS,
    options.setupTimeoutMs,
  );
  const installTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_INSTALL_TIMEOUT_MS",
    options.installTimeoutMs ?? DEFAULT_TARGET_INSTALL_TIMEOUT_MS,
    options.installTimeoutMs,
  );
  try {
    run(
      "node",
      [
        "-e",
        "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error(`Node ${process.version} is too old for target validation`); process.exit(1); }",
      ],
      { cwd, env: validationEnv, timeoutMs: setupTimeoutMs },
    );

    if (toolchain.packageManager === "bun") {
      prepareBunToolchain({ cwd, validationEnv, setupTimeoutMs, installTimeoutMs });
      return;
    }
    if (toolchain.packageManager === "npm") {
      prepareNpmToolchain({ cwd, validationEnv, installTimeoutMs });
      return;
    }
    preparePnpmToolchain({
      cwd,
      packageJson,
      validationEnv,
      setupTimeoutMs,
      installTimeoutMs,
    });
  } finally {
    // Failed installers are still untrusted target code. Re-check in finally so
    // they cannot hide a source/control-plane mutation behind their own error.
    assertTargetSourceIdentity(cwd, sourceIdentity);
  }
}

function preparePnpmToolchain({
  cwd,
  packageJson,
  validationEnv,
  setupTimeoutMs,
  installTimeoutMs,
}: {
  cwd: string;
  packageJson: LooseRecord;
  validationEnv: NodeJS.ProcessEnv;
  setupTimeoutMs: number;
  installTimeoutMs: number;
}) {
  const packageManager = trustedTargetPnpmDescriptor(
    String(packageJson.packageManager ?? DEFAULT_TARGET_PNPM),
  );
  const lockfileSnapshot = snapshotTargetLockfile(cwd, "pnpm-lock.yaml");
  try {
    run("corepack", ["enable"], { cwd, env: validationEnv, timeoutMs: setupTimeoutMs });
    run("corepack", ["prepare", packageManager, "--activate"], {
      cwd,
      env: validationEnv,
      timeoutMs: setupTimeoutMs,
    });
    const installArgs = [
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--config.engine-strict=false",
      "--config.enable-pre-post-scripts=false",
    ];
    try {
      run("pnpm", installArgs, { cwd, env: validationEnv, timeoutMs: installTimeoutMs });
    } catch (error) {
      if (!/ERR_PNPM_OUTDATED_LOCKFILE/i.test(String(error.message))) throw error;
      run(
        "pnpm",
        installArgs.map((arg) => (arg === "--frozen-lockfile" ? "--no-frozen-lockfile" : arg)),
        {
          cwd,
          env: validationEnv,
          timeoutMs: installTimeoutMs,
        },
      );
    }
  } finally {
    restoreTargetLockfile(lockfileSnapshot);
  }
}

function trustedTargetPnpmDescriptor(packageManager: string) {
  const match = packageManager.match(PNPM_PACKAGE_MANAGER_PATTERN);
  if (!match) throw new Error(`unsupported target package manager: ${packageManager}`);
  const [, , , , algorithm, digest] = match;
  if (algorithm && digest) {
    const expectedLength =
      algorithm === "1"
        ? 40
        : algorithm === "224"
          ? 56
          : algorithm === "256"
            ? 64
            : algorithm === "384"
              ? 96
              : 128;
    if (digest.length !== expectedLength) {
      throw new Error(`unsupported target package manager: ${packageManager}`);
    }
  }
  return packageManager;
}

function prepareBunToolchain({
  cwd,
  validationEnv,
  setupTimeoutMs,
  installTimeoutMs,
}: {
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  setupTimeoutMs: number;
  installTimeoutMs: number;
}) {
  // The repair execution workflow provisions pinned Bun before this path runs.
  // Keep a clear fail-fast probe so local/manual runners surface setup gaps early.
  //
  // ClawSweeper itself runs under pnpm, so strip caller identity/lifecycle
  // metadata before invoking Bun while preserving target registry, auth, proxy,
  // userconfig, and cache settings. Target lifecycle scripts remain disabled:
  // validation must never execute repository-controlled install hooks.
  const lockfileSnapshots = [
    snapshotTargetLockfile(cwd, "bun.lock"),
    snapshotTargetLockfile(cwd, "bun.lockb"),
  ];
  try {
    const bunEnv = sanitizeEnvForBun(validationEnv);
    run("bun", ["--version"], { cwd, env: bunEnv, timeoutMs: setupTimeoutMs });
    const installArgs = ["install", "--frozen-lockfile", "--ignore-scripts"];
    try {
      run("bun", installArgs, { cwd, env: bunEnv, timeoutMs: installTimeoutMs });
    } catch (error) {
      const message = String(error?.message ?? "");
      if (!/lockfile|frozen|out of date|out-of-date/i.test(message)) throw error;
      run("bun", ["install", "--no-frozen-lockfile", "--ignore-scripts"], {
        cwd,
        env: bunEnv,
        timeoutMs: installTimeoutMs,
      });
    }
  } finally {
    for (const snapshot of lockfileSnapshots) restoreTargetLockfile(snapshot);
  }
}

function sanitizeEnvForBun(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (shouldStripBunInstallEnv(key)) continue;
    out[key] = value;
  }
  // Keep Bun's child environment internally consistent even though target
  // lifecycle hooks are disabled.
  out.npm_config_user_agent = `bun/unknown npm/? node/${process.versions.node} ${process.platform} ${process.arch}`;
  return out;
}

function shouldStripBunInstallEnv(key: string): boolean {
  return (
    /^PNPM_/i.test(key) ||
    /^npm_config_user_agent$/i.test(key) ||
    /^npm_execpath$/i.test(key) ||
    /^npm_node_execpath$/i.test(key) ||
    /^npm_lifecycle_/i.test(key) ||
    /^npm_package_/i.test(key)
  );
}

function prepareNpmToolchain({
  cwd,
  validationEnv,
  installTimeoutMs,
}: {
  cwd: string;
  validationEnv: NodeJS.ProcessEnv;
  installTimeoutMs: number;
}) {
  const installArgs = fs.existsSync(path.join(cwd, "package-lock.json"))
    ? ["ci", "--ignore-scripts"]
    : ["install", "--no-package-lock", "--ignore-scripts"];
  run("npm", installArgs, { cwd, env: validationEnv, timeoutMs: installTimeoutMs });
}

type TargetSourceIdentity = {
  gitControlSha256: string;
  gitDirPath: string;
  gitCommonDirPath: string;
  headSha: string;
  headSymbolicRef: string;
  worktreeSha256: string;
};

export type TargetValidationReceipt = Readonly<{
  headSha: string;
  headTreeSha: string;
}>;

const targetValidationReceiptIdentities = new WeakMap<
  TargetValidationReceipt,
  TargetSourceIdentity
>();

type TargetGitPaths = {
  commonDirInput: string;
  commonDirPath: string;
  gitControlPath: string;
  gitDirInput: string;
  gitDirPath: string;
};

const TARGET_GIT_COMMON_STATE_PATHS = [
  "refs", // all loose refs, including refs/replace
  "packed-refs",
  "packed-refs.lock",
  "shallow",
  "shallow.lock",
  "info", // info/grafts plus repository-local excludes and attributes
  "objects/info/alternates",
  "objects/info/http-alternates",
  "logs/refs",
] as const;

const TARGET_GIT_WORKTREE_STATE_PATHS = [
  "HEAD",
  "HEAD.lock",
  "ORIG_HEAD",
  "FETCH_HEAD",
  "AUTO_MERGE",
  "MERGE_HEAD",
  "MERGE_MODE",
  "MERGE_MSG",
  "MERGE_RR",
  "MERGE_AUTOSTASH",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "REBASE_AUTOSTASH",
  "SQUASH_MSG",
  "BISECT_HEAD",
  "BISECT_LOG",
  "BISECT_NAMES",
  "BISECT_START",
  "BISECT_TERMS",
  "BISECT_ANCESTORS_OK",
  "BISECT_EXPECTED_REV",
  "BISECT_RUN",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
  "refs/bisect",
  "refs/rewritten",
  "refs/worktree",
  "logs/HEAD",
  "info/sparse-checkout",
  "info/sparse-checkout.lock",
  "index.lock",
] as const;

const TARGET_GIT_OPERATION_PATHS = [
  "AUTO_MERGE",
  "MERGE_HEAD",
  "MERGE_MODE",
  "MERGE_MSG",
  "MERGE_RR",
  "MERGE_AUTOSTASH",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "REBASE_AUTOSTASH",
  "SQUASH_MSG",
  "BISECT_HEAD",
  "BISECT_LOG",
  "BISECT_NAMES",
  "BISECT_START",
  "BISECT_TERMS",
  "BISECT_ANCESTORS_OK",
  "BISECT_EXPECTED_REV",
  "BISECT_RUN",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
  "refs/bisect",
  "refs/rewritten",
] as const;

const TARGET_GIT_DIRECT_LOCK_PATHS = [
  "HEAD.lock",
  "ORIG_HEAD.lock",
  "FETCH_HEAD.lock",
  "index.lock",
  "config.worktree.lock",
  "info/sparse-checkout.lock",
] as const;

const TARGET_GIT_COMMON_LOCK_PATHS = ["config.lock", "packed-refs.lock", "shallow.lock"] as const;

function runTargetIdentityGit(
  cwd: string,
  args: string[],
  { allowReplaceObjects = false }: { allowReplaceObjects?: boolean } = {},
) {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    ...(allowReplaceObjects ? {} : { GIT_NO_REPLACE_OBJECTS: "1" }),
  };
  return run("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env });
}

function assertNoActiveGitObjectReplacement(cwd: string) {
  const replacements = runTargetIdentityGit(cwd, ["replace", "-l"], {
    allowReplaceObjects: true,
  }).trim();
  if (replacements) throw new Error("target validation receipt rejects active Git replace refs");
  const graftsPath = path.resolve(
    cwd,
    runTargetIdentityGit(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/grafts",
    ]).trim(),
  );
  if (fs.existsSync(graftsPath) && fs.statSync(graftsPath).size > 0) {
    throw new Error("target validation receipt rejects legacy Git grafts");
  }
}

function assertSafeTargetReceiptConfig(cwd: string, gitPaths = targetGitPaths(cwd)) {
  for (const attributesPath of new Set([
    path.join(gitPaths.commonDirPath, "info", "attributes"),
    path.join(gitPaths.gitDirPath, "info", "attributes"),
  ])) {
    if (hasTargetControlPath(attributesPath)) {
      throw new Error("target validation receipt rejects repository-local info/attributes");
    }
  }
  const configSources = [
    runTargetIdentityGit(cwd, [
      "config",
      "--local",
      "--includes",
      "--name-only",
      "--null",
      "--list",
    ]),
  ];
  const worktreeConfig = path.join(gitPaths.gitDirPath, "config.worktree");
  if (hasTargetControlPath(worktreeConfig)) {
    configSources.push(
      runTargetIdentityGit(cwd, [
        "config",
        "--file",
        worktreeConfig,
        "--includes",
        "--name-only",
        "--null",
        "--list",
      ]),
    );
  }
  for (const source of configSources) {
    for (const rawKey of source.split("\0").filter(Boolean)) {
      const key = rawKey.trim().toLowerCase();
      if (
        key === "core.fsmonitor" ||
        key === "core.hookspath" ||
        key === "core.excludesfile" ||
        key === "core.attributesfile" ||
        /^filter\..+\.(?:clean|process|smudge|required)$/.test(key)
      ) {
        throw new Error(`target validation receipt rejects unsafe local Git config: ${key}`);
      }
    }
  }
}

function assertNoActiveTargetGitOperation(cwd: string, gitPaths = targetGitPaths(cwd)) {
  for (const relativePath of TARGET_GIT_OPERATION_PATHS) {
    if (hasTargetControlPath(path.join(gitPaths.gitDirPath, ...relativePath.split("/")))) {
      throw new Error(`target validation receipt rejects active Git operation: ${relativePath}`);
    }
  }
  for (const relativePath of TARGET_GIT_DIRECT_LOCK_PATHS) {
    if (hasTargetControlPath(path.join(gitPaths.gitDirPath, ...relativePath.split("/")))) {
      throw new Error(`target validation receipt rejects active Git lock: ${relativePath}`);
    }
  }
  for (const relativePath of TARGET_GIT_COMMON_LOCK_PATHS) {
    if (hasTargetControlPath(path.join(gitPaths.commonDirPath, ...relativePath.split("/")))) {
      throw new Error(`target validation receipt rejects active Git lock: ${relativePath}`);
    }
  }
  for (const controlRoot of [
    path.join(gitPaths.commonDirPath, "refs"),
    path.join(gitPaths.commonDirPath, "logs"),
    path.join(gitPaths.gitDirPath, "refs"),
    path.join(gitPaths.gitDirPath, "logs"),
  ]) {
    const lockPath = findTargetGitLockPath(controlRoot);
    if (lockPath) {
      throw new Error(
        `target validation receipt rejects active Git lock: ${path.relative(gitPaths.commonDirPath, lockPath) || path.basename(lockPath)}`,
      );
    }
  }
}

function hasTargetControlPath(controlPath: string) {
  try {
    fs.lstatSync(controlPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function findTargetGitLockPath(controlRoot: string): string | null {
  if (!hasTargetControlPath(controlRoot)) return null;
  const pending = [controlRoot];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > 10_000) {
      throw new Error(
        `target validation receipt Git lock scan exceeded its budget: ${controlRoot}`,
      );
    }
    const stat = fs.lstatSync(current);
    if (path.basename(current).endsWith(".lock")) return current;
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    for (const child of fs.readdirSync(current)) pending.push(path.join(current, child));
  }
  return null;
}

type TargetIndexEntry = {
  mode: string;
  object: string;
  path: string;
};

function targetIndexEntries(cwd: string): TargetIndexEntry[] {
  return runTargetIdentityGit(cwd, ["ls-files", "--stage", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/);
      if (!match || match[3] !== "0") {
        throw new Error("target validation receipt requires an unambiguous tracked index");
      }
      return { mode: match[1]!, object: match[2]!, path: match[4]! };
    });
}

function assertTargetIndexMatchesHead(
  cwd: string,
  headTree: string,
  indexEntries: TargetIndexEntry[],
) {
  const headEntries = runTargetIdentityGit(cwd, ["ls-tree", "-r", "--full-tree", "-z", headTree])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/);
      if (!match) {
        throw new Error("target validation receipt could not parse the committed HEAD tree");
      }
      return { mode: match[1]!, object: match[2]!, path: match[3]! };
    });
  if (
    headEntries.length !== indexEntries.length ||
    headEntries.some((entry, index) => {
      const indexed = indexEntries[index];
      return (
        indexed?.mode !== entry.mode ||
        indexed.object !== entry.object ||
        indexed.path !== entry.path
      );
    })
  ) {
    throw new Error("target validation receipt index tree differs from the committed HEAD tree");
  }
}

type TargetRawIndexEntry = {
  bytes: Buffer;
  entry: TargetIndexEntry;
  rawMatches: boolean;
};

function assertRawTargetCheckoutClean(cwd: string, activeRoots = new Set<string>()) {
  const root = fs.realpathSync(cwd);
  if (activeRoots.has(root)) throw new Error(`target gitlink cycle detected at ${root}`);
  activeRoots.add(root);
  try {
    const gitPaths = targetGitPaths(root);
    assertSafeTargetReceiptConfig(root, gitPaths);
    assertNoActiveGitObjectReplacement(root);
    assertNoActiveTargetGitOperation(root, gitPaths);
    assertNoHiddenTrackedIndexFlags(root);

    const headTree = runTargetIdentityGit(root, ["rev-parse", "HEAD^{tree}"]).trim();
    const entries = targetIndexEntries(root);
    assertTargetIndexMatchesHead(root, headTree, entries);

    const objectFormat = runTargetIdentityGit(root, [
      "rev-parse",
      "--show-object-format=storage",
    ]).trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      throw new Error(
        `target validation receipt rejects unsupported Git object format: ${objectFormat}`,
      );
    }
    const attributes: TargetRawIndexEntry[] = [];
    const regularEntries: TargetRawIndexEntry[] = [];
    const transformedEntries: TargetRawIndexEntry[] = [];
    for (const entry of entries) {
      const inspected = inspectRawTargetIndexEntry(root, entry, objectFormat, activeRoots);
      if (!inspected) continue;
      if (isTargetAttributesPath(entry.path)) {
        if (entry.mode !== "100644" && entry.mode !== "100755") {
          throw new Error(
            `target validation receipt requires a regular tracked .gitattributes: ${entry.path}`,
          );
        }
        if (!inspected.rawMatches) {
          throw new Error(
            `target validation receipt raw .gitattributes bytes differ from HEAD: ${entry.path}`,
          );
        }
        attributes.push(inspected);
      }
      if (entry.mode === "100644" || entry.mode === "100755") {
        regularEntries.push(inspected);
        if (!inspected.rawMatches) transformedEntries.push(inspected);
      } else if (!inspected.rawMatches) {
        throw new Error(
          `target validation receipt raw tracked bytes differ from HEAD: ${entry.path}`,
        );
      }
    }
    assertExpectedTargetCheckoutBytes({
      attributes,
      gitPaths,
      headTree,
      objectFormat,
      regularEntries,
      transformedEntries,
    });

    assertNoUntrackedTargetSource(root);
  } finally {
    activeRoots.delete(root);
  }
}

function assertNoUntrackedTargetSource(cwd: string): void {
  const untracked = runTargetIdentityGit(cwd, [
    "ls-files",
    "--others",
    "--exclude-per-directory=.gitignore",
    "--exclude=!.gitignore",
    "--exclude=!**/.gitignore",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);
  if (untracked.length > 0) {
    throw new Error(
      `target validation receipt requires no untracked source files: ${untracked[0]}`,
    );
  }
}

function inspectRawTargetIndexEntry(
  root: string,
  entry: TargetIndexEntry,
  objectFormat: "sha1" | "sha256",
  activeRoots: Set<string>,
): TargetRawIndexEntry | null {
  const absolutePath = path.resolve(root, ...entry.path.split("/"));
  if (!isTargetPathWithin(root, absolutePath)) {
    throw new Error(`tracked target input escapes checkout: ${entry.path}`);
  }
  if (entry.mode === "160000") {
    assertRawTargetGitlinkClean(root, absolutePath, entry, activeRoots);
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`target validation receipt tracked path is absent: ${entry.path}`);
    }
    throw error;
  }

  let bytes: Buffer;
  if (entry.mode === "120000") {
    if (!stat.isSymbolicLink()) {
      throw new Error(`target validation receipt tracked symlink has wrong type: ${entry.path}`);
    }
    bytes = fs.readlinkSync(absolutePath, { encoding: "buffer" });
  } else if (entry.mode === "100644" || entry.mode === "100755") {
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`target validation receipt tracked file has wrong type: ${entry.path}`);
    }
    const realPath = fs.realpathSync(absolutePath);
    if (!isTargetPathWithin(root, realPath)) {
      throw new Error(`tracked target input escapes checkout: ${entry.path}`);
    }
    if (process.platform !== "win32") {
      const executable = (stat.mode & 0o111) !== 0;
      if (executable !== (entry.mode === "100755")) {
        throw new Error(`target validation receipt tracked file mode differs: ${entry.path}`);
      }
    }
    bytes = fs.readFileSync(absolutePath);
  } else {
    throw new Error(`target validation receipt rejects tracked mode ${entry.mode}: ${entry.path}`);
  }

  return {
    bytes,
    entry,
    rawMatches: gitBlobObjectId(bytes, objectFormat) === entry.object,
  };
}

function isTargetAttributesPath(relativePath: string) {
  return path.posix.basename(relativePath) === ".gitattributes";
}

function assertExpectedTargetCheckoutBytes({
  attributes,
  gitPaths,
  headTree,
  objectFormat,
  regularEntries,
  transformedEntries,
}: {
  attributes: TargetRawIndexEntry[];
  gitPaths: TargetGitPaths;
  headTree: string;
  objectFormat: "sha1" | "sha256";
  regularEntries: TargetRawIndexEntry[];
  transformedEntries: TargetRawIndexEntry[];
}) {
  if (regularEntries.length === 0) return;
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-target-checkout-proof-"),
  );
  const worktree = path.join(temporaryRoot, "worktree");
  const gitDir = path.join(temporaryRoot, "git");
  const templates = path.join(temporaryRoot, "templates");
  const home = path.join(temporaryRoot, "home");
  const index = path.join(temporaryRoot, "index");
  for (const directory of [worktree, templates, home]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const baseEnv = isolatedTargetGitEnvironment(temporaryRoot, home);
  try {
    run(
      "git",
      [
        "init",
        "--quiet",
        `--object-format=${objectFormat}`,
        `--template=${templates}`,
        `--separate-git-dir=${gitDir}`,
        worktree,
      ],
      { cwd: temporaryRoot, env: baseEnv },
    );
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: fs.realpathSync(
        path.join(gitPaths.commonDirPath, "objects"),
      ),
      GIT_DIR: gitDir,
      GIT_INDEX_FILE: index,
      GIT_WORK_TREE: worktree,
    };
    run("git", ["read-tree", headTree], { cwd: worktree, env });
    for (const attribute of attributes) {
      const destination = path.resolve(worktree, ...attribute.entry.path.split("/"));
      if (!isTargetPathWithin(worktree, destination)) {
        throw new Error(`tracked target input escapes checkout: ${attribute.entry.path}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, attribute.bytes);
    }

    assertNoTargetCheckoutFilters(worktree, env, regularEntries);
    if (transformedEntries.length === 0) return;
    run("git", ["checkout-index", "--force", "-z", "--stdin"], {
      cwd: worktree,
      env,
      input: `${transformedEntries.map(({ entry }) => entry.path).join("\0")}\0`,
    });
    for (const transformed of transformedEntries) {
      const expectedPath = path.resolve(worktree, ...transformed.entry.path.split("/"));
      if (!isTargetPathWithin(worktree, expectedPath)) {
        throw new Error(`tracked target input escapes checkout: ${transformed.entry.path}`);
      }
      let expected: Buffer;
      try {
        const stat = fs.lstatSync(expectedPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("wrong type");
        expected = fs.readFileSync(expectedPath);
      } catch {
        throw new Error(
          `target validation receipt could not reconstruct tracked bytes: ${transformed.entry.path}`,
        );
      }
      if (!expected.equals(transformed.bytes)) {
        throw new Error(
          `target validation receipt raw tracked bytes differ from HEAD: ${transformed.entry.path}`,
        );
      }
    }
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function isolatedTargetGitEnvironment(temporaryRoot: string, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    HOME: home,
    LC_ALL: "C",
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
}

function assertNoTargetCheckoutFilters(
  worktree: string,
  env: NodeJS.ProcessEnv,
  regularEntries: TargetRawIndexEntry[],
) {
  const paths = regularEntries.map(({ entry }) => entry.path);
  const fields = run("git", ["check-attr", "-z", "--stdin", "filter"], {
    cwd: worktree,
    env,
    input: `${paths.join("\0")}\0`,
  }).split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length !== paths.length * 3) {
    throw new Error("target validation receipt could not prove checkout attributes");
  }
  for (let index = 0; index < paths.length; index += 1) {
    const [reportedPath, attribute, value] = fields.slice(index * 3, index * 3 + 3);
    if (reportedPath !== paths[index] || attribute !== "filter" || !value) {
      throw new Error("target validation receipt could not prove checkout attributes");
    }
    if (value !== "unspecified" && value !== "unset") {
      throw new Error(`target validation receipt rejects filtered worktree path: ${reportedPath}`);
    }
  }
}

function assertRawTargetGitlinkClean(
  root: string,
  gitlinkPath: string,
  entry: TargetIndexEntry,
  activeRoots: Set<string>,
) {
  const state = targetGitlinkFilesystemState(root, gitlinkPath, entry.path);
  // A non-recursive clone legitimately leaves a clean gitlink absent.
  if (state.kind === "absent") return;
  const gitlinkRoot = state.root;
  let topLevel: string;
  try {
    topLevel = fs.realpathSync(
      runTargetIdentityGit(gitlinkRoot, ["rev-parse", "--show-toplevel"]).trim(),
    );
  } catch {
    topLevel = "";
  }
  if (topLevel !== gitlinkRoot) {
    const children = fs.readdirSync(gitlinkRoot);
    if (children.length > 0) {
      throw new Error(
        `target validation receipt uninitialized gitlink is not empty: ${entry.path}`,
      );
    }
    return;
  }
  const gitlinkHead = runTargetIdentityGit(gitlinkRoot, ["rev-parse", "HEAD"]).trim();
  if (gitlinkHead !== entry.object) {
    throw new Error(
      `target validation receipt gitlink HEAD differs from indexed commit: ${entry.path}`,
    );
  }
  assertRawTargetCheckoutClean(gitlinkRoot, activeRoots);
}

function targetGitlinkFilesystemState(
  root: string,
  gitlinkPath: string,
  relativePath: string,
): { kind: "absent" } | { kind: "directory"; root: string } {
  const parent = path.dirname(gitlinkPath);
  const parentRelative = path.relative(root, parent);
  if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`)) {
    throw new Error(`tracked target gitlink escapes checkout: ${relativePath}`);
  }
  let current = root;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`target validation receipt gitlink parent has wrong type: ${relativePath}`);
    }
    const realParent = fs.realpathSync(current);
    if (!isTargetPathWithin(root, realParent)) {
      throw new Error(`tracked target gitlink escapes checkout: ${relativePath}`);
    }
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(gitlinkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `target validation receipt uninitialized gitlink has wrong type: ${relativePath}`,
    );
  }
  const gitlinkRoot = fs.realpathSync(gitlinkPath);
  if (!isTargetPathWithin(root, gitlinkRoot)) {
    throw new Error(`tracked target gitlink escapes checkout: ${relativePath}`);
  }
  return { kind: "directory", root: gitlinkRoot };
}

function gitBlobObjectId(bytes: Buffer, objectFormat: "sha1" | "sha256") {
  const digest = createHash(objectFormat);
  digest.update(`blob ${bytes.length}\0`);
  digest.update(bytes);
  return digest.digest("hex");
}

function targetSourceIdentity(cwd: string): TargetSourceIdentity {
  const root = fs.realpathSync(cwd);
  let topLevel: string;
  try {
    topLevel = fs.realpathSync(runTargetIdentityGit(cwd, ["rev-parse", "--show-toplevel"]).trim());
  } catch {
    throw new Error("target validation requires a Git checkout root");
  }
  if (topLevel !== root) throw new Error("target validation requires a Git checkout root");
  const gitPaths = targetGitPaths(root);
  return {
    gitControlSha256: targetGitControlSha256(cwd, gitPaths),
    gitDirPath: gitPaths.gitDirPath,
    gitCommonDirPath: gitPaths.commonDirPath,
    headSha: runTargetIdentityGit(cwd, ["rev-parse", "HEAD"]).trim(),
    headSymbolicRef: runTargetIdentityGit(cwd, [
      "rev-parse",
      "--symbolic-full-name",
      "HEAD",
    ]).trim(),
    worktreeSha256: targetWorktreeSha256(cwd),
  };
}

function assertTargetSourceIdentity(cwd: string, expected: TargetSourceIdentity) {
  const actual = targetSourceIdentity(cwd);
  if (
    actual.gitControlSha256 !== expected.gitControlSha256 ||
    actual.gitDirPath !== expected.gitDirPath ||
    actual.gitCommonDirPath !== expected.gitCommonDirPath ||
    actual.headSha !== expected.headSha ||
    actual.headSymbolicRef !== expected.headSymbolicRef ||
    actual.worktreeSha256 !== expected.worktreeSha256
  ) {
    throw new Error("target dependency setup mutated tracked source identity");
  }
}

export function captureTargetValidationReceipt(cwd: string): TargetValidationReceipt {
  const gitPaths = targetGitPaths(cwd);
  assertSafeTargetReceiptConfig(cwd, gitPaths);
  assertNoActiveGitObjectReplacement(cwd);
  assertNoActiveTargetGitOperation(cwd, gitPaths);
  // Reject by path before hashing worktree contents. The full raw-clean proof
  // below remains authoritative and closes the race after identity capture.
  assertNoUntrackedTargetSource(cwd);
  const sourceIdentity = targetSourceIdentity(cwd);
  assertRawTargetCheckoutClean(cwd);
  const headTreeSha = runTargetIdentityGit(cwd, [
    "rev-parse",
    `${sourceIdentity.headSha}^{tree}`,
  ]).trim();
  // Re-read the complete identity after the raw proof so a concurrent change
  // cannot become a clean receipt baseline between individual checks.
  assertTargetSourceIdentity(cwd, sourceIdentity);
  assertSafeTargetReceiptConfig(cwd, gitPaths);
  assertNoActiveGitObjectReplacement(cwd);
  assertNoActiveTargetGitOperation(cwd, gitPaths);
  const receipt = Object.freeze({ headSha: sourceIdentity.headSha, headTreeSha });
  targetValidationReceiptIdentities.set(receipt, sourceIdentity);
  return receipt;
}

export function assertTargetValidationReceipt(cwd: string, receipt: TargetValidationReceipt): void {
  const sourceIdentity = targetValidationReceiptIdentities.get(receipt);
  if (!sourceIdentity) throw new Error("target validation receipt is invalid or expired");
  const gitPaths = targetGitPaths(cwd);
  assertSafeTargetReceiptConfig(cwd, gitPaths);
  assertNoActiveGitObjectReplacement(cwd);
  assertNoActiveTargetGitOperation(cwd, gitPaths);
  assertRawTargetCheckoutClean(cwd);
  assertTargetSourceIdentity(cwd, sourceIdentity);
  assertSafeTargetReceiptConfig(cwd, gitPaths);
  assertNoActiveGitObjectReplacement(cwd);
  assertNoActiveTargetGitOperation(cwd, gitPaths);
  const headTreeSha = runTargetIdentityGit(cwd, [
    "rev-parse",
    `${sourceIdentity.headSha}^{tree}`,
  ]).trim();
  if (headTreeSha !== receipt.headTreeSha) {
    throw new Error("target validation receipt tree no longer matches the checkout");
  }
}

type TargetIdentityBudget = {
  bytes: number;
  deadline: number;
  entries: number;
};

function targetWorktreeSha256(
  cwd: string,
  activeRoots = new Set<string>(),
  budget: TargetIdentityBudget = {
    bytes: 0,
    deadline: Date.now() + TARGET_IDENTITY_DEADLINE_MS,
    entries: 0,
  },
) {
  const root = fs.realpathSync(cwd);
  if (activeRoots.has(root)) throw new Error(`target gitlink cycle detected at ${root}`);
  activeRoots.add(root);
  assertNoHiddenTrackedIndexFlags(cwd);
  const digest = createHash("sha256");
  updateTargetSourceDigest(
    digest,
    "index-resolve-undo",
    runTargetIdentityGit(cwd, ["ls-files", "--resolve-undo", "-z"]),
  );
  try {
    const entries = runTargetIdentityGit(cwd, ["ls-files", "--stage", "-z"])
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      consumeTargetIdentityEntry(budget);
      const match = entry.match(/^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/);
      if (!match || match[3] !== "0") {
        throw new Error("target dependency setup requires an unambiguous tracked index");
      }
      const [, mode, indexObject, , relativePath] = match;
      const absolutePath = path.resolve(root, ...relativePath!.split("/"));
      if (!isTargetPathWithin(root, absolutePath)) {
        throw new Error(`tracked target input escapes checkout: ${relativePath}`);
      }
      updateTargetSourceDigest(digest, "path", relativePath!);
      updateTargetSourceDigest(digest, "mode", mode!);
      updateTargetSourceDigest(digest, "index", indexObject!);
      if (mode === "160000") {
        updateTargetGitlinkDigest(digest, root, absolutePath, relativePath!, activeRoots, budget);
        continue;
      }
      try {
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
          const link = fs.readlinkSync(absolutePath);
          updateTargetSourceDigest(digest, "symlink", link);
          const targetPath = resolveTargetSymlink(
            root,
            absolutePath,
            relativePath!,
            link,
            "tracked",
          );
          if (targetPath) {
            updateTargetSourceDigest(
              digest,
              "symlink-target",
              path.relative(root, targetPath).split(path.sep).join("/"),
            );
            updateTargetFilesystemDigest(
              digest,
              root,
              targetPath,
              `${relativePath!}\0target`,
              new Set(),
              "tracked",
              budget,
            );
          } else {
            updateTargetSourceDigest(digest, "symlink-target", "<absent>");
          }
        } else if (stat.isFile()) {
          updateTargetSourceDigest(digest, "working-tree-mode", stat.mode.toString(8));
          updateTargetFileDigest(digest, "file", absolutePath, budget);
        } else {
          updateTargetSourceDigest(digest, "working-tree", "<non-file>");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        updateTargetSourceDigest(digest, "working-tree", "<absent>");
      }
    }
    updateUntrackedTargetWorktreeDigest(digest, cwd, root, budget);
    return digest.digest("hex");
  } finally {
    activeRoots.delete(root);
  }
}

function updateTargetGitlinkDigest(
  digest: ReturnType<typeof createHash>,
  root: string,
  gitlinkPath: string,
  relativePath: string,
  activeRoots: Set<string>,
  budget: TargetIdentityBudget,
) {
  const state = targetGitlinkFilesystemState(root, gitlinkPath, relativePath);
  if (state.kind === "absent") {
    updateTargetSourceDigest(digest, "gitlink", "<absent>");
    return;
  }
  const gitlinkRoot = state.root;

  let topLevel: string;
  try {
    topLevel = fs.realpathSync(
      runTargetIdentityGit(root, ["-C", gitlinkRoot, "rev-parse", "--show-toplevel"]).trim(),
    );
  } catch {
    topLevel = "";
  }
  if (topLevel !== gitlinkRoot) {
    updateTargetSourceDigest(digest, "gitlink", "<uninitialized>");
    updateTargetFilesystemDigest(
      digest,
      root,
      gitlinkRoot,
      `${relativePath}\0uninitialized`,
      new Set(),
      "tracked",
      budget,
    );
    return;
  }

  updateTargetSourceDigest(
    digest,
    "gitlink-head",
    runTargetIdentityGit(gitlinkRoot, ["rev-parse", "HEAD"]).trim(),
  );
  const gitPaths = targetGitPaths(gitlinkRoot);
  updateTargetSourceDigest(
    digest,
    "gitlink-control",
    targetGitControlSha256(gitlinkRoot, gitPaths),
  );
  updateTargetSourceDigest(digest, "gitlink-git-dir", gitPaths.gitDirPath);
  updateTargetSourceDigest(digest, "gitlink-common-dir", gitPaths.commonDirPath);
  updateTargetSourceDigest(
    digest,
    "gitlink-head-symbolic-ref",
    runTargetIdentityGit(gitlinkRoot, ["rev-parse", "--symbolic-full-name", "HEAD"]).trim(),
  );
  updateTargetSourceDigest(
    digest,
    "gitlink-worktree",
    targetWorktreeSha256(gitlinkRoot, activeRoots, budget),
  );
}

function updateUntrackedTargetWorktreeDigest(
  digest: ReturnType<typeof createHash>,
  cwd: string,
  root: string,
  budget: TargetIdentityBudget,
) {
  const paths = runTargetIdentityGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  updateTargetSourceDigest(digest, "untracked-count", String(paths.length));
  for (const relativePath of paths) {
    consumeTargetIdentityEntry(budget);
    const absolutePath = path.resolve(root, ...relativePath.split("/"));
    if (!isTargetPathWithin(root, absolutePath)) {
      throw new Error(`untracked target input escapes checkout: ${relativePath}`);
    }
    updateTargetSourceDigest(digest, "untracked-path", relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      updateTargetSourceDigest(digest, "untracked-entry", "<absent>");
      continue;
    }
    updateTargetSourceDigest(digest, "untracked-mode", stat.mode.toString(8));
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(absolutePath);
      updateTargetSourceDigest(digest, "untracked-symlink", link);
      const targetPath = resolveTargetSymlink(root, absolutePath, relativePath, link, "untracked");
      if (!targetPath) {
        updateTargetSourceDigest(digest, "untracked-symlink-target", "<absent>");
        continue;
      }
      updateTargetSourceDigest(
        digest,
        "untracked-symlink-target",
        path.relative(root, targetPath).split(path.sep).join("/"),
      );
      updateTargetFilesystemDigest(
        digest,
        root,
        targetPath,
        `${relativePath}\0target`,
        new Set(),
        "untracked",
        budget,
      );
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`untracked target input has unsupported type: ${relativePath}`);
    }
    updateTargetFileDigest(digest, "untracked-bytes", absolutePath, budget);
  }
}

function resolveTargetSymlink(
  root: string,
  entryPath: string,
  relativePath: string,
  link: string,
  inputKind: "tracked" | "untracked",
) {
  const lexicalTarget = path.resolve(path.dirname(entryPath), link);
  if (!isTargetPathWithin(root, lexicalTarget)) {
    throw new Error(`${inputKind} target symlink escapes checkout: ${relativePath}`);
  }
  try {
    const targetPath = fs.realpathSync(entryPath);
    if (!isTargetPathWithin(root, targetPath)) {
      throw new Error(`${inputKind} target symlink escapes checkout: ${relativePath}`);
    }
    return targetPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function updateTargetFilesystemDigest(
  digest: ReturnType<typeof createHash>,
  root: string,
  entryPath: string,
  logicalPath: string,
  activeDirectories: Set<string>,
  inputKind: "tracked" | "untracked" = "tracked",
  budget?: TargetIdentityBudget,
) {
  if (budget) consumeTargetIdentityEntry(budget);
  const stat = fs.lstatSync(entryPath);
  updateTargetSourceDigest(digest, "entry", logicalPath);
  updateTargetSourceDigest(digest, "entry-mode", stat.mode.toString(8));
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(entryPath);
    updateTargetSourceDigest(digest, "entry-link", link);
    const targetPath = resolveTargetSymlink(root, entryPath, logicalPath, link, inputKind);
    if (!targetPath) {
      updateTargetSourceDigest(digest, "entry-link-target", "<absent>");
      return;
    }
    updateTargetFilesystemDigest(
      digest,
      root,
      targetPath,
      `${logicalPath}\0target`,
      activeDirectories,
      inputKind,
      budget,
    );
    return;
  }
  if (stat.isFile()) {
    updateTargetFileDigest(digest, "entry-bytes", entryPath, budget);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`${inputKind} target input has unsupported type: ${logicalPath}`);
  }
  const realDirectory = fs.realpathSync(entryPath);
  if (activeDirectories.has(realDirectory)) {
    throw new Error(`${inputKind} target symlink cycle detected at ${logicalPath}`);
  }
  activeDirectories.add(realDirectory);
  try {
    const children = boundedTargetIdentityChildren(entryPath, budget);
    updateTargetSourceDigest(digest, "entry-children", children.join("\0"));
    for (const child of children) {
      updateTargetFilesystemDigest(
        digest,
        root,
        path.join(entryPath, child),
        `${logicalPath}/${child}`,
        activeDirectories,
        inputKind,
        budget,
      );
    }
  } finally {
    activeDirectories.delete(realDirectory);
  }
}

function boundedTargetIdentityChildren(entryPath: string, budget?: TargetIdentityBudget): string[] {
  if (!budget) return fs.readdirSync(entryPath).sort();
  const directory = fs.opendirSync(entryPath);
  const children: string[] = [];
  try {
    while (true) {
      assertTargetIdentityDeadline(budget);
      const entry = directory.readSync();
      if (!entry) break;
      if (budget.entries + children.length + 1 > MAX_TARGET_IDENTITY_ENTRIES) {
        throw new Error("target worktree identity exceeds the entry budget");
      }
      children.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return children.sort();
}

function updateTargetFileDigest(
  digest: ReturnType<typeof createHash>,
  label: string,
  filePath: string,
  budget?: TargetIdentityBudget,
) {
  if (!budget) {
    const bytes = fs.readFileSync(filePath);
    digest.update(`${label}:${bytes.length}:`);
    digest.update(bytes);
    digest.update("\0");
    return;
  }
  assertTargetIdentityDeadline(budget);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile())
      throw new Error(`target identity path is not a regular file: ${filePath}`);
    if (metadata.size > MAX_TARGET_IDENTITY_FILE_BYTES) {
      throw new Error("target worktree identity exceeds the per-file byte budget");
    }
    budget.bytes += metadata.size;
    if (budget.bytes > MAX_TARGET_IDENTITY_BYTES) {
      throw new Error("target worktree identity exceeds the aggregate byte budget");
    }
    digest.update(`${label}:${metadata.size}:`);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, metadata.size)));
    let position = 0;
    while (position < metadata.size) {
      assertTargetIdentityDeadline(budget);
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, metadata.size - position),
        position,
      );
      if (bytesRead <= 0) throw new Error(`short read while hashing target identity: ${filePath}`);
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    digest.update("\0");
  } finally {
    fs.closeSync(descriptor);
  }
}

function consumeTargetIdentityEntry(budget: TargetIdentityBudget) {
  assertTargetIdentityDeadline(budget);
  budget.entries += 1;
  if (budget.entries > MAX_TARGET_IDENTITY_ENTRIES) {
    throw new Error("target worktree identity exceeds the entry budget");
  }
}

function assertTargetIdentityDeadline(budget: TargetIdentityBudget) {
  if (Date.now() > budget.deadline) {
    throw new Error("target worktree identity exceeded its time budget");
  }
}

function assertNoHiddenTrackedIndexFlags(cwd: string) {
  const entries = runTargetIdentityGit(cwd, ["ls-files", "-v", "-z"]).split("\0").filter(Boolean);
  for (const entry of entries) {
    const tag = entry[0] ?? "";
    if (tag === "S" || (/[A-Za-z]/.test(tag) && tag === tag.toLowerCase())) {
      throw new Error(
        `target dependency setup rejects hidden tracked index flags: ${entry.slice(2) || "unknown"}`,
      );
    }
  }
}

function targetGitPaths(cwd: string): TargetGitPaths {
  const root = fs.realpathSync(cwd);
  const gitDirInput = runTargetIdentityGit(cwd, ["rev-parse", "--git-dir"]).trim();
  const commonDirInput = runTargetIdentityGit(cwd, ["rev-parse", "--git-common-dir"]).trim();
  return {
    commonDirInput,
    commonDirPath: fs.realpathSync(resolveTargetGitPath(cwd, commonDirInput)),
    gitControlPath: path.join(root, ".git"),
    gitDirInput,
    gitDirPath: fs.realpathSync(resolveTargetGitPath(cwd, gitDirInput)),
  };
}

function targetGitControlSha256(cwd: string, gitPaths = targetGitPaths(cwd)) {
  const digest = createHash("sha256");
  updateTargetSourceDigest(digest, "git-dir-input", gitPaths.gitDirInput);
  updateTargetSourceDigest(digest, "git-dir-path", gitPaths.gitDirPath);
  updateTargetSourceDigest(digest, "git-common-dir-input", gitPaths.commonDirInput);
  updateTargetSourceDigest(digest, "git-common-dir-path", gitPaths.commonDirPath);
  updateTargetGitIndirectionDigest(digest, gitPaths.gitControlPath);
  updateTargetSourceDigest(
    digest,
    "git-effective-config",
    runTargetIdentityGit(cwd, [
      "config",
      "--includes",
      "--list",
      "--show-origin",
      "--show-scope",
      "-z",
    ]),
  );
  updateTargetSourceDigest(
    digest,
    "git-effective-refs",
    runTargetIdentityGit(cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(symref)%00",
    ]),
  );

  const hooksPath = path.resolve(
    cwd,
    runTargetIdentityGit(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks",
    ]).trim(),
  );
  updateTargetSourceDigest(digest, "git-hooks-path", hooksPath);
  updateTargetHooksDigest(digest, hooksPath, gitPaths);
  for (const controlPath of [
    path.join(gitPaths.commonDirPath, "config"),
    path.join(gitPaths.gitDirPath, "config.worktree"),
    path.join(gitPaths.gitDirPath, "commondir"),
    path.join(gitPaths.gitDirPath, "gitdir"),
  ]) {
    updateOptionalTargetControlDigest(digest, controlPath, path.basename(controlPath), new Set());
  }
  updateTargetGitStateDigest(digest, gitPaths);
  return digest.digest("hex");
}

function updateTargetHooksDigest(
  digest: ReturnType<typeof createHash>,
  hooksPath: string,
  gitPaths: TargetGitPaths,
) {
  let resolvedHooksPath = hooksPath;
  try {
    resolvedHooksPath = fs.realpathSync(hooksPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    !isTargetPathWithin(gitPaths.commonDirPath, hooksPath) ||
    !isTargetPathWithin(gitPaths.commonDirPath, resolvedHooksPath)
  ) {
    // Global/system hook directories are outside the target repository's
    // authority. Bind the effective path through the config digest above, but
    // never recursively read an arbitrary external tree. Publication Git
    // mutations separately force an empty trusted hooks directory.
    updateTargetSourceDigest(digest, "git-hooks-scope", "external");
    return;
  }
  updateTargetSourceDigest(digest, "git-hooks-scope", "repository");
  const budget = { bytes: 0, entries: 0 };
  updateBoundedTargetHooksDigest(digest, hooksPath, "hooks", budget);
}

function updateBoundedTargetHooksDigest(
  digest: ReturnType<typeof createHash>,
  entryPath: string,
  logicalPath: string,
  budget: { bytes: number; entries: number },
) {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    updateTargetSourceDigest(digest, logicalPath, "<absent>");
    return;
  }
  budget.entries += 1;
  if (budget.entries > MAX_BOUND_HOOK_ENTRIES) {
    throw new Error("target Git hooks directory exceeds the identity entry budget");
  }
  updateTargetSourceDigest(digest, "git-hook-entry", logicalPath);
  updateTargetSourceDigest(digest, "git-hook-mode", stat.mode.toString(8));
  if (stat.isSymbolicLink()) {
    // Bind only the link itself. Never follow a hook symlink out of the Git
    // control directory while constructing an identity.
    updateTargetSourceDigest(digest, "git-hook-link", fs.readlinkSync(entryPath));
    return;
  }
  if (stat.isFile()) {
    budget.bytes += stat.size;
    if (budget.bytes > MAX_BOUND_HOOK_BYTES) {
      throw new Error("target Git hooks directory exceeds the identity byte budget");
    }
    updateTargetFileDigest(digest, "git-hook-bytes", entryPath);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`target Git hook has unsupported type: ${logicalPath}`);
  }
  const children = fs.readdirSync(entryPath).sort();
  updateTargetSourceDigest(digest, "git-hook-children", children.join("\0"));
  for (const child of children) {
    updateBoundedTargetHooksDigest(
      digest,
      path.join(entryPath, child),
      `${logicalPath}/${child}`,
      budget,
    );
  }
}

function updateTargetGitStateDigest(
  digest: ReturnType<typeof createHash>,
  gitPaths: TargetGitPaths,
) {
  for (const relativePath of TARGET_GIT_COMMON_STATE_PATHS) {
    const controlPath = path.join(gitPaths.commonDirPath, ...relativePath.split("/"));
    updateTargetSourceDigest(digest, "git-common-state-path", `${relativePath}\0${controlPath}`);
    updateOptionalTargetControlDigest(digest, controlPath, `common/${relativePath}`, new Set());
  }
  for (const gitPath of TARGET_GIT_WORKTREE_STATE_PATHS) {
    const controlPath = path.join(gitPaths.gitDirPath, ...gitPath.split("/"));
    updateTargetSourceDigest(digest, "git-worktree-state-path", `${gitPath}\0${controlPath}`);
    updateOptionalTargetControlDigest(digest, controlPath, `worktree/${gitPath}`, new Set());
  }
}

function updateTargetGitIndirectionDigest(
  digest: ReturnType<typeof createHash>,
  controlPath: string,
) {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(controlPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    updateTargetSourceDigest(digest, "git-control-path", "<absent>");
    return;
  }
  updateTargetSourceDigest(digest, "git-control-path", controlPath);
  updateTargetSourceDigest(digest, "git-control-path-mode", stat.mode.toString(8));
  if (stat.isSymbolicLink()) {
    updateTargetSourceDigest(digest, "git-control-path-link", fs.readlinkSync(controlPath));
    const targetPath = fs.realpathSync(controlPath);
    updateTargetSourceDigest(digest, "git-control-path-target", targetPath);
    const targetStat = fs.lstatSync(targetPath);
    updateTargetSourceDigest(digest, "git-control-target-mode", targetStat.mode.toString(8));
    if (targetStat.isFile()) {
      updateTargetFileDigest(digest, "git-control-target-bytes", targetPath);
    } else if (!targetStat.isDirectory()) {
      throw new Error(`target git control path has unsupported type: ${controlPath}`);
    }
    return;
  }
  if (stat.isFile()) {
    updateTargetFileDigest(digest, "git-control-path-bytes", controlPath);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`target git control path has unsupported type: ${controlPath}`);
  }
  updateTargetSourceDigest(digest, "git-control-path-target", fs.realpathSync(controlPath));
}

function resolveTargetGitPath(cwd: string, gitPath: string) {
  return path.resolve(cwd, gitPath);
}

function updateOptionalTargetControlDigest(
  digest: ReturnType<typeof createHash>,
  entryPath: string,
  logicalPath: string,
  activeDirectories: Set<string>,
) {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    updateTargetSourceDigest(digest, logicalPath, "<absent>");
    return;
  }
  updateTargetSourceDigest(digest, "git-control", logicalPath);
  updateTargetSourceDigest(digest, "git-control-mode", stat.mode.toString(8));
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(entryPath);
    updateTargetSourceDigest(digest, "git-control-link", link);
    const targetPath = fs.realpathSync(entryPath);
    updateTargetSourceDigest(digest, "git-control-link-target", targetPath);
    updateOptionalTargetControlDigest(
      digest,
      targetPath,
      `${logicalPath}\0target`,
      activeDirectories,
    );
    return;
  }
  if (stat.isFile()) {
    updateTargetFileDigest(digest, "git-control-bytes", entryPath);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`target git control path has unsupported type: ${logicalPath}`);
  }
  const realDirectory = fs.realpathSync(entryPath);
  if (activeDirectories.has(realDirectory)) {
    throw new Error(`target git control path cycle detected at ${logicalPath}`);
  }
  activeDirectories.add(realDirectory);
  try {
    const children = fs.readdirSync(entryPath).sort();
    updateTargetSourceDigest(digest, "git-control-children", children.join("\0"));
    for (const child of children) {
      updateOptionalTargetControlDigest(
        digest,
        path.join(entryPath, child),
        `${logicalPath}/${child}`,
        activeDirectories,
      );
    }
  } finally {
    activeDirectories.delete(realDirectory);
  }
}

function isTargetPathWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function updateTargetSourceDigest(
  digest: ReturnType<typeof createHash>,
  label: string,
  value: string,
) {
  digest.update(`${label}:${Buffer.byteLength(value)}:`);
  digest.update(value);
  digest.update("\0");
}

export function runAllowedValidationCommands(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  const baseRef = validationBaseRef(cwd, baseBranch, options);
  return runAllowedValidationCommandsBound(
    commands,
    cwd,
    options,
    baseBranch,
    baseRef,
    targetSourceIdentity(cwd),
  );
}

export function runAllowedValidationCommandsWithReceipt(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string = DEFAULT_BASE_BRANCH,
) {
  const baseRef = validationBaseRef(cwd, baseBranch, options);
  const receipt = captureTargetValidationReceipt(cwd);
  const sourceIdentity = targetValidationReceiptIdentities.get(receipt)!;
  try {
    return {
      commands: runAllowedValidationCommandsBound(
        commands,
        cwd,
        options,
        baseBranch,
        baseRef,
        sourceIdentity,
      ),
      receipt,
    };
  } finally {
    assertTargetValidationReceipt(cwd, receipt);
  }
}

function runAllowedValidationCommandsBound(
  commands: LooseRecord[],
  cwd: string,
  options: TargetValidationOptions,
  baseBranch: string,
  baseRef: string,
  sourceIdentity: TargetSourceIdentity,
) {
  const validationEnv = targetValidationEnv();
  const validationTimeoutMs = targetValidationTimeoutMs(
    "CLAWSWEEPER_TARGET_VALIDATION_TIMEOUT_MS",
    options.validationTimeoutMs ?? DEFAULT_TARGET_VALIDATION_TIMEOUT_MS,
    options.validationTimeoutMs,
  );
  const executed: string[] = [];
  const attempts = new Map<string, number>();
  const requiredCommands = requiredValidationCommands(commands, cwd, options);
  if (requiredCommands.length === 0) {
    throw new Error(
      "validation_command_missing: no configured or artifact validation command is available",
    );
  }
  for (const command of requiredCommands) {
    const resolvedCommands = resolveAllowedValidationCommands(command, cwd, baseBranch, options);
    for (const parts of resolvedCommands) {
      const executable = parts[0]!;
      const rendered = parts.join(" ");
      if (executed.includes(rendered)) continue;
      while (true) {
        try {
          run(executable, parts.slice(1), {
            cwd,
            env: validationEnv,
            timeoutMs: validationTimeoutMs,
          });
          assertTargetSourceIdentity(cwd, sourceIdentity);
          executed.push(rendered);
          break;
        } catch (error) {
          assertTargetSourceIdentity(cwd, sourceIdentity);
          const fallbackCommands = validationFallbackCommands({
            parts,
            error,
            cwd,
            baseBranch,
            baseRef,
            options,
          });
          if (fallbackCommands.length > 0) {
            for (const fallbackParts of fallbackCommands) {
              const fallbackExecutable = fallbackParts[0]!;
              const fallbackRendered = fallbackParts.join(" ");
              if (executed.includes(fallbackRendered)) continue;
              try {
                run(fallbackExecutable, fallbackParts.slice(1), {
                  cwd,
                  env: validationEnv,
                  timeoutMs: validationTimeoutMs,
                });
              } finally {
                assertTargetSourceIdentity(cwd, sourceIdentity);
              }
              executed.push(fallbackRendered);
            }
            break;
          }
          if (shouldRetryValidationCommand({ parts, error, attempts, options })) continue;
          throw new Error(
            `validation command failed (${parts.join(" ")}): ${compactText(error.message, 12000)}`,
          );
        }
      }
    }
  }
  return executed;
}

export function preflightTargetValidationPlan(
  { fixArtifact, targetDir, baseBranch = DEFAULT_BASE_BRANCH }: LooseRecord,
  options: TargetValidationOptions,
) {
  const scripts = readPackageScriptSet(targetDir);
  const availableScripts = [...scripts].sort();
  const resolved: string[] = [];
  const requiredScripts: LooseRecord[] = [];
  for (const command of requiredValidationCommands(
    fixArtifact.validation_commands ?? [],
    targetDir,
    options,
  )) {
    const resolvedCommands = resolveAllowedValidationCommands(
      command,
      targetDir,
      baseBranch,
      options,
    );
    for (const parts of resolvedCommands) {
      const rendered = parts.join(" ");
      if (!resolved.includes(rendered)) resolved.push(rendered);
      const script = packageScriptRequirement(parts);
      if (script) requiredScripts.push(script);
    }
  }

  if (resolved.length === 0) {
    return {
      status: "blocked",
      code: "validation_command_missing",
      available_scripts: availableScripts,
      resolved_commands: [],
      reason:
        "validation_command_missing: no configured or artifact validation command is available",
    };
  }

  const missing = requiredScripts.find((script: JsonValue) => !scripts.has(script.name));
  if (!missing) {
    return {
      status: "passed",
      resolved_commands: resolved,
      available_scripts: availableScripts,
    };
  }

  const sourcePr =
    (fixArtifact.source_prs ?? []).find(
      (source: JsonValue) => parsePullRequestUrl(source)?.repo === options.targetRepo,
    ) ?? null;
  return {
    status: "blocked",
    code: "validation_script_missing",
    required: missing.command,
    missing_script: missing.name,
    available_scripts: availableScripts,
    target_branch: fixArtifact.branch ?? fixArtifact.head_branch ?? null,
    source_pr: sourcePr,
    resolved_commands: resolved,
    reason: `validation_script_missing: required ${missing.command} is unavailable in target checkout`,
  };
}

export function requiredValidationCommands(
  commands: LooseRecord[] | undefined,
  cwd: string,
  options: TargetValidationOptions,
) {
  const toolchain = getToolchain(options);
  const replacementCommands = [
    ...(options.additionalValidationCommands ?? []),
    ...toolchain.baseValidationCommands,
  ];
  const sanitized = sanitizeStaleChangedGateCommands(
    commands ?? [],
    toolchain,
    replacementCommands,
  );
  const out = [...sanitized, ...replacementCommands];
  const gate = toolchain.changedGate;
  if (gate && !options.skipOpenClawChangedGate && requiresChangedGate(cwd, toolchain)) {
    out.push(gate.command);
  }
  return uniqueStrings(out);
}

/**
 * Drop validation commands that look like "some other repo's changed gate"
 * when the current target repo does not have one. This protects against stale
 * fixArtifacts (most notably deterministic automerge artifacts authored before
 * per-repo toolchain config landed) that ship `pnpm check:changed` even when
 * the target is bun-based and has no `check:changed` script. Without this
 * guard preflight terminates with `validation_script_missing` and the
 * executor never tries the project's real validation command.
 *
 * We are deliberately conservative: we only drop commands that match the
 * fingerprint of a known changed-gate command and only when the active
 * toolchain has no gate of its own. If no repository-specific replacement
 * exists, fall back to `git diff --check`; unrelated commands still pass
 * through so genuinely missing scripts remain visible.
 */
function sanitizeStaleChangedGateCommands(
  commands: readonly LooseRecord[],
  toolchain: TargetRepoToolchain,
  replacementCommands: readonly string[],
): LooseRecord[] {
  if (toolchain.changedGate) return [...commands];
  const filtered = commands.filter((command) => !looksLikeStaleChangedGateCommand(command));
  if (
    filtered.length === 0 &&
    commands.some((command) => looksLikeStaleChangedGateCommand(command)) &&
    replacementCommands.length === 0
  ) {
    return ["git diff --check"];
  }
  return filtered;
}

function looksLikeStaleChangedGateCommand(command: LooseRecord): boolean {
  const text = String(command ?? "").trim();
  if (!text) return false;
  // Matches the canonical openclaw/openclaw changed gate verbatim, with or
  // without a leading `env` wrapper. Kept narrow on purpose so we only
  // discard things we are confident are the stale gate.
  return /^(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?pnpm\s+(?:-s\s+|--silent\s+)?(?:run\s+)?check:changed$/.test(
    text,
  );
}

export function repairDeltaValidationPlan(
  { fixArtifact, targetDir, sourceHead }: LooseRecord,
  options: TargetValidationOptions,
): RepairDeltaValidationPlan {
  const commands = fixArtifact.validation_commands ?? [];
  const changedSurface = {
    commands,
    options,
    scope: "changed-surface" as const,
    changed_files: [],
    reason: "validate the full changed surface against the target base branch",
  };
  if (options.targetRepo !== "openclaw/openclaw") return changedSurface;
  if (fixArtifact.repair_strategy !== "repair_contributor_branch") return changedSurface;
  const sourceRef = String(sourceHead ?? "");
  if (!/^[0-9a-f]{40}$/i.test(sourceRef)) return changedSurface;
  if (!isAncestor({ targetDir, ancestor: sourceRef, descendant: "HEAD" })) return changedSurface;

  const changedFiles = changedFilesSinceRef(targetDir, sourceRef);
  if (changedFiles.length === 0 || !changedFiles.every(isDocsOnlyRepairDeltaFile)) {
    return { ...changedSurface, changed_files: changedFiles };
  }

  return {
    commands: [`git diff --check ${sourceRef}..HEAD`],
    options: { ...options, skipOpenClawChangedGate: true },
    scope: "repair-delta-docs",
    changed_files: changedFiles,
    reason:
      "adopted PR repair changed only docs/changelog files since the source head; validate the repair delta and let PR checks gate the existing source diff",
  };
}

export function canSkipInternalCodexReviewForRepairDelta(plan: LooseRecord) {
  return String(plan?.scope ?? "") === "repair-delta-docs";
}

type TargetLockfileSnapshot =
  | { filePath: string; kind: "absent" }
  | { bytes: Buffer; filePath: string; kind: "file"; mode: number }
  | { filePath: string; kind: "symlink"; link: string; mode: number };

function snapshotTargetLockfile(cwd: string, lockfile: string): TargetLockfileSnapshot {
  const filePath = path.join(cwd, lockfile);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { filePath, kind: "absent" };
    }
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    return { filePath, kind: "symlink", link: fs.readlinkSync(filePath), mode };
  }
  if (stat.isFile()) {
    return { bytes: fs.readFileSync(filePath), filePath, kind: "file", mode };
  }
  throw new Error(`target lockfile has unsupported type: ${lockfile}`);
}

function restoreTargetLockfile(snapshot: TargetLockfileSnapshot) {
  fs.rmSync(snapshot.filePath, { force: true, recursive: true });
  if (snapshot.kind === "absent") return;
  if (snapshot.kind === "symlink") {
    fs.symlinkSync(snapshot.link, snapshot.filePath);
  } else {
    fs.writeFileSync(snapshot.filePath, snapshot.bytes);
    fs.chmodSync(snapshot.filePath, snapshot.mode);
  }
  const restoredMode = fs.lstatSync(snapshot.filePath).mode & 0o7777;
  if (restoredMode !== snapshot.mode) {
    throw new Error(`failed to restore target lockfile mode: ${path.basename(snapshot.filePath)}`);
  }
}

function validationFallbackCommands({
  parts,
  error,
  cwd,
  baseBranch,
  baseRef,
  options,
}: LooseRecord) {
  if (options.strictTargetValidation) return [];
  if (!isChangedGateCommand(parts, options)) return [];
  if (/no merge base/i.test(String(error?.message ?? ""))) {
    validationBaseRef(cwd, baseBranch, options);
    return [parts];
  }
  if (!isChangedGateStall(error)) return [];
  const changedTests = changedTestFiles(cwd, baseBranch, options);
  return [
    ["git", "diff", "--check", `${baseRef}...HEAD`],
    ...(changedTests.length > 0 ? [["pnpm", "test:serial", ...changedTests]] : []),
  ];
}

function isChangedGateStall(error: JsonValue) {
  return /no output for \d+ms|terminating stalled Vitest|stalled Vitest process/i.test(
    String(error?.message ?? ""),
  );
}

function shouldRetryValidationCommand({ parts, error, attempts, options }: LooseRecord) {
  if (options.strictTargetValidation) return false;
  if (!isChangedGateCommand(parts, options)) return false;
  if (isChangedGateStall(error)) return false;

  const configuredRetries = Number.parseInt(process.env.CLAWSWEEPER_VALIDATION_RETRIES ?? "1", 10);
  const maxRetries = Number.isFinite(configuredRetries) ? Math.max(0, configuredRetries) : 1;
  const rendered = parts.join(" ");
  const used = attempts.get(rendered) ?? 0;
  if (used >= maxRetries) return false;
  attempts.set(rendered, used + 1);
  return true;
}

function targetValidationEnv() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: process.env.CI ?? "true",
    OPENCLAW_LOCAL_CHECK: process.env.OPENCLAW_LOCAL_CHECK ?? "0",
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CLAWSWEEPER_INTERNAL_MODEL;
  delete env.CODEX_HOME;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_ENV;
  delete env.GITHUB_OUTPUT;
  delete env.GITHUB_PATH;
  delete env.GITHUB_STEP_SUMMARY;
  env.COREPACK_DEFAULT_TO_LATEST = "0";
  env.COREPACK_ENABLE_AUTO_PIN = "0";
  // `corepack prepare <validated descriptor> --activate` selects the pnpm
  // version explicitly. Do not let package.json devEngines/packageManager
  // redirect the subsequent shim invocation back to target-controlled input.
  env.COREPACK_ENABLE_PROJECT_SPEC = "0";
  env.COREPACK_ENABLE_STRICT = "1";
  env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS = "0";
  env.COREPACK_ENV_FILE = "0";
  for (const key of Object.keys(env)) {
    if (
      /^ACTIONS_/i.test(key) ||
      /^CLAWSWEEPER_.*GH_TOKEN$/.test(key) ||
      key.startsWith("CLAWSWEEPER_CRABFLEET_")
    ) {
      delete env[key];
    }
  }
  return env;
}

function targetValidationTimeoutMs(name: string, fallback: number, cap?: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  const timeout = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return cap ? Math.min(timeout, cap) : timeout;
}

function resolveAllowedValidationCommands(
  command: LooseRecord,
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
  options: TargetValidationOptions,
) {
  const parts = parseAllowedValidationCommand(command);
  const commandParts = stripEnvPrefix(parts);
  const envPrefix = parts[0] === "env" ? parts.slice(0, parts.length - commandParts.length) : [];
  const scripts = readPackageScriptSet(cwd);
  const toolchain = getToolchain(options);
  const gate = toolchain.changedGate;
  if (
    !options.strictTargetValidation &&
    gate &&
    scripts.has(gate.requiredScript) &&
    commandParts[0] !== "git"
  ) {
    return [gate.command.split(" ")];
  }
  if (commandParts[0] === "npm" && commandParts[1] === "run" && commandParts[2] === "validate") {
    if (!scripts.has("validate") && gate && scripts.has(gate.requiredScript)) {
      return [gate.command.split(" ")];
    }
  }
  if (toolchain.packageManager === "pnpm" && commandParts[0] === "pnpm") {
    const commandStart = commandParts[1] === "-s" || commandParts[1] === "--silent" ? 2 : 1;
    const pnpmScript = commandParts[commandStart];
    if (isExpensivePnpmValidation(commandParts, commandStart, options.allowExpensiveValidation)) {
      return [["pnpm", "check:changed"]];
    }
    const vitestArgsStart =
      pnpmScript === "vitest" && commandParts[commandStart + 1] === "run"
        ? commandStart + 2
        : pnpmScript === "exec" &&
            commandParts[commandStart + 1] === "vitest" &&
            commandParts[commandStart + 2] === "run"
          ? commandStart + 3
          : -1;
    if (vitestArgsStart >= 0) {
      const vitestArgs = commandParts.slice(vitestArgsStart);
      const pathIndexes = vitestPathFilterIndexes(vitestArgs);
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          ["pnpm", "exec", "vitest", "run", ...vitestArgs],
          cwd,
          baseBranch,
          4,
          new Set(pathIndexes),
          options,
        ),
      );
    }
    if (pnpmScript === "test" || pnpmScript === "test:serial") {
      return withEnvPrefix(
        envPrefix,
        normalizePathValidationCommand(
          ["pnpm", pnpmScript, ...commandParts.slice(commandStart + 1)],
          cwd,
          baseBranch,
          2,
          undefined,
          options,
        ),
      );
    }
  }
  return [parts];
}

function withEnvPrefix(envPrefix: string[], commands: string[][]) {
  if (envPrefix.length === 0) return commands;
  return commands.map((command) => [...envPrefix, ...command]);
}

function normalizePathValidationCommand(
  parts: string[],
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
  pathArgStart: number = 2,
  testPathIndexes?: ReadonlySet<number>,
  options?: TargetValidationOptions,
) {
  const args = parts.slice(pathArgStart);
  const shouldNormalize = (arg: string, index: number) =>
    testPathIndexes ? testPathIndexes.has(index) : looksLikePathArgument(arg);
  if (!args.some(shouldNormalize)) return [parts];

  const normalizedArgs: string[] = [];
  const missing: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (!shouldNormalize(arg, index)) {
      normalizedArgs.push(arg);
      continue;
    }
    const mapped = resolveRepoPathArgument(arg, cwd);
    if (mapped) normalizedArgs.push(mapped);
    else missing.push(arg);
  }

  if (missing.length === 0) {
    return [[...parts.slice(0, pathArgStart), ...normalizedArgs]];
  }

  const changedTests = changedTestFiles(cwd, baseBranch, options);
  if (changedTests.length > 0) {
    return [[...parts.slice(0, pathArgStart), ...normalizedArgs, ...changedTests]];
  }

  return [["pnpm", "check:changed"]];
}

function resolveRepoPathArgument(arg: JsonValue, cwd: string): string {
  const clean = String(arg ?? "").trim();
  if (!clean || clean.startsWith("-")) return clean;
  if (fs.existsSync(path.join(cwd, clean))) return clean;

  const candidates = candidateRepoPaths(clean, cwd).filter((candidate) =>
    fs.existsSync(path.join(cwd, candidate)),
  );
  return candidates[0] ?? "";
}

function candidateRepoPaths(filePath: string, cwd: string): string[] {
  const out: string[] = [];
  if (filePath.startsWith("src/web/")) {
    out.push(`extensions/whatsapp/src/${filePath.slice("src/web/".length)}`);
  }
  const basename = path.basename(filePath);
  if (basename) {
    const files = gitLsFiles(cwd);
    out.push(...files.filter((file) => path.basename(file) === basename));
  }
  return uniqueStrings(out);
}

function changedTestFiles(
  cwd: string,
  baseBranch: string = DEFAULT_BASE_BRANCH,
  options?: TargetValidationOptions,
) {
  const changedFiles = options?.pinnedBaseRef
    ? gitChangedFilesFromRef(cwd, validationBaseRef(cwd, baseBranch, options))
    : gitChangedFiles(cwd, baseBranch);
  return changedFiles.filter((file) => isTestFile(file) && fs.existsSync(path.join(cwd, file)));
}

function validationBaseRef(cwd: string, baseBranch: string, options: TargetValidationOptions) {
  if (!options.pinnedBaseRef) {
    ensureMergeBaseAvailable({ targetDir: cwd, baseBranch, gitFetch: options.gitFetch });
    return `origin/${baseBranch}`;
  }
  run("git", ["merge-base", options.pinnedBaseRef, "HEAD"], { cwd });
  return options.pinnedBaseRef;
}

function gitChangedFilesFromRef(cwd: string, baseRef: string) {
  const committed = run("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommitted = run("git", ["status", "--porcelain"], { cwd })
    .split("\n")
    .map((line) => line.replace(/\r$/, "").slice(3))
    .map((line) => line.split(" -> ").pop())
    .filter((line): line is string => Boolean(line));
  return uniqueStrings([...committed, ...uncommitted]);
}

function referencedTrackedPaths(
  message: string,
  { targetDir, trackedAtBase }: { targetDir: string; trackedAtBase: ReadonlySet<string> },
) {
  const normalized = message.split(`${path.resolve(targetDir)}${path.sep}`).join("");
  const candidates = normalized.match(/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g) ?? [];
  const paths: string[] = [];
  for (const rawCandidate of uniqueStrings(candidates)) {
    const candidate = rawCandidate.replace(/^\.\//, "");
    if (trackedAtBase.has(candidate)) {
      paths.push(candidate);
      continue;
    }
    for (const trackedPath of trackedAtBase) {
      if (candidate.endsWith(`/${trackedPath}`)) paths.push(trackedPath);
    }
  }
  return uniqueStrings(paths);
}

function normalizedValidationFailure(message: string, trackedAtBase: ReadonlySet<string>) {
  const ansiCsi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  let normalized = message.replace(ansiCsi, "").replace(/\r\n/g, "\n");
  const candidates = normalized.match(/\/?[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*/g) ?? [];
  for (const candidate of uniqueStrings(candidates).sort(
    (left, right) => right.length - left.length,
  )) {
    const withoutLeadingSlash = candidate.replace(/^\//, "");
    const trackedPath = trackedAtBase.has(withoutLeadingSlash)
      ? withoutLeadingSlash
      : [...trackedAtBase].find((tracked) => withoutLeadingSlash.endsWith(`/${tracked}`));
    if (trackedPath) normalized = normalized.split(candidate).join(trackedPath);
  }
  return normalized.trim();
}

function splitGitLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function readPackageScriptSet(cwd: string) {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return new Set<string>();
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return new Set<string>(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set<string>();
  }
}

function requiresChangedGate(cwd: string, toolchain: TargetRepoToolchain) {
  if (!toolchain.changedGate) return false;
  return readPackageScriptSet(cwd).has(toolchain.changedGate.requiredScript);
}

function getToolchain(options: TargetValidationOptions): TargetRepoToolchain {
  return options.toolchain ?? resolveTargetRepoToolchain(options.targetRepo);
}

function isChangedGateCommand(parts: readonly string[], options: TargetValidationOptions) {
  return changedGateCommandParts(getToolchain(options).changedGate, parts) !== null;
}

function changedGateCommandParts(
  gate: TargetChangedGate | null,
  parts: readonly string[],
): readonly string[] | null {
  if (!gate) return null;
  const gateParts = gate.command.split(/\s+/).filter(Boolean);
  if (gateParts.length !== parts.length) return null;
  for (let i = 0; i < gateParts.length; i += 1) {
    if (gateParts[i] !== parts[i]) return null;
  }
  return gateParts;
}

function changedFilesSinceRef(cwd: string, sourceRef: string) {
  const committed = run("git", ["diff", "--name-only", `${sourceRef}..HEAD`], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommitted = run("git", ["status", "--porcelain"], { cwd })
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^.. /, ""))
    .map((line) => line.split(" -> ").pop())
    .filter(Boolean);
  return uniqueStrings([...committed, ...uncommitted]);
}

function isDocsOnlyRepairDeltaFile(filePath: string) {
  const file = String(filePath ?? "").trim();
  if (!file) return false;
  if (file === "CHANGELOG.md") return true;
  if (file.startsWith("docs/")) return true;
  if (/^(?:README|CONTRIBUTING|SECURITY|SUPPORT|CODE_OF_CONDUCT)\.md$/i.test(file)) return true;
  return /\.(?:md|mdx|txt)$/i.test(file);
}
