#!/usr/bin/env node
import {
  assertIsolatedPrincipalIdentity,
  terminateAndProvePrincipalEmpty,
} from "./trusted-principal-runtime.js";

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  throw new Error("principal drain must run as root on Linux");
}
const uid = requiredId(process.argv[2], "UID");
const gid = requiredId(process.argv[3], "GID");
assertIsolatedPrincipalIdentity({ uid, gid });
terminateAndProvePrincipalEmpty(uid);
console.log(`Dedicated Codex principal ${uid}:${gid} is empty.`);

function requiredId(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`principal drain ${label} is required`);
  return Number(value);
}
