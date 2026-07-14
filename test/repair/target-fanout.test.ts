import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultLimit,
  filterEligibleRepositories,
  selectRepositories,
  type InventoryConfig,
  type ListedRepository,
} from "../../dist/repair/target-fanout.js";
import { importActionEventShards } from "../../dist/action-ledger-runtime.js";
import { mockGhBinEnv } from "../helpers.ts";

const config: InventoryConfig = {
  owners: ["openclaw", "steipete"],
  denyRepositories: ["openclaw/clawsweeper-state"],
  includePrivate: false,
  includeArchived: false,
  includeForks: false,
  requireIssues: true,
};

test("target fanout defaults match the scheduled cursor batch sizes", () => {
  assert.equal(defaultLimit("hot-intake"), "10");
  assert.equal(defaultLimit("normal-review"), "6");
  assert.equal(defaultLimit("audit"), "12");
});

test("target fanout filters eligible repositories conservatively", () => {
  const repositories: ListedRepository[] = [
    repo("openclaw/openclaw"),
    repo("openclaw/clawsweeper-state"),
    repo("openclaw/archived", { isArchived: true }),
    repo("openclaw/forked", { isFork: true }),
    repo("openclaw/no-issues", { hasIssuesEnabled: false }),
    repo("openclaw/empty", { defaultBranch: "" }),
    repo("steipete/private-tool", { visibility: "PRIVATE" }),
    repo("steipete/internal-tool", { visibility: "INTERNAL" }),
  ];

  assert.deepEqual(filterEligibleRepositories(repositories, config), [
    { targetRepo: "openclaw/openclaw", defaultBranch: "main", visibility: "PUBLIC" },
  ]);
});

test("target fanout skips owners without minted inventory tokens in Actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-fanout-"));
  const logPath = join(dir, "gh.log");
  const cursorPath = join(dir, "cursor.json");
  const ghPath = join(dir, "gh.js");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, ghToken: process.env.GH_TOKEN || ""}) + "\\n");
if (args[0] === "repo" && args[1] === "list") {
  process.stdout.write(JSON.stringify([
    {nameWithOwner:"openclaw/B",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}
  ]));
  process.exit(0);
}
if (args[0] === "api" && args[1].endsWith("/dispatches")) process.exit(0);
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      "dist/repair/target-fanout.js",
      "--mode",
      "hot-intake",
      "--limit",
      "2",
      "--cursor-path",
      cursorPath,
      "--repo",
      "openclaw/clawsweeper",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        ...mockGhBinEnv(ghPath),
        GH_TOKEN: "workflow-token",
        CLAWSWEEPER_DISPATCH_TOKEN: "dispatch-token",
        CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "inventory-openclaw",
        CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE: "",
      },
    },
  );

  const summary = JSON.parse(output) as { dispatched: string[]; total: number };
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.dispatched, ["openclaw/b"]);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; ghToken: string });
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "repo").map((call) => call.ghToken),
    ["inventory-openclaw"],
  );
});

test("target fanout can use anonymous public inventory in Actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-fanout-"));
  const logPath = join(dir, "gh.log");
  const cursorPath = join(dir, "cursor.json");
  const ghPath = join(dir, "gh.js");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, ghToken: process.env.GH_TOKEN || ""}) + "\\n");
if (args[0] === "repo" && args[1] === "list") {
  const owner = args[2];
  const data = owner === "openclaw"
    ? [{nameWithOwner:"openclaw/B",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}]
    : [{nameWithOwner:"steipete/A",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}];
  process.stdout.write(JSON.stringify(data));
  process.exit(0);
}
if (args[0] === "api" && args[1].endsWith("/dispatches")) process.exit(0);
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      "dist/repair/target-fanout.js",
      "--mode",
      "hot-intake",
      "--limit",
      "2",
      "--cursor-path",
      cursorPath,
      "--repo",
      "openclaw/clawsweeper",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        ...mockGhBinEnv(ghPath),
        CLAWSWEEPER_DISPATCH_TOKEN: "dispatch-token",
        CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "inventory-openclaw",
        CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE: "__public__",
      },
    },
  );

  const summary = JSON.parse(output) as { dispatched: string[]; total: number };
  assert.equal(summary.total, 2);
  assert.deepEqual(summary.dispatched, ["openclaw/b", "steipete/a"]);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; ghToken: string });
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "repo").map((call) => call.ghToken),
    ["inventory-openclaw", "dispatch-token"],
  );
});

