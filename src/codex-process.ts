import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_OUTPUT_FILE_BYTES,
  DEFAULT_CODEX_OUTPUT_TAIL_BYTES,
} from "./codex-output-capture.js";
import { codexProcessCommand } from "./codex-spawn.js";
import {
  assertIsolatedPrincipalIdentity,
  type IsolatedPrincipalIdentity,
  type PrincipalWritableFile,
} from "./trusted-principal-runtime.js";

export { codexProcessCommand, codexSpawnInvocation } from "./codex-spawn.js";

export interface CodexProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stdout: string;
  stderr: string;
}

interface SerializedCodexProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: {
    message: string;
    code?: string;
  };
  stdout: string;
  stderr: string;
}

const CODEX_PROCESS_WORKER_PATH = fileURLToPath(
  new URL("./codex-process-worker.js", import.meta.url),
);
const CODEX_APP_SERVER_WORKER_PATH = fileURLToPath(
  new URL("./codex-app-server-worker.js", import.meta.url),
);
const TRUSTED_PRINCIPAL_PROOF_PATH = fileURLToPath(
  new URL("./trusted-principal-proof.js", import.meta.url),
);
const TRUSTED_PRINCIPAL_CLEANUP_PATH = fileURLToPath(
  new URL("./trusted-principal-cleanup.js", import.meta.url),
);
const ISOLATED_CODEX_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

export interface CodexAppServerProcessOptions {
  statePath: string;
  label?: string;
  runnerPtyUrl?: string;
  workStateUrl?: string;
  agentToken?: string;
}

