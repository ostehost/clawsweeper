import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSafeOutputPath,
  parseArgs,
  runReadonlyProof,
  writePublicReceipt,
} from "../scripts/linear-proof-readonly.mjs";

test("proof package commands build the tracked TypeScript before loading dist", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  assert.equal(
    packageJson.scripts?.["linear:proof:readonly"],
    "pnpm run build && node scripts/linear-proof-readonly.mjs",
  );
  assert.equal(
    packageJson.scripts?.["linear:test:schema"],
    "pnpm run build && node scripts/linear-schema-conformance.mjs",
  );
});

test("proof output containment rejects an in-repository name beginning with two dots", () => {
  assert.match(assertSafeOutputPath(".artifacts/linear-proof.json"), /linear-proof\.json$/);
  assert.throws(
    () => assertSafeOutputPath("..proof/receipt.json"),
    /must be under an ignored path/,
  );
});

const GIT_COORDINATES = {
  head: "1".repeat(40),
  tree: "2".repeat(40),
  mergeBase: "3".repeat(40),
  baseTip: "4".repeat(40),
};

const SCHEMA_CONFORMANCE = {
  schemaCommit: "eabc85d0df87617b4647e56d2f236e60bc2ed117",
  schemaSha256: "5".repeat(64),
  schemaBytes: 1_270_042,
  readDocumentCount: 5,
  retainedMutationDocumentCount: 4,
  e2eFixtureMutationDocumentCount: 2,
  allDocumentsValid: true,
};