test("target fanout falls back to public inventory env outside Actions", () => {
  const source = readFileSync("src/repair/target-fanout.ts", "utf8");
  const helperStart = source.indexOf("function inventoryEnv(");
  const helperEnd = source.indexOf("function publicInventoryEnv(", helperStart);

  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /if \(process\.env\.GITHUB_ACTIONS === "true"\) return null;/);
  assert.match(helper, /return publicInventoryEnv\(\);/);
  assert.doesNotMatch(helper, /GH_TOKEN: ""/);
});

test("target fanout selection advances cursor with wraparound", () => {
  const repositories = [
    { targetRepo: "openclaw/a", defaultBranch: "main", visibility: "PUBLIC" },
    { targetRepo: "openclaw/b", defaultBranch: "main", visibility: "PUBLIC" },
    { targetRepo: "openclaw/c", defaultBranch: "main", visibility: "PUBLIC" },
  ];

  assert.deepEqual(selectRepositories(repositories, { limit: 2, cursor: 2 }), {
    repositories: [repositories[2], repositories[0]],
    cursor: 1,
    total: 3,
  });
});

test("target fanout CLI lists repos and dispatches selected workflow runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-fanout-"));
  const logPath = join(dir, "gh.log");
  const cursorPath = join(dir, "cursor.json");
  const ghPath = join(dir, "gh.js");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, ghToken: process.env.GH_TOKEN || ""}) + "\\n");
if (args[0] === "repo" && args[1] === "list") {
  const owner = args[2];
  const data = owner === "openclaw"
    ? [
        {nameWithOwner:"openclaw/B",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}},
        {nameWithOwner:"openclaw/clawsweeper-state",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}
      ]
    : [
        {nameWithOwner:"steipete/A",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"master"}}
      ];
  process.stdout.write(JSON.stringify(data));
  process.exit(0);
}
if ((args[0] === "workflow" && args[1] === "run") || (args[0] === "api" && args[1].endsWith("/dispatches"))) process.exit(0);
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      "dist/repair/target-fanout.js",
      "--mode",
      "hot-intake",
      "--limit",
      "2",
      "--cursor-path",
      cursorPath,
      "--repo",
      "openclaw/clawsweeper",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...mockGhBinEnv(ghPath),
        GH_TOKEN: "workflow-token",
        CLAWSWEEPER_DISPATCH_TOKEN: "dispatch-token",
        CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "inventory-openclaw",
        CLAWSWEEPER_INVENTORY_TOKEN_STEIPETE: "inventory-steipete",
      },
    },
  );

  const summary = JSON.parse(output) as { dispatched: string[]; next_cursor: number };
  assert.deepEqual(summary.dispatched, ["openclaw/b", "steipete/a"]);
  assert.equal(summary.next_cursor, 0);
  assert.match(readFileSync(cursorPath, "utf8"), /"next_cursor": 0/);

  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; ghToken: string });
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "repo").map((call) => call.ghToken),
    ["inventory-openclaw", "inventory-steipete"],
  );
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "api").map((call) => call.ghToken),
    ["dispatch-token", "dispatch-token"],
  );
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "api").map((call) => call.args.join(" ")),
    [
      "api repos/openclaw/clawsweeper/dispatches -f event_type=clawsweeper_target_sweep -f client_payload[target_repo]=openclaw/b -f client_payload[target_branch]=main -f client_payload[hot_intake]=true -f client_payload[batch_size]=1 -f client_payload[shard_count]=1",
      "api repos/openclaw/clawsweeper/dispatches -f event_type=clawsweeper_target_sweep -f client_payload[target_repo]=steipete/a -f client_payload[target_branch]=master -f client_payload[hot_intake]=true -f client_payload[batch_size]=1 -f client_payload[shard_count]=1",
    ],
  );
});

