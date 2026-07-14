import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const hydrateScript = path.resolve("scripts/hydrate-state.ts");

test("hydrate-state preserves default hydration without copying the action ledger", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-state-"));
  const state = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(path.join(state, "notifications"), { recursive: true });
  fs.mkdirSync(path.join(state, "ledger"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "ledger"), { recursive: true });
  fs.writeFileSync(
    path.join(state, "notifications", "clawsweeper-event-ledger.json"),
    '{"version":1,"notifications":[]}\n',
  );
  fs.writeFileSync(path.join(state, "ledger", "state.json"), '{"source":"state"}\n');
  fs.writeFileSync(path.join(worktree, "ledger", "state.json"), '{"source":"worktree"}\n');

  try {
    const result = runHydrate(state, worktree);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(
        path.join(worktree, "notifications", "clawsweeper-event-ledger.json"),
        "utf8",
      ),
      '{"version":1,"notifications":[]}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(worktree, "ledger", "state.json"), "utf8"),
      '{"source":"worktree"}\n',
    );
    const report = JSON.parse(result.stdout) as { hydrated: string[] };
    assert.deepEqual(report.hydrated, [
      "records",
      "jobs",
      "results",
      "assets",
      "notifications",
      "apply-report.json",
      "repair-apply-report.json",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hydrate-state hydrates only explicitly selected approved roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-ledger-"));
  const state = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(path.join(state, "ledger"), { recursive: true });
  fs.mkdirSync(path.join(state, "records"), { recursive: true });
  fs.mkdirSync(path.join(state, "notifications"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "notifications"), { recursive: true });
  fs.writeFileSync(path.join(state, "ledger", "events.jsonl"), '{"event":"complete"}\n');
  fs.writeFileSync(path.join(state, "records", "index.json"), '{"records":1}\n');
  fs.writeFileSync(path.join(state, "notifications", "state.json"), '{"source":"state"}\n');
  fs.writeFileSync(path.join(worktree, "notifications", "state.json"), '{"source":"worktree"}\n');

  try {
    const result = runHydrate(state, worktree, {}, ["--hydrate-paths", "ledger\nrecords\nledger"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(worktree, "ledger", "events.jsonl"), "utf8"),
      '{"event":"complete"}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(worktree, "records", "index.json"), "utf8"),
      '{"records":1}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(worktree, "notifications", "state.json"), "utf8"),
      '{"source":"worktree"}\n',
    );
    assert.deepEqual((JSON.parse(result.stdout) as { hydrated: string[] }).hydrated, [
      "ledger",
      "records",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const linkedRoot of ["state directory", "worktree"] as const) {
  test(`hydrate-state rejects a symlinked ${linkedRoot} root`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-root-link-"));
    const state = path.join(root, "state");
    const worktree = path.join(root, "worktree");
    const linked = path.join(root, "linked");
    fs.mkdirSync(path.join(state, "records"), { recursive: true });
    fs.mkdirSync(path.join(worktree, "records"), { recursive: true });
    fs.writeFileSync(path.join(state, "records", "state.txt"), "state\n");
    fs.writeFileSync(path.join(worktree, "records", "keep.txt"), "keep\n");
    symlinkDirectory(linkedRoot === "state directory" ? state : worktree, linked);

    try {
      const result = runHydrate(
        linkedRoot === "state directory" ? linked : state,
        linkedRoot === "worktree" ? linked : worktree,
        {},
        ["--hydrate-paths", "records"],
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /is not a real directory/);
      assert.equal(fs.readFileSync(path.join(state, "records", "state.txt"), "utf8"), "state\n");
      assert.equal(fs.readFileSync(path.join(worktree, "records", "keep.txt"), "utf8"), "keep\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { name: "source approved roots", location: "source-root" },
  { name: "source descendants", location: "source-descendant" },
  { name: "destination approved roots", location: "destination-root" },
  { name: "destination descendants", location: "destination-descendant" },
] as const) {
  test(`hydrate-state rejects symlinked ${scenario.name} without mutating either tree`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-symlink-"));
    const state = path.join(root, "state");
    const worktree = path.join(root, "worktree");
    const outside = path.join(root, "outside");
    fs.mkdirSync(state);
    fs.mkdirSync(worktree);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");

    const source = path.join(state, "records");
    const destination = path.join(worktree, "records");
    if (scenario.location === "source-root") {
      symlinkDirectory(outside, source);
      fs.mkdirSync(destination);
    } else {
      fs.mkdirSync(source);
      fs.mkdirSync(destination);
    }
    if (scenario.location === "source-descendant") {
      symlinkDirectory(outside, path.join(source, "linked"));
    } else if (scenario.location === "destination-root") {
      fs.rmSync(destination, { recursive: true });
      symlinkDirectory(outside, destination);
    } else if (scenario.location === "destination-descendant") {
      symlinkDirectory(outside, path.join(destination, "linked"));
    }
    if (scenario.location !== "destination-root") {
      fs.writeFileSync(path.join(destination, "keep.txt"), "keep\n");
    }
    if (scenario.location !== "source-root") {
      fs.writeFileSync(path.join(source, "state.txt"), "state\n");
    }

    try {
      const result = runHydrate(state, worktree, {}, ["--hydrate-paths", "records"]);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing symbolic link/);
      assert.equal(fs.readFileSync(path.join(outside, "outside.txt"), "utf8"), "outside\n");
      if (scenario.location === "destination-root") {
        assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
      } else {
        assert.equal(fs.readFileSync(path.join(destination, "keep.txt"), "utf8"), "keep\n");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("hydrate-state validates every destination before replacing any approved root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-atomic-"));
  const state = path.join(root, "state");
  const worktree = path.join(root, "worktree");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(state, "records"), { recursive: true });
  fs.mkdirSync(path.join(state, "ledger"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "records"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(state, "records", "state.txt"), "new\n");
  fs.writeFileSync(path.join(state, "ledger", "state.txt"), "new\n");
  fs.writeFileSync(path.join(worktree, "records", "keep.txt"), "keep\n");
  fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");
  symlinkDirectory(outside, path.join(worktree, "ledger"));

  try {
    const result = runHydrate(state, worktree, {}, ["--hydrate-paths", "records\nledger"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing symbolic link/);
    assert.equal(fs.readFileSync(path.join(worktree, "records", "keep.txt"), "utf8"), "keep\n");
    assert.equal(fs.readFileSync(path.join(outside, "outside.txt"), "utf8"), "outside\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hydrate-state rejects destinations that contain the state checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-overlap-"));
  const worktree = path.join(root, "worktree");
  const state = path.join(worktree, "records", "state");
  fs.mkdirSync(path.join(state, "ledger"), { recursive: true });
  fs.writeFileSync(path.join(state, "ledger", "state.txt"), "state\n");

  try {
    const result = runHydrate(state, worktree, {}, ["--hydrate-paths", "records\nledger"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing overlapping hydration paths for records/);
    assert.equal(fs.readFileSync(path.join(state, "ledger", "state.txt"), "utf8"), "state\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const unsafePath of [
  "/tmp/ledger",
  String.raw`C:\ledger`,
  "../ledger",
  "records/../ledger",
  ".ledger",
  "ledger/.private",
  "ledger/private",
  String.raw`ledger\private`,
  "unknown",
]) {
  test(`hydrate-state rejects unsafe or unknown root ${JSON.stringify(unsafePath)}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-hydrate-reject-"));
    const state = path.join(root, "state");
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(path.join(state, "ledger"), { recursive: true });
    fs.mkdirSync(worktree);

    try {
      const result = runHydrate(state, worktree, {
        CLAWSWEEPER_HYDRATE_PATHS: unsafePath,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /(?:Unsafe|Unknown) generated hydration (?:path|root)/);
      assert.deepEqual(fs.readdirSync(worktree), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("setup-state exposes ledger hydration as an explicit opt-in", () => {
  const action = parse(fs.readFileSync(".github/actions/setup-state/action.yml", "utf8")) as {
    inputs?: Record<string, { default?: string }>;
    runs?: { steps?: Array<{ env?: Record<string, string>; run?: string }> };
  };

  assert.equal(action.inputs?.["hydrate-paths"]?.default, "");
  const hydrateStep = action.runs?.steps?.find((step) => step.run?.includes("hydrate-state.ts"));
  assert.equal(hydrateStep?.env?.CLAWSWEEPER_HYDRATE_PATHS, "${{ inputs.hydrate-paths }}");
});

function runHydrate(
  state: string,
  worktree: string,
  env: NodeJS.ProcessEnv = {},
  args: string[] = [],
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [hydrateScript, "--state-dir", state, "--worktree", worktree, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, CLAWSWEEPER_HYDRATE_PATHS: "", ...env },
    },
  );
}

function symlinkDirectory(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}
