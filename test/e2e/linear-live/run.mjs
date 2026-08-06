import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { createLinearTransport, LinearItemSource } from "../../../dist/linear/index.js";
import {
  assertNode24,
  assertSafeOutputPath,
  FORBIDDEN_LINEAR_DOCUMENTS,
  READONLY_PROOF_LIMITS,
  resolveGitMetadata,
} from "../../../scripts/linear-proof-readonly.mjs";
import { runLinearSchemaConformance } from "../../../scripts/linear-schema-conformance.mjs";
import {
  buildLinearLiveFixture,
  ISSUE_CREATE_E2E_FIXTURE_MUTATION,
  ISSUE_DELETE_E2E_FIXTURE_MUTATION,
  LINEAR_LIVE_FIXTURE_CONTRACT,
} from "../../../scripts/e2e/linear-live-fixture.mjs";

export const LINEAR_LIVE_E2E_SCENARIO = "ephemeral-readonly";
export const LINEAR_LIVE_E2E_SCHEMA_VERSION = "linear-live-e2e/v1";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const TEAM_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ALIAS_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const SAFE_CHILD_ENV_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
]);

let activeCleanup = null;
let signalCleanupInstalled = false;

class LinearLiveE2EError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

export function validateLinearLiveOptions(options) {
  if (options.scenario !== LINEAR_LIVE_E2E_SCENARIO) {
    throw new LinearLiveE2EError("preflight", "unsupported Linear live E2E scenario");
  }
  if (options.fixture !== LINEAR_LIVE_FIXTURE_CONTRACT) {
    throw new LinearLiveE2EError("preflight", "unsupported Linear live E2E fixture contract");
  }
  if (!TEAM_UUID_PATTERN.test(String(options.teamId ?? ""))) {
    throw new LinearLiveE2EError("preflight", "--team-id must be an explicit Linear team UUID");
  }
  if (!PUBLIC_ALIAS_PATTERN.test(String(options.fixtureAlias ?? ""))) {
    throw new LinearLiveE2EError("preflight", "--fixture-alias must be public-safe");
  }
  const setupToken = String(options.setupToken ?? "").trim();
  const readToken = String(options.readToken ?? "").trim();
  if (setupToken === "" || readToken === "") {
    throw new LinearLiveE2EError("preflight", "separate setup and read credentials are required");
  }
  if (setupToken === readToken) {
    throw new LinearLiveE2EError("preflight", "setup and read credentials must be distinct");
  }
  return { setupToken, readToken };
}

export function buildReadonlyChildEnv(parentEnv, readToken) {
  const childEnv = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string" && value !== "") childEnv[key] = value;
  }
  childEnv.LINEAR_API_KEY = readToken;
  return childEnv;
}

export function createLinearFixtureClient({
  setupToken,
  fetchImpl = fetch,
  endpoint = LINEAR_ENDPOINT,
} = {}) {
  async function fixedMutation(source, variables, operation, errorMessage) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: setupToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: source, variables, operationName: operation }),
      });
    } catch {
      throw new Error(errorMessage);
    }
    if (!response.ok) throw new Error(errorMessage);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(errorMessage);
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      (Array.isArray(payload.errors) && payload.errors.length > 0)
    ) {
      throw new Error(errorMessage);
    }
    return payload.data;
  }

  return Object.freeze({
    async createIssue(teamId, correlationId) {
      const data = await fixedMutation(
        ISSUE_CREATE_E2E_FIXTURE_MUTATION,
        { input: { teamId, ...buildLinearLiveFixture(correlationId) } },
        "IssueCreateE2EFixture",
        "Linear E2E fixture creation failed",
      );
      const payload = data?.issueCreate;
      if (
        payload?.success !== true ||
        typeof payload.issue?.id !== "string" ||
        payload.issue.id === "" ||
        typeof payload.issue?.identifier !== "string" ||
        payload.issue.identifier === ""
      ) {
        throw new Error("Linear E2E fixture creation failed");
      }
      return { id: payload.issue.id, identifier: payload.issue.identifier };
    },
    async deleteIssue(issueId) {
      const data = await fixedMutation(
        ISSUE_DELETE_E2E_FIXTURE_MUTATION,
        { id: issueId },
        "IssueDeleteE2EFixture",
        "Linear E2E fixture cleanup failed",
      );
      if (data?.issueDelete?.success !== true) {
        throw new Error("Linear E2E fixture cleanup failed");
      }
    },
  });
}

