import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLinearTransport } from "../dist/linear/index.js";
import {
  buildLinearLiveFixture,
  buildLinearLiveBuildEnv,
  ISSUE_CREATE_E2E_FIXTURE_MUTATION,
  ISSUE_DELETE_E2E_FIXTURE_MUTATION,
  scrubLinearCredentialEnvironment,
} from "../scripts/e2e/linear-live-fixture.mjs";
import { READONLY_PROOF_LIMITS } from "../scripts/linear-proof-readonly.mjs";
import {
  buildReadonlyChildEnv,
  createLinearFixtureClient,
  runLinearLiveE2E,
  validateLinearLiveOptions,
} from "./e2e/linear-live/run.mjs";

const TEAM_ID = "123e4567-e89b-42d3-a456-426614174000";
const CORRELATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const GIT = {
  head: "1".repeat(40),
  tree: "2".repeat(40),
  mergeBase: "3".repeat(40),
  baseTip: "4".repeat(40),
};
const SCHEMA = {
  schemaCommit: "eabc85d0df87617b4647e56d2f236e60bc2ed117",
  schemaSha256: "5".repeat(64),
  schemaBytes: 1_270_042,
  readDocumentCount: 5,
  retainedMutationDocumentCount: 4,
  e2eFixtureMutationDocumentCount: 2,
  allDocumentsValid: true,
};

test("live Linear E2E is an explicit build-first operator command outside normal checks", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.["e2e:linear:live"], "node scripts/e2e/linear-live.mjs");
  assert.doesNotMatch(String(packageJson.scripts?.check ?? ""), /e2e:linear:live/);
});

function innerReceipt(alias = "portable-linear-fixture") {
  const core = {
    schemaVersion: "linear-readonly-proof/v1",
    ...GIT,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    proofCommandVersion: "1",
    fixture: { alias },
    schemaConformance: SCHEMA,
    liveRead: {
      requestCount: 1,
      issueIdentityMatched: true,
      expectedTeamMatched: true,
      mappingAssertionsPassed: true,
    },
    proposalOnly: {
      wouldWrite: false,
      applied: false,
      decisionWrite: false,
      writeTransportConstructed: false,
      oauthTokenMintUsed: false,
    },
    forbiddenBoundary: {
      caseCount: 14,
      rejectionCount: 14,
      fetchCallCount: 0,
      sleepCallCount: 0,
    },
    limits: READONLY_PROOF_LIMITS,
  };
  return {
    ...core,
    artifactSha256: createHash("sha256").update(JSON.stringify(core)).digest("hex"),
  };
}

function options(outputRoot: string) {
  return {
    scenario: "ephemeral-readonly",
    fixture: "readonly-issue-v1",
    teamId: TEAM_ID,
    fixtureAlias: "portable-linear-fixture",
    baseTip: "upstream/main",
    candidateRoot: process.cwd(),
    outputRoot,
    setupToken: "PRIVATE_SETUP_TOKEN",
    readToken: "PRIVATE_READ_TOKEN",
    parentEnv: {
      HOME: "/tmp/home",
      PATH: process.env.PATH,
      LINEAR_E2E_SETUP_API_KEY: "PRIVATE_SETUP_TOKEN",
      GITHUB_TOKEN: "PRIVATE_GITHUB_TOKEN",
    },
  };
}

function successfulDeps(overrides: Record<string, unknown> = {}) {
  return {
    resolveGit: () => GIT,
    randomUUID: () => CORRELATION_ID,
    schemaConformance: SCHEMA,
    mutationClient: {
      createIssue: async () => ({ id: "PRIVATE_ISSUE_UUID", identifier: "PRF-42" }),
      deleteIssue: async () => {},
    },
    runReadonlyProof: async () => ({
      receipt: innerReceipt(),
      receiptFileSha256: "6".repeat(64),
    }),
    verifyCleanup: async () => true,
    ...overrides,
  };
}

test("live Linear E2E preflight requires an explicit team and distinct scoped credentials", () => {
  assert.throws(
    () =>
      validateLinearLiveOptions({
        ...options("/tmp/out"),
        teamId: "not-a-team",
      }),
    /team UUID/,
  );
  assert.throws(
    () =>
      validateLinearLiveOptions({
        ...options("/tmp/out"),
        readToken: "PRIVATE_SETUP_TOKEN",
      }),
    /must be distinct/,
  );
});

test("read-proof child environment contains only safe host fields and the read credential", () => {
  const env = buildReadonlyChildEnv(
    {
      PATH: "/bin",
      HOME: "/tmp/home",
      LINEAR_E2E_SETUP_API_KEY: "PRIVATE_SETUP_TOKEN",
      LINEAR_TOKEN: "PRIVATE_OLD_READ_TOKEN",
      GH_TOKEN: "PRIVATE_GITHUB_TOKEN",
      CODEX_HOME: "/private/codex",
    },
    "PRIVATE_READ_TOKEN",
  );
  assert.deepEqual(env, {
    HOME: "/tmp/home",
    PATH: "/bin",
    LINEAR_API_KEY: "PRIVATE_READ_TOKEN",
  });
});

