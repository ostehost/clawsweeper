import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { serverStrictBaseBindingBlock } from "../../dist/repair/strict-base-binding.js";

const APP_ID = 3306130;
const APP_SLUG = "clawsweeper";
const INSTALLATION_ID = 987654;
const UNIQUE_MAIN_RULESET_ID = 19600001;
const MISSING_UNIQUE_MAIN_POLICY =
  "automerge disabled: GitHub cannot atomically bind the merge base and no non-bypassable rule blocks updates to every non-main branch";
const UNVERIFIABLE_UNIQUE_MAIN_POLICY =
  "automerge disabled: unable to verify the unique-main update restriction";
const NO_ATOMIC_BASE_BINDING =
  "automerge disabled: GitHub merge APIs cannot atomically bind the reviewed base branch";

test("strict base binding still blocks when every observable ruleset is strict", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: fakeGithub({
        rules: [strictRulesetRule()],
        ruleset: strictRulesetDetails(),
      }),
    }),
    NO_ATOMIC_BASE_BINDING,
  );
});

test("strict base binding requires the literal main base before reading policy", () => {
  let policyReads = 0;
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "release",
      ...appIdentity(),
      policyReadJson: () => {
        policyReads += 1;
        return [];
      },
    }),
    "automerge disabled: pull request base branch must be main for strict binding",
  );
  assert.equal(policyReads, 0);
});

test("strict base binding requires an exact non-main update restriction", () => {
  const cases = [
    {
      name: "evaluation-only policy",
      summary: branchRulesetSummary({ enforcement: "evaluate" }),
      details: uniqueMainRulesetDetails({ enforcement: "evaluate" }),
    },
    {
      name: "caller bypass",
      summary: branchRulesetSummary(),
      details: uniqueMainRulesetDetails({ currentUserCanBypass: "always" }),
    },
    {
      name: "default-branch alias exclusion",
      summary: branchRulesetSummary(),
      details: uniqueMainRulesetDetails({ exclude: ["~DEFAULT_BRANCH"] }),
    },
    {
      name: "additional excluded branch",
      summary: branchRulesetSummary(),
      details: uniqueMainRulesetDetails({
        exclude: ["refs/heads/main", "refs/heads/release"],
      }),
    },
    {
      name: "fetch-and-merge exception",
      summary: branchRulesetSummary(),
      details: uniqueMainRulesetDetails({ updateAllowsFetchAndMerge: true }),
    },
  ];

  for (const fixture of cases) {
    assert.equal(
      serverStrictBaseBindingBlock({
        repo: "openclaw/openclaw",
        baseBranch: "main",
        ...appIdentity(),
        policyReadJson: fakeGithub({
          rules: [strictRulesetRule()],
          ruleset: strictRulesetDetails(),
          branchRulesetPages: [[fixture.summary]],
          uniqueMainRuleset: fixture.details,
        }),
      }),
      MISSING_UNIQUE_MAIN_POLICY,
      fixture.name,
    );
  }
});

test("strict base binding consumes every ruleset page before refusing the unbound merge", () => {
  const requestedCalls: string[][] = [];
  const unrelatedId = UNIQUE_MAIN_RULESET_ID - 1;
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: fakeGithub({
        rules: [strictRulesetRule()],
        ruleset: strictRulesetDetails(),
        branchRulesetPages: [[branchRulesetSummary({ id: unrelatedId })], [branchRulesetSummary()]],
        rulesets: {
          [unrelatedId]: mainOnlyRulesetDetails(),
        },
        requestedCalls,
      }),
    }),
    NO_ATOMIC_BASE_BINDING,
  );
  assert.deepEqual(
    requestedCalls.find((args) => args[1]?.includes("rulesets?includes_parents=true")),
    [
      "api",
      "repos/openclaw/openclaw/rulesets?includes_parents=true&targets=branch&per_page=100",
      "--paginate",
      "--slurp",
    ],
  );
});

test("strict base binding fails closed on ruleset pagination, detail, or shape uncertainty", () => {
  for (const [name, options] of [
    [
      "non-page response",
      {
        branchRulesetPages: [branchRulesetSummary()],
      },
    ],
    [
      "missing detail",
      {
        branchRulesetPages: [[branchRulesetSummary()]],
        uniqueMainRuleset: null,
      },
    ],
    [
      "malformed conditions",
      {
        branchRulesetPages: [[branchRulesetSummary()]],
        uniqueMainRuleset: {
          ...uniqueMainRulesetDetails(),
          conditions: { ref_name: { include: "~ALL", exclude: ["refs/heads/main"] } },
        },
      },
    ],
    [
      "string ruleset id",
      {
        branchRulesetPages: [[{ ...branchRulesetSummary(), id: String(UNIQUE_MAIN_RULESET_ID) }]],
      },
    ],
  ] as const) {
    assert.equal(
      serverStrictBaseBindingBlock({
        repo: "openclaw/openclaw",
        baseBranch: "main",
        ...appIdentity(),
        policyReadJson: fakeGithub({
          rules: [strictRulesetRule()],
          ruleset: strictRulesetDetails(),
          ...options,
        }),
      }),
      UNVERIFIABLE_UNIQUE_MAIN_POLICY,
      name,
    );
  }
});