test("target fanout dry-run does not advance cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-fanout-"));
  const logPath = join(dir, "gh.log");
  const cursorPath = join(dir, "cursor.json");
  const ghPath = join(dir, "gh.js");
  writeFileSync(cursorPath, `${JSON.stringify({ next_cursor: 1 }, null, 2)}\n`);
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "repo" && args[1] === "list") {
  process.stdout.write(JSON.stringify([
    {nameWithOwner:"openclaw/A",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}},
    {nameWithOwner:"openclaw/B",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}
  ]));
  process.exit(0);
}
if ((args[0] === "workflow" && args[1] === "run") || (args[0] === "api" && args[1].endsWith("/dispatches"))) process.exit(0);
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);

  const output = execFileSync(
    process.execPath,
    [
      "dist/repair/target-fanout.js",
      "--mode",
      "hot-intake",
      "--limit",
      "1",
      "--cursor-path",
      cursorPath,
      "--dry-run",
      "--owners",
      "openclaw",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...mockGhBinEnv(ghPath),
        CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "inventory-openclaw",
      },
    },
  );

  const summary = JSON.parse(output.slice(output.indexOf("{\n"))) as {
    dispatched: string[];
    cursor_written: boolean;
  };
  assert.deepEqual(summary.dispatched, ["openclaw/b"]);
  assert.equal(summary.cursor_written, false);
  assert.match(readFileSync(cursorPath, "utf8"), /"next_cursor": 1/);
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.filter((call) => call[0] === "api").length, 0);
});