test("live bootstrap strips credentials and gives build tooling a strict safe environment", () => {
  const parent = {
    HOME: "/tmp/home",
    PATH: "/bin",
    LINEAR_E2E_SETUP_API_KEY: "PRIVATE_SETUP_TOKEN",
    LINEAR_E2E_READ_API_KEY: "PRIVATE_READ_TOKEN",
    LINEAR_TOKEN: "PRIVATE_OLD_TOKEN",
    GH_TOKEN: "PRIVATE_GITHUB_TOKEN",
    OPENAI_API_KEY: "PRIVATE_OPENAI_TOKEN",
    UNRELATED_SECRET: "PRIVATE_UNRELATED_TOKEN",
  };
  scrubLinearCredentialEnvironment(parent);
  assert.deepEqual(parent, {
    HOME: "/tmp/home",
    PATH: "/bin",
    UNRELATED_SECRET: "PRIVATE_UNRELATED_TOKEN",
  });
  assert.deepEqual(buildLinearLiveBuildEnv(parent), {
    HOME: "/tmp/home",
    PATH: "/bin",
  });
});

test("fixture client permits only exact create and delete operations with fixed safe failures", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const client = createLinearFixtureClient({
    setupToken: "PRIVATE_SETUP_TOKEN",
    endpoint: "https://private.invalid/graphql",
    fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        authorization: (init?.headers as Record<string, string>)?.Authorization,
        ...body,
      });
      return new Response(
        JSON.stringify(
          body.operationName === "IssueCreateE2EFixture"
            ? {
                data: {
                  issueCreate: {
                    success: true,
                    issue: { id: "PRIVATE_ISSUE_UUID", identifier: "PRF-42" },
                  },
                },
              }
            : { data: { issueDelete: { success: true } } },
        ),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(await client.createIssue(TEAM_ID, CORRELATION_ID), {
    id: "PRIVATE_ISSUE_UUID",
    identifier: "PRF-42",
  });
  await client.deleteIssue("PRIVATE_ISSUE_UUID");
  assert.deepEqual(Object.keys(client), ["createIssue", "deleteIssue"]);
  assert.deepEqual(requests[0], {
    authorization: "PRIVATE_SETUP_TOKEN",
    query: ISSUE_CREATE_E2E_FIXTURE_MUTATION,
    variables: { input: { teamId: TEAM_ID, ...buildLinearLiveFixture(CORRELATION_ID) } },
    operationName: "IssueCreateE2EFixture",
  });
  assert.deepEqual(requests[1], {
    authorization: "PRIVATE_SETUP_TOKEN",
    query: ISSUE_DELETE_E2E_FIXTURE_MUTATION,
    variables: { id: "PRIVATE_ISSUE_UUID" },
    operationName: "IssueDeleteE2EFixture",
  });

  const failing = createLinearFixtureClient({
    setupToken: "PRIVATE_SETUP_TOKEN",
    fetchImpl: async () =>
      new Response(JSON.stringify({ errors: [{ message: "PRIVATE_PROVIDER_RESPONSE" }] }), {
        status: 200,
      }),
  });
  await assert.rejects(() => failing.createIssue(TEAM_ID, CORRELATION_ID), {
    message: "Linear E2E fixture creation failed",
  });
});

test("production Linear transport rejects both fixture mutations before fetch or retry", async () => {
  let fetchCalls = 0;
  let sleepCalls = 0;
  const transport = createLinearTransport({
    token: "PRIVATE_READ_TOKEN",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    },
    sleep: async () => {
      sleepCalls += 1;
    },
  });
  for (const source of [ISSUE_CREATE_E2E_FIXTURE_MUTATION, ISSUE_DELETE_E2E_FIXTURE_MUTATION]) {
    await assert.rejects(() => transport(source, {}), /transport is read-only/);
  }
  assert.equal(fetchCalls, 0);
  assert.equal(sleepCalls, 0);
});