test("strict base binding evaluates every applicable ruleset and rejects caller bypass", () => {
  const requestedEndpoints: string[] = [];
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: fakeGithub({
        rules: [
          strictRulesetRule(18588237, ["required-ci/first"]),
          strictRulesetRule(18588238, ["required-ci/second"]),
        ],
        rulesets: {
          18588237: strictRulesetDetails({ checks: ["required-ci/first"] }),
          18588238: strictRulesetDetails({
            checks: ["required-ci/second"],
            currentUserCanBypass: "always",
          }),
        },
        requestedEndpoints,
      }),
    }),
    "automerge disabled: merge credential can bypass an applicable strict base-binding ruleset",
  );
  assert.match(requestedEndpoints.join("\n"), /rulesets\/18588237/);
  assert.match(requestedEndpoints.join("\n"), /rulesets\/18588238/);
});

test("strict base binding evaluates strict rules returned after the first page", () => {
  const requestedCalls: string[][] = [];
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: fakeGithub({
        rulePages: [
          [strictRulesetRule(18588237, ["required-ci/first"])],
          [strictRulesetRule(18588238, ["required-ci/second"])],
        ],
        rulesets: {
          18588237: strictRulesetDetails({ checks: ["required-ci/first"] }),
          18588238: strictRulesetDetails({
            checks: ["required-ci/second"],
            currentUserCanBypass: "always",
          }),
        },
        requestedCalls,
      }),
    }),
    "automerge disabled: merge credential can bypass an applicable strict base-binding ruleset",
  );
  assert.deepEqual(requestedCalls[0], [
    "api",
    "repos/openclaw/openclaw/rules/branches/main?per_page=100",
    "--paginate",
    "--slurp",
  ]);
  assert.match(requestedCalls.map((args) => args.join(" ")).join("\n"), /rulesets\/18588238/);
});

test("strict base binding fails closed when paginated rules are not returned as complete pages", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: (args) => {
        if (args[1]?.includes("/rules/branches/")) return [strictRulesetRule()];
        return strictRulesetDetails();
      },
    }),
    "automerge disabled: unable to verify every applicable strict base-binding ruleset",
  );
});

test("strict base binding rejects a ruleset that weakens effective required checks", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: fakeGithub({
        rules: [strictRulesetRule(18588237, ["required-ci/build", "required-ci/security"])],
        ruleset: strictRulesetDetails({ checks: ["required-ci/build"] }),
      }),
    }),
    "automerge disabled: an applicable ruleset weakens required strict status checks",
  );
});

test("strict base binding evaluates inherited organization rulesets before refusing merge", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/example",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: fakeGithub({
        rules: [strictRulesetRule(18588239, ["required-ci/build"], "Organization")],
        rulesets: { 18588239: strictRulesetDetails({ checks: ["required-ci/build"] }) },
      }),
    }),
    NO_ATOMIC_BASE_BINDING,
  );
});

test("strict base binding fails closed when mutation identity or policy access is unavailable", () => {
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity(),
      policyReadJson: undefined,
    }),
    "automerge disabled: mutation credential cannot read its effective rulesets",
  );
  assert.equal(
    serverStrictBaseBindingBlock({
      repo: "openclaw/openclaw",
      baseBranch: "main",
      ...appIdentity({ installationId: "" }),
      policyReadJson: fakeGithub({ rules: [], protection: {} }),
    }),
    "automerge disabled: merge credential is not a verifiable GitHub App installation",
  );
});

test("all repair merge owners repeat the shared strict base guard immediately before merge", () => {
  for (const [file, functionName, mergeCall] of [
    ["src/repair/apply-result.ts", "function applyMergeAction(", "ghWithRetry(mergeArgs)"],
    [
      "src/repair/comment-router.ts",
      "function executeAutomerge(",
      "const result = runGitHubSpawnMutation(",
    ],
    ["src/repair/post-flight.ts", "function finalizeFixPr(", "ghWithRetry(mergeArgs)"],
  ] as const) {
    const source = fs.readFileSync(file, "utf8");
    const start = source.indexOf(functionName);
    const end = source.indexOf("\nfunction ", start + functionName.length);
    const owner = source.slice(start, end < 0 ? undefined : end);
    const guards = [...owner.matchAll(/runtimeStrictBaseBindingBlock\(\{/g)].map(
      (match) => match.index,
    );
    const merge = owner.indexOf(mergeCall);
    assert.equal(guards.length, 2, `${file} must check strict base binding twice`);
    assert.ok(merge > guards[1]!, `${file} does not guard the final merge call`);
    const finalRead = owner.lastIndexOf("fetchPullRequestView", guards[1]!);
    assert.ok(finalRead >= 0, `${file} must refresh the pull request before its final guard`);
    const finalBaseGate = owner.slice(finalRead, guards[1]!);
    assert.match(finalBaseGate, /const finalBaseBranch = String\(finalView\.baseRefName \?\? ""\)/);
    assert.match(finalBaseGate, /finalBaseBranch !== validatedBaseBranch/);
    assert.match(finalBaseGate, /pull request base changed since merge validation/);
    const finalGuard = owner.slice(guards[1]!, merge);
    assert.match(finalGuard, /baseBranch: finalBaseBranch/);
    assert.match(finalGuard, /policyReadJson: rulesetPolicyReader\(\)/);
    assert.doesNotMatch(finalGuard, /gh(?:Json|Text|Spawn|WithRetry)\(/);
  }
});

function strictRulesetRule(
  rulesetId = 18588237,
  checks = ["required-ci/exact-merge"],
  sourceType = "Repository",
) {
  return {
    type: "required_status_checks",
    ruleset_id: rulesetId,
    ruleset_source: sourceType === "Repository" ? "openclaw/openclaw" : "openclaw",
    ruleset_source_type: sourceType,
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: checks.map((context) => ({ context })),
    },
  };
}

function strictRulesetDetails({
  checks = ["required-ci/exact-merge"],
  currentUserCanBypass = "never",
}: {
  checks?: string[];
  currentUserCanBypass?: string;
} = {}) {
  return {
    enforcement: "active",
    current_user_can_bypass: currentUserCanBypass,
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: checks.map((context) => ({ context })),
        },
      },
    ],
  };
}

