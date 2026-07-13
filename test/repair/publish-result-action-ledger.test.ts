import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readSealedPublishedSource,
  resultPublicationSourceRevision,
} from "../../dist/repair/publish-result.js";
import { reviewedResultRevision } from "../../dist/repair/publish-result-source.js";
import { readText } from "../helpers.ts";

test("published repair receipts use production-valid result and plan revision fields", () => {
  const result = productionResult({
    canonical: "#42",
    canonical_pr: "#42",
  });
  const plan = {
    repo: "openclaw/openclaw",
    cluster_id: "repair-pr-42",
    mode: "autonomous",
    source_job: "jobs/openclaw/repair-pr-42.md",
    items: [
      {
        repo: "openclaw/openclaw",
        ref: "#41",
        number: 41,
        kind: "pull_request",
        pull_request: { head_sha: "a".repeat(40) },
      },
      {
        repo: "openclaw/openclaw",
        ref: "#42",
        number: 42,
        kind: "pull_request",
        pull_request: { head_sha: "b".repeat(40) },
      },
    ],
  };
  const schema = JSON.parse(fs.readFileSync("schema/repair/codex-result.schema.json", "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.ok(Object.keys(result).every((key) => key in schema.properties));
  assert.equal(
    reviewedResultRevision(result, plan, { expected_head_sha: "b".repeat(40) }),
    "b".repeat(40),
  );
  assert.equal(reviewedResultRevision(result, plan, { expected_head_sha: "c".repeat(40) }), null);
});

test("canonical PR revision rejects issue and foreign-repository URLs", () => {
  const plan = {
    repo: "openclaw/openclaw",
    cluster_id: "repair-pr-42",
    items: [
      {
        repo: "openclaw/openclaw",
        ref: "#42",
        number: 42,
        kind: "pull_request",
        pull_request: { head_sha: "b".repeat(40) },
      },
    ],
  };
  assert.equal(
    reviewedResultRevision(
      productionResult({
        canonical_pr: "https://github.com/openclaw/openclaw/pull/42",
      }),
      plan,
      { expected_head_sha: "b".repeat(40) },
    ),
    "b".repeat(40),
  );
  for (const canonicalPr of [
    "https://github.com/openclaw/openclaw/issues/42",
    "https://github.com/other/repo/pull/42",
  ]) {
    assert.throws(
      () =>
        resultPublicationSourceRevision(productionResult({ canonical_pr: canonicalPr }), plan, {
          expected_head_sha: "b".repeat(40),
        }),
      /missing one exact reviewed target revision/,
    );
  }
});

test("published repair receipts bind issue and commit workflow source revisions", () => {
  assert.equal(
    reviewedResultRevision(productionResult({ canonical: "#42", canonical_issue: "#42" }), null, {
      source_issue_revision_sha256: "d".repeat(64),
    }),
    "d".repeat(64),
  );
  assert.equal(
    reviewedResultRevision(productionResult({ canonical: null }), null, {
      source: "clawsweeper_commit",
      commit_sha: "e".repeat(40),
    }),
    "e".repeat(40),
  );
});

test("result publication accepts production blocked and generic issue-only results without fake revisions", () => {
  const blocked = productionResult({
    status: "blocked",
    summary: { reason: "manual repair required" },
    actions: [],
    needs_human: ["manual repair required"],
  });
  assert.equal(
    resultPublicationSourceRevision(blocked, null, {
      source: "clawsweeper",
      job_intent: "repair_cluster",
    }),
    null,
  );

  const issueOnly = productionResult({
    canonical: "#42",
    canonical_issue: "#42",
  });
  assert.equal(
    resultPublicationSourceRevision(issueOnly, null, {
      source: "clawsweeper",
      job_intent: "repair_cluster",
    }),
    null,
  );
});

test("result publication keeps exact revision requirements for live source-bound work", () => {
  const result = productionResult({ canonical: "#42" });
  for (const source of [
    { source: "issue_implementation" },
    { source: "clawsweeper_commit" },
    { source: "pr-repair-intake" },
    { source: "pr_automerge" },
  ]) {
    assert.throws(
      () => resultPublicationSourceRevision(result, null, source),
      /missing one exact reviewed target revision/,
    );
  }
  assert.throws(
    () =>
      resultPublicationSourceRevision(
        productionResult({ status: "blocked", canonical: "#42", canonical_pr: "#42" }),
        null,
        { source: "clawsweeper" },
      ),
    /missing one exact reviewed target revision/,
  );
});

test("published repair receipts ignore schema-invalid legacy revision shapes", () => {
  assert.equal(
    reviewedResultRevision(
      {
        reviewed_sha: "b".repeat(40),
        head_sha: "c".repeat(40),
        canonical: { pull_request: { head_sha: "d".repeat(40) } },
      },
      {
        expected_head_sha: "e".repeat(40),
        source_revision: "f".repeat(40),
      },
    ),
    null,
  );
});

test("result publication derives source provenance from sealed worker bytes", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-sealed-result-"));
  const sourceJob = "jobs/openclaw/inbox/issue-openclaw-openclaw-42.md";
  const job = `---
repo: openclaw/openclaw
cluster_id: repair-pr-42
mode: autonomous
job_intent: implement_issue
allowed_actions:
  - fix
candidates:
  - "#42"
source: issue_implementation
source_issue_revision_sha256: ${"d".repeat(64)}
---

# sealed source
`;
  const jobSha256 = createHash("sha256").update(job).digest("hex");
  const result = productionResult({ canonical: "#42", canonical_issue: "#42" });
  const plan = {
    repo: "openclaw/openclaw",
    cluster_id: "repair-pr-42",
    source_job: sourceJob,
  };
  const stateRoot = path.join(runDir, "state");
  const stateRevision = commitStateJob(stateRoot, sourceJob, job);
  fs.writeFileSync(path.join(runDir, "source-job.md"), job);
  fs.writeFileSync(
    path.join(runDir, "source-job.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        source_job: sourceJob,
        state_revision: stateRevision,
        job_sha256: jobSha256,
      },
      null,
      2,
    )}\n`,
  );

  try {
    const sealed = readSealedPublishedSource(runDir, result, plan, "result.json", null, stateRoot);
    assert.equal(sealed?.sourceJob, sourceJob);
    assert.equal(sealed?.stateRevision, stateRevision);
    assert.equal(sealed?.jobSha256, jobSha256);
    assert.equal(
      resultPublicationSourceRevision(result, plan, sealed?.frontmatter ?? null),
      "d".repeat(64),
    );

    fs.appendFileSync(path.join(runDir, "source-job.md"), "\ntampered\n");
    assert.throws(
      () => readSealedPublishedSource(runDir, result, plan, "result.json", null, stateRoot),
      /sealed source job SHA-256 mismatch/,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("sealed source identity cannot self-assert bytes absent from its state revision", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-forged-source-"));
  const stateRoot = path.join(runDir, "state");
  const sourceJob = "jobs/openclaw/inbox/cluster-42.md";
  const trustedJob = repairJob("# trusted source");
  const forgedJob = repairJob("# forged artifact");
  const stateRevision = commitStateJob(stateRoot, sourceJob, trustedJob);
  fs.writeFileSync(path.join(runDir, "source-job.md"), forgedJob);
  fs.writeFileSync(
    path.join(runDir, "source-job.json"),
    `${JSON.stringify({
      schema_version: 1,
      source_job: sourceJob,
      state_revision: stateRevision,
      job_sha256: createHash("sha256").update(forgedJob).digest("hex"),
    })}\n`,
  );

  try {
    assert.throws(
      () =>
        readSealedPublishedSource(
          runDir,
          productionResult({}),
          {
            repo: "openclaw/openclaw",
            cluster_id: "repair-pr-42",
            source_job: sourceJob,
          },
          "result.json",
          null,
          stateRoot,
        ),
      /immutable job SHA-256 mismatch/,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("result publication rejects mutable or redirected source provenance", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-sealed-redirect-"));
  const result = productionResult({});
  const plan = {
    repo: "openclaw/openclaw",
    cluster_id: "repair-pr-42",
    source_job: "jobs/openclaw/inbox/cluster-42.md",
  };
  try {
    assert.throws(
      () => readSealedPublishedSource(runDir, result, plan),
      /missing sealed source job provenance/,
    );
    fs.writeFileSync(path.join(runDir, "source-job.md"), "not trusted\n");
    fs.writeFileSync(
      path.join(runDir, "source-job.json"),
      `${JSON.stringify({
        schema_version: 1,
        source_job: "jobs/openclaw/inbox/other.md",
        state_revision: "a".repeat(40),
        job_sha256: createHash("sha256").update("not trusted\n").digest("hex"),
      })}\n`,
    );
    assert.throws(
      () => readSealedPublishedSource(runDir, result, plan),
      /sealed source job identity is invalid/,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("result publication accepts only explicitly trusted pre-contract worker provenance", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-legacy-result-"));
  const sourceJob = "jobs/openclaw/inbox/cluster-42.md";
  const result = productionResult({});
  const plan = {
    repo: "openclaw/openclaw",
    cluster_id: "repair-pr-42",
    source_job: sourceJob,
  };
  const workerHead = "e".repeat(40);
  try {
    assert.throws(
      () => readSealedPublishedSource(runDir, result, plan),
      /missing sealed source job provenance/,
    );
    assert.deepEqual(readSealedPublishedSource(runDir, result, plan, "result.json", workerHead), {
      sourceJob,
      stateRevision: null,
      jobSha256: null,
      frontmatter: null,
      provenance: "trusted_legacy_worker",
      workerHeadSha: workerHead,
    });

    fs.writeFileSync(path.join(runDir, "source-job.md"), "partial legacy provenance\n");
    assert.throws(
      () => readSealedPublishedSource(runDir, result, plan, "result.json", workerHead),
      /missing sealed source job provenance/,
    );
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("result publisher never reopens mutable live source jobs", () => {
  const publisher = readText("src/repair/publish-result.ts");
  const resolver = publisher.slice(
    publisher.indexOf("export function readSealedPublishedSource"),
    publisher.indexOf("function updateDashboard"),
  );

  assert.match(
    publisher,
    /readSealedPublishedSource\([\s\S]*runDir,[\s\S]*result,[\s\S]*clusterPlan,[\s\S]*resultPath,[\s\S]*trustedLegacyWorkerHead/,
  );
  assert.match(resolver, /path\.join\(runDir, "source-job\.md"\)/);
  assert.match(resolver, /path\.join\(runDir, "source-job\.json"\)/);
  assert.match(resolver, /createHash\("sha256"\)/);
  assert.doesNotMatch(resolver, /path\.resolve\(root/);
  assert.doesNotMatch(resolver, /fs\.existsSync\(path\.join\(root,\s*sourceJob/);
});

function productionResult(overrides: Record<string, unknown>) {
  return {
    status: "planned",
    repo: "openclaw/openclaw",
    cluster_id: "repair-pr-42",
    mode: "autonomous",
    summary: "Reviewed the exact repair target.",
    actions: [],
    needs_human: [],
    canonical: null,
    canonical_issue: null,
    canonical_pr: null,
    merge_preflight: [],
    fix_artifact: null,
    ...overrides,
  };
}

function repairJob(body: string): string {
  return `---
repo: openclaw/openclaw
cluster_id: repair-pr-42
mode: autonomous
job_intent: repair_cluster
allowed_actions:
  - fix
candidates:
  - "#42"
source: clawsweeper
---

${body}
`;
}

function commitStateJob(stateRoot: string, sourceJob: string, contents: string): string {
  fs.mkdirSync(path.dirname(path.join(stateRoot, sourceJob)), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: stateRoot });
  execFileSync("git", ["config", "user.name", "ClawSweeper Tests"], { cwd: stateRoot });
  execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: stateRoot });
  fs.writeFileSync(path.join(stateRoot, sourceJob), contents);
  execFileSync("git", ["add", sourceJob], { cwd: stateRoot });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: stateRoot });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: stateRoot,
    encoding: "utf8",
  }).trim();
}
