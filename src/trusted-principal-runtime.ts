import { spawnSync } from "node:child_process";
import fs, { constants } from "node:fs";
import path from "node:path";

const DEFAULT_PROCESS_CLEANUP_TIMEOUT_MS = 5_000;
const EMPTY_PROCESS_PROOF_SCANS = 2;
const PROCESS_PROOF_INTERVAL_MS = 25;

export type IsolatedPrincipalIdentity = {
  uid: number;
  gid: number;
};

export type PrincipalProcessRuntime = {
  listProcesses?: (uid: number) => number[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (milliseconds: number) => void;
  now?: () => number;
};

export type PrincipalWritableFile = {
  path: string;
  maxBytes: number;
};

export function setprivArguments(options: {
  principalUid: number;
  principalGid: number;
  command: string;
  commandArgs: readonly string[];
}): string[] {
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
): void {
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

export function assertIsolatedPrincipalIdentity(identity: IsolatedPrincipalIdentity): void {
  for (const [label, value] of [
    ["principal UID", identity.uid],
    ["principal GID", identity.gid],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) {
      throw new Error(`${label} must be a positive non-root Linux identifier`);
    }
  }
}

export function proveIsolatedPrincipalRuntime(options: {
  identity: IsolatedPrincipalIdentity;
  proofPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  setprivPath?: string;
  procRoot?: string;
}): void {
  if (process.platform !== "linux") {
    throw new Error("isolated principal execution is supported only on Linux");
  }
  if (process.getuid?.() !== 0) {
    throw new Error("isolated principal execution must run as root");
  }
  assertIsolatedPrincipalIdentity(options.identity);
  const existing = principalProcessIds(options.identity.uid, options.procRoot);
  if (existing.length > 0) {
    throw new Error(
      `dedicated principal UID ${options.identity.uid} already owns processes: ${existing.join(", ")}`,
    );
  }
  const setprivPath = options.setprivPath ?? "/usr/bin/setpriv";
  assertTrustedExecutable(setprivPath, "setpriv");
  assertTrustedExecutable(process.execPath, "Node.js runtime");
  assertTrustedRegularFile(options.proofPath, "principal proof helper");
  const proof = spawnSync(
    setprivPath,
    setprivArguments({
      principalUid: options.identity.uid,
      principalGid: options.identity.gid,
      command: process.execPath,
      commandArgs: [options.proofPath, String(options.identity.uid), String(options.identity.gid)],
    }),
    {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      timeout: 10_000,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  if (proof.error) throw proof.error;
  if (proof.status !== 0) throw new Error("dedicated principal runtime proof failed");
}

export function terminateAndProvePrincipalEmpty(
  uid: number,
  runtime: PrincipalProcessRuntime = {},
  timeoutMs = DEFAULT_PROCESS_CLEANUP_TIMEOUT_MS,
): void {
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

export function assertTrustedExecutable(executable: string, label: string): void {
  const metadata = assertTrustedRegularFile(executable, label);
  if ((metadata.mode & 0o111) === 0) throw new Error(`${label} is not executable`);
}

export function assertTrustedRegularFile(file: string, label: string): fs.Stats {
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

export function handOffExactFilesToPrincipal(options: {
  files: readonly PrincipalWritableFile[];
  hostUid: number;
  principal: IsolatedPrincipalIdentity;
}): void {
  for (const file of options.files) {
    assertPrincipalWritableFile(file);
    const parent = fs.lstatSync(path.dirname(file.path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error(`principal output parent must be a real directory: ${file.path}`);
    }
    if (parent.uid !== options.hostUid || (parent.mode & 0o022) !== 0) {
      throw new Error(`principal output parent is not trusted and non-writable: ${file.path}`);
    }
    const descriptor = fs.openSync(file.path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const metadata = fs.fstatSync(descriptor);
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== options.hostUid) {
        throw new Error(`principal output is not an exact host-owned regular file: ${file.path}`);
      }
      if (metadata.size !== 0) {
        throw new Error(`principal output must be empty before execution: ${file.path}`);
      }
      fs.fchmodSync(descriptor, 0o600);
      fs.fchownSync(descriptor, options.principal.uid, options.principal.gid);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

export function reclaimExactPrincipalFiles(options: {
  files: readonly PrincipalWritableFile[];
  hostUid: number;
  hostGid: number;
  principal: IsolatedPrincipalIdentity;
}): void {
  let validationError: Error | undefined;
  for (const file of options.files) {
    try {
      assertPrincipalWritableFile(file);
      const descriptor = fs.openSync(file.path, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const metadata = fs.fstatSync(descriptor);
        if (!metadata.isFile()) {
          throw new Error(`principal output is not a regular file: ${file.path}`);
        }
        if (metadata.nlink !== 1) {
          throw new Error(`principal output must have exactly one hard link: ${file.path}`);
        }
        if (metadata.uid !== options.principal.uid && metadata.uid !== options.hostUid) {
          throw new Error(`principal output ownership changed unexpectedly: ${file.path}`);
        }
        if (metadata.size > file.maxBytes) {
          throw new Error(`principal output exceeds ${file.maxBytes} bytes: ${file.path}`);
        }
        fs.fchownSync(descriptor, options.hostUid, options.hostGid);
        fs.fchmodSync(descriptor, 0o600);
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      validationError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (validationError) throw validationError;
}

function assertPrincipalWritableFile(file: PrincipalWritableFile): void {
  if (!path.isAbsolute(file.path)) {
    throw new Error("principal output path must be absolute");
  }
  if (!Number.isSafeInteger(file.maxBytes) || file.maxBytes <= 0) {
    throw new Error("principal output byte limit must be a positive integer");
  }
}

function blockingSleep(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function isTransientProcError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

function isNoSuchProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ESRCH";
}
