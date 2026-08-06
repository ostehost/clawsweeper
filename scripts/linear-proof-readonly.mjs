#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLinearTransport,
  LinearItemSource,
  parseLinearIdentifier,
} from "../dist/linear/index.js";
import {
  buildItemPlan,
  resolveReadToken,
  resolveWriteDecision,
  summarize,
} from "./linear-comment-apply.mjs";
import { runLinearSchemaConformance } from "./linear-schema-conformance.mjs";

export const READONLY_PROOF_COMMAND_VERSION = "1";

export const FORBIDDEN_LINEAR_DOCUMENTS = Object.freeze([
  { name: "bare mutation", source: "mutation Forbidden { issueUpdate { success } }" },
  {
    name: "comment-prefixed mutation",
    source: "# legal leading comment\nmutation Forbidden { issueUpdate { success } }",
  },
  {
    name: "BOM commas and whitespace before mutation",
    source: "\uFEFF, , \n\tmutation Forbidden { issueUpdate { success } }",
  },
  {
    name: "multiple comments before mutation",
    source: "# first\n# second\nmutation Forbidden { issueUpdate { success } }",
  },
  {
    name: "CRLF comment before mutation",
    source: "# first\r\n# second\r\nmutation Forbidden { issueUpdate { success } }",
  },
  { name: "capitalized mutation keyword", source: "Mutation { issueUpdate { success } }" },
  { name: "uppercase mutation keyword", source: "MUTATION { issueUpdate { success } }" },
  {
    name: "mixed query and mutation",
    source: "query Allowed { viewer { id } } mutation Forbidden { issueUpdate { success } }",
  },
  { name: "subscription", source: "subscription Forbidden { issueUpdated { id } }" },
  { name: "fragment only", source: "fragment Orphan on Issue { id }" },
  { name: "multiple queries", source: "query One { viewer { id } } query Two { viewer { id } }" },
  { name: "type-system definition", source: "type Query { viewer: String }" },
  { name: "malformed document", source: "query Broken { viewer { id }" },
  {
    name: "oversized ignored comment",
    source: `#${"x".repeat(100_001)}\nquery Allowed { viewer { id } }`,
  },
]);

const READ_DOCUMENT_ERROR =
  "Linear transport is read-only; exactly one valid GraphQL query operation is required; mutations are disabled";

export function parseArgs(argv) {
  const options = {
    identifier: "",
    fixtureAlias: "",
    out: "",
    baseTip: "upstream/main",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--identifier":
        options.identifier = requireValue(argv, ++index, arg);
        break;
      case "--fixture-alias":
        options.fixtureAlias = requireValue(argv, ++index, arg);
        break;
      case "--out":
        options.out = requireValue(argv, ++index, arg);
        break;
      case "--base-tip":
      case "--base":
        options.baseTip = requireValue(argv, ++index, arg);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.identifier === "") {
    throw new Error("--identifier <KEY> is required");
  }
  if (!options.help && options.out === "") {
    throw new Error("--out <artifact> is required");
  }
  if (!options.help && options.fixtureAlias === "") {
    throw new Error("--fixture-alias <alias> is required for a public-safe receipt");
  }
  if (options.fixtureAlias !== "" && !/^[A-Za-z0-9._-]{1,80}$/.test(options.fixtureAlias)) {
    throw new Error(
      "--fixture-alias must use 1-80 public-safe letters, numbers, dots, dashes, or underscores",
    );
  }
  if (!options.help) {
    try {
      parseLinearIdentifier(options.identifier);
    } catch {
      throw new Error("--identifier must use the <TEAM>-<number> form");
    }
  }

  return options;
}