export function runReadonlyChild({
  candidateRoot,
  identifier,
  fixtureAlias,
  baseTip,
  out,
  readToken,
  parentEnv = process.env,
}) {
  const child = spawnSync(
    process.execPath,
    [
      path.join(candidateRoot, "scripts/linear-proof-readonly.mjs"),
      "--identifier",
      identifier,
      "--fixture-alias",
      fixtureAlias,
      "--base-tip",
      baseTip,
      "--out",
      out,
    ],
    {
      cwd: candidateRoot,
      env: buildReadonlyChildEnv(parentEnv, readToken),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.error || child.status !== 0) {
    throw new LinearLiveE2EError("readonly-proof", "inner Linear read-only proof failed");
  }
  let terminal;
  let receipt;
  try {
    terminal = JSON.parse(child.stdout);
    receipt = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    throw new LinearLiveE2EError("readonly-proof", "inner Linear read-only receipt is invalid");
  }
  if (
    terminal.status !== "ok" ||
    terminal.artifactSha256 !== receipt.artifactSha256 ||
    terminal.receiptFileSha256 !== sha256(readFileSync(out))
  ) {
    throw new LinearLiveE2EError("readonly-proof", "inner Linear read-only receipt is invalid");
  }
  return { receipt, receiptFileSha256: terminal.receiptFileSha256 };
}

export async function verifyFixtureAbsent({
  identifier,
  readToken,
  fetchImpl = fetch,
  endpoint,
  maxAttempts = 5,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const source = new LinearItemSource(
    createLinearTransport({
      token: readToken,
      fetchImpl,
      ...(endpoint === undefined ? {} : { endpoint }),
    }),
  );
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if ((await source.fetchIssueByIdentifier(identifier)) === null) return true;
    if (attempt + 1 < maxAttempts) await sleep(1_000);
  }
  return false;
}

export function installLinearLiveSignalCleanup() {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.once(signal, async () => {
      try {
        if (activeCleanup !== null) await activeCleanup();
      } finally {
        process.exit(exitCode);
      }
    });
  }
}

