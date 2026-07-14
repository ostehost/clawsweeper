import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const executor = path.join(process.cwd(), "dist/repair/execute-fix-artifact.js");
const reviewer = path.join(process.cwd(), "dist/repair/review-results.js");
const codexResultSchema = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema/repair/codex-result.schema.json"), "utf8"),
);

test("execute-fix CLI defers outcome publication until fresh-token invocation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publication-cli-"));
  const binDir = path.join(root, "bin");
  const jobPath = path.join(root, "job.md");
  const resultPath = path.join(root, "result.json");
  const reportPath = path.join(root, "fix-execution-report.json");
  const tokenLog = path.join(root, "outcome-tokens.log");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    jobPath,
    `---\nrepo: openclaw/clawsweeper\ncluster_id: automerge-openclaw-clawsweeper-494\nmode: autonomous\nsource: pr_automerge\nallowed_actions: [comment]\ncandidates: [#494]\ncanonical: [#494]\n---\nfixture\n`,
  );
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify({
      repo: "openclaw/clawsweeper",
      cluster_id: "automerge-openclaw-clawsweeper-494",
      mode: "autonomous",
      canonical_pr: "https://github.com/openclaw/clawsweeper/pull/494",
      reviewed_sha: "a".repeat(40),
      fix_artifact: {
        source_prs: ["https://github.com/openclaw/clawsweeper/pull/494"],
      },
      actions: [],
    })}\n`,
  );
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/bin/sh\nset -eu\ncase "$*" in\n  *"issues/494/comments?per_page=100"*) printf '[]\\n' ;;\n  "pr view 494 "*) printf '{"state":"CLOSED","headRefOid":"%s","statusCheckRollup":[]}\\n' "${"a".repeat(40)}" ;;\n  *"issues/494/comments --method POST"*) printf '%s\\n' "\${GH_TOKEN:-}" >> "$TOKEN_LOG" ;;\n  *) printf 'unexpected gh args: %s\\n' "$*" >&2; exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  const baseEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CLAWSWEEPER_ALLOW_EXECUTE: "1",
    CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
    CLAWSWEEPER_MODEL: "fixture-model",
    GH_BIN: ghPath,
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ID: "123",
    TOKEN_LOG: tokenLog,
  };

  runExecutor([jobPath, resultPath, "--defer-publication"], {
    ...baseEnv,
    GH_TOKEN: "expired-token",
  });
  assert.equal(fs.existsSync(reportPath), true);
  assert.equal(fs.existsSync(tokenLog), false);

  runExecutor([jobPath, resultPath, "--publish-report-only"], {
    ...baseEnv,
    GH_TOKEN: "fresh-token",
  });
  assert.equal(fs.readFileSync(tokenLog, "utf8"), "fresh-token\n");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.actions.at(-1)?.action, "automerge_repair_outcome_comment");
  assert.equal(report.actions.at(-1)?.status, "executed");
});

test("execute-fix receipts preserve the canonical job revision", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-execute-revision-")),
  );
  const jobPath = path.join(root, "job.md");
  const resultPath = path.join(root, "result.json");
  const ledgerOutputRoot = path.join(root, "ledger-output");
  const sourceRevision = "b".repeat(64);
  fs.mkdirSync(ledgerOutputRoot);
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/clawsweeper",
      "cluster_id: issue-openclaw-clawsweeper-521",
      "mode: autonomous",
      "allowed_actions: [comment]",
      "candidates: ['#521']",
      `source_issue_revision_sha256: "${sourceRevision}"`,
      "---",
      "fixture",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify({
      repo: "openclaw/clawsweeper",
      cluster_id: "issue-openclaw-clawsweeper-521",
      mode: "autonomous",
      reviewed_sha: "c".repeat(40),
      actions: [],
    })}\n`,
  );
  const env = actionLedgerEnv(root, ledgerOutputRoot, "execute-fix");

  try {
    runExecutor([jobPath, resultPath], env);
    execFileSync(
      process.execPath,
      [path.join(process.cwd(), "dist/repair/action-ledger-cli.js"), "finalize"],
      { env, stdio: "pipe" },
    );

    const events = readActionEvents(ledgerOutputRoot);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.subject?.source_revision === sourceRevision));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no-publication validation accepts only terminal non-executable fix strategies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-no-publication-cli-"));
  const jobPath = path.join(root, "job.md");
  const resultPath = path.join(root, "result.json");
  const reportPath = path.join(root, "fix-execution-report.json");
  const clusterId = "automerge-openclaw-clawsweeper-494";
  const clusterTarget = `cluster:${clusterId}`;
  fs.writeFileSync(
    jobPath,
    `---
repo: openclaw/clawsweeper
cluster_id: ${clusterId}
mode: autonomous
source: pr_automerge
allowed_actions: [comment, label, fix, raise_pr]
blocked_actions: [close, merge]
require_human_for: [close, merge]
canonical: [#494]
candidates: [#494]
cluster_refs: [#494]
allow_fix_pr: true
---
fixture
`,
  );
  fs.writeFileSync(path.join(root, "cluster-plan.json"), '{"item_matrix":[]}\n');
  const baseResult = {
    repo: "openclaw/clawsweeper",
    cluster_id: clusterId,
    mode: "autonomous",
    status: "planned",
    summary: "The reviewed repair reached a terminal publication decision.",
    needs_human: [],
    canonical: null,
    canonical_issue: null,
    canonical_pr: null,
    merge_preflight: [],
  };
  const fixArtifact = (repairStrategy: string, overrides: Record<string, unknown> = {}) => ({
    summary: "Apply the narrow reviewed repair.",
    pr_title: "fix: apply reviewed repair",
    pr_body: "Implements the reviewed repair and preserves contributor context.",
    affected_surfaces: ["src/repair"],
    likely_files: ["src/repair/example.ts"],
    linked_refs: ["#494"],
    validation_commands: ["pnpm test"],
    credit_notes: ["Preserve the source report context."],
    changelog_required: false,
    repair_contract: { must_touch: ["src/repair/example.ts"], match: "any" },
    repair_strategy: repairStrategy,
    source_prs: [],
    allow_no_pr: false,
    branch_update_blockers: [],
    ...overrides,
  });
  const plannedAction = {
    action: "fix_needed",
    status: "planned",
    target: clusterTarget,
    idempotency_key: `${clusterId}:fix_needed`,
    classification: null,
    target_kind: null,
    target_timeline_cursor: null,
    target_updated_at: null,
    canonical: null,
    duplicate_of: null,
    candidate_fix: null,
    comment: null,
    evidence: ["The reviewed cluster requires a bounded fix decision."],
    reason: "The cluster needs a terminal fix disposition.",
  };
  const baseEnv = {
    ...process.env,
    CLAWSWEEPER_ALLOW_EXECUTE: "1",
    CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
    CLAWSWEEPER_MODEL: "fixture-model",
  };

  for (const fixture of [
    {
      repairStrategy: "already_fixed_on_main",
      needsHuman: [],
    },
    {
      repairStrategy: "needs_human",
      needsHuman: ["A maintainer must choose the safe implementation boundary."],
    },
  ]) {
    fs.writeFileSync(
      resultPath,
      `${JSON.stringify({
        ...baseResult,
        fix_artifact: fixArtifact(fixture.repairStrategy),
        actions: [plannedAction],
        needs_human: fixture.needsHuman,
      })}\n`,
    );
    assertReviewedResult(resultPath);
    const validated = runExecutorResult(
      [jobPath, resultPath, "--validate-no-publication"],
      baseEnv,
    );
    assert.equal(validated.status, 0, `${fixture.repairStrategy}: ${validated.stderr}`);

    const published = runExecutorResult(
      [jobPath, resultPath, "--publish-no-publication", "--dry-run"],
      baseEnv,
    );
    assert.equal(published.status, 0, published.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.status, "skipped");
    assert.equal(
      report.reason,
      `fix_artifact.repair_strategy ${fixture.repairStrategy} is not executable`,
    );
    const executeAction = report.actions.find(
      (action: { action?: string }) => action.action === "execute_fix",
    );
    assert.equal(executeAction?.repair_strategy, fixture.repairStrategy);
    assert.deepEqual(report.needs_human ?? [], fixture.needsHuman);
  }

  for (const fixture of [
    {
      label: "executable strategy",
      fix_artifact: fixArtifact("new_fix_pr"),
      actions: [plannedAction],
    },
    {
      label: "promoted needs_human strategy",
      fix_artifact: fixArtifact("needs_human", {
        source_prs: ["https://github.com/openclaw/clawsweeper/pull/494"],
        summary:
          "Open a replacement PR because maintainer_can_modify=false makes the source uneditable.",
        branch_update_blockers: ["Cannot safely update the uneditable source branch."],
        credit_notes: [
          "Preserve contributor credit from https://github.com/openclaw/clawsweeper/pull/494.",
        ],
      }),
      actions: [
        {
          action: "open_fix_pr",
          status: "blocked",
          target: clusterTarget,
          idempotency_key: `${clusterId}:open_fix_pr`,
          classification: "needs_human",
          target_kind: null,
          target_timeline_cursor: null,
          target_updated_at: null,
          canonical: null,
          duplicate_of: null,
          candidate_fix: null,
          comment: null,
          evidence: ["The source branch cannot be updated safely."],
          reason: "Cannot safely update the source; open a replacement PR.",
        },
      ],
      needs_human: ["The source branch is uneditable and needs a replacement."],
    },
  ]) {
    const { label, ...reviewedFixture } = fixture;
    fs.writeFileSync(resultPath, `${JSON.stringify({ ...baseResult, ...reviewedFixture })}\n`);
    assertReviewedResult(resultPath);
    const rejected = runExecutorResult([jobPath, resultPath, "--validate-no-publication"], baseEnv);
    assert.notEqual(rejected.status, 0, label);
    assert.match(rejected.stderr, /immutable cluster result still requires fix execution/, label);
  }
});