export async function exerciseForbiddenDocuments() {
  let fetchCallCount = 0;
  let sleepCallCount = 0;
  let rejectionCount = 0;
  const failures = [];
  const transport = createLinearTransport({
    token: "readonly-proof-sentinel",
    endpoint: "https://readonly-proof.invalid/graphql",
    fetchImpl: async () => {
      fetchCallCount += 1;
      throw new TypeError("sentinel fetch invoked", { cause: { code: "ECONNRESET" } });
    },
    maxRetries: 2,
    sleep: async () => {
      sleepCallCount += 1;
    },
  });

  for (const testCase of FORBIDDEN_LINEAR_DOCUMENTS) {
    try {
      await transport(testCase.source, {});
      failures.push(testCase.name);
    } catch (error) {
      if (error instanceof Error && error.message === READ_DOCUMENT_ERROR) {
        rejectionCount += 1;
      } else {
        failures.push(testCase.name);
      }
    }
  }

  if (
    failures.length !== 0 ||
    rejectionCount !== FORBIDDEN_LINEAR_DOCUMENTS.length ||
    fetchCallCount !== 0 ||
    sleepCallCount !== 0
  ) {
    throw new Error("read-only GraphQL boundary proof failed");
  }

  return {
    caseCount: FORBIDDEN_LINEAR_DOCUMENTS.length,
    rejectionCount,
    fetchCallCount,
    sleepCallCount,
  };
}

export async function runReadonlyProof(options, deps = {}) {
  assertNode24();
  const parsedIdentifier = parseLinearIdentifier(options.identifier);
  const canonicalIdentifier = `${parsedIdentifier.teamKey}-${parsedIdentifier.number}`;
  const fixtureAlias = options.fixtureAlias;
  const schemaConformance =
    deps.schemaConformance ?? (await runLinearSchemaConformance(deps.schemaDeps));
  const forbiddenBoundary = await exerciseForbiddenDocuments();

  let liveReadRequestCount = 0;
  const delegateFetch = deps.fetchImpl ?? fetch;
  const countedFetch = async (input, init) => {
    liveReadRequestCount += 1;
    return delegateFetch(input, init);
  };
  const transportOptions = {
    token: options.token,
    fetchImpl: countedFetch,
    ...(deps.endpoint === undefined ? {} : { endpoint: deps.endpoint }),
  };
  const source = new LinearItemSource(createLinearTransport(transportOptions));
  const result = await buildItemPlan(source, {
    identifier: canonicalIdentifier,
    nowIso: "2000-01-01T00:00:00Z",
  });

  const issueIdentityMatched =
    result.hydrated.issue.identifier === canonicalIdentifier &&
    result.record.identifier === canonicalIdentifier;
  const expectedTeamMatched =
    result.hydrated.team.key === parsedIdentifier.teamKey &&
    result.record.workspaceSlug === `linear-${result.hydrated.team.key.toLowerCase()}`;
  const mappingAssertionsPassed =
    issueIdentityMatched &&
    expectedTeamMatched &&
    result.record.id === result.hydrated.issue.id &&
    result.record.snapshotHash.length === 64;
  if (liveReadRequestCount < 1 || !mappingAssertionsPassed) {
    throw new Error("live Linear read or source mapping proof failed");
  }

  const mode = { live: false, reason: "read-only behavior proof" };
  const decision = resolveWriteDecision(result, mode);
  const summary = summarize(result, mode);
  const applied = false;
  if (summary.wouldWrite !== false || decision.write !== false || applied !== false) {
    throw new Error("proposal-only decision proof failed");
  }

  const metadata = options.git;
  assertGitMetadata(metadata);
  const coreReceipt = {
    schemaVersion: "linear-readonly-proof/v1",
    head: metadata.head,
    tree: metadata.tree,
    mergeBase: metadata.mergeBase,
    baseTip: metadata.baseTip,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    proofCommandVersion: READONLY_PROOF_COMMAND_VERSION,
    fixture: { alias: fixtureAlias },
    schemaConformance,
    liveRead: {
      requestCount: liveReadRequestCount,
      issueIdentityMatched,
      expectedTeamMatched,
      mappingAssertionsPassed,
    },
    proposalOnly: {
      wouldWrite: summary.wouldWrite,
      applied,
      decisionWrite: decision.write,
      writeTransportConstructed: false,
      oauthTokenMintUsed: false,
    },
    forbiddenBoundary,
    limits: [
      "Proves one dedicated issue read through the production transport, source mapper, and proposal path.",
      "Proves the deterministic forbidden-document matrix is rejected before fetch, retry, or sleep.",
      "Does not prove scheduler or webhook operation, broad workspace coverage, write recovery, OAuth, comments, labels, workflow or priority mutation, Worker/R2 publication, deployment, merge safety, or OpenClaw Bay behavior.",
      "No live mutation is attempted; zero forbidden transport invocation is the mutation-boundary proof.",
      "artifactSha256 covers the canonical receipt fields excluding artifactSha256.",
    ],
  };
  const artifactSha256 = sha256(JSON.stringify(coreReceipt));
  return { ...coreReceipt, artifactSha256 };
}

