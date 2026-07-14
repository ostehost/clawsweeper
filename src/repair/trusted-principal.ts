import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SET_PRIV_PATH = "/usr/bin/setpriv";
const DEFAULT_PROCESS_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TRANSFER_ENTRIES = 4_096;
const DEFAULT_MAX_TRANSFER_DEPTH = 12;
const EMPTY_PROCESS_PROOF_SCANS = 2;
const PROCESS_PROOF_INTERVAL_MS = 25;
const PRINCIPAL_PROOF_PATH = fileURLToPath(
  new URL("./trusted-principal-proof.js", import.meta.url),
);

const FORBIDDEN_CHILD_ENV = new Set([
  "ACTIONS_CACHE_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
  "RUNNER_TRACKING_ID",
]);

export type TrustedTransferFile = {
  name: string;
  maxBytes: number;
};

export type StagedTransferFile = {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
};

export type IsolatedPrincipalOptions = {
  principalUid: number;
  principalGid: number;
  stageOwnerUid: number;
  stageOwnerGid: number;
  cwd: string;
  home: string;
  tmpDir: string;
  path: string;
  sourceRoot: string;
  stageRoot: string;
  files: readonly TrustedTransferFile[];
  allowEmptyTransfer?: boolean;
  command: string;
  commandArgs: readonly string[];
  childEnv?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  setprivPath?: string;
  procRoot?: string;
};