test("target fanout records queue, exact dispatch, and cursor publication lifecycles", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const outputRoot = join(fixture.root, "action-ledger-output");
  mkdirSync(outputRoot, { recursive: true });

  try {
    const result = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "2",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: fanoutActionLedgerEnv(fixture.ghPath, outputRoot, "7101"),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(cursorPath, "utf8"), /"next_cursor": 0/);

    const events = readActionLedgerEvents(outputRoot);
    assert.equal(events.length, 9);
    assert.deepEqual(
      events
        .filter((event) => event.event_type === "queue.lifecycle")
        .map((event) => event.action.status),
      ["started", "queued", "completed"],
    );

    const dispatches = events.filter((event) => event.event_type === "dispatch.lifecycle");
    assert.equal(dispatches.length, 4);
    for (const targetRepo of ["openclaw/a", "openclaw/b"]) {
      const attempt = dispatches.find(
        (event) => event.subject.repository === targetRepo && event.action.status === "started",
      );
      const outcome = dispatches.find(
        (event) => event.subject.repository === targetRepo && event.action.status === "dispatched",
      );
      assert.ok(attempt);
      assert.ok(outcome);
      assert.equal(attempt.attributes?.completion_reason, "dispatch_attempted");
      assert.equal(outcome.attributes?.completion_reason, "mutation_accepted");
      assert.equal(outcome.parent_event_id, attempt.event_id);
      assert.equal(outcome.idempotency_key_sha256, attempt.idempotency_key_sha256);
      assert.equal(outcome.action.mutation, true);
      assert.equal(attempt.evidence?.[0]?.sha256, outcome.evidence?.[0]?.sha256);
    }

    const publications = events.filter((event) => event.event_type === "publication.lifecycle");
    assert.deepEqual(
      publications.map((event) => event.action.status),
      ["started", "completed"],
    );
    assert.equal(publications[1]?.parent_event_id, publications[0]?.event_id);
    assert.equal(publications[1]?.idempotency_key_sha256, publications[0]?.idempotency_key_sha256);
    assert.equal(publications[1]?.attributes?.publication_kind, "local_artifact");
    assert.match(publications[1]?.evidence?.[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);

    const terminal = events.at(-1);
    assert.equal(terminal?.event_type, "queue.lifecycle");
    assert.equal(terminal?.attributes?.processed_count, 2);
    assert.equal(terminal?.action.mutation, true);

    const serialized = actionLedgerContents(outputRoot);
    assert.doesNotMatch(serialized, /dispatch-token|inventory-token|workflow-token/);
    assert.doesNotMatch(serialized, /https?:\/\//);
    assert.doesNotMatch(serialized, /client_payload\[/);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(cursorPath)));
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("target fanout closes a failed request attempt without advancing the cursor", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const outputRoot = join(fixture.root, "action-ledger-output");
  mkdirSync(outputRoot, { recursive: true });

  try {
    const result = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, outputRoot, "7102"),
          FAIL_DISPATCH: "1",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(existsSync(cursorPath), false);

    const events = readActionLedgerEvents(outputRoot);
    const attempt = events.find(
      (event) => event.event_type === "dispatch.lifecycle" && event.action.status === "started",
    );
    const outcome = events.find(
      (event) => event.event_type === "dispatch.lifecycle" && event.action.status === "failed",
    );
    assert.ok(attempt);
    assert.ok(outcome);
    assert.equal(outcome.parent_event_id, attempt.event_id);
    assert.equal(outcome.idempotency_key_sha256, attempt.idempotency_key_sha256);
    assert.equal(outcome.attributes?.completion_reason, "dispatch_outcome_unknown");
    assert.equal(outcome.action.mutation, true);
    assert.equal(outcome.action.retryable, false);
    assert.equal(
      events.some((event) => event.event_type === "publication.lifecycle"),
      false,
    );

    const terminal = events.at(-1);
    assert.equal(terminal?.event_type, "queue.lifecycle");
    assert.equal(terminal?.action.status, "failed");
    assert.equal(terminal?.action.retryable, false);
    assert.equal(terminal?.action.mutation, true);
    assert.equal(terminal?.attributes?.partial, true);
    assert.equal(terminal?.attributes?.completion_reason, "dispatch_outcome_unknown");

    const serialized = actionLedgerContents(outputRoot);
    assert.doesNotMatch(serialized, /sensitive-dispatch-marker|https?:\/\//);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("target fanout records definitive dispatch rejection without claiming mutation", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const outputRoot = join(fixture.root, "action-ledger-output");
  mkdirSync(outputRoot, { recursive: true });

  try {
    const result = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, outputRoot, "7103"),
          FAIL_DISPATCH: "rejected",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(existsSync(cursorPath), false);

    const events = readActionLedgerEvents(outputRoot);
    const attempt = events.find(
      (event) => event.event_type === "dispatch.lifecycle" && event.action.status === "started",
    );
    const outcome = events.find(
      (event) => event.event_type === "dispatch.lifecycle" && event.action.status === "skipped",
    );
    assert.ok(attempt);
    assert.ok(outcome);
    assert.equal(outcome.parent_event_id, attempt.event_id);
    assert.equal(outcome.idempotency_key_sha256, attempt.idempotency_key_sha256);
    assert.equal(outcome.attributes?.completion_reason, "mutation_rejected");
    assert.equal(outcome.action.mutation, false);
    assert.equal(outcome.action.retryable, false);

    const terminal = events.at(-1);
    assert.equal(terminal?.event_type, "queue.lifecycle");
    assert.equal(terminal?.action.status, "failed");
    assert.equal(terminal?.action.retryable, false);
    assert.equal(terminal?.action.mutation, false);
    assert.equal(terminal?.attributes?.partial, false);
    assert.equal(terminal?.attributes?.completion_reason, "dispatch_rejected");
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

for (const failure of [{ name: "secondary-rate-limit 403", value: "secondary-rate-limit" }]) {
  test(`target fanout keeps definitive ${failure.name} rejection retryable`, () => {
    const fixture = isolatedFanoutFixture();
    const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
    const outputRoot = join(fixture.root, "action-ledger-output");
    mkdirSync(outputRoot, { recursive: true });

    try {
      const result = spawnSync(
        process.execPath,
        [
          fixture.scriptPath,
          "--mode",
          "hot-intake",
          "--limit",
          "1",
          "--cursor-path",
          cursorPath,
          "--repo",
          "openclaw/clawsweeper",
          "--owners",
          "openclaw",
        ],
        {
          cwd: fixture.root,
          encoding: "utf8",
          env: {
            ...fanoutActionLedgerEnv(fixture.ghPath, outputRoot, `7104-${failure.value}`),
            FAIL_DISPATCH: failure.value,
          },
        },
      );
      assert.equal(result.status, 1);
      assert.equal(existsSync(cursorPath), false);

      const events = readActionLedgerEvents(outputRoot);
      const outcome = events.find(
        (event) => event.event_type === "dispatch.lifecycle" && event.action.status === "skipped",
      );
      assert.ok(outcome);
      assert.equal(outcome.attributes?.completion_reason, "mutation_rejected");
      assert.equal(outcome.action.mutation, false);
      assert.equal(outcome.action.retryable, true);

      const terminal = events.at(-1);
      assert.equal(terminal?.event_type, "queue.lifecycle");
      assert.equal(terminal?.action.status, "failed");
      assert.equal(terminal?.action.retryable, true);
      assert.equal(terminal?.action.mutation, false);
      assert.equal(terminal?.attributes?.partial, false);
      assert.equal(terminal?.attributes?.completion_reason, "dispatch_rejected");
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
}

test("target fanout keeps HTTP 429 dispatch outcomes unknown and replay-unsafe", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const outputRoot = join(fixture.root, "action-ledger-output");
  mkdirSync(outputRoot, { recursive: true });

  try {
    const result = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, outputRoot, "7104-rate-limit"),
          FAIL_DISPATCH: "rate-limit",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(existsSync(cursorPath), false);

    const events = readActionLedgerEvents(outputRoot);
    const outcome = events.find(
      (event) => event.event_type === "dispatch.lifecycle" && event.action.status === "failed",
    );
    assert.ok(outcome);
    assert.equal(outcome.attributes?.completion_reason, "dispatch_outcome_unknown");
    assert.equal(outcome.action.mutation, true);
    assert.equal(outcome.action.retryable, false);

    const terminal = events.at(-1);
    assert.equal(terminal?.event_type, "queue.lifecycle");
    assert.equal(terminal?.action.status, "failed");
    assert.equal(terminal?.action.retryable, false);
    assert.equal(terminal?.action.mutation, true);
    assert.equal(terminal?.attributes?.partial, true);
    assert.equal(terminal?.attributes?.completion_reason, "dispatch_outcome_unknown");
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("target fanout keeps a partially dispatched throttled batch replay-unsafe", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const outputRoot = join(fixture.root, "action-ledger-output");
  mkdirSync(outputRoot, { recursive: true });

  try {
    const result = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "2",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, outputRoot, "7105"),
          FAIL_SECOND_DISPATCH: "secondary-rate-limit",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(cursorPath, "utf8")), {
      next_cursor: 1,
      after_repository: "openclaw/a",
    });

    const events = readActionLedgerEvents(outputRoot);
    const firstOutcome = events.find(
      (event) =>
        event.event_type === "dispatch.lifecycle" &&
        event.subject.repository === "openclaw/a" &&
        event.action.status === "dispatched",
    );
    const secondOutcome = events.find(
      (event) =>
        event.event_type === "dispatch.lifecycle" &&
        event.subject.repository === "openclaw/b" &&
        event.action.status === "skipped",
    );
    assert.ok(firstOutcome);
    assert.ok(secondOutcome);
    assert.equal(firstOutcome.action.mutation, true);
    assert.equal(secondOutcome.action.mutation, false);
    assert.equal(secondOutcome.action.retryable, true);
    assert.equal(secondOutcome.attributes?.completion_reason, "mutation_rejected");

    const terminal = events.at(-1);
    assert.equal(terminal?.event_type, "queue.lifecycle");
    assert.equal(terminal?.action.status, "failed");
    assert.equal(terminal?.action.retryable, false);
    assert.equal(terminal?.action.mutation, true);
    assert.equal(terminal?.attributes?.processed_count, 1);
    assert.equal(terminal?.attributes?.partial, true);
    assert.equal(terminal?.attributes?.completion_reason, "dispatch_rejected");
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("target fanout reserves an accepted dispatch before writing its receipt", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const outputRoot = join(fixture.root, "action-ledger-output");
  mkdirSync(outputRoot, { recursive: true });

  try {
    const first = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, outputRoot, "7106"),
          DISPATCH_LOG_PATH: fixture.logPath,
          FAIL_ACCEPTED_RECEIPT: "1",
        },
      },
    );
    assert.equal(first.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(cursorPath, "utf8")), {
      next_cursor: 1,
      after_repository: "openclaw/a",
    });
    assert.deepEqual(readDispatchLog(fixture.logPath), ["openclaw/a"]);

    rmSync(join(fixture.root, ".clawsweeper-repair", "action-events"), {
      force: true,
      recursive: true,
    });
    const second = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, outputRoot, "7107"),
          DISPATCH_LOG_PATH: fixture.logPath,
        },
      },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readDispatchLog(fixture.logPath), ["openclaw/a", "openclaw/b"]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("target fanout reruns advance past a durably accepted dispatch without repeating it", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const firstOutput = join(fixture.root, "first-action-ledger-output");
  const secondOutput = join(fixture.root, "second-action-ledger-output");
  const stateRoot = join(fixture.root, "state");
  for (const directory of [firstOutput, secondOutput, stateRoot]) {
    mkdirSync(directory, { recursive: true });
  }

  try {
    const first = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, firstOutput, "7110"),
          DISPATCH_LOG_PATH: fixture.logPath,
        },
      },
    );
    assert.equal(first.status, 0, first.stderr);
    importActionEventShards(firstOutput, stateRoot);
    rmSync(cursorPath);
    rmSync(join(fixture.root, ".clawsweeper-repair", "action-events"), {
      force: true,
      recursive: true,
    });

    const second = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, secondOutput, "7110"),
          CLAWSWEEPER_STATE_DIR: stateRoot,
          DISPATCH_LOG_PATH: fixture.logPath,
          GITHUB_RUN_ATTEMPT: "2",
          TARGET_BRANCH: "renamed",
        },
      },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readDispatchLog(fixture.logPath), ["openclaw/a"]);
    assert.deepEqual(JSON.parse(readFileSync(cursorPath, "utf8")), {
      next_cursor: 1,
      after_repository: "openclaw/a",
    });
    assert.ok(
      readActionLedgerEvents(secondOutput).some(
        (event) => event.attributes?.completion_reason === "already_accepted",
      ),
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("target fanout reruns fail closed without current-run durable receipts", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const foreignOutput = join(fixture.root, "foreign-action-ledger-output");
  const outputRoot = join(fixture.root, "action-ledger-output");
  const stateRoot = join(fixture.root, "state");
  for (const directory of [foreignOutput, outputRoot, stateRoot]) {
    mkdirSync(directory, { recursive: true });
  }

  try {
    const foreign = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, foreignOutput, "foreign-run"),
          DISPATCH_LOG_PATH: fixture.logPath,
        },
      },
    );
    assert.equal(foreign.status, 0, foreign.stderr);
    importActionEventShards(foreignOutput, stateRoot);
    rmSync(cursorPath);
    rmSync(join(fixture.root, ".clawsweeper-repair", "action-events"), {
      force: true,
      recursive: true,
    });
    writeFileSync(fixture.logPath, "");

    const result = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, outputRoot, "7112"),
          CLAWSWEEPER_STATE_DIR: stateRoot,
          DISPATCH_LOG_PATH: fixture.logPath,
          GITHUB_RUN_ATTEMPT: "2",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /without prior-attempt durable receipts/);
    assert.deepEqual(readDispatchLog(fixture.logPath), []);
    assert.equal(existsSync(cursorPath), false);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("target fanout reruns replay the original batch across inventory insertions", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const firstOutput = join(fixture.root, "first-action-ledger-output");
  const replayOutput = join(fixture.root, "replay-action-ledger-output");
  const nextOutput = join(fixture.root, "next-action-ledger-output");
  const stateRoot = join(fixture.root, "state");
  for (const directory of [firstOutput, replayOutput, nextOutput, stateRoot]) {
    mkdirSync(directory, { recursive: true });
  }

  try {
    const first = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "2",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, firstOutput, "7113"),
          DISPATCH_LOG_PATH: fixture.logPath,
        },
      },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(readDispatchLog(fixture.logPath), ["openclaw/a", "openclaw/b"]);
    importActionEventShards(firstOutput, stateRoot);
    rmSync(cursorPath);
    rmSync(join(fixture.root, ".clawsweeper-repair", "action-events"), {
      force: true,
      recursive: true,
    });

    const replay = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "2",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, replayOutput, "7113"),
          CLAWSWEEPER_STATE_DIR: stateRoot,
          DISPATCH_LOG_PATH: fixture.logPath,
          GITHUB_RUN_ATTEMPT: "2",
          INSERT_REPOSITORY_BEFORE: "1",
        },
      },
    );
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(readDispatchLog(fixture.logPath), ["openclaw/a", "openclaw/b"]);
    assert.deepEqual(JSON.parse(readFileSync(cursorPath, "utf8")), {
      next_cursor: 0,
      after_repository: "openclaw/b",
    });

    const next = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, nextOutput, "7114"),
          DISPATCH_LOG_PATH: fixture.logPath,
          INSERT_REPOSITORY_BEFORE: "1",
        },
      },
    );
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(readDispatchLog(fixture.logPath), ["openclaw/a", "openclaw/b", "openclaw/00"]);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("target fanout reruns block an outcome-unknown durable dispatch", () => {
  const fixture = isolatedFanoutFixture();
  const cursorPath = join(fixture.root, "results", "target-fanout-cursors", "hot-intake.json");
  const firstOutput = join(fixture.root, "first-action-ledger-output");
  const secondOutput = join(fixture.root, "second-action-ledger-output");
  const stateRoot = join(fixture.root, "state");
  for (const directory of [firstOutput, secondOutput, stateRoot]) {
    mkdirSync(directory, { recursive: true });
  }

  try {
    const first = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, firstOutput, "7111"),
          DISPATCH_LOG_PATH: fixture.logPath,
          FAIL_DISPATCH: "rate-limit",
        },
      },
    );
    assert.equal(first.status, 1);
    importActionEventShards(firstOutput, stateRoot);
    rmSync(join(fixture.root, ".clawsweeper-repair", "action-events"), {
      force: true,
      recursive: true,
    });

    const second = spawnSync(
      process.execPath,
      [
        fixture.scriptPath,
        "--mode",
        "hot-intake",
        "--limit",
        "1",
        "--cursor-path",
        cursorPath,
        "--repo",
        "openclaw/clawsweeper",
        "--owners",
        "openclaw",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...fanoutActionLedgerEnv(fixture.ghPath, secondOutput, "7111"),
          CLAWSWEEPER_STATE_DIR: stateRoot,
          DISPATCH_LOG_PATH: fixture.logPath,
          GITHUB_RUN_ATTEMPT: "2",
        },
      },
    );
    assert.equal(second.status, 1);
    assert.match(second.stderr, /without a complete accepted original batch/);
    assert.deepEqual(readDispatchLog(fixture.logPath), ["openclaw/a"]);
    assert.equal(existsSync(cursorPath), false);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("target fanout publishes its cursor before finalizing and publishing exact shards", () => {
  const workflow = readFileSync(".github/workflows/sweep.yml", "utf8");
  const start = workflow.indexOf("\n  target-fanout:");
  const end = workflow.indexOf("\n  plan:", start);
  const fanout = workflow.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(fanout, /uses: \.\/\.github\/actions\/setup-action-ledger/);
  assert.match(fanout, /id: action-ledger/);
  assert.match(fanout, /id: setup-state/);
  assert.match(fanout, /id: setup-pnpm/);
  assert.match(fanout, /--receipt-kind target_fanout_cursor_publication/);
  assert.match(
    fanout,
    /Publish fanout cursor[\s\S]*?if: \$\{\{ always\(\) && steps\.setup-state\.outcome == 'success'/,
  );
  assert.match(fanout, /repair:action-ledger -- finalize/);
  assert.match(
    fanout,
    /repair:action-ledger -- publish-workflow \\\n\s+--expected-producer-job target-fanout/,
  );
  assert.match(fanout, /publish-action-event-paths/);
  assert.ok(
    fanout.indexOf("--receipt-kind target_fanout_cursor_publication") <
      fanout.indexOf("repair:action-ledger -- finalize"),
  );
  assert.ok(
    fanout.indexOf("repair:action-ledger -- finalize") <
      fanout.indexOf("repair:action-ledger -- publish-workflow"),
  );
  assert.doesNotMatch(
    fanout.slice(fanout.indexOf("Import immutable target fanout action ledger")),
    /--rebase-strategy theirs/,
  );
});

function repo(nameWithOwner: string, overrides: Partial<ListedRepository> = {}): ListedRepository {
  return {
    nameWithOwner,
    isArchived: false,
    isDisabled: false,
    isFork: false,
    hasIssuesEnabled: true,
    visibility: "PUBLIC",
    defaultBranch: "main",
    ...overrides,
  };
}

type LedgerEvent = {
  event_id: string;
  event_type: string;
  idempotency_key_sha256: string;
  parent_event_id: string | null;
  phase_seq: number;
  action: {
    mutation: boolean;
    retryable: boolean;
    status: string;
  };
  subject: {
    repository: string;
  };
  evidence?: Array<{
    sha256?: string;
  }>;
  attributes?: Record<string, string | number | boolean>;
};

function isolatedFanoutFixture(): {
  root: string;
  scriptPath: string;
  ghPath: string;
  logPath: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clawsweeper-fanout-ledger-")));
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("config", join(root, "config"), { recursive: true });
  const ghPath = join(root, "gh.js");
  const logPath = join(root, "dispatch.log");
  writeFileSync(logPath, "");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "list") {
  const repositories = [
    ...(process.env.INSERT_REPOSITORY_BEFORE === "1"
      ? [{nameWithOwner:"openclaw/00",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}]
      : []),
    {nameWithOwner:"openclaw/A",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:process.env.TARGET_BRANCH || "main"}},
    {nameWithOwner:"openclaw/B",isArchived:false,isDisabled:false,isFork:false,hasIssuesEnabled:true,visibility:"PUBLIC",defaultBranchRef:{name:"main"}}
  ];
  process.stdout.write(JSON.stringify(repositories));
  process.exit(0);
}
if (args[0] === "api" && args[1].endsWith("/dispatches")) {
  const target = args.find((arg) => arg.startsWith("client_payload[target_repo]="))?.split("=")[1];
  if (process.env.DISPATCH_LOG_PATH && target) {
    fs.appendFileSync(process.env.DISPATCH_LOG_PATH, target + "\\n");
  }
  if (
    process.env.FAIL_SECOND_DISPATCH === "secondary-rate-limit" &&
    args.includes("client_payload[target_repo]=openclaw/b")
  ) {
    process.stderr.write("gh: You have exceeded a secondary rate limit. (HTTP 403)");
    process.exit(1);
  }
  if (process.env.FAIL_DISPATCH === "secondary-rate-limit") {
    process.stderr.write("gh: You have exceeded a secondary rate limit. (HTTP 403)");
    process.exit(1);
  }
  if (process.env.FAIL_DISPATCH === "rate-limit") {
    process.stderr.write("gh: API rate limit exceeded (HTTP 429)");
    process.exit(1);
  }
  if (process.env.FAIL_DISPATCH === "rejected") {
    process.stderr.write("gh: Validation Failed (HTTP 422)");
    process.exit(1);
  }
  if (process.env.FAIL_DISPATCH === "1") {
    process.stderr.write("sensitive-dispatch-marker https://example.invalid/private");
    process.exit(7);
  }
  if (process.env.FAIL_ACCEPTED_RECEIPT === "1") {
    const eventRoot = path.join(process.cwd(), ".clawsweeper-repair", "action-events");
    fs.rmSync(eventRoot, { force: true, recursive: true });
    fs.mkdirSync(path.dirname(eventRoot), { recursive: true });
    fs.writeFileSync(eventRoot, "receipt writes blocked\\n");
  }
  process.exit(0);
}
process.exit(2);
`,
  );
  chmodSync(ghPath, 0o755);
  return {
    root,
    scriptPath: join(root, "dist", "repair", "target-fanout.js"),
    ghPath,
    logPath,
  };
}

function readDispatchLog(logPath: string): string[] {
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

function fanoutActionLedgerEnv(
  ghPath: string,
  outputRoot: string,
  runId: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...mockGhBinEnv(ghPath),
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: outputRoot,
    CLAWSWEEPER_DISPATCH_TOKEN: "dispatch-token",
    CLAWSWEEPER_INVENTORY_TOKEN_OPENCLAW: "inventory-token",
    GH_TOKEN: "workflow-token",
    GITHUB_ACTION: "dispatch_selected_targets",
    GITHUB_JOB: "target-fanout",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_STARTED_AT: "2026-07-13T10:00:00Z",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "ClawSweeper",
    GITHUB_WORKFLOW_REF: "openclaw/clawsweeper/.github/workflows/sweep.yml@refs/heads/main",
  };
}

function readActionLedgerEvents(outputRoot: string): LedgerEvent[] {
  const files = recursiveFiles(outputRoot).filter((file) => file.endsWith(".jsonl"));
  return files
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerEvent),
    )
    .sort((left, right) => left.phase_seq - right.phase_seq);
}

function actionLedgerContents(outputRoot: string): string {
  return recursiveFiles(outputRoot)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

function recursiveFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) files.push(...recursiveFiles(file));
    else files.push(file);
  }
  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
