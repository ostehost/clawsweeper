import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPrincipalRuntimeStatus,
  parseProcStatusUids,
  principalProcessIds,
  setprivArguments,
  stageExactPrincipalFiles,
  strictPrincipalEnvironment,
  terminateAndProvePrincipalEmpty,
} from "./trusted-principal.js";

test("setpriv invocation drops identity, groups, capabilities, and future privilege gains", () => {
  assert.deepEqual(
    setprivArguments({
      principalUid: 42001,
      principalGid: 42001,
      command: "/usr/bin/node",
      commandArgs: ["worker.js"],
    }),
    [
      "--reuid=42001",
      "--regid=42001",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      "--pdeathsig=KILL",
      "--",
      "/usr/bin/node",
      "worker.js",
    ],
  );
});

test("strict principal environment excludes workflow channels and loader injection", () => {
  const env = strictPrincipalEnvironment({
    home: "/tmp/principal-home",
    tmpDir: "/tmp/principal-tmp",
    path: "/usr/bin:/bin",
    childEnv: { GH_TOKEN: "read-only", CLAWSWEEPER_ALLOW_EXECUTE: "1" },
  });
  assert.deepEqual(env, {
    CI: "true",
    HOME: "/tmp/principal-home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: "clawsweeper-untrusted",
    PATH: "/usr/bin:/bin",
    SHELL: "/usr/sbin/nologin",
    TMPDIR: "/tmp/principal-tmp",
    USER: "clawsweeper-untrusted",
    GH_TOKEN: "read-only",
    CLAWSWEEPER_ALLOW_EXECUTE: "1",
  });
  for (const key of [
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_FUTURE_CREDENTIAL",
    "CLAWSWEEPER_CRABFLEET_AGENT_TOKEN",
    "LD_PRELOAD",
    "SUDO_COMMAND",
  ]) {
    assert.throws(
      () =>
        strictPrincipalEnvironment({
          home: "/tmp/home",
          tmpDir: "/tmp/tmp",
          path: "/usr/bin",
          childEnv: { [key]: "unsafe" },
        }),
      /unsafe isolated environment key/,
    );
  }
});

test("proc status parsing and enumeration match every saved UID slot", () => {
  assert.deepEqual(
    parseProcStatusUids("Name:\ttest\nUid:\t42001\t42001\t42001\t42001\n"),
    [42001, 42001, 42001, 42001],
  );
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-proc-"));
  test.after(() => fs.rmSync(procRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(procRoot, "12"));
  fs.writeFileSync(path.join(procRoot, "12", "status"), "Uid:\t1\t42001\t1\t1\n");
  fs.mkdirSync(path.join(procRoot, "13"));
  fs.writeFileSync(path.join(procRoot, "13", "status"), "Uid:\t2\t2\t2\t2\n");
  assert.deepEqual(principalProcessIds(42001, procRoot), [12]);

  fs.mkdirSync(path.join(procRoot, "14"));
  fs.mkdirSync(path.join(procRoot, "14", "status"));
  assert.throws(
    () => principalProcessIds(42001, procRoot),
    /EISDIR|illegal operation on a directory/i,
  );
});

test("principal runtime proof requires exact IDs, no groups, NNP, and zero capabilities", () => {
  const status = [
    "Name:\tnode",
    "Uid:\t42001\t42001\t42001\t42001",
    "Gid:\t42002\t42002\t42002\t42002",
    "Groups:\t",
    "CapInh:\t0000000000000000",
    "CapPrm:\t0000000000000000",
    "CapEff:\t0000000000000000",
    "CapBnd:\t0000000000000000",
    "CapAmb:\t0000000000000000",
    "NoNewPrivs:\t1",
    "",
  ].join("\n");
  assert.doesNotThrow(() => assertPrincipalRuntimeStatus(status, 42001, 42002));
  assert.throws(
    () =>
      assertPrincipalRuntimeStatus(
        status.replace("CapEff:\t0000000000000000", "CapEff:\t1"),
        42001,
        42002,
      ),
    /retained capabilities/,
  );
  assert.throws(
    () =>
      assertPrincipalRuntimeStatus(
        status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
        42001,
        42002,
      ),
    /no_new_privs proof failed/,
  );
  assert.throws(
    () => assertPrincipalRuntimeStatus(status.replace("Groups:\t", "Groups:\t27"), 42001, 42002),
    /supplementary groups/,
  );
});

test("principal cleanup kills persistent descendants and requires two empty proofs", () => {
  const scans = [[71, 72], [72, 73], [], []];
  const killed: number[] = [];
  let now = 0;
  terminateAndProvePrincipalEmpty(
    42001,
    {
      listProcesses: () => scans.shift() ?? [],
      kill: (pid, signal) => {
        assert.equal(signal, "SIGKILL");
        killed.push(pid);
      },
      sleep: (milliseconds) => {
        now += milliseconds;
      },
      now: () => now,
    },
    1_000,
  );
  assert.deepEqual(killed, [71, 72, 72, 73]);
  assert.equal(scans.length, 0);
});

test("exact staging copies only unique bounded principal-owned regular files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-principal-stage-"));
  const source = path.join(root, "source");
  const stage = path.join(root, "stage");
  const nested = path.join(source, "run-1");
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.writeFileSync(path.join(nested, "prepared-publication.json"), '{"version":1}\n');
  fs.writeFileSync(path.join(nested, "prepared-publication.bundle"), "bundle\n");
  fs.writeFileSync(path.join(nested, "debug.log"), "must not transfer\n");
  const uid = process.getuid!();
  const gid = process.getgid!();

  const staged = stageExactPrincipalFiles({
    sourceRoot: source,
    stageRoot: stage,
    sourceUid: uid,
    stageOwnerUid: uid,
    stageOwnerGid: gid,
    files: [
      { name: "prepared-publication.json", maxBytes: 1024 },
      { name: "prepared-publication.bundle", maxBytes: 1024 },
    ],
  });
  assert.deepEqual(
    staged.map((entry) => entry.name),
    ["prepared-publication.json", "prepared-publication.bundle"],
  );
  assert.deepEqual(fs.readdirSync(stage).sort(), [
    "prepared-publication.bundle",
    "prepared-publication.json",
  ]);
  assert.equal(
    fs.readFileSync(path.join(stage, "prepared-publication.bundle"), "utf8"),
    "bundle\n",
  );
  assert.equal(fs.statSync(path.join(stage, "prepared-publication.bundle")).mode & 0o777, 0o600);
});

