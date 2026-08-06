#!/usr/bin/env node

/**
 * Operator-only live proof wrapper. It creates one caller-owned Linear fixture,
 * runs the production query-only proof with a separate credential, and trashes
 * exactly that returned fixture in finally. It is never part of normal CI.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  buildLinearLiveBuildEnv,
  scrubLinearCredentialEnvironment,
} from "./linear-live-fixture.mjs";

const LINEAR_LIVE_E2E_SCENARIO = "ephemeral-readonly";
const LINEAR_LIVE_FIXTURE_CONTRACT = "readonly-issue-v1";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`Usage:
  pnpm e2e:linear:live -- --team-id <uuid> --fixture-alias <alias> [options]

Description:
  Creates one ephemeral issue in the explicitly selected caller-owned team,
  proves the production proposal-only read path with a separate read key, then
  trashes exactly that issue and verifies it is absent from the active workspace.

Required environment:
  LINEAR_E2E_SETUP_API_KEY  Team-scoped Create issues + Write/Delete key
  LINEAR_E2E_READ_API_KEY   Distinct team-scoped Read key

Options:
  --team-id <uuid>         Explicit caller-owned Linear team UUID (required)
  --fixture-alias <alias>  Public-safe receipt alias (required)
  --scenario <name>        ${LINEAR_LIVE_E2E_SCENARIO} (default)
  --fixture <name>         ${LINEAR_LIVE_FIXTURE_CONTRACT} (default)
  --base-tip <ref>         Current base tip (default: upstream/main)
  --output <dir>           Ignored artifact root (default: test-results/linear-live)
  -h, --help               Show this help

The command never accepts credentials on argv. SIGKILL, process crash, or network
loss may leave a fixture requiring recovery from <output>/private/recovery.json.
Linear trash is recoverable for 30 days; cleanup is not permanent erasure.
`);
  process.exit(0);
}

try {
  const setupToken = process.env.LINEAR_E2E_SETUP_API_KEY;
  const readToken = process.env.LINEAR_E2E_READ_API_KEY;
  scrubLinearCredentialEnvironment(process.env);
  runBuildWithSafeEnvironment(process.cwd());
  const { installLinearLiveSignalCleanup, runLinearLiveE2E } =
    await import("../../test/e2e/linear-live/run.mjs");
  installLinearLiveSignalCleanup();
  const result = await runLinearLiveE2E({
    scenario: String(args.scenario ?? LINEAR_LIVE_E2E_SCENARIO),
    fixture: String(args.fixture ?? LINEAR_LIVE_FIXTURE_CONTRACT),
    teamId: String(args.teamId ?? ""),
    fixtureAlias: String(args.fixtureAlias ?? ""),
    baseTip: String(args.baseTip ?? "upstream/main"),
    candidateRoot: process.cwd(),
    outputRoot: path.resolve(
      String(args.output ?? path.join(process.cwd(), "test-results", "linear-live")),
    ),
    setupToken,
    readToken,
    parentEnv: process.env,
  });
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      artifactSha256: result.summary.combinedArtifactSha256,
      receiptFileSha256: result.summaryFileSha256,
    })}\n`,
  );
} catch {
  process.stderr.write("Linear live E2E failed without exposing provider or fixture data\n");
  process.exitCode = 1;
}

function runBuildWithSafeEnvironment(candidateRoot) {
  const child = spawnSync("pnpm", ["run", "build"], {
    cwd: candidateRoot,
    env: buildLinearLiveBuildEnv(process.env),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) throw new Error("credential-free build failed");
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--team-id") out.teamId = requiredValue(argv, ++index, arg);
    else if (arg === "--fixture-alias") out.fixtureAlias = requiredValue(argv, ++index, arg);
    else if (arg === "--scenario") out.scenario = requiredValue(argv, ++index, arg);
    else if (arg === "--fixture") out.fixture = requiredValue(argv, ++index, arg);
    else if (arg === "--base-tip") out.baseTip = requiredValue(argv, ++index, arg);
    else if (arg === "--output") out.output = requiredValue(argv, ++index, arg);
    else throw new Error(`unknown option: ${arg}; use --help for usage`);
  }
  return out;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
