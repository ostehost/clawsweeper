#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { importActionEventShards, workflowActionProducer } from "../action-ledger-runtime.js";
import {
  finalizeCommandActionLedgerManifest,
  parseCommandActionLedgerManifest,
  serializeCommandActionLedgerManifest,
} from "./command-action-ledger-manifest.js";
import { repoRoot } from "./paths.js";
import { flushRepairActionEvents } from "./repair-action-ledger.js";
import {
  assertRepairActionLedgerManifestSource,
  finalizeRepairActionLedgerManifest,
  parseRepairActionLedgerManifest,
  serializeRepairActionLedgerManifest,
} from "./repair-action-ledger-manifest.js";

const rawArgv = process.argv.slice(2);
const [command, ...argv] = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
const args = parseArgs(argv);

if (command === "finalize") {
  if (args.lane) {
    const manifest = await finalizeCommandActionLedgerManifest(args.lane, {
      allowEmpty: args.allowEmpty === true,
    });
    if (manifest) process.stdout.write(serializeCommandActionLedgerManifest(manifest));
  } else if (args.repairLane) {
    const manifest = await finalizeRepairActionLedgerManifest(args.repairLane);
    process.stdout.write(serializeRepairActionLedgerManifest(manifest));
  } else {
    const paths = await flushRepairActionEvents();
    console.log(JSON.stringify({ paths }, null, 2));
  }
} else if (command === "verify" || command === "publish") {
  const sourceRoot = path.resolve(args.sourceRoot ?? actionLedgerOutputRoot());
  if (args.lane) {
    if (command === "verify") {
      throw new Error("command action ledger verification uses publish with its merged manifest");
    }
    const stateRoot = path.resolve(args.stateRoot ?? repoRoot());
    const lane = requiredArg(args.lane, "--lane");
    const manifestPath = path.resolve(requiredArg(args.manifest, "--manifest"));
    const manifest = parseCommandActionLedgerManifest(fs.readFileSync(manifestPath, "utf8"), lane);
    console.log(
      JSON.stringify(
        importActionEventShards(sourceRoot, stateRoot, {
          expectedProducer: {
            repository: manifest.repository,
            sha: manifest.sha,
            workflow: manifest.workflow,
            job: manifest.job,
            runId: manifest.run_id,
            runAttempt: manifest.run_attempt,
          },
          expectedEventPaths: manifest.event_paths,
        }),
        null,
        2,
      ),
    );
  } else if (args.repairLane) {
    const lane = requiredArg(args.repairLane, "--repair-lane");
    const manifestPath = path.resolve(requiredArg(args.manifest, "--manifest"));
    const current = workflowActionProducer("repair_manifest");
    const manifest = parseRepairActionLedgerManifest(fs.readFileSync(manifestPath, "utf8"), lane, {
      repository: current.repository,
      sha: current.sha,
      workflow: current.workflow,
      job: args.expectedJob ?? current.job,
      runId: current.runId,
      runAttempt: args.expectedRunAttempt ?? current.runAttempt,
    });
    assertRepairActionLedgerManifestSource(sourceRoot, manifest);
    if (command === "verify") {
      console.log(JSON.stringify({ eventPaths: manifest.event_paths }, null, 2));
    } else {
      const stateRoot = path.resolve(args.stateRoot ?? repoRoot());
      console.log(
        JSON.stringify(
          importActionEventShards(sourceRoot, stateRoot, {
            expectedProducer: {
              repository: manifest.repository,
              sha: manifest.sha,
              workflow: manifest.workflow,
              job: manifest.job,
              runId: manifest.run_id,
              runAttempt: manifest.run_attempt,
            },
            expectedEventPaths: manifest.event_paths,
          }),
          null,
          2,
        ),
      );
    }
  } else {
    throw new Error("repair action ledger publication requires --repair-lane and --manifest");
  }
} else {
  throw new Error(
    "usage: action-ledger-cli.ts <finalize|verify|publish> [--lane name --allow-empty | --repair-lane name] [--manifest path] [--expected-job job --expected-run-attempt attempt] [--source-root path --state-root path]",
  );
}

function actionLedgerOutputRoot(): string {
  return (
    process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim() ||
    path.join(repoRoot(), ".clawsweeper-repair", "action-ledger-state")
  );
}

function parseArgs(argv: readonly string[]) {
  const parsed: {
    lane?: string;
    allowEmpty?: boolean;
    repairLane?: string;
    manifest?: string;
    sourceRoot?: string;
    stateRoot?: string;
    expectedJob?: string;
    expectedRunAttempt?: number;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--lane") parsed.lane = requiredValue(argv, ++index, arg);
    else if (arg === "--repair-lane") parsed.repairLane = requiredValue(argv, ++index, arg);
    else if (arg === "--manifest") parsed.manifest = requiredValue(argv, ++index, arg);
    else if (arg === "--source-root") parsed.sourceRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--state-root") parsed.stateRoot = requiredValue(argv, ++index, arg);
    else if (arg === "--allow-empty") parsed.allowEmpty = true;
    else if (arg === "--expected-job") parsed.expectedJob = requiredValue(argv, ++index, arg);
    else if (arg === "--expected-run-attempt") {
      parsed.expectedRunAttempt = positiveInteger(requiredValue(argv, ++index, arg), arg);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.lane && parsed.repairLane) {
    throw new Error("--lane and --repair-lane are mutually exclusive");
  }
  return parsed;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function requiredArg(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}
