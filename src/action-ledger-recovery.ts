import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  fsyncDirectory,
  prepareSafeReadRoot,
  prepareSafeReadTarget,
  prepareSafeWriteTarget,
  processIncarnationIdentitySha256,
  processIsDefunct,
  readDirectoryEntriesNoFollow,
  readUtf8FileIfExistsNoFollow,
  readUtf8FileNoFollow,
  removeFileNoFollow,
  removeUtf8FileIfContentNoFollow,
  unlinkFileIfExistsNoFollow,
  writeUtf8FileAtomicReplaceNoFollow,
} from "./action-ledger-files.js";
import { actionLedgerJson } from "./action-ledger.js";

const MUTATION_RECOVERY_SCHEMA = "clawsweeper.action-ledger-mutation-recovery";
const MUTATION_RECOVERY_VERSION = 1;
const MUTATION_RECOVERY_MAX_FILES = 1024;
const MUTATION_RECOVERY_MAX_BYTES = 256 * 1024;
const MUTATION_RECOVERY_FAMILY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MUTATION_RECOVERY_KEY_PATTERN = /^[a-f0-9]{64}$/;
const MUTATION_RECOVERY_TEMP_PATTERN =
  /^\.(?<key>[a-f0-9]{64})\.(?<pid>[1-9][0-9]*)\.(?<incarnation>[a-f0-9]{64})\.(?<createdAt>[0-9]+)\.(?<nonce>[a-f0-9-]{36})\.tmp$/;
const LEGACY_MUTATION_RECOVERY_TEMP_PATTERN =
  /^\.(?<key>[a-f0-9]{64})\.(?<pid>[1-9][0-9]*)\.(?<createdAt>[0-9]+)\.tmp$/;
const MUTATION_RECOVERY_RECLAIM_PATTERN =
  /^(?<key>[a-f0-9]{64})\.json\.(?<pid>[1-9][0-9]*)\.(?<nonce>[a-f0-9-]{36})\.reclaim$/;
const WORKFLOW_ENV_KEYS = [
  "CLAWSWEEPER_ACTION_LEDGER_FORCE",
  "CLAWSWEEPER_ACTION_LEDGER_INVOCATION",
  "CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT",
  "CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE",
  "CLAWSWEEPER_ACTION_LEDGER_ROOT",
  "CLAWSWEEPER_CRABFLEET_SESSION_ID",
  "GITHUB_ACTION",
  "GITHUB_JOB",
  "GITHUB_REPOSITORY",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_STARTED_AT",
  "GITHUB_SERVER_URL",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW",
  "GITHUB_WORKFLOW_REF",
] as const;

type MutationRecoveryEnvelope<T> = {
  schema: typeof MUTATION_RECOVERY_SCHEMA;
  schema_version: typeof MUTATION_RECOVERY_VERSION;
  family: string;
  key: string;
  payload: T;
};

export type MutationRecoveryRecord<T> = {
  key: string;
  path: string;
  content: string;
  payload: T;
};

export function actionLedgerRecoveryEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of WORKFLOW_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

export function actionLedgerRecoveryRoot(env: NodeJS.ProcessEnv, fallbackRoot: string): string {
  return (
    env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim() ||
    path.join(fallbackRoot, ".clawsweeper-repair", "action-ledger-state")
  );
}

export function writeMutationRecovery<T>(
  recoveryRoot: string,
  family: string,
  key: string,
  payload: T,
): string {
  assertMutationRecoveryIdentity(family, key);
  const root = path.resolve(recoveryRoot);
  prepareMutationRecoveryDirectory(root, family);
  const target = prepareSafeWriteTarget(
    root,
    path.join(".mutation-recovery", family, `${key}.json`),
    "mutation recovery",
  );
  const processIncarnation = processIncarnationIdentitySha256();
  if (processIncarnation === null) {
    throw new Error("unable to determine mutation recovery writer process incarnation");
  }
  const temporaryFilename = `.${key}.${process.pid}.${processIncarnation}.${Date.now()}.${randomUUID()}.tmp`;
  const envelope: MutationRecoveryEnvelope<T> = {
    schema: MUTATION_RECOVERY_SCHEMA,
    schema_version: MUTATION_RECOVERY_VERSION,
    family,
    key,
    payload,
  };
  const content = `${actionLedgerJson(envelope)}\n`;
  if (Buffer.byteLength(content, "utf8") > MUTATION_RECOVERY_MAX_BYTES) {
    throw new Error(`mutation recovery exceeds ${MUTATION_RECOVERY_MAX_BYTES} bytes`);
  }
  writeUtf8FileAtomicReplaceNoFollow(target, content, temporaryFilename);
  return content;
}