test("deterministic lifecycle creates once, proves reads, cleans once, and emits no private data", async () => {
  const roots = [
    mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-a-")),
    mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-b-")),
  ];
  try {
    const first = await runLinearLiveE2E(options(roots[0]), successfulDeps());
    const second = await runLinearLiveE2E(options(roots[1]), successfulDeps());
    assert.equal(first.summary.status, "passed");
    assert.deepEqual(first.summary.fixtureHarness, {
      alias: "portable-linear-fixture",
      operations: {
        create: "IssueCreateE2EFixture",
        cleanup: "IssueDeleteE2EFixture",
      },
      createCount: 1,
      deleteCount: 1,
      cleanupVerified: true,
      cleanupMode: "trashed-recoverable-for-30-days",
      recoveryRequired: false,
    });
    assert.equal(first.summary.subjectUnderTest.mutationCount, 0);
    assert.equal(first.summary.combinedArtifactSha256, second.summary.combinedArtifactSha256);
    assert.equal(existsSync(join(roots[0], "private", "recovery.json")), false);
    assert.equal(existsSync(join(roots[0], "private", "run.lock")), false);
    for (const relative of [
      "summary.json",
      "steps/preflight.json",
      "steps/create.json",
      "steps/readonly-proof.json",
      "steps/cleanup.json",
    ]) {
      const content = readFileSync(join(roots[0], relative), "utf8");
      for (const privateValue of [
        "PRIVATE_SETUP_TOKEN",
        "PRIVATE_READ_TOKEN",
        "PRIVATE_ISSUE_UUID",
        "PRF-42",
        TEAM_ID,
        CORRELATION_ID,
      ]) {
        assert.doesNotMatch(content, new RegExp(privateValue));
      }
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("inner proof failure still cleans the exact created fixture", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-proof-failure-"));
  let deleteCalls = 0;
  try {
    await assert.rejects(
      () =>
        runLinearLiveE2E(
          options(root),
          successfulDeps({
            mutationClient: {
              createIssue: async () => ({ id: "PRIVATE_ISSUE_UUID", identifier: "PRF-42" }),
              deleteIssue: async (id: string) => {
                assert.equal(id, "PRIVATE_ISSUE_UUID");
                deleteCalls += 1;
              },
            },
            runReadonlyProof: async () => {
              throw new Error("PRIVATE_INNER_FAILURE");
            },
          }),
        ),
      /inspect the public summary/,
    );
    assert.equal(deleteCalls, 1);
    assert.equal(existsSync(join(root, "private", "recovery.json")), false);
    assert.equal(existsSync(join(root, "private", "run.lock")), false);
    const summary = readFileSync(join(root, "summary.json"), "utf8");
    assert.match(summary, /"stage": "readonly-proof"/);
    assert.doesNotMatch(summary, /PRIVATE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a semantically rejected inner receipt cannot produce a successful proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-invalid-receipt-"));
  try {
    const receipt = innerReceipt() as Record<string, unknown>;
    receipt.liveRead = {
      ...(receipt.liveRead as Record<string, unknown>),
      privateIssueIdentifier: "PRF-42",
    };
    await assert.rejects(
      () =>
        runLinearLiveE2E(
          options(root),
          successfulDeps({
            runReadonlyProof: async ({ out }: { out: string }) => {
              writeFileSync(out, JSON.stringify(receipt));
              return { receipt, receiptFileSha256: "6".repeat(64) };
            },
          }),
        ),
      /inspect the public summary/,
    );
    const summary = readFileSync(join(root, "summary.json"), "utf8");
    assert.match(summary, /"status": "failed"/);
    assert.match(summary, /"stage": "readonly-proof"/);
    assert.doesNotMatch(summary, /subjectUnderTest|PRF-42|privateIssueIdentifier/);
    assert.equal(existsSync(join(root, "readonly-proof.json")), false);
    assert.equal(existsSync(join(root, "private", "recovery.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a zero-length forbidden matrix cannot produce a successful proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-empty-matrix-"));
  try {
    const receipt = innerReceipt() as Record<string, unknown>;
    receipt.forbiddenBoundary = {
      caseCount: 0,
      rejectionCount: 0,
      fetchCallCount: 0,
      sleepCallCount: 0,
    };
    const { artifactSha256: _old, ...core } = receipt;
    receipt.artifactSha256 = createHash("sha256").update(JSON.stringify(core)).digest("hex");
    await assert.rejects(
      () =>
        runLinearLiveE2E(
          options(root),
          successfulDeps({
            runReadonlyProof: async () => ({ receipt, receiptFileSha256: "6".repeat(64) }),
          }),
        ),
      /inspect the public summary/,
    );
    assert.match(readFileSync(join(root, "summary.json"), "utf8"), /"status": "failed"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup failure retains a private mode-0600 recovery record and a public-safe failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-cleanup-failure-"));
  try {
    await assert.rejects(
      () =>
        runLinearLiveE2E(
          options(root),
          successfulDeps({
            randomUUID: () => CORRELATION_ID,
            mutationClient: {
              createIssue: async () => ({ id: "PRIVATE_ISSUE_UUID", identifier: "PRF-42" }),
              deleteIssue: async () => {
                throw new Error("PRIVATE_DELETE_FAILURE");
              },
            },
          }),
        ),
      /inspect the public summary/,
    );
    const recovery = join(root, "private", "recovery.json");
    assert.equal(existsSync(recovery), true);
    assert.equal(statSync(recovery).mode & 0o777, 0o600);
    assert.match(readFileSync(recovery, "utf8"), /PRIVATE_ISSUE_UUID/);
    assert.equal(existsSync(join(root, "private", "run.lock")), true);
    const summary = readFileSync(join(root, "summary.json"), "utf8");
    assert.match(summary, /"recoveryRequired": true/);
    assert.match(summary, /"deleteCount": 1/);
    assert.doesNotMatch(summary, /PRIVATE_ISSUE_UUID|PRF-42|PRIVATE_DELETE_FAILURE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create failure performs no cleanup and retains an unknown-outcome recovery lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-create-failure-"));
  let deleteCalls = 0;
  try {
    await assert.rejects(
      () =>
        runLinearLiveE2E(
          options(root),
          successfulDeps({
            mutationClient: {
              createIssue: async () => {
                throw new Error("PRIVATE_CREATE_FAILURE");
              },
              deleteIssue: async () => {
                deleteCalls += 1;
              },
            },
          }),
        ),
      /inspect the public summary/,
    );
    assert.equal(deleteCalls, 0);
    assert.equal(existsSync(join(root, "private", "recovery.json")), true);
    assert.equal(existsSync(join(root, "private", "run.lock")), true);
    const summary = readFileSync(join(root, "summary.json"), "utf8");
    assert.match(summary, /"createCount": 1/);
    assert.match(summary, /"deleteCount": 0/);
    assert.match(summary, /"recoveryRequired": true/);
    assert.doesNotMatch(summary, /PRIVATE_CREATE_FAILURE/);
    const recovery = readFileSync(join(root, "private", "recovery.json"), "utf8");
    assert.match(recovery, new RegExp(TEAM_ID));
    assert.match(recovery, new RegExp(CORRELATION_ID));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked private output path is rejected before mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-symlink-root-"));
  const external = mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-symlink-target-"));
  let createCalls = 0;
  try {
    symlinkSync(external, join(root, "private"), "dir");
    await assert.rejects(
      () =>
        runLinearLiveE2E(
          options(root),
          successfulDeps({
            mutationClient: {
              createIssue: async () => {
                createCalls += 1;
                return { id: "PRIVATE_ISSUE_UUID", identifier: "PRF-42" };
              },
              deleteIssue: async () => {},
            },
          }),
        ),
      /preflight failed/,
    );
    assert.equal(createCalls, 0);
    assert.deepEqual(readdirSync(external), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("ignoring only summary.json cannot authorize private recovery artifacts", async () => {
  const root = mkdtempSync(join(process.cwd(), "linear-live-partial-ignore-"));
  let createCalls = 0;
  try {
    writeFileSync(join(root, ".gitignore"), "summary.json\n");
    await assert.rejects(
      () =>
        runLinearLiveE2E(
          options(root),
          successfulDeps({
            mutationClient: {
              createIssue: async () => {
                createCalls += 1;
                return { id: "PRIVATE_ISSUE_UUID", identifier: "PRF-42" };
              },
              deleteIssue: async () => {},
            },
          }),
        ),
      /preflight failed/,
    );
    assert.equal(createCalls, 0);
    assert.deepEqual(readdirSync(root), [".gitignore"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing recovery lease atomically blocks mutation and public artifact overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-lease-"));
  let createCalls = 0;
  try {
    const privateDir = join(root, "private");
    const lease = join(privateDir, "run.lock");
    const summary = join(root, "summary.json");
    mkdirSync(lease, { recursive: true });
    writeFileSync(summary, "existing-owner-summary\n");
    await assert.rejects(
      () =>
        runLinearLiveE2E(
          options(root),
          successfulDeps({
            mutationClient: {
              createIssue: async () => {
                createCalls += 1;
                return { id: "PRIVATE_ISSUE_UUID", identifier: "PRF-42" };
              },
              deleteIssue: async () => {},
            },
          }),
        ),
      /preflight failed/,
    );
    assert.equal(createCalls, 0);
    assert.equal(readFileSync(summary, "utf8"), "existing-owner-summary\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live harness rejects Windows before creating private recovery state", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-linear-live-windows-"));
  let createCalls = 0;
  try {
    await assert.rejects(
      () =>
        runLinearLiveE2E(
          options(root),
          successfulDeps({
            platform: "win32",
            mutationClient: {
              createIssue: async () => {
                createCalls += 1;
                return { id: "PRIVATE_ISSUE_UUID", identifier: "PRF-42" };
              },
              deleteIssue: async () => {},
            },
          }),
        ),
      /preflight failed/,
    );
    assert.equal(createCalls, 0);
    assert.equal(existsSync(join(root, "private")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