test("exact staging rejects symlinks, hardlinks, ownership drift, duplicates, and oversize files", () => {
  const uid = process.getuid!();
  const gid = process.getgid!();
  const fixture = (mutate: (source: string, nested: string) => void) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-principal-reject-"));
    const source = path.join(root, "source");
    const nested = path.join(source, "run");
    const stage = path.join(root, "stage");
    fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.writeFileSync(path.join(nested, "result.json"), "{}\n");
    fs.writeFileSync(path.join(nested, "cluster-plan.json"), "{}\n");
    mutate(source, nested);
    return { root, source, stage };
  };
  const run = (source: string, stage: string, sourceUid = uid, maxBytes = 1024) =>
    stageExactPrincipalFiles({
      sourceRoot: source,
      stageRoot: stage,
      sourceUid,
      stageOwnerUid: uid,
      stageOwnerGid: gid,
      files: [
        { name: "result.json", maxBytes },
        { name: "cluster-plan.json", maxBytes: 1024 },
      ],
    });

  const symbolic = fixture((_source, nested) =>
    fs.symlinkSync("result.json", path.join(nested, "planted-link")),
  );
  assert.throws(() => run(symbolic.source, symbolic.stage), /contains symbolic link/);
  fs.rmSync(symbolic.root, { recursive: true, force: true });

  const hardlinked = fixture((_source, nested) =>
    fs.linkSync(path.join(nested, "result.json"), path.join(nested, "result-copy.json")),
  );
  assert.throws(() => run(hardlinked.source, hardlinked.stage), /exactly one hard link/);
  fs.rmSync(hardlinked.root, { recursive: true, force: true });

  const duplicate = fixture((source) => {
    fs.mkdirSync(path.join(source, "other"));
    fs.writeFileSync(path.join(source, "other", "result.json"), "{}\n");
  });
  assert.throws(() => run(duplicate.source, duplicate.stage), /exactly one result\.json; found 2/);
  fs.rmSync(duplicate.root, { recursive: true, force: true });

  const oversized = fixture(() => {});
  assert.throws(() => run(oversized.source, oversized.stage, uid, 1), /bounded transfer size/);
  fs.rmSync(oversized.root, { recursive: true, force: true });

  const wrongOwner = fixture(() => {});
  assert.throws(
    () => run(wrongOwner.source, wrongOwner.stage, uid + 1),
    /not owned by the dedicated principal UID/,
  );
  fs.rmSync(wrongOwner.root, { recursive: true, force: true });
});

test("optional exact staging accepts only an entirely absent transfer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-principal-optional-"));
  const source = path.join(root, "source");
  const stage = path.join(root, "stage");
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(source, { mode: 0o700 });
  fs.mkdirSync(stage, { mode: 0o700 });
  const uid = process.getuid!();
  const gid = process.getgid!();
  const options = {
    sourceRoot: source,
    stageRoot: stage,
    sourceUid: uid,
    stageOwnerUid: uid,
    stageOwnerGid: gid,
    files: [
      { name: "prepared-publication.json", maxBytes: 1024 },
      { name: "prepared-publication.bundle", maxBytes: 1024 },
    ],
    allowEmptyTransfer: true,
  };

  assert.deepEqual(stageExactPrincipalFiles(options), []);
  fs.writeFileSync(path.join(source, "prepared-publication.json"), "{}\n");
  assert.throws(
    () => stageExactPrincipalFiles(options),
    /exactly one prepared-publication\.bundle; found 0/,
  );
});