export type PrincipalProcessRuntime = {
  listProcesses?: (uid: number) => number[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => void;
  now?: () => number;
};

export function runAsIsolatedPrincipalAndStage(
  options: IsolatedPrincipalOptions,
): StagedTransferFile[] {
  assertLinuxRoot();
  assertPrincipalIds(options);
  assertSecureDirectory(options.home, options.principalUid, "principal home");
  assertSecureDirectory(options.tmpDir, options.principalUid, "principal temporary directory");
  assertAbsoluteDirectory(options.cwd, "principal working directory");
  assertSecureStageRoot(options.stageRoot, options.stageOwnerUid, options.stageOwnerGid);
  assertSeparatedRoots(options.sourceRoot, options.stageRoot);

  const procRoot = options.procRoot ?? "/proc";
  const existing = principalProcessIds(options.principalUid, procRoot);
  if (existing.length > 0) {
    throw new Error(
      `dedicated principal UID ${options.principalUid} already owns processes: ${existing.join(", ")}`,
    );
  }

  const setprivPath = options.setprivPath ?? DEFAULT_SET_PRIV_PATH;
  assertTrustedExecutable(setprivPath, "setpriv");
  assertTrustedExecutable(options.command, "isolated command");
  assertTrustedExecutable(process.execPath, "Node.js runtime");
  assertTrustedRegularFile(PRINCIPAL_PROOF_PATH, "principal proof helper");
  const childEnv = strictPrincipalEnvironment(options);
  const proofResult = spawnSync(
    setprivPath,
    setprivArguments({
      principalUid: options.principalUid,
      principalGid: options.principalGid,
      command: process.execPath,
      commandArgs: [
        PRINCIPAL_PROOF_PATH,
        String(options.principalUid),
        String(options.principalGid),
      ],
    }),
    {
      cwd: options.cwd,
      env: childEnv,
      stdio: "inherit",
      timeout: 10_000,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  if (proofResult.error) throw proofResult.error;
  if (proofResult.status !== 0) {
    throw new Error("dedicated principal runtime proof failed");
  }
  const setprivArgs = setprivArguments(options);

  let commandResult: SpawnSyncReturns<Buffer>;
  const previousUmask = process.umask(0o077);
  try {
    commandResult = spawnSync(setprivPath, setprivArgs, {
      cwd: options.cwd,
      env: childEnv,
      stdio: "inherit",
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
  } finally {
    process.umask(previousUmask);
  }

  // A command can daemonize or double-fork. Workflow steps do not provide a
  // security boundary, so no transfer is touched until the dedicated UID has
  // been fully drained and two consecutive /proc scans prove it is empty.
  terminateAndProvePrincipalEmpty(options.principalUid, {
    listProcesses: (uid) => principalProcessIds(uid, procRoot),
  });

  if (commandResult.error) throw commandResult.error;
  if (commandResult.status !== 0) {
    const detail = commandResult.signal
      ? `signal ${commandResult.signal}`
      : `exit ${commandResult.status ?? "unknown"}`;
    throw new Error(`isolated principal command failed with ${detail}`);
  }

  return stageExactPrincipalFiles({
    sourceRoot: options.sourceRoot,
    stageRoot: options.stageRoot,
    sourceUid: options.principalUid,
    stageOwnerUid: options.stageOwnerUid,
    stageOwnerGid: options.stageOwnerGid,
    files: options.files,
    ...(options.allowEmptyTransfer === undefined
      ? {}
      : { allowEmptyTransfer: options.allowEmptyTransfer }),
  });
}

export function strictPrincipalEnvironment(
  options: Pick<IsolatedPrincipalOptions, "home" | "tmpDir" | "path" | "childEnv">,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CI: "true",
    HOME: options.home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: "clawsweeper-untrusted",
    PATH: options.path,
    SHELL: "/usr/sbin/nologin",
    TMPDIR: options.tmpDir,
    USER: "clawsweeper-untrusted",
  };
  for (const [key, value] of Object.entries(options.childEnv ?? {})) {
    assertSafeEnvironmentEntry(key, value);
    if (key in env) throw new Error(`isolated child environment cannot replace ${key}`);
    env[key] = value;
  }
  return env;
}

export function setprivArguments(
  options: Pick<
    IsolatedPrincipalOptions,
    "principalUid" | "principalGid" | "command" | "commandArgs"
  >,
): string[] {
  return [
    `--reuid=${options.principalUid}`,
    `--regid=${options.principalGid}`,
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--no-new-privs",
    "--pdeathsig=KILL",
    "--",
    options.command,
    ...options.commandArgs,
  ];
}

export function principalProcessIds(uid: number, procRoot = "/proc"): number[] {
  const matches: number[] = [];
  for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const status = fs.readFileSync(path.join(procRoot, entry.name, "status"), "utf8");
      const statusUids = parseProcStatusUids(status);
      if (statusUids.includes(uid)) matches.push(Number(entry.name));
    } catch (error) {
      if (isTransientProcError(error)) continue;
      throw error;
    }
  }
  return matches.sort((left, right) => left - right);
}

export function parseProcStatusUids(status: string): number[] {
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  if (!match) return [];
  return match.slice(1).map((value) => Number(value));
}

export function assertPrincipalRuntimeStatus(
  status: string,
  expectedUid: number,
  expectedGid: number,
) {
  const uids = parseProcStatusUids(status);
  const gidMatch = /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  const gids = gidMatch?.slice(1).map((value) => Number(value)) ?? [];
  const groupsMatch = /^Groups:[ \t]*(.*?)[ \t]*$/m.exec(status);
  const groups = (groupsMatch?.[1] ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number(value));
  if (uids.length !== 4 || uids.some((value) => value !== expectedUid)) {
    throw new Error("dedicated principal runtime UID proof failed");
  }
  if (gids.length !== 4 || gids.some((value) => value !== expectedGid)) {
    throw new Error("dedicated principal runtime GID proof failed");
  }
  if (groups.length !== 0) {
    throw new Error("dedicated principal retained supplementary groups");
  }
  if (!/^NoNewPrivs:\s+1\s*$/m.test(status)) {
    throw new Error("dedicated principal no_new_privs proof failed");
  }
  for (const label of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    const match = new RegExp(`^${label}:\\s+([0-9a-fA-F]+)\\s*$`, "m").exec(status);
    if (!match || BigInt(`0x${match[1]}`) !== 0n) {
      throw new Error(`dedicated principal retained capabilities in ${label}`);
    }
  }
}

export function terminateAndProvePrincipalEmpty(
  uid: number,
  runtime: PrincipalProcessRuntime = {},
  timeoutMs = DEFAULT_PROCESS_CLEANUP_TIMEOUT_MS,
) {
  const listProcesses = runtime.listProcesses ?? ((value) => principalProcessIds(value));
  const kill = runtime.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = runtime.sleep ?? blockingSleep;
  const now = runtime.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let emptyScans = 0;
  let lastProcesses: number[] = [];

  while (now() <= deadline) {
    lastProcesses = listProcesses(uid);
    if (lastProcesses.length === 0) {
      emptyScans += 1;
      if (emptyScans >= EMPTY_PROCESS_PROOF_SCANS) return;
      sleep(PROCESS_PROOF_INTERVAL_MS);
      continue;
    }
    emptyScans = 0;
    for (const pid of lastProcesses) {
      try {
        kill(pid, "SIGKILL");
      } catch (error) {
        if (!isNoSuchProcess(error)) throw error;
      }
    }
    sleep(PROCESS_PROOF_INTERVAL_MS);
  }
  throw new Error(
    `dedicated principal UID ${uid} still owns processes after cleanup: ${lastProcesses.join(", ")}`,
  );
}

export function stageExactPrincipalFiles(options: {
  sourceRoot: string;
  stageRoot: string;
  sourceUid: number;
  stageOwnerUid: number;
  stageOwnerGid: number;
  files: readonly TrustedTransferFile[];
  allowEmptyTransfer?: boolean;
  maxEntries?: number;
  maxDepth?: number;
}): StagedTransferFile[] {
  assertAbsoluteDirectory(options.sourceRoot, "transfer source root");
  assertSecureStageRoot(options.stageRoot, options.stageOwnerUid, options.stageOwnerGid);
  assertSeparatedRoots(options.sourceRoot, options.stageRoot);
  if (fs.readdirSync(options.stageRoot).length !== 0) {
    throw new Error("trusted transfer staging root must be empty");
  }
  const allowed = validateTransferFiles(options.files);
  const found = new Map<string, string[]>();
  for (const name of allowed.keys()) found.set(name, []);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_TRANSFER_ENTRIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_TRANSFER_DEPTH;
  let entries = 0;

  const visit = (directory: string, depth: number) => {
    if (depth > maxDepth) throw new Error("trusted transfer source exceeded maximum depth");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > maxEntries) throw new Error("trusted transfer source exceeded entry limit");
      const candidate = path.join(directory, entry.name);
      const metadata = fs.lstatSync(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error(`trusted transfer source contains symbolic link: ${entry.name}`);
      }
      if (metadata.isDirectory()) {
        visit(candidate, depth + 1);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`trusted transfer source contains special file: ${entry.name}`);
      }
      if (found.has(entry.name)) found.get(entry.name)!.push(candidate);
    }
  };
  visit(options.sourceRoot, 0);

  if (
    options.allowEmptyTransfer === true &&
    [...found.values()].every((matches) => matches.length === 0)
  ) {
    fsyncDirectory(options.stageRoot);
    return [];
  }

  for (const [name, matches] of found) {
    if (matches.length !== 1) {
      throw new Error(`trusted transfer requires exactly one ${name}; found ${matches.length}`);
    }
  }

  const staged: StagedTransferFile[] = [];
  try {
    for (const [name, { maxBytes }] of allowed) {
      const source = found.get(name)![0]!;
      staged.push(
        copyPrincipalFile({
          source,
          destination: path.join(options.stageRoot, name),
          name,
          maxBytes,
          sourceUid: options.sourceUid,
          stageOwnerUid: options.stageOwnerUid,
          stageOwnerGid: options.stageOwnerGid,
        }),
      );
    }
    fsyncDirectory(options.stageRoot);
    return staged;
  } catch (error) {
    for (const name of allowed.keys())
      fs.rmSync(path.join(options.stageRoot, name), { force: true });
    throw error;
  }
}

