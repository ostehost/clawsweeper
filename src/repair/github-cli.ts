import type { JsonValue } from "./json-types.js";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { stripAnsi } from "./comment-router-utils.js";
import { ghCliEnv } from "./process-env.js";
import { repoRoot } from "./paths.js";
import { ghRetryKind, ghRetryWaitMs } from "../github-retry.js";
import { parseGhJsonWithRetry, parseGhJsonWithRetryAsync } from "../github-json.js";
import { resolveSpawnCommand } from "../command.js";

const execFileAsync = promisify(execFile);

export type GhRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
};

export type GhRetryOptions = GhRunOptions & {
  attempts?: number;
};

export type GhSpawnMutationOutcome = "accepted" | "rejected" | "unknown";

type GhSpawnResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stdout?: string | null;
  stderr?: string | null;
};

export function ghJson<T = JsonValue>(ghArgs: string[], options: GhRunOptions = {}): T {
  return JSON.parse(ghText(ghArgs, options) || "null") as T;
}

export function ghJsonWithRetry<T = JsonValue>(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): T {
  return parseGhJsonWithRetry<T>(() => ghTextWithRetry(ghArgs, options) || "null", ghArgs, {
    onRetry: (_error, attempt) => sleepMs(ghRetryWaitMs("transient", attempt - 1)),
  });
}

export async function ghJsonWithRetryAsync<T = JsonValue>(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): Promise<T> {
  return parseGhJsonWithRetryAsync<T>(
    async () => (await ghTextWithRetryAsync(ghArgs, options)) || "null",
    ghArgs,
    {
      onRetry: (_error, attempt) => sleepAsync(ghRetryWaitMs("transient", attempt - 1)),
    },
  );
}

export function ghJsonBestEffort<T = JsonValue>(
  ghArgs: string[],
  fallback: T,
  options: GhRunOptions = {},
): T {
  try {
    return ghJson<T>(ghArgs, options);
  } catch {
    return fallback;
  }
}

export function githubPaginatedPath(apiPath: string): string {
  return githubPathWithQueryDefaults(apiPath, { per_page: "100" });
}

export function githubLimitedPagePath(apiPath: string, limit: number, page = 1): string {
  const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const normalizedPage = Number.isFinite(page) ? Math.floor(page) : 1;
  const pageSize = Math.max(1, Math.min(100, normalizedLimit));
  const pageNumber = Math.max(1, normalizedPage);
  return githubPathWithQueryDefaults(
    apiPath,
    { per_page: String(pageSize), page: String(pageNumber) },
    { override: true },
  );
}

export function ghPaged<T = JsonValue>(apiPath: string, options: GhRunOptions = {}): T[] {
  const pages = ghJson<JsonValue[]>(
    ["api", githubPaginatedPath(apiPath), "--paginate", "--slurp"],
    options,
  );
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page: JsonValue) => (Array.isArray(page) ? (page as T[]) : []));
}

export function ghPagedWithRetry<T = JsonValue>(
  apiPath: string,
  options: GhRetryOptions | number = {},
): T[] {
  const pages = ghJsonWithRetry<JsonValue[]>(
    ["api", githubPaginatedPath(apiPath), "--paginate", "--slurp"],
    options,
  );
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page: JsonValue) => (Array.isArray(page) ? (page as T[]) : []));
}

export async function ghPagedWithRetryAsync<T = JsonValue>(
  apiPath: string,
  options: GhRetryOptions | number = {},
): Promise<T[]> {
  const pages = await ghJsonWithRetryAsync<JsonValue[]>(
    ["api", githubPaginatedPath(apiPath), "--paginate", "--slurp"],
    options,
  );
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((page: JsonValue) => (Array.isArray(page) ? (page as T[]) : []));
}

export function ghPagedLimit<T = JsonValue>(
  apiPath: string,
  limit: number,
  options: GhRunOptions = {},
): T[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (max <= 0) return [];

  const perPage = Math.min(100, max);
  const out: T[] = [];
  for (let page = 1; out.length < max; page += 1) {
    const entries = ghJson<JsonValue[]>(
      ["api", githubLimitedPagePath(apiPath, perPage, page)],
      options,
    );
    if (!Array.isArray(entries) || entries.length === 0) break;
    out.push(...(entries as T[]));
    if (entries.length < perPage) break;
  }
  return out.slice(0, max);
}

