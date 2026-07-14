#!/usr/bin/env node
import {
  assertIsolatedPrincipalIdentity,
  reclaimExactPrincipalFiles,
  terminateAndProvePrincipalEmpty,
  type PrincipalWritableFile,
} from "./trusted-principal-runtime.js";

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("principal cleanup must run as root on Linux");
}
const parsed = parseArgs(process.argv.slice(2));
const principal = { uid: parsed.uid, gid: parsed.gid };
assertIsolatedPrincipalIdentity(principal);
terminateAndProvePrincipalEmpty(principal.uid);
reclaimExactPrincipalFiles({
  files: parsed.files,
  hostUid: parsed.hostUid,
  hostGid: parsed.hostGid,
  principal,
});

function parseArgs(argv: readonly string[]): {
  uid: number;
  gid: number;
  hostUid: number;
  hostGid: number;
  files: PrincipalWritableFile[];
} {
  const values = new Map<string, string>();
  const files: PrincipalWritableFile[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[++index];
    if (!arg || !value) throw new Error("principal cleanup arguments must be flag/value pairs");
    if (arg === "--file") {
      const separator = value.lastIndexOf(":");
      if (separator <= 0) throw new Error("--file must use absolute-path:maxBytes syntax");
      files.push({
        path: value.slice(0, separator),
        maxBytes: positiveInt(value.slice(separator + 1)),
      });
    } else {
      values.set(arg, value);
    }
  }
  if (files.length === 0) throw new Error("principal cleanup requires at least one --file");
  return {
    uid: positiveInt(values.get("--uid")),
    gid: positiveInt(values.get("--gid")),
    hostUid: nonnegativeInt(values.get("--host-uid")),
    hostGid: nonnegativeInt(values.get("--host-gid")),
    files,
  };
}

function positiveInt(value: string | undefined): number {
  const parsed = nonnegativeInt(value);
  if (parsed === 0) throw new Error("principal cleanup IDs and sizes must be positive");
  return parsed;
}

function nonnegativeInt(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error("principal cleanup requires numeric values");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("principal cleanup value is out of range");
  return parsed;
}
