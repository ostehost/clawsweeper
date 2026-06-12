#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib.js";
import { clawsweeperGitUserEmail, clawsweeperGitUserName } from "./process-env.js";

export type ProviderLease = {
  id: string;
  owner: string;
  lane: string;
  item: string;
  runId: string;
  weight: number;
  acquiredAt: string;
  expiresAt: string;
};

export type ProviderLeaseDocument = {
  provider: string;
  capacity: number;
  updatedAt: string;
  leases: ProviderLease[];
};

export type ProviderLeaseAcquireResult = {
  acquired: boolean;
  activeWeight: number;
  capacity: number;
  lease?: ProviderLease;
  reason?: string;
};

type AcquireOptions = {
  stateDir: string;
  provider: string;
  leaseId: string;
  owner: string;
  lane: string;
  item: string;
  runId: string;
  capacity: number;
  weight: number;
  ttlMs: number;
  waitMs: number;
  pollMs: number;
  now?: Date;
};

type ReleaseOptions = {
  stateDir: string;
  provider: string;
  leaseId: string;
  capacity: number;
};

type RenewOptions = ReleaseOptions & {
  ttlMs: number;
};

type GitRunOptions = {
  allowFailure?: boolean;
};

const DEFAULT_PROVIDER = "codex-internal-default";
const DEFAULT_CAPACITY = 4;
const DEFAULT_WEIGHT = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;

const args = parseArgs(process.argv.slice(2));

export function providerLeasePath(stateDir: string, provider: string): string {
  return resolve(stateDir, "provider-leases", `${safeProviderName(provider)}.json`);
}

export function safeProviderName(provider: string): string {
  return provider.trim().replace(/[^A-Za-z0-9_.-]/g, "-") || DEFAULT_PROVIDER;
}

export function readProviderLeaseDocument(
  stateDir: string,
  provider: string,
  capacity = DEFAULT_CAPACITY,
  now = new Date(),
): ProviderLeaseDocument {
  const file = providerLeasePath(stateDir, provider);
  if (!existsSync(file)) {
    return { provider, capacity, updatedAt: now.toISOString(), leases: [] };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    return { provider, capacity, updatedAt: now.toISOString(), leases: [] };
  }
  return normalizeProviderLeaseDocument(parsed, provider, capacity, now);
}

export function normalizeProviderLeaseDocument(
  value: Record<string, unknown>,
  provider: string,
  fallbackCapacity = DEFAULT_CAPACITY,
  now = new Date(),
): ProviderLeaseDocument {
  const capacity = positiveInteger(fallbackCapacity, DEFAULT_CAPACITY);
  const leases = Array.isArray(value.leases)
    ? value.leases.flatMap((lease) => normalizeProviderLease(lease))
    : [];
  return {
    provider:
      typeof value.provider === "string" && value.provider.trim() ? value.provider : provider,
    capacity,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt
        : now.toISOString(),
    leases,
  };
}

export function pruneExpiredLeases(
  document: ProviderLeaseDocument,
  now = new Date(),
): ProviderLeaseDocument {
  const nowMs = now.getTime();
  return {
    ...document,
    leases: document.leases.filter((lease) => Date.parse(lease.expiresAt) > nowMs),
  };
}

export function tryAcquireProviderLease(
  document: ProviderLeaseDocument,
  options: {
    leaseId: string;
    owner: string;
    lane: string;
    item: string;
    runId: string;
    weight: number;
    ttlMs: number;
    now?: Date;
  },
): { document: ProviderLeaseDocument; result: ProviderLeaseAcquireResult } {
  const now = options.now ?? new Date();
  const pruned = pruneExpiredLeases(document, now);
  const capacity = Math.max(1, Math.floor(pruned.capacity));
  const weight = Math.max(1, Math.floor(options.weight));
  const existing = pruned.leases.find((lease) => lease.id === options.leaseId);
  const activeWeight = pruned.leases.reduce((sum, lease) => sum + Math.max(1, lease.weight), 0);
  const expiresAt = new Date(now.getTime() + options.ttlMs).toISOString();

  if (existing) {
    const lease = { ...existing, expiresAt };
    const leases = pruned.leases.map((entry) => (entry.id === lease.id ? lease : entry));
    return {
      document: { ...pruned, updatedAt: now.toISOString(), leases },
      result: { acquired: true, activeWeight, capacity, lease },
    };
  }

  if (activeWeight + weight > capacity) {
    return {
      document: { ...pruned, updatedAt: now.toISOString() },
      result: {
        acquired: false,
        activeWeight,
        capacity,
        reason: `provider capacity full: active weight ${activeWeight}/${capacity}, requested ${weight}`,
      },
    };
  }

  const lease: ProviderLease = {
    id: options.leaseId,
    owner: options.owner,
    lane: options.lane,
    item: options.item,
    runId: options.runId,
    weight,
    acquiredAt: now.toISOString(),
    expiresAt,
  };
  return {
    document: { ...pruned, updatedAt: now.toISOString(), leases: [...pruned.leases, lease] },
    result: { acquired: true, activeWeight: activeWeight + weight, capacity, lease },
  };
}

