import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCommitFindingReportRevision,
  assertCommitFindingReportSha256,
  commitFindingReportSha256,
  immutableCommitFindingReportUrl,
  isMissingGithubContentError,
  missingCommitFindingReport,
  verifyCommitFindingReport,
} from "../../dist/repair/commit-finding-report.js";
import { mockGhBinEnv } from "../helpers.ts";

test("commit finding synthetic actions satisfy the strict result schema", () => {
  const source = fs.readFileSync("src/repair/commit-finding-intake.ts", "utf8");
  const schema = JSON.parse(fs.readFileSync("schema/repair/codex-result.schema.json", "utf8"));
  const actionStart = source.indexOf("actions: [", source.indexOf("function writeSyntheticRun"));
  const actionEnd = source.indexOf("\n    needs_human:", actionStart);
  const action = source.slice(actionStart, actionEnd);
  const required = schema.properties.actions.items.required as string[];

  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  for (const property of required) {
    assert.match(
      action,
      new RegExp(`\\b${property}:`),
      `missing synthetic action field ${property}`,
    );
  }
});

test("commit finding reports require exact immutable identity values", () => {
  const revision = "a".repeat(40);
  const digest = "b".repeat(64);

  assert.equal(assertCommitFindingReportRevision(revision), revision);
  assert.equal(assertCommitFindingReportSha256(digest), digest);
  assert.equal(
    immutableCommitFindingReportUrl(
      "openclaw/clawsweeper-state",
      "records/openclaw-openclaw/commits/abc.md",
      revision,
    ),
    `https://github.com/openclaw/clawsweeper-state/blob/${revision}/records/openclaw-openclaw/commits/abc.md`,
  );

  for (const invalid of ["a".repeat(39), "A".repeat(40), `${"a".repeat(40)}\n`]) {
    assert.throws(
      () => assertCommitFindingReportRevision(invalid),
      /exact lowercase 40-hex commit SHA/,
    );
  }
  for (const invalid of ["b".repeat(63), "B".repeat(64), `${"b".repeat(64)}\n`]) {
    assert.throws(() => assertCommitFindingReportSha256(invalid), /exact lowercase 64-hex digest/);
  }
});

test("commit finding reports verify exact bytes before decoding", () => {
  const reportBytes = Buffer.from("---\nresult: findings\n---\n\nfinding\n", "utf8");
  const digest = createHash("sha256").update(reportBytes).digest("hex");

  assert.equal(commitFindingReportSha256(reportBytes), digest);
  assert.equal(verifyCommitFindingReport(reportBytes, digest), reportBytes.toString("utf8"));
  assert.throws(
    () => verifyCommitFindingReport(Buffer.from(`${reportBytes.toString("utf8")}tampered`), digest),
    /commit finding report SHA-256 mismatch/,
  );
});

