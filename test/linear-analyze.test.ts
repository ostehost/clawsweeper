import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeItem,
  buildAnalysisPrompt,
  buildHarnessInputs,
  collectIssueUrls,
  loadFallbackOwners,
  parseArgs,
  repoInferenceItemFor,
  toAnalyzerDecision,
} from "../scripts/linear-analyze.mjs";
import { buildRepoCatalog } from "../dist/linear/repo-infer.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHydrated(overrides = {}) {
  return {
    team: { id: "t1", key: "PAR", name: "Partner" },
    project: null,
    issue: {
      id: "uuid-1",
      identifier: "PAR-42",
      title: "fix the clawhub widget",
      url: "https://linear.app/x/issue/PAR-42",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      teamId: "t1",
      projectId: null,
      stateId: "s",
      stateName: "Todo",
      stateType: "unstarted",
      priority: 2,
      labels: [{ id: "l1", name: "clawhub" }],
    },
    comments: [],
    attachments: [],
    description: "",
    ...overrides,
  };
}

const NOW = "2026-01-03T00:00:00Z"; // 1 day after updatedAt → eligible "review"

function makeModelDecision(overrides = {}) {
  return {
    decision: "close",
    closeReason: "implemented_on_main",
    confidence: "high",
    changeSummary: "Adds the widget on main.",
    evidence: [
      {
        label: "implemented",
        detail: "see src/widget.ts",
        file: "src/widget.ts",
        line: 10,
        command: "git log -1",
        sha: "deadbeef",
      },
    ],
    reproductionStatus: "not_applicable",
    reproductionAssessment: "N/A",
    workReason: "Already on main.",
    bestSolution: "Close as implemented.",
    ...overrides,
  };
}

const CATALOG = buildRepoCatalog([
  { owner: "openclaw", allowRepoNamePattern: /^[A-Za-z0-9_.-]+$/ },
]);

function baseDeps(overrides = {}) {
  const hydrated = overrides.hydrated ?? makeHydrated();
  return {
    catalog: CATALOG,
    repoInferenceItem: repoInferenceItemFor(hydrated),
    repoHead: "headsha",
    verifySha: () => true,
    runModel: async () => makeModelDecision(),
    modelId: "internal",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs: --analyze OFF by default", () => {
  const o = parseArgs(["--identifier", "PAR-1"]);
  assert.equal(o.identifier, "PAR-1");
  assert.equal(o.analyze, false);
});

test("parseArgs: --analyze opt-in, --dry-run resets it, unknown rejected", () => {
  assert.equal(parseArgs(["--analyze"]).analyze, true);
  assert.equal(parseArgs(["--analyze", "--dry-run"]).analyze, false);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument: --nope/);
});

// ---------------------------------------------------------------------------
// loadFallbackOwners
// ---------------------------------------------------------------------------

test("loadFallbackOwners reads generic_fallbacks owners + patterns", () => {
  const json = JSON.stringify({
    generic_fallbacks: [
      { owner: "openclaw", allow_repo_name_pattern: "^[A-Za-z0-9_.-]+$" },
      { owner: "steipete", allow_repo_name_pattern: "^x" },
    ],
  });
  const owners = loadFallbackOwners({ readFileSync: () => json });
  assert.equal(owners.length, 2);
  assert.equal(owners[0].owner, "openclaw");
  assert.ok(owners[0].allowRepoNamePattern instanceof RegExp);
});

test("loadFallbackOwners returns [] on a missing/unreadable config", () => {
  const owners = loadFallbackOwners({
    readFileSync: () => {
      throw new Error("ENOENT");
    },
  });
  assert.deepEqual(owners, []);
});

// ---------------------------------------------------------------------------
// collectIssueUrls / buildHarnessInputs / buildAnalysisPrompt
// ---------------------------------------------------------------------------

test("collectIssueUrls pulls attachment + description github urls (not the linear self-url)", () => {
  const h = makeHydrated({
    attachments: [{ url: "https://github.com/openclaw/clawhub/issues/5" }],
    description: "see https://github.com/openclaw/fs-safe/pull/2 too",
  });
  const urls = collectIssueUrls(h);
  assert.ok(urls.includes("https://github.com/openclaw/clawhub/issues/5"));
  assert.ok(urls.some((u) => u.includes("fs-safe")));
  assert.ok(!urls.includes("https://linear.app/x/issue/PAR-42"));
});

test("buildHarnessInputs maps a Linear issue into a read-only Item with the numeric id", () => {
  const profile = repositoryProfileFor("openclaw/clawhub");
  const { item, context, git } = buildHarnessInputs(makeHydrated(), profile, "mainsha");
  assert.equal(item.repo, "openclaw/clawhub");
  assert.equal(item.number, 42);
  assert.equal(item.kind, "issue");
  assert.equal(git.mainSha, "mainsha");
  assert.equal(context.issue.identifier, "PAR-42");
});