export function releaseProviderLeaseDocument(
  document: ProviderLeaseDocument,
  leaseId: string,
  now = new Date(),
): { document: ProviderLeaseDocument; released: boolean } {
  const pruned = pruneExpiredLeases(document, now);
  const leases = pruned.leases.filter((lease) => lease.id !== leaseId);
  return {
    document: { ...pruned, updatedAt: now.toISOString(), leases },
    released: leases.length !== pruned.leases.length,
  };
}

export function renewProviderLeaseDocument(
  document: ProviderLeaseDocument,
  leaseId: string,
  ttlMs: number,
  now = new Date(),
): { document: ProviderLeaseDocument; renewed: boolean; lease?: ProviderLease } {
  const pruned = pruneExpiredLeases(document, now);
  const current = pruned.leases.find((lease) => lease.id === leaseId);
  if (!current) {
    return { document: { ...pruned, updatedAt: now.toISOString() }, renewed: false };
  }
  const lease = { ...current, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
  return {
    document: {
      ...pruned,
      updatedAt: now.toISOString(),
      leases: pruned.leases.map((entry) => (entry.id === lease.id ? lease : entry)),
    },
    renewed: true,
    lease,
  };
}

export function writeProviderLeaseDocument(
  stateDir: string,
  document: ProviderLeaseDocument,
): void {
  const file = providerLeasePath(stateDir, document.provider);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

export function acquireProviderLease(options: AcquireOptions): ProviderLeaseAcquireResult {
  const deadline = Date.now() + Math.max(0, options.waitMs);
  configureStateGit(options.stateDir);

  for (;;) {
    syncStateBranch(options.stateDir);
    const now = new Date();
    const current = readProviderLeaseDocument(
      options.stateDir,
      options.provider,
      options.capacity,
      now,
    );
    const { document, result } = tryAcquireProviderLease(current, { ...options, now });
    writeProviderLeaseDocument(options.stateDir, document);
    if (result.acquired && commitAndPushState(options.stateDir, "chore: acquire provider lease")) {
      return result;
    }
    resetStateBranch(options.stateDir);
    if (Date.now() >= deadline) {
      if (result.acquired) {
        throw new Error(
          "failed to acquire provider lease: shared state push failed before accepting the lease",
        );
      }
      return result;
    }
    sleep(jitter(options.pollMs));
  }
}

export function releaseProviderLease(options: ReleaseOptions): boolean {
  configureStateGit(options.stateDir);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    syncStateBranch(options.stateDir);
    const current = readProviderLeaseDocument(options.stateDir, options.provider, options.capacity);
    const { document, released } = releaseProviderLeaseDocument(current, options.leaseId);
    writeProviderLeaseDocument(options.stateDir, document);
    if (!released) return false;
    if (commitAndPushState(options.stateDir, "chore: release provider lease")) return true;
    sleep(jitter(1000 * attempt));
  }
  throw new Error(`failed to release provider lease ${options.leaseId}`);
}

export function renewProviderLease(options: RenewOptions): boolean {
  configureStateGit(options.stateDir);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    syncStateBranch(options.stateDir);
    const current = readProviderLeaseDocument(options.stateDir, options.provider, options.capacity);
    const { document, renewed } = renewProviderLeaseDocument(
      current,
      options.leaseId,
      options.ttlMs,
    );
    writeProviderLeaseDocument(options.stateDir, document);
    if (commitAndPushState(options.stateDir, "chore: renew provider lease")) return renewed;
    resetStateBranch(options.stateDir);
    sleep(jitter(1000 * attempt));
  }
  throw new Error(`failed to renew provider lease ${options.leaseId}`);
}

function runCli(): void {
  const command = String(args._[0] ?? "");
  if (command === "acquire") {
    const result = acquireProviderLease(acquireOptionsFromArgs());
    printGithubOutput("acquired", result.acquired ? "true" : "false");
    printGithubOutput("active_weight", String(result.activeWeight));
    printGithubOutput("capacity", String(result.capacity));
    printGithubOutput("reason", result.reason ?? "");
    printGithubOutput("lease_id", stringArg("lease-id", defaultLeaseId()));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "release") {
    const released = releaseProviderLease(releaseOptionsFromArgs());
    printGithubOutput("released", released ? "true" : "false");
    console.log(JSON.stringify({ released }, null, 2));
    return;
  }
  if (command === "renew") {
    const renewed = renewProviderLease(renewOptionsFromArgs());
    printGithubOutput("renewed", renewed ? "true" : "false");
    console.log(JSON.stringify({ renewed }, null, 2));
    if (!renewed) process.exitCode = 1;
    return;
  }
  throw new Error("usage: provider-lease <acquire|renew|release> --state-dir DIR [options]");
}