export function codexAppServerProcessOptionsFromEnv(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexAppServerProcessOptions | undefined {
  if (env.CLAWSWEEPER_STEERABLE_CODEX !== "1") return undefined;
  const statePath =
    env.CLAWSWEEPER_CODEX_THREAD_STATE?.trim() ||
    join(env.CODEX_HOME?.trim() || tmpdir(), "clawsweeper-thread-state.json");
  return {
    statePath,
    label,
    ...(env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL?.trim()
      ? { runnerPtyUrl: env.CLAWSWEEPER_CRABFLEET_RUNNER_PTY_URL.trim() }
      : {}),
    ...(env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL?.trim()
      ? { workStateUrl: env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL.trim() }
      : {}),
    ...(env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN?.trim()
      ? { agentToken: env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN.trim() }
      : {}),
  };
}

export function runCodexProcess(options: {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  tailBytes?: number;
  outputFileBytes?: number;
  stdoutPath?: string;
  stderrPath?: string;
  appServer?: CodexAppServerProcessOptions;
  redactValues?: readonly string[];
}): CodexProcessResult {
  const workDir = mkdtempSync(join(tmpdir(), "clawsweeper-codex-process-"));
  const optionsPath = join(workDir, "options.json");
  const resultPath = join(workDir, "result.json");
  const stdoutPath = options.stdoutPath ?? join(workDir, "stdout.log");
  const stderrPath = options.stderrPath ?? join(workDir, "stderr.log");
  const isolatedPrincipal = isolatedCodexPrincipal(options.env);
  const hostIdentity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  let principalFiles: PrincipalWritableFile[] = [];
  try {
    if (isolatedPrincipal) {
      if (options.appServer) {
        throw new Error("isolated Codex app-server mode is not supported");
      }
      principalFiles = [isolatedCodexOutputFile(options.args, options.cwd)];
      precreatePrincipalOutputFiles(principalFiles);
    }
    const workerEnv = isolatedPrincipal
      ? isolatedCodexEnvironment(options.env)
      : { ...options.env };
    writeFileSync(
      optionsPath,
      JSON.stringify({
        args: [...options.args],
        command: isolatedPrincipal
          ? trustedCodexExecutable(options.env, options.cwd)
          : codexProcessCommand(options.env, process.platform, options.cwd),
        timeoutMs: options.timeoutMs,
        resultPath,
        stdoutPath,
        stderrPath,
        tailBytes: normalizedTailBytes(options.tailBytes),
        maxOutputFileBytes: normalizedOutputFileBytes(options.outputFileBytes),
        ...(options.appServer ? { appServer: options.appServer } : {}),
        ...(isolatedPrincipal
          ? {
              env: workerEnv,
              isolatedPrincipal,
              hostIdentity,
              principalFiles,
              proofPath: TRUSTED_PRINCIPAL_PROOF_PATH,
            }
          : {}),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const workerPath = options.appServer ? CODEX_APP_SERVER_WORKER_PATH : CODEX_PROCESS_WORKER_PATH;
    const workerCommand = isolatedPrincipal ? "/usr/bin/sudo" : process.execPath;
    const workerArgs = isolatedPrincipal
      ? ["--non-interactive", process.execPath, workerPath, optionsPath]
      : [workerPath, optionsPath];
    const worker = spawnSync(workerCommand, workerArgs, {
      cwd: options.cwd,
      env: isolatedPrincipal ? trustedLauncherEnvironment() : workerEnv,
      input: JSON.stringify({
        input: options.input,
        redactValues: [...(options.redactValues ?? [])],
      }),
      stdio: ["pipe", "ignore", "ignore"],
      timeout: options.timeoutMs + 10_000,
    });
    if (isolatedPrincipal) {
      const cleanupError = runPrincipalCleanup(isolatedPrincipal, hostIdentity, principalFiles);
      if (cleanupError) return failedProcessResult(cleanupError, worker.status, worker.signal);
    }
    if (existsSync(resultPath)) {
      const result = deserializeProcessResult(JSON.parse(readFileSync(resultPath, "utf8")));
      return worker.error ? { ...result, error: worker.error } : result;
    }
    if (worker.error) return failedProcessResult(worker.error, worker.status, worker.signal);
    return failedProcessResult(
      new Error(
        `Codex process worker failed with exit ${worker.status ?? "unknown"} and did not write a result.`,
      ),
      worker.status,
      worker.signal,
    );
  } catch (error) {
    if (isolatedPrincipal && principalFiles.length > 0) {
      const cleanupError = runPrincipalCleanup(isolatedPrincipal, hostIdentity, principalFiles);
      if (cleanupError) return failedProcessResult(cleanupError);
    }
    return failedProcessResult(error instanceof Error ? error : new Error(String(error)));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function isolatedCodexPrincipal(
  env: NodeJS.ProcessEnv = process.env,
): IsolatedPrincipalIdentity | undefined {
  const rawUid = env.CLAWSWEEPER_CODEX_PRINCIPAL_UID?.trim();
  const rawGid = env.CLAWSWEEPER_CODEX_PRINCIPAL_GID?.trim();
  if (!rawUid && !rawGid) return undefined;
  if (!rawUid || !rawGid || !/^\d+$/.test(rawUid) || !/^\d+$/.test(rawGid)) {
    throw new Error("Codex principal isolation requires numeric UID and GID together");
  }
  const identity = { uid: Number(rawUid), gid: Number(rawGid) };
  assertIsolatedPrincipalIdentity(identity);
  return identity;
}

export function isolatedCodexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = requiredPrincipalDirectoryEnv(env, "CLAWSWEEPER_CODEX_PRINCIPAL_HOME");
  const tmpDir = requiredPrincipalDirectoryEnv(env, "CLAWSWEEPER_CODEX_PRINCIPAL_TMPDIR");
  const codexHome = requiredPrincipalDirectoryEnv(env, "CLAWSWEEPER_CODEX_PRINCIPAL_CODEX_HOME");
  const result: NodeJS.ProcessEnv = {
    CI: "true",
    CODEX_HOME: codexHome,
    GIT_OPTIONAL_LOCKS: "0",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: "clawsweeper-codex",
    PATH: trustedCodexPath(),
    SHELL: "/usr/sbin/nologin",
    TMPDIR: tmpDir,
    USER: "clawsweeper-codex",
  };
  for (const name of [
    "ALL_PROXY",
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "all_proxy",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "CLAWSWEEPER_PROOF_INPUT_DIR",
    "CLAWSWEEPER_PROOF_SCRATCH_DIR",
  ]) {
    const value = env[name];
    if (value !== undefined && !value.includes("\0")) result[name] = value;
  }
  return result;
}

function requiredPrincipalDirectoryEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute directory`);
  return value;
}

function trustedCodexPath(): string {
  return [...new Set([dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"])]
    .filter((directory) => {
      try {
        return statSync(directory).isDirectory();
      } catch {
        return false;
      }
    })
    .join(":");
}

function trustedCodexExecutable(env: NodeJS.ProcessEnv, cwd: string): string {
  const command = codexProcessCommand(env);
  const candidate = isAbsolute(command)
    ? command
    : command.includes("/")
      ? resolve(cwd, command)
      : executableOnPath(command, env.PATH ?? "");
  if (!candidate) throw new Error(`Unable to resolve isolated Codex executable: ${command}`);
  const executable = realpathSync(candidate);
  const metadata = statSync(executable);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) {
    throw new Error("isolated Codex executable is not a trusted executable file");
  }
  return executable;
}

function executableOnPath(command: string, pathValue: string): string | undefined {
  for (const directory of pathValue.split(":")) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through absolute PATH entries only.
    }
  }
  return undefined;
}

function isolatedCodexOutputFile(args: readonly string[], cwd: string): PrincipalWritableFile {
  let outputPath = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--output-last-message") continue;
    if (outputPath || !args[index + 1]) {
      throw new Error("isolated Codex requires exactly one --output-last-message path");
    }
    outputPath = args[index + 1]!;
    index += 1;
  }
  if (!outputPath) throw new Error("isolated Codex requires --output-last-message");
  return {
    path: isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath),
    maxBytes: ISOLATED_CODEX_OUTPUT_MAX_BYTES,
  };
}

function precreatePrincipalOutputFiles(files: readonly PrincipalWritableFile[]): void {
  for (const file of files) {
    const descriptor = openSync(
      file.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(descriptor);
  }
}

function trustedLauncherEnvironment(): NodeJS.ProcessEnv {
  return { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" };
}

function runPrincipalCleanup(
  principal: IsolatedPrincipalIdentity,
  host: { uid: number; gid: number },
  files: readonly PrincipalWritableFile[],
): Error | undefined {
  const args = [
    "--non-interactive",
    process.execPath,
    TRUSTED_PRINCIPAL_CLEANUP_PATH,
    "--uid",
    String(principal.uid),
    "--gid",
    String(principal.gid),
    "--host-uid",
    String(host.uid),
    "--host-gid",
    String(host.gid),
    ...files.flatMap((file) => ["--file", `${file.path}:${file.maxBytes}`]),
  ];
  const result = spawnSync("/usr/bin/sudo", args, {
    env: trustedLauncherEnvironment(),
    stdio: "ignore",
    timeout: 10_000,
  });
  if (result.error) return result.error;
  if (result.status !== 0) return new Error("isolated Codex principal cleanup failed");
  return undefined;
}

export function codexProcessErrorCode(error: Error | undefined): string | null {
  if (!error || !("code" in error)) return null;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : null;
}

function normalizedTailBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_TAIL_BYTES;
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_TAIL_BYTES);
}

function normalizedOutputFileBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_FILE_BYTES;
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_FILE_BYTES);
}

function failedProcessResult(
  error: Error,
  status: number | null = null,
  signal: NodeJS.Signals | null = null,
): CodexProcessResult {
  return { status, signal, error, stdout: "", stderr: "" };
}

function deserializeProcessResult(value: SerializedCodexProcessResult): CodexProcessResult {
  return {
    status: value.status,
    signal: value.signal,
    ...(value.error ? { error: deserializeError(value.error) } : {}),
    stdout: value.stdout,
    stderr: value.stderr,
  };
}

function deserializeError(value: { message: string; code?: string }): Error {
  const error = new Error(value.message);
  if (value.code) (error as NodeJS.ErrnoException).code = value.code;
  return error;
}
