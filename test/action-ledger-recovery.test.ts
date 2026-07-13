import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { readMutationRecoveries } from "../dist/action-ledger-recovery.js";

test("mutation recovery readers preserve a live writer staging file", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-concurrency-")),
  );
  const readyPath = path.join(root, "writer-ready");
  const releasePath = path.join(root, "writer-release");
  const key = "a".repeat(64);
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "action-ledger-recovery.js"),
  ).href;
  const script = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [root, readyPath, releasePath, key] = process.argv.slice(1);
const originalRenameSync = fs.renameSync;
fs.renameSync = (source, destination) => {
  fs.writeFileSync(readyPath, "ready\\n");
  while (!fs.existsSync(releasePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  return originalRenameSync(source, destination);
};
syncBuiltinESMExports();
const { writeMutationRecovery } = await import(${JSON.stringify(moduleUrl)});
writeMutationRecovery(root, "repair", key, { state: "pending" });
`;
  const writer = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, root, readyPath, releasePath, key],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const writerDone = childResult(writer);

  try {
    await waitForPath(readyPath);
    assert.deepEqual(readMutationRecoveries(root, "repair"), []);
    const recoveryDirectory = path.join(root, ".mutation-recovery", "repair");
    assert.equal(
      fs.readdirSync(recoveryDirectory).filter((entry) => entry.endsWith(".tmp")).length,
      1,
    );

    fs.writeFileSync(releasePath, "release\n");
    const result = await writerDone;
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const [recovery] = readMutationRecoveries<{ state: string }>(root, "repair");
    assert.equal(recovery?.key, key);
    assert.deepEqual(recovery?.payload, { state: "pending" });
  } finally {
    if (!fs.existsSync(releasePath)) fs.writeFileSync(releasePath, "release\n");
    await writerDone;
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("mutation recovery readers remove only provably stale staging files", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-recovery-stale-")),
  );
  const directory = path.join(root, ".mutation-recovery", "repair");
  fs.mkdirSync(directory, { recursive: true });
  const key = "b".repeat(64);
  const stale = path.join(
    directory,
    `.${key}.2147483647.${"0".repeat(64)}.1.00000000-0000-4000-8000-000000000000.tmp`,
  );
  const malformed = path.join(directory, `.${key}.${process.pid}.1.tmp`);
  fs.writeFileSync(stale, "stale\n");
  fs.writeFileSync(malformed, "unknown-owner\n");

  try {
    assert.throws(() => readMutationRecoveries(root, "repair"), /invalid mutation recovery entry/);
    assert.equal(fs.existsSync(malformed), true);
    fs.rmSync(malformed);
    assert.deepEqual(readMutationRecoveries(root, "repair"), []);
    assert.equal(fs.existsSync(stale), false);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

async function waitForPath(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function childResult(
  child: ChildProcess,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}