test("buildAnalysisPrompt instructs read-only git + schema-bound output", () => {
  const profile = repositoryProfileFor("openclaw/clawhub");
  const prompt = buildAnalysisPrompt(makeHydrated(), profile, "mainsha");
  assert.ok(/READ-ONLY/i.test(prompt));
  assert.ok(/git blame\/log\/show/.test(prompt));
  assert.ok(/never closes/.test(prompt));
});

// ---------------------------------------------------------------------------
// toAnalyzerDecision
// ---------------------------------------------------------------------------

test("toAnalyzerDecision maps schema fields verbatim, normalizing missing evidence fields", () => {
  const d = toAnalyzerDecision(makeModelDecision());
  assert.equal(d.closeReason, "implemented_on_main");
  assert.equal(d.evidence[0].sha, "deadbeef");
  assert.equal(d.changeSummary, "Adds the widget on main.");
});

// ---------------------------------------------------------------------------
// analyzeItem — guardrails: --analyze gate, eligibility, ambiguity, idempotency
// ---------------------------------------------------------------------------

test("analyzeItem: dry-run (analyze off) never calls the model and writes nothing", async () => {
  let called = false;
  const deps = baseDeps({
    runModel: async () => {
      called = true;
      return makeModelDecision();
    },
  });
  const summary = await analyzeItem(makeHydrated(), { nowIso: NOW, analyze: false }, deps);
  assert.equal(called, false);
  assert.equal(summary.analyzed, false);
  assert.match(summary.skipped, /dry-run/);
  assert.equal(summary.recordBody, undefined);
});

test("analyzeItem: ineligible (closed) item is skipped before repo inference", async () => {
  const closed = makeHydrated();
  closed.issue.stateType = "completed";
  const deps = baseDeps({ hydrated: closed, repoInferenceItem: repoInferenceItemFor(closed) });
  const summary = await analyzeItem(closed, { nowIso: NOW, analyze: true }, deps);
  assert.equal(summary.analyzed, false);
  assert.match(summary.skipped, /ineligible/);
});

test("analyzeItem: ambiguous repo is skipped, never analyzed", async () => {
  const h = makeHydrated();
  h.issue.labels = [{ id: "x", name: "bug" }]; // no known repo, no owner token
  const deps = baseDeps({ hydrated: h, repoInferenceItem: repoInferenceItemFor(h) });
  const summary = await analyzeItem(h, { nowIso: NOW, analyze: true }, deps);
  assert.equal(summary.analyzed, false);
  assert.match(summary.skipped, /repo ambiguous/);
});

test("analyzeItem: --analyze runs the model, derives closeLeaning, plans a comment, writes a record", async () => {
  const deps = baseDeps();
  const summary = await analyzeItem(makeHydrated(), { nowIso: NOW, analyze: true }, deps);
  assert.equal(summary.analyzed, true);
  assert.equal(summary.repo, "openclaw/clawhub");
  assert.equal(summary.closeReason, "implemented_on_main");
  assert.equal(summary.closeLeaning, true); // high-confidence implemented_on_main, sha verified
  assert.ok(["create", "update"].includes(summary.planAction));
  assert.ok(summary.recordBody.includes("**Summary**"));
  assert.ok(summary.recordBody.startsWith("---\n"));
  assert.equal(summary.recordPath, "records/linear-par/items/PAR-42.md");
});

test("analyzeItem: an unverifiable cited sha forces closeLeaning=false (host re-verification)", async () => {
  const deps = baseDeps({ verifySha: () => false });
  const summary = await analyzeItem(makeHydrated(), { nowIso: NOW, analyze: true }, deps);
  assert.equal(summary.analyzed, true);
  assert.equal(summary.closeLeaning, false);
  assert.equal(summary.shaVerification.allVerified, false);
});

test("analyzeItem: never closeLeaning for a closeReason outside the issue auto-close rule", async () => {
  // stale_insufficient_info is evidence-bearing but not in any profile's issue rule.
  const deps = baseDeps({
    runModel: async () => makeModelDecision({ closeReason: "stale_insufficient_info" }),
  });
  const summary = await analyzeItem(makeHydrated(), { nowIso: NOW, analyze: true }, deps);
  assert.equal(summary.analyzed, true);
  assert.equal(summary.closeLeaning, false);
  assert.equal(summary.autoCloseAllowed, false);
});

test("analyzeItem: unchanged fingerprint short-circuits re-analysis (idempotency)", async () => {
  // First run to compute the fingerprint.
  const first = await analyzeItem(makeHydrated(), { nowIso: NOW, analyze: true }, baseDeps());
  let called = false;
  const deps = baseDeps({
    persistedFingerprint: first.fingerprint,
    runModel: async () => {
      called = true;
      return makeModelDecision();
    },
  });
  const second = await analyzeItem(makeHydrated(), { nowIso: NOW, analyze: true }, deps);
  assert.equal(called, false);
  assert.equal(second.analyzed, false);
  assert.match(second.skipped, /fingerprint unchanged/);
});