export async function runLinearLiveE2E(options, deps = {}) {
  const candidateRoot = path.resolve(options.candidateRoot ?? process.cwd());
  let outputRoot = path.resolve(options.outputRoot);
  let paths = outputPaths(outputRoot);
  let metadata;
  let schemaConformance;
  let fixture = null;
  let stage = "preflight";
  let readonlyResult = null;
  let readonlyValidated = false;
  let cleanupVerified = false;
  let cleanupPromise = null;
  let outputSafe = false;
  let leaseAcquired = false;
  let existingRecovery = false;
  let correlationId = "";
  const counts = { create: 0, delete: 0 };
  let credentials;
  let mutationClient;
  const writeStep = (name, status) =>
    writeJson(path.join(paths.steps, `${name}.json`), { name, status });

  const cleanupOnce = async () => {
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async () => {
      if (fixture === null) return;
      try {
        counts.delete += 1;
        await mutationClient.deleteIssue(fixture.id);
        cleanupVerified = await (deps.verifyCleanup ?? verifyFixtureAbsent)({
          identifier: fixture.identifier,
          readToken: credentials.readToken,
          fetchImpl: deps.readFetchImpl,
          endpoint: deps.readEndpoint,
        });
        if (!cleanupVerified) throw new Error("cleanup verification failed");
        rmSync(paths.recovery, { force: true });
        writeStep("cleanup", "passed");
      } catch {
        writeStep("cleanup", "failed");
        throw new LinearLiveE2EError("cleanup", "Linear E2E fixture cleanup failed");
      }
    })();
    return cleanupPromise;
  };

  try {
    assertNode24();
    if ((deps.platform ?? process.platform) === "win32") {
      throw new LinearLiveE2EError(
        "preflight",
        "Linear live E2E requires POSIX recovery-file permissions",
      );
    }
    credentials = validateLinearLiveOptions(options);
    assertRequestedOutputEntriesSafe(outputRoot, paths);
    outputRoot = resolveSafeOutputRoot(outputRoot);
    paths = outputPaths(outputRoot);
    prepareSafeOutputTree(outputRoot, paths);
    outputSafe = true;
    metadata = (deps.resolveGit ?? resolveGitMetadata)(options.baseTip);
    schemaConformance =
      deps.schemaConformance ?? (await runLinearSchemaConformance(deps.schemaDeps));
    acquireExclusiveLease(paths.lease);
    leaseAcquired = true;
    existingRecovery = existsSync(paths.recovery);
    if (existingRecovery) {
      throw new LinearLiveE2EError(
        "preflight",
        "an unresolved private Linear E2E recovery record already exists",
      );
    }
    rmSync(paths.summary, { force: true });
    rmSync(paths.innerReceipt, { force: true });
    rmSync(paths.steps, { recursive: true, force: true });
    mkdirSync(paths.steps, { recursive: true, mode: 0o700 });
    writeStep("preflight", "passed");

    mutationClient =
      deps.mutationClient ??
      createLinearFixtureClient({
        setupToken: credentials.setupToken,
        fetchImpl: deps.setupFetchImpl,
        endpoint: deps.setupEndpoint,
      });
    stage = "create";
    correlationId = (deps.randomUUID ?? randomUUID)();
    writePrivateRecovery(paths.recovery, {
      schemaVersion: "linear-live-recovery/v1",
      fixtureContract: LINEAR_LIVE_FIXTURE_CONTRACT,
      status: "create-pending",
      teamId: options.teamId,
      correlationId,
      head: metadata.head,
    });
    activeCleanup = async () => {
      await cleanupOnce();
      if (cleanupVerified) releaseExclusiveLease(paths.lease);
    };
    counts.create += 1;
    fixture = await mutationClient.createIssue(options.teamId, correlationId);
    writePrivateRecovery(paths.recovery, {
      schemaVersion: "linear-live-recovery/v1",
      fixtureContract: LINEAR_LIVE_FIXTURE_CONTRACT,
      status: "created",
      teamId: options.teamId,
      correlationId,
      issueId: fixture.id,
      identifier: fixture.identifier,
      head: metadata.head,
    });
    writeStep("create", "passed");

    stage = "readonly-proof";
    const candidateReadonlyResult = await (deps.runReadonlyProof ?? runReadonlyChild)({
      candidateRoot,
      identifier: fixture.identifier,
      fixtureAlias: options.fixtureAlias,
      baseTip: options.baseTip,
      out: paths.innerReceipt,
      readToken: credentials.readToken,
      parentEnv: options.parentEnv ?? process.env,
    });
    try {
      assertInnerReceipt(
        candidateReadonlyResult.receipt,
        metadata,
        options.fixtureAlias,
        schemaConformance,
      );
      if (!/^[a-f0-9]{64}$/.test(candidateReadonlyResult.receiptFileSha256 ?? "")) {
        throw new LinearLiveE2EError("readonly-proof", "inner Linear read-only receipt is invalid");
      }
    } catch (error) {
      rmSync(paths.innerReceipt, { force: true });
      throw error;
    }
    readonlyResult = candidateReadonlyResult;
    readonlyValidated = true;
    writeStep("readonly-proof", "passed");
  } catch (error) {
    stage = error instanceof LinearLiveE2EError ? error.stage : stage;
  } finally {
    if (fixture !== null) {
      try {
        await cleanupOnce();
      } catch {
        stage = "cleanup";
      }
    }
    activeCleanup = null;
  }

  const passed =
    fixture !== null &&
    readonlyValidated &&
    counts.create === 1 &&
    counts.delete === 1 &&
    cleanupVerified;
  const coreSummary = {
    schemaVersion: LINEAR_LIVE_E2E_SCHEMA_VERSION,
    status: passed ? "passed" : "failed",
    ...(!passed && { stage }),
    scenario: LINEAR_LIVE_E2E_SCENARIO,
    fixtureContract: LINEAR_LIVE_FIXTURE_CONTRACT,
    ...metadata,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    fixtureHarness: {
      alias: options.fixtureAlias,
      operations: {
        create: "IssueCreateE2EFixture",
        cleanup: "IssueDeleteE2EFixture",
      },
      createCount: counts.create,
      deleteCount: counts.delete,
      cleanupVerified,
      cleanupMode: "trashed-recoverable-for-30-days",
      recoveryRequired: existingRecovery || (counts.create > 0 && !cleanupVerified),
    },
    ...(passed
      ? {
          subjectUnderTest: {
            mutationCount: 0,
            schemaConformance,
            liveRead: publicLiveRead(readonlyResult.receipt.liveRead),
            forbiddenBoundary: publicForbiddenBoundary(readonlyResult.receipt.forbiddenBoundary),
            proposalOnly: publicProposalOnly(readonlyResult.receipt.proposalOnly),
            innerArtifactSha256: readonlyResult.receipt.artifactSha256,
            innerReceiptFileSha256: readonlyResult.receiptFileSha256,
          },
        }
      : {}),
    limits: [
      "The fixture harness creates one issue in the explicit caller-owned team and trashes exactly that returned issue after proof.",
      "The subject under test performs authenticated reads only and rejects non-query documents before fetch or retry work.",
      "Linear retains trashed issues for recovery; successful cleanup is removal from the active workspace, not permanent erasure.",
      "SIGKILL, process crash, or network loss can require operator recovery from the private mode-0600 record.",
      "A lost create response can leave an unknown fixture outcome because Linear issueCreate has no harness settlement ledger.",
      "The fixture omits optional project and label relationships and proves one team and one issue only.",
      "This does not prove OAuth, webhooks, scheduling, broad workspace behavior, write recovery, Worker/R2 publication, deployment, merge safety, or OpenClaw Bay behavior.",
      "combinedArtifactSha256 covers the canonical summary fields excluding combinedArtifactSha256.",
    ],
  };
  const summary = {
    ...coreSummary,
    combinedArtifactSha256: sha256(JSON.stringify(coreSummary)),
  };
  if (!outputSafe || !leaseAcquired || existingRecovery) {
    throw new LinearLiveE2EError(stage, "Linear live E2E preflight failed");
  }
  const { fileSha256 } = writePublicSummary(paths.summary, summary);
  if (!summary.fixtureHarness.recoveryRequired && leaseAcquired) {
    releaseExclusiveLease(paths.lease);
  }
  if (!passed) {
    throw new LinearLiveE2EError(stage, "Linear live E2E failed; inspect the public summary");
  }
  return { summary, summaryFileSha256: fileSha256, artifacts: outputRoot };
}

