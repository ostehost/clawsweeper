#!/usr/bin/env node
import { runAsIsolatedPrincipalAndStage, type TrustedTransferFile } from "./trusted-principal.js";

type CliArgs = {
  principalUid?: number;
  principalGid?: number;
  stageOwnerUid?: number;
  stageOwnerGid?: number;
  cwd?: string;
  home?: string;
  tmpDir?: string;
  path?: string;
  sourceRoot?: string;
  stageRoot?: string;
  timeoutMs?: number;
  setprivPath?: string;
  allowEmptyTransfer: boolean;
  files: TrustedTransferFile[];
  passEnv: string[];
  command: string[];
};

const args = parseArgs(process.argv.slice(2));
const childEnv: Record<string, string> = {};
for (const name of args.passEnv) {
  const value = process.env[name];
  if (value === undefined) throw new Error(`--pass-env ${name} is not set`);
  childEnv[name] = value;
}

const staged = runAsIsolatedPrincipalAndStage({
  principalUid: requiredNumber(args.principalUid, "--principal-uid"),
  principalGid: requiredNumber(args.principalGid, "--principal-gid"),
  stageOwnerUid: requiredNumber(args.stageOwnerUid, "--stage-owner-uid"),
  stageOwnerGid: requiredNumber(args.stageOwnerGid, "--stage-owner-gid"),
  cwd: requiredString(args.cwd, "--cwd"),
  home: requiredString(args.home, "--home"),
  tmpDir: requiredString(args.tmpDir, "--tmp-dir"),
  path: requiredString(args.path, "--path"),
  sourceRoot: requiredString(args.sourceRoot, "--source-root"),
  stageRoot: requiredString(args.stageRoot, "--stage-root"),
  files: args.files,
  allowEmptyTransfer: args.allowEmptyTransfer,
  command: args.command[0]!,
  commandArgs: args.command.slice(1),
  childEnv,
  ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  ...(args.setprivPath === undefined ? {} : { setprivPath: args.setprivPath }),
});
console.log(JSON.stringify({ status: "staged", files: staged }));

function parseArgs(argv: readonly string[]): CliArgs {
  const parsed: CliArgs = {
    allowEmptyTransfer: false,
    files: [],
    passEnv: [],
    command: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      parsed.command = argv.slice(index + 1);
      break;
    }
    if (arg === "--principal-uid")
      parsed.principalUid = positiveInt(value(argv, ++index, arg), arg);
    else if (arg === "--principal-gid")
      parsed.principalGid = positiveInt(value(argv, ++index, arg), arg);
    else if (arg === "--stage-owner-uid")
      parsed.stageOwnerUid = positiveInt(value(argv, ++index, arg), arg);
    else if (arg === "--stage-owner-gid")
      parsed.stageOwnerGid = positiveInt(value(argv, ++index, arg), arg);
    else if (arg === "--cwd") parsed.cwd = value(argv, ++index, arg);
    else if (arg === "--home") parsed.home = value(argv, ++index, arg);
    else if (arg === "--tmp-dir") parsed.tmpDir = value(argv, ++index, arg);
    else if (arg === "--path") parsed.path = value(argv, ++index, arg);
    else if (arg === "--source-root") parsed.sourceRoot = value(argv, ++index, arg);
    else if (arg === "--stage-root") parsed.stageRoot = value(argv, ++index, arg);
    else if (arg === "--timeout-ms") parsed.timeoutMs = positiveInt(value(argv, ++index, arg), arg);
    else if (arg === "--setpriv") parsed.setprivPath = value(argv, ++index, arg);
    else if (arg === "--allow-empty-transfer") parsed.allowEmptyTransfer = true;
    else if (arg === "--file") parsed.files.push(parseFile(value(argv, ++index, arg)));
    else if (arg === "--pass-env") parsed.passEnv.push(value(argv, ++index, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.command.length === 0) throw new Error("an isolated command is required after --");
  return parsed;
}

function parseFile(raw: string): TrustedTransferFile {
  const separator = raw.lastIndexOf(":");
  if (separator <= 0) throw new Error("--file must use name:maxBytes syntax");
  const name = raw.slice(0, separator);
  const maxBytes = positiveInt(raw.slice(separator + 1), `--file ${name}`);
  return { name, maxBytes };
}

function value(argv: readonly string[], index: number, flag: string) {
  const result = argv[index];
  if (!result || result === "--") throw new Error(`${flag} requires a value`);
  return result;
}

function positiveInt(raw: string, flag: string) {
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} requires a positive integer`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return result;
}

function requiredNumber(result: number | undefined, flag: string) {
  if (result === undefined) throw new Error(`${flag} is required`);
  return result;
}

function requiredString(result: string | undefined, flag: string) {
  if (!result) throw new Error(`${flag} is required`);
  return result;
}