function copyPrincipalFile(options: {
  source: string;
  destination: string;
  name: string;
  maxBytes: number;
  sourceUid: number;
  stageOwnerUid: number;
  stageOwnerGid: number;
}): StagedTransferFile {
  const sourceFd = fs.openSync(options.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationFd: number | undefined;
  try {
    const sourceMetadata = fs.fstatSync(sourceFd);
    if (!sourceMetadata.isFile()) throw new Error(`${options.name} is not a regular file`);
    if (sourceMetadata.uid !== options.sourceUid) {
      throw new Error(`${options.name} is not owned by the dedicated principal UID`);
    }
    if (sourceMetadata.nlink !== 1) {
      throw new Error(`${options.name} must have exactly one hard link`);
    }
    if (sourceMetadata.size <= 0 || sourceMetadata.size > options.maxBytes) {
      throw new Error(`${options.name} exceeds its bounded transfer size`);
    }

    destinationFd = fs.openSync(
      options.destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, sourceMetadata.size));
    let position = 0;
    while (position < sourceMetadata.size) {
      const requested = Math.min(buffer.length, sourceMetadata.size - position);
      const bytesRead = fs.readSync(sourceFd, buffer, 0, requested, position);
      if (bytesRead <= 0) throw new Error(`short read while staging ${options.name}`);
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(
          destinationFd,
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    fs.fsyncSync(destinationFd);
    fs.fchmodSync(destinationFd, 0o600);
    fs.fchownSync(destinationFd, options.stageOwnerUid, options.stageOwnerGid);
    const afterCopy = fs.fstatSync(sourceFd);
    if (
      afterCopy.dev !== sourceMetadata.dev ||
      afterCopy.ino !== sourceMetadata.ino ||
      afterCopy.size !== sourceMetadata.size ||
      afterCopy.mtimeMs !== sourceMetadata.mtimeMs ||
      afterCopy.ctimeMs !== sourceMetadata.ctimeMs
    ) {
      throw new Error(`${options.name} changed while it was staged`);
    }
    return {
      name: options.name,
      path: options.destination,
      bytes: sourceMetadata.size,
      sha256: digest.digest("hex"),
    };
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

function validateTransferFiles(files: readonly TrustedTransferFile[]) {
  if (files.length === 0) throw new Error("trusted transfer requires at least one file");
  const allowed = new Map<string, TrustedTransferFile>();
  for (const file of files) {
    if (
      !file.name ||
      file.name !== path.basename(file.name) ||
      file.name === "." ||
      file.name === ".." ||
      file.name.includes("\\") ||
      file.name.includes("\0")
    ) {
      throw new Error(`invalid trusted transfer filename: ${file.name}`);
    }
    if (!Number.isSafeInteger(file.maxBytes) || file.maxBytes <= 0) {
      throw new Error(`invalid trusted transfer size for ${file.name}`);
    }
    if (allowed.has(file.name)) throw new Error(`duplicate trusted transfer file: ${file.name}`);
    allowed.set(file.name, file);
  }
  return allowed;
}

function assertPrincipalIds(
  options: Pick<
    IsolatedPrincipalOptions,
    "principalUid" | "principalGid" | "stageOwnerUid" | "stageOwnerGid"
  >,
) {
  for (const [label, value] of [
    ["principal UID", options.principalUid],
    ["principal GID", options.principalGid],
    ["stage owner UID", options.stageOwnerUid],
    ["stage owner GID", options.stageOwnerGid],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) {
      throw new Error(`${label} must be a positive non-root Linux identifier`);
    }
  }
  if (options.principalUid === options.stageOwnerUid) {
    throw new Error("dedicated principal UID must differ from the staging owner UID");
  }
  if (options.principalGid === options.stageOwnerGid) {
    throw new Error("dedicated principal GID must differ from the staging owner GID");
  }
}

function assertLinuxRoot() {
  if (process.platform !== "linux") {
    throw new Error("trusted principal execution is supported only on Linux");
  }
  if (process.getuid?.() !== 0) {
    throw new Error("trusted principal execution must run as root to drop to a dedicated UID");
  }
}

function assertSecureDirectory(directory: string, ownerUid: number, label: string) {
  assertAbsoluteDirectory(directory, label);
  const metadata = fs.lstatSync(directory);
  if (metadata.uid !== ownerUid)
    throw new Error(`${label} is not owned by the dedicated principal`);
  if ((metadata.mode & 0o077) !== 0)
    throw new Error(`${label} must not grant group or other access`);
}

function assertSecureStageRoot(directory: string, ownerUid: number, ownerGid: number) {
  assertAbsoluteDirectory(directory, "trusted transfer staging root");
  const metadata = fs.lstatSync(directory);
  if (metadata.uid !== ownerUid || metadata.gid !== ownerGid) {
    throw new Error("trusted transfer staging root is not caller-owned");
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error("trusted transfer staging root must have mode 0700");
  }
}

function assertAbsoluteDirectory(directory: string, label: string) {
  if (!path.isAbsolute(directory)) throw new Error(`${label} must be an absolute path`);
  const metadata = fs.lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function assertSeparatedRoots(sourceRoot: string, stageRoot: string) {
  const source = fs.realpathSync(sourceRoot);
  const stage = fs.realpathSync(stageRoot);
  if (source === stage || isWithin(source, stage) || isWithin(stage, source)) {
    throw new Error("trusted transfer source and staging roots must not overlap");
  }
}

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

function assertTrustedExecutable(executable: string, label: string) {
  const metadata = assertTrustedRegularFile(executable, label);
  if ((metadata.mode & 0o111) === 0) throw new Error(`${label} is not executable`);
}

function assertTrustedRegularFile(file: string, label: string) {
  if (!path.isAbsolute(file)) throw new Error(`${label} must use an absolute path`);
  const metadata = fs.lstatSync(file);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be writable by group or other users`);
  }
  return metadata;
}

function assertSafeEnvironmentEntry(key: string, value: string) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid isolated environment key: ${key}`);
  if (
    FORBIDDEN_CHILD_ENV.has(key) ||
    key.startsWith("ACTIONS_") ||
    key.startsWith("CLAWSWEEPER_CRABFLEET_") ||
    key.startsWith("LD_") ||
    key.startsWith("DYLD_") ||
    key.startsWith("SUDO_")
  ) {
    throw new Error(`unsafe isolated environment key: ${key}`);
  }
  if (value.includes("\0")) throw new Error(`isolated environment value contains NUL: ${key}`);
}

function fsyncDirectory(directory: string) {
  const fd = fs.openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function blockingSleep(milliseconds: number) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function isTransientProcError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  // Only a process disappearing between readdir(2) and read(2) is benign.
  // Treat unreadable status metadata as a failed proof, never as an empty UID.
  return code === "ENOENT" || code === "ESRCH";
}

function isNoSuchProcess(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ESRCH";
}