function assertInnerReceipt(receipt, metadata, alias, schemaConformance) {
  if (
    !hasExactKeys(receipt, [
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
    ]) ||
    receipt.schemaVersion !== "linear-readonly-proof/v1" ||
    receipt?.head !== metadata.head ||
    receipt?.tree !== metadata.tree ||
    receipt?.mergeBase !== metadata.mergeBase ||
    receipt?.baseTip !== metadata.baseTip ||
    receipt?.nodeVersion !== process.version ||
    receipt?.platform !== `${process.platform}-${process.arch}` ||
    receipt?.proofCommandVersion !== "1" ||
    !hasExactKeys(receipt?.fixture, ["alias"]) ||
    receipt.fixture.alias !== alias ||
    JSON.stringify(receipt?.schemaConformance) !== JSON.stringify(schemaConformance) ||
    !hasExactKeys(receipt?.liveRead, [
      "requestCount",
      "issueIdentityMatched",
      "expectedTeamMatched",
      "mappingAssertionsPassed",
    ]) ||
    !Number.isInteger(receipt.liveRead.requestCount) ||
    receipt.liveRead.requestCount < 1 ||
    receipt.liveRead.issueIdentityMatched !== true ||
    receipt.liveRead.expectedTeamMatched !== true ||
    receipt?.liveRead?.mappingAssertionsPassed !== true ||
    !hasExactKeys(receipt?.forbiddenBoundary, [
      "caseCount",
      "rejectionCount",
      "fetchCallCount",
      "sleepCallCount",
    ]) ||
    !Number.isInteger(receipt.forbiddenBoundary.caseCount) ||
    !Number.isInteger(receipt.forbiddenBoundary.rejectionCount) ||
    receipt?.forbiddenBoundary?.fetchCallCount !== 0 ||
    receipt?.forbiddenBoundary?.sleepCallCount !== 0 ||
    receipt?.forbiddenBoundary?.caseCount !== FORBIDDEN_LINEAR_DOCUMENTS.length ||
    receipt?.forbiddenBoundary?.rejectionCount !== FORBIDDEN_LINEAR_DOCUMENTS.length ||
    !hasExactKeys(receipt?.proposalOnly, [
      "wouldWrite",
      "applied",
      "decisionWrite",
      "writeTransportConstructed",
      "oauthTokenMintUsed",
    ]) ||
    receipt?.proposalOnly?.wouldWrite !== false ||
    receipt?.proposalOnly?.decisionWrite !== false ||
    receipt?.proposalOnly?.applied !== false ||
    receipt?.proposalOnly?.writeTransportConstructed !== false ||
    receipt?.proposalOnly?.oauthTokenMintUsed !== false ||
    JSON.stringify(receipt?.limits) !== JSON.stringify(READONLY_PROOF_LIMITS) ||
    !/^[a-f0-9]{64}$/.test(receipt?.artifactSha256 ?? "") ||
    !artifactDigestMatches(receipt)
  ) {
    throw new LinearLiveE2EError("readonly-proof", "inner Linear read-only receipt is invalid");
  }
}

