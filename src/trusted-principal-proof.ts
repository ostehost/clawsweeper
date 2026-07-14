#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { assertPrincipalRuntimeStatus } from "./trusted-principal-runtime.js";

const uid = requiredId(process.argv[2], "UID");
const gid = requiredId(process.argv[3], "GID");
assertPrincipalRuntimeStatus(readFileSync("/proc/self/status", "utf8"), uid, gid);

function requiredId(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`principal proof ${label} is required`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`principal proof ${label} must be a positive non-root identifier`);
  }
  return parsed;
}