function assertReviewedResult(resultPath: string) {
  assertStrictSchemaShape(
    JSON.parse(fs.readFileSync(resultPath, "utf8")),
    codexResultSchema,
    "result",
  );
  const reviewed = spawnSync(process.execPath, [reviewer, resultPath], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  assert.equal(reviewed.status, 0, `${reviewed.stderr}\n${reviewed.stdout}`);
}

function assertStrictSchemaShape(
  value: unknown,
  schema: Record<string, unknown>,
  location: string,
): void {
  const anyOf = schema.anyOf as Record<string, unknown>[] | undefined;
  if (anyOf) {
    const branch = anyOf.find((candidate) => schemaTypeMatches(value, candidate.type));
    assert.ok(branch, `${location} has no matching schema branch`);
    assertStrictSchemaShape(value, branch, location);
    return;
  }
  if (schema.type === "object") {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), `${location} object`);
    const record = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    assert.deepEqual(Object.keys(record).sort(), [...required].sort(), `${location} keys`);
    const properties = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
    for (const [key, child] of Object.entries(record)) {
      assertStrictSchemaShape(child, properties[key]!, `${location}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${location} array`);
    const itemSchema = schema.items as Record<string, unknown>;
    value.forEach((item, index) =>
      assertStrictSchemaShape(item, itemSchema, `${location}[${index}]`),
    );
  }
}

function schemaTypeMatches(value: unknown, rawType: unknown): boolean {
  const types = Array.isArray(rawType) ? rawType : [rawType];
  if (value === null) return types.includes("null");
  if (Array.isArray(value)) return types.includes("array");
  return types.includes(typeof value);
}

function runExecutor(args: string[], env: NodeJS.ProcessEnv) {
  const child = runExecutorResult(args, env);
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
}

function runExecutorResult(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [executor, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
}

function actionLedgerEnv(
  root: string,
  ledgerOutputRoot: string,
  invocation: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_ROOT: root,
    CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: ledgerOutputRoot,
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-07-13",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: invocation,
    CLAWSWEEPER_ALLOW_EXECUTE: "1",
    CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
    GITHUB_ACTION: "execute_fix",
    GITHUB_JOB: "execute",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "521",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW: "repair cluster worker",
    GITHUB_WORKFLOW_REF:
      "openclaw/clawsweeper/.github/workflows/repair-cluster-worker.yml@refs/heads/main",
  };
}

function readActionEvents(root: string): Record<string, any>[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return readActionEvents(target);
    if (!target.endsWith(".jsonl")) return [];
    return fs
      .readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  });
}