function artifactDigestMatches(receipt) {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return false;
  const { artifactSha256, ...core } = receipt;
  return artifactSha256 === sha256(JSON.stringify(core));
}

function publicLiveRead(value) {
  return {
    requestCount: value.requestCount,
    issueIdentityMatched: value.issueIdentityMatched,
    expectedTeamMatched: value.expectedTeamMatched,
    mappingAssertionsPassed: value.mappingAssertionsPassed,
  };
}

function publicForbiddenBoundary(value) {
  return {
    caseCount: value.caseCount,
    rejectionCount: value.rejectionCount,
    fetchCallCount: value.fetchCallCount,
    sleepCallCount: value.sleepCallCount,
  };
}

function publicProposalOnly(value) {
  return {
    wouldWrite: value.wouldWrite,
    applied: value.applied,
    decisionWrite: value.decisionWrite,
    writeTransportConstructed: value.writeTransportConstructed,
    oauthTokenMintUsed: value.oauthTokenMintUsed,
  };
}

function hasExactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function acquireExclusiveLease(directory) {
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  } catch {
    throw new LinearLiveE2EError(
      "preflight",
      "another Linear live E2E run or recovery lease already exists",
    );
  }
}

function releaseExclusiveLease(directory) {
  rmSync(directory, { recursive: true, force: true });
}

function outputPaths(root) {
  const privateRoot = path.join(root, "private");
  return {
    summary: path.join(root, "summary.json"),
    innerReceipt: path.join(root, "readonly-proof.json"),
    privateRoot,
    recovery: path.join(privateRoot, "recovery.json"),
    lease: path.join(privateRoot, "run.lock"),
    steps: path.join(root, "steps"),
  };
}

function prepareSafeOutputTree(root, paths) {
  mkdirSync(root, { recursive: true });
  assertPathKind(root, "directory");
  for (const file of [paths.summary, paths.innerReceipt, paths.recovery]) {
    if (existsSync(file)) assertPathKind(file, "file");
  }
  if (existsSync(paths.steps)) assertPathKind(paths.steps, "directory");
  if (existsSync(paths.privateRoot)) assertPathKind(paths.privateRoot, "directory");
  else mkdirSync(paths.privateRoot, { mode: 0o700 });
  chmodSync(paths.privateRoot, 0o700);
}

function resolveSafeOutputRoot(requestedRoot) {
  const safeRoot = assertSafeOutputPath(requestedRoot);
  const safePaths = outputPaths(safeRoot);
  const artifactPaths = [
    safePaths.summary,
    safePaths.innerReceipt,
    safePaths.privateRoot,
    safePaths.recovery,
    `${safePaths.recovery}.probe.tmp`,
    safePaths.lease,
    safePaths.steps,
    ...["preflight", "create", "readonly-proof", "cleanup"].map((name) =>
      path.join(safePaths.steps, `${name}.json`),
    ),
  ];
  for (const artifactPath of artifactPaths) {
    if (assertSafeOutputPath(artifactPath) !== artifactPath) {
      throw new LinearLiveE2EError(
        "preflight",
        "Linear live E2E output must use one canonical ignored root",
      );
    }
  }
  return safeRoot;
}

function assertRequestedOutputEntriesSafe(root, paths) {
  for (const target of [
    root,
    paths.summary,
    paths.innerReceipt,
    paths.privateRoot,
    paths.recovery,
    paths.steps,
  ]) {
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new LinearLiveE2EError(
        "preflight",
        "Linear live E2E output contains an unsafe filesystem entry",
      );
    }
  }
}

function assertPathKind(target, kind) {
  const stat = lstatSync(target);
  const correctKind = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !correctKind) {
    throw new LinearLiveE2EError(
      "preflight",
      "Linear live E2E output contains an unsafe filesystem entry",
    );
  }
}

function writePrivateRecovery(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    const directoryDescriptor = openSync(path.dirname(file), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function writePublicSummary(file, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serialized, { encoding: "utf8", mode: 0o600 });
  return { fileSha256: sha256(serialized) };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