function branchRulesetSummary({
  id = UNIQUE_MAIN_RULESET_ID,
  enforcement = "active",
}: {
  id?: number;
  enforcement?: string;
} = {}) {
  return {
    id,
    target: "branch",
    enforcement,
  };
}

function uniqueMainRulesetDetails({
  enforcement = "active",
  currentUserCanBypass = "never",
  include = ["~ALL"],
  exclude = ["refs/heads/main"],
  updateAllowsFetchAndMerge = false,
}: {
  enforcement?: string;
  currentUserCanBypass?: string;
  include?: string[];
  exclude?: string[];
  updateAllowsFetchAndMerge?: boolean;
} = {}) {
  return {
    target: "branch",
    enforcement,
    current_user_can_bypass: currentUserCanBypass,
    conditions: { ref_name: { include, exclude } },
    rules: [
      {
        type: "update",
        parameters: { update_allows_fetch_and_merge: updateAllowsFetchAndMerge },
      },
    ],
  };
}

function mainOnlyRulesetDetails() {
  return {
    target: "branch",
    enforcement: "active",
    current_user_can_bypass: "never",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [{ type: "deletion", parameters: null }],
  };
}

function appIdentity(
  overrides: Partial<{
    configuredAppSlug: string;
    authenticatedAppId: string | number;
    appSlug: string;
    installationId: string | number;
  }> = {},
) {
  return {
    configuredAppSlug: APP_SLUG,
    authenticatedAppId: APP_ID,
    appSlug: APP_SLUG,
    installationId: INSTALLATION_ID,
    ...overrides,
  };
}

function fakeGithub({
  rules,
  rulePages,
  ruleset = null,
  rulesets = {},
  branchRulesetPages = [[branchRulesetSummary()]],
  uniqueMainRuleset = uniqueMainRulesetDetails(),
  protection = { required_status_checks: null },
  requestedEndpoints,
  requestedCalls,
}: {
  rules?: unknown[];
  rulePages?: unknown[][];
  ruleset?: unknown;
  rulesets?: Record<number, unknown>;
  branchRulesetPages?: unknown;
  uniqueMainRuleset?: unknown;
  protection?: unknown;
  requestedEndpoints?: string[];
  requestedCalls?: string[][];
}) {
  return (args: string[]) => {
    const endpoint = args[1];
    requestedCalls?.push(args);
    if (endpoint) requestedEndpoints?.push(endpoint);
    if (endpoint === "repos/openclaw/openclaw/rules/branches/main?per_page=100") {
      return rulePages ?? [rules ?? []];
    }
    if (endpoint === "repos/openclaw/example/rules/branches/main?per_page=100") {
      return rulePages ?? [rules ?? []];
    }
    if (
      endpoint ===
        "repos/openclaw/openclaw/rulesets?includes_parents=true&targets=branch&per_page=100" ||
      endpoint ===
        "repos/openclaw/example/rulesets?includes_parents=true&targets=branch&per_page=100"
    ) {
      return branchRulesetPages;
    }
    const rulesetId = Number(
      endpoint?.match(/\/rulesets\/(\d+)(?:\?includes_parents=true)?$/)?.[1],
    );
    if (Number.isSafeInteger(rulesetId) && rulesetId in rulesets) return rulesets[rulesetId];
    if (rulesetId === UNIQUE_MAIN_RULESET_ID) return uniqueMainRuleset;
    if (endpoint === "repos/openclaw/openclaw/rulesets/18588237?includes_parents=true" && ruleset)
      return ruleset;
    if (endpoint === "repos/openclaw/example/rulesets/18588239?includes_parents=true") {
      return rulesets[18588239];
    }
    if (endpoint?.endsWith("/branches/main/protection")) return protection;
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
}