test("commit finding intake rejects mismatched fetched bytes before writing state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "commit-finding-intake-mismatch-"));
  const unique = randomUUID().replaceAll("-", "").slice(0, 12);
  const targetRepo = `openclaw/fixture-${unique}`;
  const targetSlug = `openclaw-fixture-${unique}`;
  const sha = "d".repeat(40);
  const revision = "e".repeat(40);
  const reportRepo = "openclaw/clawsweeper-state";
  const reportPath = `records/${targetSlug}/commits/${sha}.md`;
  const reportBytes = Buffer.from(
    `---\nresult: findings\nsha: ${sha}\nrepository: ${targetRepo}\n---\n\n## Summary\n\nMismatch proof.\n`,
    "utf8",
  );
  const ghLog = path.join(root, "gh.log");
  const ghPath = path.join(root, "gh.js");
  const clusterId = `clawsweeper-commit-${targetSlug}-${sha.slice(0, 12)}`;
  const jobPath = path.join(process.cwd(), "jobs", "openclaw", "inbox", `${clusterId}.md`);
  const auditRoot = path.join(process.cwd(), "results", "commit-findings", targetSlug);
  const runRoot = path.join(process.cwd(), ".clawsweeper-repair", "runs");

  fs.writeFileSync(
    ghPath,
    [
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.MOCK_GH_LOG, `${JSON.stringify(args)}\\n`);",
      `if (args[0] === "api" && args[1] === ${JSON.stringify(`repos/${reportRepo}/contents/${reportPath}`)}) {`,
      `  process.stdout.write(${JSON.stringify(reportBytes.toString("base64"))});`,
      "  process.exit(0);",
      "}",
      `if (args[0] === "api" && args[1] === ${JSON.stringify(`repos/${targetRepo}/commits/main`)}) {`,
      `  process.stdout.write(${JSON.stringify("f".repeat(40))});`,
      "  process.exit(0);",
      "}",
      'process.stderr.write(`unexpected gh args: ${args.join(" ")}\\n`);',
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const child = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/commit-finding-intake.js"),
        "prepare",
        "--target-repo",
        targetRepo,
        "--commit-sha",
        sha,
        "--report-repo",
        reportRepo,
        "--report-path",
        reportPath,
        "--report-revision",
        revision,
        "--report-sha256",
        "0".repeat(64),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...mockGhBinEnv(ghPath, root),
          MOCK_GH_LOG: ghLog,
        },
      },
    );

    assert.equal(child.status, 2);
    assert.match(child.stderr, /commit finding report SHA-256 mismatch/);
    const invocations = fs
      .readFileSync(ghLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(invocations.length, 1);
    assert.ok(invocations[0]?.includes(`ref=${revision}`));
    assert.ok(!invocations[0]?.includes("ref=main"));
    assert.equal(fs.existsSync(jobPath), false);
    assert.equal(fs.existsSync(path.join(auditRoot, `${sha}.md`)), false);
    assert.equal(
      fs.existsSync(runRoot) &&
        fs.readdirSync(runRoot).some((entry) => entry.startsWith(`${clusterId}-commit-finding-`)),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(jobPath, { force: true });
    fs.rmSync(auditRoot, { recursive: true, force: true });
    if (fs.existsSync(runRoot)) {
      for (const entry of fs.readdirSync(runRoot)) {
        if (entry.startsWith(`${clusterId}-commit-finding-`)) {
          fs.rmSync(path.join(runRoot, entry), { recursive: true, force: true });
        }
      }
    }
  }
});