export function writePublicReceipt(path, receipt) {
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
  return { receiptFileSha256: sha256(serialized) };
}

function gitValue(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function resolveGitMetadata(baseRef) {
  const trackedStatus = gitValue(["status", "--porcelain=v1", "--untracked-files=no"]);
  if (trackedStatus !== "") {
    throw new Error("proof requires a clean tracked worktree at the exact committed head");
  }
  const head = gitValue(["rev-parse", "HEAD^{commit}"]);
  const baseTip = gitValue(["rev-parse", `${baseRef}^{commit}`]);
  return {
    head,
    tree: gitValue(["rev-parse", "HEAD^{tree}"]),
    mergeBase: gitValue(["merge-base", head, baseTip]),
    baseTip,
  };
}

function resolvePhysicalPath(path) {
  const tail = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...tail);
}

export function assertSafeOutputPath(path) {
  const repoRoot = realpathSync(gitValue(["rev-parse", "--show-toplevel"]));
  const absolutePath = resolvePhysicalPath(path);
  const relativePath = relative(repoRoot, absolutePath);
  const outsideRepository =
    relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
  if (!outsideRepository) {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", relativePath], {
        cwd: repoRoot,
        stdio: "ignore",
      });
    } catch {
      throw new Error("proof output inside the repository must be under an ignored path");
    }
  }
  return absolutePath;
}

function assertGitMetadata(metadata) {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !/^[a-f0-9]{40}$/.test(metadata.head ?? "") ||
    !/^[a-f0-9]{40}$/.test(metadata.tree ?? "") ||
    !/^[a-f0-9]{40}$/.test(metadata.mergeBase ?? "") ||
    !/^[a-f0-9]{40}$/.test(metadata.baseTip ?? "")
  ) {
    throw new Error(
      "proof requires exact 40-character head, tree, merge-base, and base-tip object ids",
    );
  }
}

function assertNode24() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error("Linear read-only proof requires Node 24 or newer");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage() {
  return `Usage: pnpm linear:proof:readonly -- --identifier <KEY> --fixture-alias <alias> --out <artifact> [options]

Runs a public-safe, proposal-only Linear behavior proof for one dedicated non-production
issue. Raw responses remain in memory. The output receipt contains only allowlisted booleans,
counts, public fixture coordinates, runtime coordinates, explicit limits, and digests.

Options:
  --identifier <KEY>       Dedicated Linear issue identifier (required)
  --fixture-alias <alias>  Required public-safe alias; hides the identifier and team key
  --out <artifact>         Receipt path (required; repository paths must be ignored)
  --base-tip <ref>         Current base tip to resolve (default: upstream/main)
  --help, -h               Show this help message`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    const out = assertSafeOutputPath(options.out);
    const git = resolveGitMetadata(options.baseTip);
    const token = resolveReadToken();
    const receipt = await runReadonlyProof({ ...options, token, git });
    const { receiptFileSha256 } = writePublicReceipt(out, receipt);
    console.log(
      JSON.stringify({
        status: "ok",
        artifactSha256: receipt.artifactSha256,
        receiptFileSha256,
      }),
    );
  } catch {
    // Never print provider responses or mapped issue errors from a failed live proof.
    console.error("Linear read-only proof failed without writing a public receipt");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