function acquireOptionsFromArgs(): AcquireOptions {
  return {
    stateDir: requiredString("state-dir"),
    provider: stringArg("provider", DEFAULT_PROVIDER),
    leaseId: stringArg("lease-id", defaultLeaseId()),
    owner: stringArg("owner", "clawsweeper"),
    lane: stringArg("lane", "review"),
    item: stringArg("item", ""),
    runId: stringArg("run-id", process.env.GITHUB_RUN_ID ?? ""),
    capacity: numberArg(
      "capacity",
      envNumber("CLAWSWEEPER_PROVIDER_LEASE_CAPACITY", DEFAULT_CAPACITY),
    ),
    weight: numberArg("weight", DEFAULT_WEIGHT),
    ttlMs: numberArg("ttl-seconds", DEFAULT_TTL_MS / 1000) * 1000,
    waitMs: numberArg("wait-seconds", DEFAULT_WAIT_MS / 1000) * 1000,
    pollMs: numberArg("poll-seconds", DEFAULT_POLL_MS / 1000) * 1000,
  };
}

function releaseOptionsFromArgs(): ReleaseOptions {
  return {
    stateDir: requiredString("state-dir"),
    provider: stringArg("provider", DEFAULT_PROVIDER),
    leaseId: stringArg("lease-id", defaultLeaseId()),
    capacity: numberArg(
      "capacity",
      envNumber("CLAWSWEEPER_PROVIDER_LEASE_CAPACITY", DEFAULT_CAPACITY),
    ),
  };
}

function renewOptionsFromArgs(): RenewOptions {
  return {
    ...releaseOptionsFromArgs(),
    ttlMs: numberArg("ttl-seconds", DEFAULT_TTL_MS / 1000) * 1000,
  };
}

function commitAndPushState(stateDir: string, message: string): boolean {
  runGit(stateDir, ["add", "-A", "--", "provider-leases"]);
  if (runGit(stateDir, ["diff", "--cached", "--quiet"], { allowFailure: true }).status === 0) {
    return true;
  }
  runGit(stateDir, ["commit", "-m", `${message}\n\n[skip ci]`]);
  return runGit(stateDir, ["push", "origin", "HEAD:state"], { allowFailure: true }).status === 0;
}

function configureStateGit(stateDir: string): void {
  runGit(stateDir, ["config", "user.name", clawsweeperGitUserName()]);
  runGit(stateDir, ["config", "user.email", clawsweeperGitUserEmail()]);
}

function syncStateBranch(stateDir: string): void {
  runGit(stateDir, ["fetch", "origin", "state"]);
  runGit(stateDir, ["checkout", "-B", "state", "origin/state"]);
}

function resetStateBranch(stateDir: string): void {
  runGit(stateDir, ["reset", "--hard", "origin/state"]);
}

function runGit(stateDir: string, gitArgs: readonly string[], options: GitRunOptions = {}) {
  const child = spawnSync("git", gitArgs, {
    cwd: stateDir,
    env: process.env,
    encoding: "utf8",
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  const status = child.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    throw new Error((child.stderr || child.stdout || `git ${gitArgs[0]} failed`).trim());
  }
  return { status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function normalizeProviderLease(value: unknown): ProviderLease[] {
  if (!isRecord(value)) return [];
  const id = stringValue(value.id);
  if (!id) return [];
  return [
    {
      id,
      owner: stringValue(value.owner) || "unknown",
      lane: stringValue(value.lane) || "unknown",
      item: stringValue(value.item),
      runId: stringValue(value.runId),
      weight: positiveInteger(value.weight, DEFAULT_WEIGHT),
      acquiredAt: stringValue(value.acquiredAt) || new Date(0).toISOString(),
      expiresAt: stringValue(value.expiresAt) || new Date(0).toISOString(),
    },
  ];
}

function requiredString(name: string): string {
  const value = stringArg(name, "");
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function stringArg(name: string, fallback: string): string {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberArg(name: string, fallback: number): number {
  const value = args[name];
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultLeaseId(): string {
  return [
    process.env.GITHUB_RUN_ID,
    process.env.GITHUB_RUN_ATTEMPT,
    process.env.GITHUB_JOB,
    stringArg("item", ""),
  ]
    .filter(Boolean)
    .join("-");
}

function printGithubOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  writeFileSync(output, `${name}=${value}\n`, { flag: "a" });
}

function jitter(ms: number): number {
  const base = Math.max(250, ms);
  const spread = Math.floor(base * 0.3);
  return base + Math.floor(Math.random() * Math.max(1, spread));
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
