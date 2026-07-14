import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveSpawnCommand } from "../command.js";
import type { ParsedJob } from "./lib.js";
import { parseSimpleYaml, repoRoot, validateJob } from "./lib.js";

const IMMUTABLE_JOB_PATH = /^jobs\/[A-Za-z0-9_.-]+\/inbox\/[A-Za-z0-9_.-]+\.md$/;
const STATE_REVISION = /^[a-f0-9]{40}$/;
const JOB_SHA256 = /^[a-f0-9]{64}$/;

export type ImmutableJobIdentity = {
  jobPath: string;
  stateRevision: string;
  jobSha256: string;
  identityKey: string;
  job: ParsedJob;
};

export function resolveCurrentStateJobIdentity(
  jobPath: unknown,
  options: { stateRoot?: string } = {},
): ImmutableJobIdentity {
  const stateRoot = resolveStateRoot(options.stateRoot);
  const stateRevision = gitText(stateRoot, ["rev-parse", "--verify", "HEAD^{commit}"], {
    failure: "cannot resolve current clawsweeper-state revision",
  });
  return resolveStateJobIdentity({ jobPath, stateRevision, stateRoot });
}

export function resolveStateJobIdentity({
  jobPath,
  stateRevision,
  jobSha256,
  stateRoot: requestedStateRoot,
}: {
  jobPath: unknown;
  stateRevision: unknown;
  jobSha256?: unknown;
  stateRoot?: string;
}): ImmutableJobIdentity {
  const normalizedJobPath = immutableJobPath(jobPath);
  const normalizedRevision = immutableHex(stateRevision, "state revision", STATE_REVISION);
  const expectedJobSha256 =
    jobSha256 === undefined || jobSha256 === null || jobSha256 === ""
      ? null
      : immutableHex(jobSha256, "job SHA-256", JOB_SHA256);
  const stateRoot = resolveStateRoot(requestedStateRoot);

  gitText(stateRoot, ["cat-file", "-e", `${normalizedRevision}^{commit}`], {
    failure: `missing historical clawsweeper-state commit ${normalizedRevision}`,
  });
  const objectType = gitText(
    stateRoot,
    ["cat-file", "-t", `${normalizedRevision}:${normalizedJobPath}`],
    {
      failure: `immutable job is missing at ${normalizedRevision}:${normalizedJobPath}`,
    },
  );
  if (objectType !== "blob") {
    throw new Error(`immutable job is not a file at ${normalizedRevision}:${normalizedJobPath}`);
  }
  const bytes = gitBytes(
    stateRoot,
    ["cat-file", "blob", `${normalizedRevision}:${normalizedJobPath}`],
    `cannot read immutable job at ${normalizedRevision}:${normalizedJobPath}`,
  );
  const actualJobSha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedJobSha256 && actualJobSha256 !== expectedJobSha256) {
    throw new Error(
      `immutable job SHA-256 mismatch for ${normalizedJobPath}: expected ${expectedJobSha256}, got ${actualJobSha256}`,
    );
  }

  const job = parseImmutableJob(normalizedJobPath, bytes);
  const errors = validateJob(job);
  if (errors.length > 0) {
    throw new Error(`invalid immutable job ${normalizedJobPath}: ${errors.join("; ")}`);
  }
  return {
    jobPath: normalizedJobPath,
    stateRevision: normalizedRevision,
    jobSha256: actualJobSha256,
    identityKey: immutableJobIdentityKey({
      jobPath: normalizedJobPath,
      stateRevision: normalizedRevision,
      jobSha256: actualJobSha256,
    }),
    job,
  };
}

export function immutableJobDispatchArgs(
  identity: Pick<ImmutableJobIdentity, "stateRevision" | "jobSha256">,
): string[] {
  return [
    "-f",
    "payload_version=2",
    "-f",
    `state_revision=${identity.stateRevision}`,
    "-f",
    `job_sha256=${identity.jobSha256}`,
  ];
}

export function immutableJobIdentityKey({
  jobPath,
  stateRevision,
  jobSha256,
}: {
  jobPath: unknown;
  stateRevision: unknown;
  jobSha256: unknown;
}): string {
  return [
    immutableJobPath(jobPath),
    immutableHex(stateRevision, "state revision", STATE_REVISION),
    immutableHex(jobSha256, "job SHA-256", JOB_SHA256),
  ].join(":");
}

export function isMissingImmutableJobError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /^immutable job is missing at [a-f0-9]{40}:jobs\/[A-Za-z0-9_.-]+\/inbox\/[A-Za-z0-9_.-]+\.md(?:\s|:|$)/.test(
    detail,
  );
}

function parseImmutableJob(jobPath: string, bytes: Buffer): ParsedJob {
  const raw = bytes.toString("utf8");
  if (!Buffer.from(raw, "utf8").equals(bytes)) {
    throw new Error(`immutable job is not valid UTF-8: ${jobPath}`);
  }
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`missing YAML frontmatter: ${jobPath}`);
  return {
    path: path.join(repoRoot(), jobPath),
    relativePath: jobPath,
    frontmatter: parseSimpleYaml(match[1] ?? "") as ParsedJob["frontmatter"],
    body: (match[2] ?? "").trim(),
    raw,
  };
}

function immutableJobPath(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .replaceAll("\\", "/");
  if (!IMMUTABLE_JOB_PATH.test(normalized) || path.posix.normalize(normalized) !== normalized) {
    throw new Error("immutable job path must match jobs/<owner>/inbox/<job>.md without traversal");
  }
  return normalized;
}

function immutableHex(value: unknown, label: string, pattern: RegExp): string {
  const normalized = String(value ?? "").trim();
  if (!pattern.test(normalized)) {
    throw new Error(`${label} is malformed`);
  }
  return normalized;
}

function resolveStateRoot(requested: string | undefined): string {
  const configured = String(requested ?? process.env.CLAWSWEEPER_STATE_DIR ?? "").trim();
  if (!configured) {
    throw new Error("CLAWSWEEPER_STATE_DIR is required for immutable job handoff");
  }
  const root = fs.realpathSync(path.resolve(configured));
  const topLevel = gitText(root, ["rev-parse", "--show-toplevel"], {
    failure: `CLAWSWEEPER_STATE_DIR is not a git worktree: ${root}`,
  });
  if (fs.realpathSync(path.resolve(topLevel)) !== root) {
    throw new Error(`CLAWSWEEPER_STATE_DIR must point at the state repository root: ${root}`);
  }
  return root;
}

function gitText(root: string, args: string[], { failure }: { failure: string }): string {
  return gitBytes(root, args, failure).toString("utf8").trim();
}

function gitBytes(root: string, args: string[], failure: string): Buffer {
  const commandArgs = ["-C", root, ...args];
  const invocation = resolveSpawnCommand("git", commandArgs, {
    cwd: root,
    env: process.env,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  if (result.status !== 0 || result.error) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : String(result.stderr ?? result.error?.message ?? "").trim();
    throw new Error(detail ? `${failure}: ${detail}` : failure);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}