function liveIssueNode() {
  return {
    id: "PRIVATE_ISSUE_ID",
    identifier: "PRF-1",
    title: "PRIVATE_ISSUE_TITLE",
    description: "PRIVATE_ISSUE_DESCRIPTION",
    url: "https://linear.app/private/issue/PRF-1",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    priority: 2,
    creator: { id: "PRIVATE_CREATOR_ID", name: "PRIVATE_CREATOR_NAME", admin: false },
    team: { id: "PRIVATE_TEAM_ID", key: "PRF", name: "PRIVATE_TEAM_NAME" },
    project: { id: "PRIVATE_PROJECT_ID", name: "PRIVATE_PROJECT_NAME", state: "started" },
    state: { id: "PRIVATE_STATE_ID", name: "Backlog", type: "backlog" },
    labels: {
      nodes: [{ id: "PRIVATE_LABEL_ID", name: "PRIVATE_LABEL_NAME" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    attachments: {
      nodes: [
        {
          id: "PRIVATE_ATTACHMENT_ID",
          url: "https://private.invalid/attachment",
          title: "PRIVATE_ATTACHMENT_TITLE",
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    comments: {
      nodes: [
        {
          id: "PRIVATE_COMMENT_ID",
          body: "PRIVATE_COMMENT_BODY",
          createdAt: "2026-08-02T01:00:00Z",
          botActor: null,
          user: { id: "PRIVATE_COMMENT_ACTOR_ID", name: "PRIVATE_COMMENT_ACTOR_NAME" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

test("parseArgs requires one fixture and output while allowing a public alias and explicit base tip", () => {
  assert.deepEqual(
    parseArgs([
      "--identifier",
      "prf-1",
      "--fixture-alias",
      "readonly-fixture",
      "--out",
      ".artifacts/proof.json",
      "--base-tip",
      "upstream/main",
    ]),
    {
      identifier: "prf-1",
      fixtureAlias: "readonly-fixture",
      out: ".artifacts/proof.json",
      baseTip: "upstream/main",
      help: false,
    },
  );
  assert.throws(() => parseArgs(["--out", "proof.json"]), /--identifier/);
  assert.throws(
    () => parseArgs(["--identifier", "PRF-1", "--out", "proof.json"]),
    /--fixture-alias/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--identifier",
        "private team key",
        "--fixture-alias",
        "readonly-fixture",
        "--out",
        "proof.json",
      ]),
    /<TEAM>-<number>/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--identifier",
        "PRF-1",
        "--fixture-alias",
        "private alias",
        "--out",
        "proof.json",
      ]),
    /public-safe/,
  );
});

test("runReadonlyProof emits only the public allowlist after the real transport and mapper path", async () => {
  let liveFetchCalls = 0;
  let rawAuthorization = "";
  let postedVariables: Record<string, unknown> | undefined;
  const fakeFetch: typeof fetch = async (_input, init) => {
    liveFetchCalls += 1;
    rawAuthorization = ((init?.headers ?? {}) as Record<string, string>)["Authorization"] ?? "";
    const body = JSON.parse(String(init?.body)) as {
      variables?: Record<string, unknown>;
    };
    postedVariables = body.variables;
    return new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: [liveIssueNode()],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      { status: 200 },
    );
  };

  const receipt = await runReadonlyProof(
    {
      identifier: "PRF-1",
      fixtureAlias: "readonly-fixture",
      token: "PRIVATE_TOKEN_VALUE",
      git: GIT_COORDINATES,
    },
    {
      endpoint: "https://private-endpoint.invalid/graphql",
      fetchImpl: fakeFetch,
      schemaConformance: SCHEMA_CONFORMANCE,
    },
  );

  assert.equal(liveFetchCalls, 1);
  assert.equal(rawAuthorization, "PRIVATE_TOKEN_VALUE");
  assert.deepEqual(postedVariables, {
    teamKey: "PRF",
    number: 1,
    first: 1,
    commentFirst: 100,
  });
  assert.deepEqual(Object.keys(receipt), [
    "schemaVersion",
    "head",
    "tree",
    "mergeBase",
    "baseTip",
    "nodeVersion",
    "platform",
    "proofCommandVersion",
    "fixture",
    "schemaConformance",
    "liveRead",
    "proposalOnly",
    "forbiddenBoundary",
    "limits",
    "artifactSha256",
  ]);
  assert.deepEqual(receipt.fixture, { alias: "readonly-fixture" });
  assert.doesNotMatch(JSON.stringify(receipt.fixture), /PRF/);
  assert.deepEqual(receipt.schemaConformance, SCHEMA_CONFORMANCE);
  assert.deepEqual(receipt.liveRead, {
    requestCount: 1,
    issueIdentityMatched: true,
    expectedTeamMatched: true,
    mappingAssertionsPassed: true,
  });
  assert.deepEqual(receipt.proposalOnly, {
    wouldWrite: false,
    applied: false,
    decisionWrite: false,
    writeTransportConstructed: false,
    oauthTokenMintUsed: false,
  });
  assert.equal(receipt.forbiddenBoundary.caseCount, receipt.forbiddenBoundary.rejectionCount);
  assert.equal(receipt.forbiddenBoundary.fetchCallCount, 0);
  assert.equal(receipt.forbiddenBoundary.sleepCallCount, 0);

  const { artifactSha256, ...coreReceipt } = receipt;
  assert.equal(
    artifactSha256,
    createHash("sha256").update(JSON.stringify(coreReceipt)).digest("hex"),
  );

  const serialized = JSON.stringify(receipt);
  for (const privateValue of [
    "PRIVATE_TOKEN_VALUE",
    "private-endpoint",
    "PRIVATE_ISSUE_ID",
    "PRIVATE_ISSUE_TITLE",
    "PRIVATE_ISSUE_DESCRIPTION",
    "PRIVATE_CREATOR_ID",
    "PRIVATE_PROJECT_ID",
    "PRIVATE_COMMENT_BODY",
    "PRIVATE_COMMENT_ACTOR_ID",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue));
  }
});

test("writePublicReceipt writes the allowlisted JSON and reports its exact file digest", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-linear-proof-"));
  try {
    const path = join(root, "nested", "receipt.json");
    const receipt = { schemaVersion: "test", artifactSha256: "a".repeat(64) };
    const result = writePublicReceipt(path, receipt);
    const serialized = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(serialized), receipt);
    assert.equal(result.receiptFileSha256, createHash("sha256").update(serialized).digest("hex"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