export function readMutationRecoveries<T>(
  recoveryRoot: string,
  family: string,
): MutationRecoveryRecord<T>[] {
  assertMutationRecoveryFamily(family);
  const root = path.resolve(recoveryRoot);
  const directory = mutationRecoveryDirectory(root, family);
  if (!existsSync(directory)) return [];
  const safeRoot = prepareSafeReadRoot(root, "mutation recovery");
  const relativeDirectory = path.join(".mutation-recovery", family);
  let entries: ReturnType<typeof readDirectoryEntriesNoFollow>;
  try {
    entries = readDirectoryEntriesNoFollow(
      safeRoot,
      relativeDirectory,
      "mutation recovery",
      MUTATION_RECOVERY_MAX_FILES,
    );
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const records: MutationRecoveryRecord<T>[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    const temporary = MUTATION_RECOVERY_TEMP_PATTERN.exec(entry.name);
    if (temporary?.groups) {
      if (!assertRecoveryFileIfPresent(filePath, entry.name)) continue;
      if (
        mutationRecoveryWriterIsStale(Number(temporary.groups.pid), temporary.groups.incarnation!)
      ) {
        removeMutationRecoveryEntry(
          safeRoot,
          path.join(relativeDirectory, entry.name),
          "stale mutation recovery staging file",
        );
      }
      continue;
    }
    const legacyTemporary = LEGACY_MUTATION_RECOVERY_TEMP_PATTERN.exec(entry.name);
    if (legacyTemporary?.groups) {
      if (!assertRecoveryFileIfPresent(filePath, entry.name)) continue;
      if (!processIsAlive(Number(legacyTemporary.groups.pid))) {
        removeMutationRecoveryEntry(
          safeRoot,
          path.join(relativeDirectory, entry.name),
          "stale legacy mutation recovery staging file",
        );
      }
      continue;
    }
    const reclaim = MUTATION_RECOVERY_RECLAIM_PATTERN.exec(entry.name);
    if (reclaim?.groups) {
      removeMutationRecoveryClaim(
        safeRoot,
        path.join(relativeDirectory, entry.name),
        "interrupted mutation recovery reclaim file",
      );
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error(`invalid mutation recovery entry: ${entry.name}`);
    }
    const key = entry.name.slice(0, -".json".length);
    assertMutationRecoveryIdentity(family, key);
    const content = readUtf8FileNoFollow(
      prepareSafeReadTarget(
        safeRoot,
        path.join(relativeDirectory, entry.name),
        "mutation recovery",
      ),
      MUTATION_RECOVERY_MAX_BYTES,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`mutation recovery is not valid JSON: ${entry.name}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`mutation recovery envelope is invalid: ${entry.name}`);
    }
    const envelope = parsed as Partial<MutationRecoveryEnvelope<T>>;
    if (
      envelope.schema !== MUTATION_RECOVERY_SCHEMA ||
      envelope.schema_version !== MUTATION_RECOVERY_VERSION ||
      envelope.family !== family ||
      envelope.key !== key ||
      envelope.payload === undefined ||
      `${actionLedgerJson(envelope)}\n` !== content
    ) {
      throw new Error(`mutation recovery identity is invalid: ${entry.name}`);
    }
    records.push({ key, path: filePath, content, payload: envelope.payload });
  }
  return records;
}

export function removeMutationRecovery(
  recoveryRoot: string,
  family: string,
  key: string,
  expectedContent: string,
): void {
  assertMutationRecoveryIdentity(family, key);
  const root = path.resolve(recoveryRoot);
  if (!existsSync(root)) return;
  let target;
  try {
    target = prepareSafeReadTarget(
      prepareSafeReadRoot(root, "mutation recovery"),
      path.join(".mutation-recovery", family, `${key}.json`),
      "mutation recovery",
    );
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  const content = readUtf8FileIfExistsNoFollow(target, MUTATION_RECOVERY_MAX_BYTES);
  if (content === null) return;
  if (content !== expectedContent) {
    throw new Error(`refusing changed mutation recovery file: ${target.path}`);
  }
  if (removeUtf8FileIfContentNoFollow(target, expectedContent)) return;
  const raced = readUtf8FileIfExistsNoFollow(target, MUTATION_RECOVERY_MAX_BYTES);
  if (raced !== null) throw new Error(`refusing changed mutation recovery file: ${target.path}`);
}

export function mutationRecoveryPath(recoveryRoot: string, family: string, key: string): string {
  assertMutationRecoveryIdentity(family, key);
  return path.join(mutationRecoveryDirectory(recoveryRoot, family), `${key}.json`);
}

function mutationRecoveryDirectory(recoveryRoot: string, family: string): string {
  assertMutationRecoveryFamily(family);
  return path.join(recoveryRoot, ".mutation-recovery", family);
}

function prepareMutationRecoveryDirectory(recoveryRoot: string, family: string): string {
  const root = path.resolve(recoveryRoot);
  prepareMutationRecoveryRoot(root);
  const parent = path.join(root, ".mutation-recovery");
  ensureMutationRecoveryDirectory(root, parent);
  const directory = mutationRecoveryDirectory(root, family);
  ensureMutationRecoveryDirectory(parent, directory);
  return directory;
}

function prepareMutationRecoveryRoot(root: string): void {
  const missing: string[] = [];
  let ancestor = root;
  while (!existsSync(ancestor)) {
    missing.push(ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`mutation recovery root is unavailable: ${root}`);
    ancestor = parent;
  }
  prepareSafeReadRoot(ancestor, "mutation recovery root ancestor");
  for (const directory of missing.reverse()) {
    mkdirSync(directory, { mode: 0o700 });
    assertDirectory(directory);
    fsyncDirectory(path.dirname(directory), "mutation recovery root");
  }
  prepareSafeReadRoot(root, "mutation recovery");
}

function ensureMutationRecoveryDirectory(parent: string, directory: string): void {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  assertDirectory(directory);
  fsyncDirectory(parent, "mutation recovery directory");
}

function assertMutationRecoveryIdentity(family: string, key: string): void {
  assertMutationRecoveryFamily(family);
  if (!MUTATION_RECOVERY_KEY_PATTERN.test(key)) {
    throw new Error("mutation recovery key is invalid");
  }
}

function assertMutationRecoveryFamily(family: string): void {
  if (!MUTATION_RECOVERY_FAMILY_PATTERN.test(family)) {
    throw new Error("mutation recovery family is invalid");
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function assertDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`mutation recovery directory is unsafe: ${directory}`);
  }
}

function assertRecoveryFile(filePath: string, name: string) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`invalid mutation recovery file: ${name}`);
  }
  if (stat.size > MUTATION_RECOVERY_MAX_BYTES) {
    throw new Error(`mutation recovery exceeds ${MUTATION_RECOVERY_MAX_BYTES} bytes: ${name}`);
  }
  return stat;
}

function assertRecoveryFileIfPresent(filePath: string, name: string): boolean {
  try {
    assertRecoveryFile(filePath, name);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function removeMutationRecoveryEntry(
  root: ReturnType<typeof prepareSafeReadRoot>,
  relativePath: string,
  label: string,
): void {
  let target;
  try {
    target = prepareSafeReadTarget(root, relativePath, label);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  const result = removeFileNoFollow(target);
  if (result === "changed" || result === "replaced") {
    throw new Error(`refusing changed ${label}: ${target.path}`);
  }
}

function removeMutationRecoveryClaim(
  root: ReturnType<typeof prepareSafeReadRoot>,
  relativePath: string,
  label: string,
): void {
  let target;
  try {
    target = prepareSafeReadTarget(root, relativePath, label);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  unlinkFileIfExistsNoFollow(target);
}

function mutationRecoveryWriterIsStale(pid: number, expectedIncarnation: string): boolean {
  if (!processIsAlive(pid)) return true;
  const currentIncarnation = processIncarnationIdentitySha256(pid, { fresh: true });
  return currentIncarnation !== null && currentIncarnation !== expectedIncarnation;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || processIsDefunct(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}