export function ghPagedLimitWithRetry<T = JsonValue>(
  apiPath: string,
  limit: number,
  options: GhRetryOptions | number = {},
): T[] {
  const resolved = resolveRetryOptions(options);
  const attempts = Math.max(1, resolved.attempts ?? 6);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return ghPagedLimit<T>(apiPath, limit, resolved);
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      if (attempt >= attempts || retryKind === "none") throw error;
      sleepMs(ghRetryWaitMs(retryKind, attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function ghText(ghArgs: string[], options: GhRunOptions = {}): string {
  const env = ghEnv(options.env);
  const cwd = options.cwd ?? repoRoot();
  const command = ghCommand(ghArgs, env, cwd);
  const text = execFileSync(command.command, command.args, {
    cwd,
    env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  return stripAnsi(text).trim();
}

export function ghTextWithRetry(ghArgs: string[], options: GhRetryOptions | number = {}): string {
  const resolved = resolveRetryOptions(options);
  const attempts = Math.max(1, resolved.attempts ?? 6);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return ghText(ghArgs, resolved);
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      if (attempt >= attempts || retryKind === "none") throw error;
      sleepMs(ghRetryWaitMs(retryKind, attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function ghTextWithRetryAsync(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): Promise<string> {
  const resolved = resolveRetryOptions(options);
  const attempts = Math.max(1, resolved.attempts ?? 6);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await ghTextAsync(ghArgs, resolved);
    } catch (error) {
      lastError = error;
      const retryKind = ghRetryKind(error);
      if (attempt >= attempts || retryKind === "none") throw error;
      await sleepAsync(ghRetryWaitMs(retryKind, attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function ghTextAsync(ghArgs: string[], options: GhRunOptions = {}): Promise<string> {
  if (options.input !== undefined) return ghText(ghArgs, options);
  const env = ghEnv(options.env);
  const cwd = options.cwd ?? repoRoot();
  const command = ghCommand(ghArgs, env, cwd);
  const { stdout } = await execFileAsync(command.command, command.args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  return stripAnsi(String(stdout)).trim();
}

export function ghBestEffort(ghArgs: string[], options: GhRunOptions = {}): void {
  try {
    ghText(ghArgs, options);
  } catch {
    // Helpful metadata should not block the primary command path.
  }
}

export function ghBestEffortWithRetry(
  ghArgs: string[],
  options: GhRetryOptions | number = {},
): string {
  try {
    return ghTextWithRetry(ghArgs, options);
  } catch {
    return "";
  }
}

export function ghSpawn(ghArgs: string[], options: GhRunOptions = {}) {
  const env = ghEnv(options.env);
  const cwd = options.cwd ?? repoRoot();
  const command = ghCommand(ghArgs, env, cwd);
  return spawnSync(command.command, command.args, {
    cwd,
    encoding: "utf8",
    env,
    input: options.input,
    stdio: "pipe",
    ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

export function ghSpawnMutationOutcome(result: GhSpawnResult): GhSpawnMutationOutcome {
  if (result.signal) return "unknown";
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return code && DEFINITE_PRE_SPAWN_ERROR_CODES.has(code) ? "rejected" : "unknown";
  }
  if (result.status === 0) return "accepted";
  if (result.status === null) return "unknown";
  const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  if (ghRetryKind(new Error(detail || `GitHub command exited ${result.status}`)) !== "none") {
    return "unknown";
  }
  return /\b(?:HTTP|status(?: code)?)\s*:?\s*4\d\d\b/i.test(detail) ? "rejected" : "unknown";
}

const DEFINITE_PRE_SPAWN_ERROR_CODES = new Set([
  "E2BIG",
  "EACCES",
  "EISDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

export function ghEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return ghCliEnv(overrides);
}

export function ghErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");
  const commandError = error as {
    message?: string;
    output?: unknown[];
    stderr?: Buffer | string;
    stdout?: Buffer | string;
  };
  const parts = [
    commandError.stderr,
    commandError.stdout,
    ...(Array.isArray(commandError.output) ? commandError.output : []),
    commandError.message,
  ].filter(Boolean);
  return stripAnsi(parts.map((part) => bufferLikeToString(part)).join("\n")).trim();
}

export function ghStdoutFromError(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const commandError = error as {
    output?: unknown[];
    stdout?: Buffer | string;
  };
  return stripAnsi(
    bufferLikeToString(commandError.stdout ?? commandError.output?.[1] ?? ""),
  ).trim();
}

function resolveRetryOptions(options: GhRetryOptions | number): GhRetryOptions {
  if (typeof options === "number") return { attempts: options };
  if (options.attempts !== undefined) return options;
  const configuredValue =
    options.env?.CLAWSWEEPER_GH_RETRY_ATTEMPTS ?? process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
  if (configuredValue == null || configuredValue.trim() === "") return options;
  const configuredAttempts = Number(configuredValue);
  if (!Number.isFinite(configuredAttempts)) return options;
  return { ...options, attempts: Math.max(1, Math.floor(configuredAttempts)) };
}

function ghCommand(ghArgs: readonly string[], env: NodeJS.ProcessEnv, cwd: string) {
  return resolveSpawnCommand("gh", ghArgs, { cwd, env });
}

function githubPathWithQueryDefaults(
  apiPath: string,
  defaults: Record<string, string>,
  { override = false }: { override?: boolean } = {},
): string {
  const [basePart, query = ""] = apiPath.split("?", 2);
  const base = basePart ?? apiPath;
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(defaults)) {
    if (override || !params.has(key)) params.set(key, value);
  }
  const serialized = params.toString();
  return serialized ? `${base}?${serialized}` : base;
}

function bufferLikeToString(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value ?? "");
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
