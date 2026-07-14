#!/usr/bin/env node
import fs from "node:fs";

import { assertPrincipalRuntimeStatus } from "./trusted-principal.js";

const uid = parseIdentifier(process.argv[2], "UID");
const gid = parseIdentifier(process.argv[3], "GID");
if (process.getuid?.() !== uid || process.geteuid?.() !== uid) {
  throw new Error("dedicated principal process UID does not match the requested UID");
}
if (process.getgid?.() !== gid || process.getegid?.() !== gid) {
  throw new Error("dedicated principal process GID does not match the requested GID");
}
const status = fs.readFileSync("/proc/self/status", "utf8");
assertPrincipalRuntimeStatus(status, uid, gid);
console.log(
  `[clawsweeper] dedicated principal proof passed uid=${uid} gid=${gid} no_new_privs=1 capabilities=0`,
);

function parseIdentifier(raw: string | undefined, label: string) {
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`principal proof requires a numeric ${label}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`principal proof requires a positive non-root ${label}`);
  }
  return value;
}