test("commit finding intake accepts only the canonical report repository and path", () => {
  const targetRepo = "openclaw/foo.bar_baz";
  const sha = "a".repeat(40);
  const revision = "b".repeat(40);
  const expectedPath = `records/openclaw-foo.bar_baz/commits/${sha}.md`;
  const baseArgs = [
    path.resolve("dist/repair/commit-finding-intake.js"),
    "prepare",
    "--target-repo",
    targetRepo,
    "--commit-sha",
    sha,
    "--report-revision",
    revision,
    "--report-sha256",
    "c".repeat(64),
  ];

  const wrongRepo = spawnSync(
    process.execPath,
    [...baseArgs, "--report-repo", "openclaw/clawsweeper", "--report-path", expectedPath],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(wrongRepo.status, 2);
  assert.match(wrongRepo.stderr, /report repository must be openclaw\/clawsweeper-state/);

  const canonicalPath = spawnSync(
    process.execPath,
    [
      ...baseArgs,
      "--report-repo",
      "openclaw/clawsweeper-state",
      "--report-path",
      expectedPath,
      "--report-url",
      "https://example.invalid/report",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(canonicalPath.status, 2);
  assert.match(canonicalPath.stderr, /report URL must match immutable report identity/);
  assert.doesNotMatch(canonicalPath.stderr, /report path must be/);

  const wrongPath = spawnSync(
    process.execPath,
    [
      ...baseArgs,
      "--report-repo",
      "openclaw/clawsweeper-state",
      "--report-path",
      `records/openclaw-foo-bar-baz/commits/${sha}.md`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(wrongPath.status, 2);
  assert.match(wrongPath.stderr, new RegExp(`report path must be ${expectedPath}`));
});

test("commit finding intake rejects a valid immutable report for another source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "commit-finding-intake-identity-"));
  const unique = randomUUID().replaceAll("-", "").slice(0, 12);
  const targetRepo = `openclaw/fixture-${unique}`;
  const targetSlug = `openclaw-fixture-${unique}`;
  const sha = "4".repeat(40);
  const revision = "5".repeat(40);
  const reportPath = `records/${targetSlug}/commits/${sha}.md`;
  const reportFile = path.join(root, "report.md");
  const reportBytes = Buffer.from(
    `---\nresult: findings\nsha: ${"6".repeat(40)}\nrepository: another/repo\n---\n\n## Summary\n\nWrong source.\n`,
    "utf8",
  );
  const clusterId = `clawsweeper-commit-${targetSlug}-${sha.slice(0, 12)}`;
  const jobPath = path.join(process.cwd(), "jobs", "openclaw", "inbox", `${clusterId}.md`);
  const auditRoot = path.join(process.cwd(), "results", "commit-findings", targetSlug);
  const runRoot = path.join(process.cwd(), ".clawsweeper-repair", "runs");
  fs.writeFileSync(reportFile, reportBytes);

  try {
    const child = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/commit-finding-intake.js"),
        "prepare",
        "--target-repo",
        targetRepo,
        "--commit-sha",
        sha,
        "--report-repo",
        "openclaw/clawsweeper-state",
        "--report-path",
        reportPath,
        "--report-revision",
        revision,
        "--report-sha256",
        createHash("sha256").update(reportBytes).digest("hex"),
        "--report-file",
        reportFile,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(child.status, 2);
    assert.match(
      child.stderr,
      new RegExp(`commit finding report identity mismatch: expected ${targetRepo}@${sha}`),
    );
    assert.equal(fs.existsSync(jobPath), false);
    assert.equal(fs.existsSync(path.join(auditRoot, `${sha}.md`)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(jobPath, { force: true });
    fs.rmSync(auditRoot, { recursive: true, force: true });
    if (fs.existsSync(runRoot)) {
      for (const entry of fs.readdirSync(runRoot)) {
        if (entry.startsWith(`${clusterId}-commit-finding-`)) {
          fs.rmSync(path.join(runRoot, entry), { recursive: true, force: true });
        }
      }
    }
  }
});

test("commit finding intake accepts mixed-case report repository identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "commit-finding-intake-repository-case-"));
  const unique = randomUUID().replaceAll("-", "").slice(0, 12);
  const targetRepo = `openclaw/fixture-${unique}`;
  const mixedCaseRepo = `OpenClaw/Fixture-${unique}`;
  const targetSlug = `openclaw-fixture-${unique}`;
  const sha = "7".repeat(40);
  const revision = "8".repeat(40);
  const reportPath = `records/${targetSlug}/commits/${sha}.md`;
  const reportFile = path.join(root, "report.md");
  const reportBytes = Buffer.from(
    `---\nresult: no_findings\nsha: ${sha}\nrepository: ${mixedCaseRepo}\n---\n\n## Summary\n\nNo remaining finding.\n`,
    "utf8",
  );
  const ghPath = path.join(root, "gh.js");
  const auditRoot = path.join(process.cwd(), "results", "commit-findings", targetSlug);
  fs.writeFileSync(reportFile, reportBytes);
  fs.writeFileSync(
    ghPath,
    [
      "const args = process.argv.slice(2);",
      `if (args[0] === "api" && args[1] === ${JSON.stringify(`repos/${targetRepo}/commits/main`)}) {`,
      `  process.stdout.write(${JSON.stringify("9".repeat(40))});`,
      "  process.exit(0);",
      "}",
      'process.stderr.write(`unexpected gh args: ${args.join(" ")}\\n`);',
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const child = spawnSync(
      process.execPath,
      [
        path.resolve("dist/repair/commit-finding-intake.js"),
        "prepare",
        "--target-repo",
        targetRepo,
        "--commit-sha",
        sha,
        "--report-repo",
        "openclaw/clawsweeper-state",
        "--report-path",
        reportPath,
        "--report-revision",
        revision,
        "--report-sha256",
        createHash("sha256").update(reportBytes).digest("hex"),
        "--report-file",
        reportFile,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, ...mockGhBinEnv(ghPath, root) },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    const summary = JSON.parse(child.stdout);
    assert.equal(summary.status, "non_findings");
    assert.equal(summary.target_repo, targetRepo);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(auditRoot, { recursive: true, force: true });
  }
});

test("commit finding intake classifies missing report blobs as skips", () => {
  const revision = "c".repeat(40);
  assert.equal(isMissingGithubContentError("gh: Not Found (HTTP 404)"), true);
  assert.equal(isMissingGithubContentError("HTTP 503: Service Unavailable"), false);

  assert.deepEqual(
    missingCommitFindingReport(
      "openclaw/clawsweeper-state",
      "records/openclaw-openclaw/commits/abc.md",
      revision,
    ),
    {
      ok: false,
      reason: `report openclaw/clawsweeper-state:records/openclaw-openclaw/commits/abc.md is not available at ${revision}`,
    },
  );
});
