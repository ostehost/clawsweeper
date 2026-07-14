import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  openCodexOutputCapture,
  redactCodexText,
} from "./codex-output-capture.js";
import { spawnCodex, terminateCodexProcessTree } from "./codex-spawn.js";
import {
  handOffExactFilesToPrincipal,
  proveIsolatedPrincipalRuntime,
  reclaimExactPrincipalFiles,
  terminateAndProvePrincipalEmpty,
  type IsolatedPrincipalIdentity,
  type PrincipalWritableFile,
} from "./trusted-principal-runtime.js";

interface WorkerOptions {
  args: string[];
  command: string;
  timeoutMs: number;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  tailBytes: number;
  maxOutputFileBytes: number;
  env?: NodeJS.ProcessEnv;
  isolatedPrincipal?: IsolatedPrincipalIdentity;
  hostIdentity?: IsolatedPrincipalIdentity;
  principalFiles?: PrincipalWritableFile[];
  proofPath?: string;
  setprivPath?: string;
}

const options = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as WorkerOptions;
const input = await readWorkerInput();
const childEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env), CODEX_BIN: options.command };
if (options.isolatedPrincipal) prepareIsolatedPrincipal();
const stdout = openCodexOutputCapture(options.stdoutPath, {
  maxFileBytes: options.maxOutputFileBytes,
  tailBytes: options.tailBytes,
  redactValues: input.redactValues,
});
const stderr = openCodexOutputCapture(options.stderrPath, {
  maxFileBytes: options.maxOutputFileBytes,
  tailBytes: options.tailBytes,
  redactValues: input.redactValues,
});
const child = spawnCodex(options.args, {
  cwd: process.cwd(),
  env: childEnv,
  ...(options.isolatedPrincipal ? { isolatedPrincipal: options.isolatedPrincipal } : {}),
  ...(options.setprivPath ? { setprivPath: options.setprivPath } : {}),
});
let spawnError: Error | undefined;
let timeoutError: Error | undefined;
let terminating = false;
let forceKillTimer: NodeJS.Timeout | undefined;
const timeout = setTimeout(() => {
  timeoutError = new Error(`Codex process timed out after ${options.timeoutMs}ms`);
  (timeoutError as NodeJS.ErrnoException).code = "ETIMEDOUT";
  forceKillTimer = terminateCodexProcessTree(child);
}, options.timeoutMs);

child.stdout.on("data", (chunk: Buffer) => {
  appendCodexOutputCapture(stdout, chunk);
});
child.stderr.on("data", (chunk: Buffer) => {
  appendCodexOutputCapture(stderr, chunk);
});
child.stdin.on("error", () => {});
child.stdin.end(input.prompt);

child.once("error", (error) => {
  spawnError = error;
});
child.once("close", (status, signal) => {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  clearTimeout(timeout);
  closeCodexOutputCapture(stdout);
  closeCodexOutputCapture(stderr);
  const boundaryError = cleanupIsolatedPrincipal();
  writeFileSync(
    options.resultPath,
    JSON.stringify({
      status,
      signal,
      ...(boundaryError || timeoutError || spawnError
        ? {
            error: serializedError(
              boundaryError ?? timeoutError ?? spawnError!,
              input.redactValues,
            ),
          }
        : {}),
      stdout: codexOutputTail(stdout),
      stderr: codexOutputTail(stderr),
    }),
    "utf8",
  );
  process.exit(0);
});

function prepareIsolatedPrincipal(): void {
  const principal = options.isolatedPrincipal!;
  const host = requiredHostIdentity();
  const files = requiredPrincipalFiles();
  const proofPath = options.proofPath;
  if (!proofPath) throw new Error("isolated Codex principal proof path is required");
  for (const name of ["HOME", "TMPDIR", "CODEX_HOME"] as const) {
    const directory = childEnv[name];
    if (!directory) throw new Error(`isolated Codex ${name} is required`);
    const metadata = lstatSync(directory);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== principal.uid ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error(`isolated Codex ${name} is not a secure principal-owned directory`);
    }
  }
  proveIsolatedPrincipalRuntime({
    identity: principal,
    proofPath,
    cwd: process.cwd(),
    env: childEnv,
    ...(options.setprivPath ? { setprivPath: options.setprivPath } : {}),
  });
  handOffExactFilesToPrincipal({ files, hostUid: host.uid, principal });
}

function cleanupIsolatedPrincipal(): Error | undefined {
  if (!options.isolatedPrincipal) return undefined;
  try {
    terminateAndProvePrincipalEmpty(options.isolatedPrincipal.uid);
    const host = requiredHostIdentity();
    reclaimExactPrincipalFiles({
      files: requiredPrincipalFiles(),
      hostUid: host.uid,
      hostGid: host.gid,
      principal: options.isolatedPrincipal,
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function requiredHostIdentity(): IsolatedPrincipalIdentity {
  if (!options.hostIdentity) throw new Error("isolated Codex host identity is required");
  return options.hostIdentity;
}

function requiredPrincipalFiles(): PrincipalWritableFile[] {
  if (!options.principalFiles?.length) {
    throw new Error("isolated Codex exact output file is required");
  }
  return options.principalFiles;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    if (terminating) return;
    terminating = true;
    process.stdin.unpipe(child.stdin);
    child.stdin.end();
    forceKillTimer = terminateCodexProcessTree(child, signal);
  });
}

function serializedError(
  error: Error,
  redactValues: readonly string[],
): {
  message: string;
  code?: string;
} {
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return {
    message: redactCodexText(error.message, redactValues),
    ...(typeof code === "string" ? { code } : {}),
  };
}

async function readWorkerInput(): Promise<{ prompt: string; redactValues: string[] }> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    input?: unknown;
    redactValues?: unknown;
  };
  return {
    prompt: typeof value.input === "string" ? value.input : "",
    redactValues: Array.isArray(value.redactValues)
      ? value.redactValues.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}
