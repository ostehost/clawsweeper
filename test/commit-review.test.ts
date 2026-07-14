import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/commit-sweeper.js", import.meta.url));

test("commit review emits current-attempt report and receipt bundles without write credentials", () => {
  const workflow = fs.readFileSync(".github/workflows/commit-review.yml", "utf8");
  const review = workflow.slice(workflow.indexOf("\n  review:"), workflow.indexOf("\n  publish:"));

  assert.match(review, /setup-action-ledger/);
  assert.match(review, /CLAWSWEEPER_ACTION_LEDGER_INVOCATION: commit-\$\{\{ matrix\.sha \}\}/);
  assert.doesNotMatch(review, /permission-checks: write|publish-check|finish-review/);
  assert.doesNotMatch(review, /COMMIT_SWEEPER_TARGET_GH_TOKEN/);
  assert.doesNotMatch(review, /create-state-token|setup-state|CLAWSWEEPER_STATE_DIR/);
  assert.match(review, /--codex-sandbox read-only/);
  assert.match(review, /--require-publishable-report/);
  assert.doesNotMatch(review, /--defer-workflow-completion/);
  assert.match(review, /remote set-url origin "https:\/\/github\.com\/\$\{TARGET_REPO\}\.git"/);
  assert.doesNotMatch(review, /path: commit-work\/\*\*/);
  assert.match(review, /path: commit-work\/\$\{\{ matrix\.sha \}\}\.diagnostic\.json/);
  assert.doesNotMatch(
    review,
    /commit-work\/\$\{\{ matrix\.sha \}\}\.(?:prompt\.md|jsonl|stderr\.log|md)/,
  );
  assert.match(review, /Finalize commit review action ledger/);
  assert.match(review, /Prepare commit review receipt bundle/);
  assert.match(
    review,
    /name: commit-review-\$\{\{ matrix\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(review, /cp -R "\$output_root"\/\. "\$bundle_root\/ledger\/"/);
});

test("commit report publication accepts only exact current-attempt bundles", () => {
  const workflow = fs.readFileSync(".github/workflows/commit-review.yml", "utf8");
  const publisher = workflow.slice(workflow.indexOf("\n  publish:"));

  assert.match(
    publisher,
    /pattern: commit-review-\*-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(
    publisher,
    /artifact_name="commit-review-\$\{commit_sha\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
  );
  assert.match(publisher, /--expected-job review/);
  assert.match(publisher, /--expected-run-attempt "\$GITHUB_RUN_ATTEMPT"/);
  assert.match(publisher, /--commit-report "\$\{report_files\[0\]\}"/);
  assert.match(publisher, /cmp -s "\$expected_shas_file" "\$actual_shas_file"/);
  assert.match(publisher, /COMMIT_SWEEPER_ADDITIONAL_PROMPT:/);
  assert.doesNotMatch(publisher, /--additional-prompt "\$ADDITIONAL_PROMPT"/);
  assert.match(publisher, /Attest current-attempt commit review reports/);
  assert.ok(
    publisher.indexOf("- name: Attest current-attempt commit review reports") <
      publisher.indexOf("- name: Commit reports"),
  );
  assert.doesNotMatch(
    publisher,
    /resolve-run-artifact|CLAWSWEEPER_ALLOW_PRIOR_ARTIFACT|prior attempt|prior-attempt/,
  );
});

test("commit review materializes private clone data before removing review credentials", () => {
  const workflow = fs.readFileSync(".github/workflows/commit-review.yml", "utf8");
  const review = workflow.slice(workflow.indexOf("\n  review:"), workflow.indexOf("\n  publish:"));
  const checkout = review.slice(
    review.indexOf("      - name: Check out target main"),
    review.indexOf("      - name: Review commit"),
  );
  const reviewCommit = review.slice(
    review.indexOf("      - name: Review commit"),
    review.indexOf("      - name: Upload commit review diagnostic"),
  );
  const hydrateIdentities = review.slice(
    review.indexOf("      - name: Hydrate commit identities"),
    review.indexOf("      - name: Review commit"),
  );
  const materializeCommit =
    'git -C "$TARGET_NAME" diff --no-ext-diff --binary "$COMMIT_SHA^" "$COMMIT_SHA" >/dev/null';
  const removePromisorCredential =
    'git -C "$TARGET_NAME" remote set-url origin "https://github.com/${TARGET_REPO}.git"';

  assert.match(checkout, /TARGET_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \}\}/);
  assert.ok(checkout.includes(materializeCommit));
  assert.ok(checkout.indexOf(materializeCommit) < checkout.indexOf(removePromisorCredential));
  assert.match(hydrateIdentities, /GH_TOKEN: \$\{\{ steps\.target-read-token\.outputs\.token \}\}/);
  assert.match(hydrateIdentities, /gh api "repos\/\$TARGET_REPO\/commits\/\$COMMIT_SHA"/);
  assert.doesNotMatch(reviewCommit, /GH_TOKEN|GITHUB_TOKEN|TARGET_TOKEN/);
  assert.match(reviewCommit, /--prehydrated-github-metadata/);
  assert.match(
    reviewCommit,
    /--github-author "\$\{\{ steps\.commit-identities\.outputs\.github_author \}\}"/,
  );
  assert.doesNotMatch(reviewCommit, /COMMIT_SWEEPER_TARGET_GH_TOKEN/);
});

test("commit review retains only content-safe diagnostics", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-review-stream-")));
  const targetDir = path.join(root, "target");
  const reportDir = path.join(root, "reports");
  const workDir = path.join(root, "work");
  const binDir = path.join(root, "bin");
  const invocationPath = path.join(root, "codex-args.json");
  fs.mkdirSync(targetDir);
  fs.mkdirSync(binDir);

  try {
    git(targetDir, "init", "-q");
    git(targetDir, "config", "user.name", "Test Author");
    git(targetDir, "config", "user.email", "test@example.com");
    git(targetDir, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(targetDir, "review.txt"), "base\n");
    git(targetDir, "add", "review.txt");
    git(targetDir, "commit", "-q", "-m", "base");
    const baseSha = git(targetDir, "rev-parse", "HEAD");
    const sourceSecret = "fixture-source-private-token-123456";
    const escapedSecret = "fixture-private-key-123456\nfixture-private-line-abcdef";
    const promptSecret = "fixture-prompt-private-token-123456";
    fs.writeFileSync(path.join(targetDir, "review.txt"), `${sourceSecret}\n`);
    git(targetDir, "commit", "-qam", "review target");
    const sha = git(targetDir, "rev-parse", "HEAD");
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "private-model-name"\n');

    const codexPath = path.join(binDir, "codex");
    fs.writeFileSync(
      codexPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify(args));
if (!args.includes("--json")) {
  process.stderr.write("missing --json");
  process.exit(2);
}
if (process.env.CLAWSWEEPER_INTERNAL_MODEL) {
  process.stderr.write("internal model leaked");
  process.exit(3);
}
for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) {
  if (process.env[name]) {
    process.stderr.write(name + " leaked");
    process.exit(4);
  }
}
for (const entry of fs.readdirSync(os.tmpdir())) {
  if (!entry.startsWith("clawsweeper-codex-process-")) continue;
  const optionsPath = path.join(os.tmpdir(), entry, "options.json");
  if (!fs.existsSync(optionsPath)) continue;
  const options = fs.readFileSync(optionsPath, "utf8");
  if (options.includes("private-model-name") || options.includes("ghs_review-secret-token-123456")) {
    process.stderr.write("redaction secret persisted in worker options");
    process.exit(5);
  }
}
const prompt = fs.readFileSync(0, "utf8");
if (
  prompt.includes("private-model-name") ||
  prompt.includes("ghs_review-read-token-123456") ||
  prompt.includes("ghs_review-secret-token-123456")
) {
  process.stderr.write("redaction secret forwarded to Codex stdin");
  process.exit(6);
}
if (!prompt.includes("- GitHub author: hydrated-author")) {
  process.stderr.write("GitHub author was not hydrated");
  process.exit(7);
}
if (!prompt.includes(${JSON.stringify(promptSecret)})) {
  process.stderr.write("additional prompt was not forwarded");
  process.exit(8);
}
const sourceSecret = fs.readFileSync(path.join(process.cwd(), "review.txt"), "utf8").trim();
const escapedSecret = ${JSON.stringify(escapedSecret)};
const outputIndex = args.indexOf("--output-last-message");
const outputPath = args[outputIndex + 1];
process.stdout.write(JSON.stringify({
  type: "thread.started",
  marker: "stream-start",
  model: "private-model-name",
  sourceSecret,
  promptSecret: ${JSON.stringify(promptSecret)}
}) + "\\n");
for (let index = 0; index < 1600; index += 1) {
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    index,
    payload: "x".repeat(80)
  }) + "\\n");
}
process.stdout.write(JSON.stringify({ type: "turn.completed", marker: "stream-end" }) + "\\n");
process.stderr.write("stderr-start model=private-model-name source=" + sourceSecret + " prompt=${promptSecret}\\n");
process.stderr.write("diagnostic\\n".repeat(7000));
process.stderr.write("stderr-end\\n");
fs.writeFileSync(outputPath, [
  "---",
  "repository: openclaw/clawsweeper",
  "sha: ${sha}",
  "result: nothing_found",
  "---",
  "",
  "# Commit Review",
  "",
  "Model echo: private-model-name",
  JSON.stringify({ credential: escapedSecret }),
  "",
  "No findings.",
  ""
].join("\\n"));
`,
      { mode: 0o755 },
    );
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(ghPath, '#!/bin/sh\necho "unexpected gh invocation" >&2\nexit 99\n', {
      mode: 0o755,
    });

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--target-repo",
        "openclaw/clawsweeper",
        "--target-dir",
        targetDir,
        "--commit-sha",
        sha,
        "--base-sha",
        baseSha,
        "--report-dir",
        reportDir,
        "--artifact-mode",
        "--work-dir",
        workDir,
        "--codex-model",
        "internal",
        "--codex-timeout-ms",
        "10000",
        "--require-publishable-report",
        "--prehydrated-github-metadata",
        "--github-author",
        "hydrated-author",
        "--github-committer",
        "hydrated-committer",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          GH_TOKEN: "ghs_review-read-token-123456",
          COMMIT_SWEEPER_TARGET_GH_TOKEN: "ghs_review-secret-token-123456",
          CLAWSWEEPER_APP_PRIVATE_KEY: escapedSecret,
          COMMIT_SWEEPER_ADDITIONAL_PROMPT: promptSecret,
          CODEX_BIN: codexPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const invocation = JSON.parse(fs.readFileSync(invocationPath, "utf8")) as string[];
    assert.ok(invocation.includes("--json"));
    assert.doesNotMatch(invocation.join(" "), /private-model-name/);

    const diagnosticPath = path.join(workDir, `${sha}.diagnostic.json`);
    const workFiles = fs.readdirSync(workDir);
    assert.deepEqual(workFiles, [`${sha}.diagnostic.json`]);
    const diagnosticText = fs.readFileSync(diagnosticPath, "utf8");
    const diagnostic = JSON.parse(diagnosticText) as Record<string, unknown>;
    assert.deepEqual(diagnostic, {
      diagnostic_version: 1,
      commit_sha: sha,
      outcome: "completed",
      failure_reason: "none",
      exit_status: 0,
      signal: null,
      stdout_capture_bytes: diagnostic.stdout_capture_bytes,
      stderr_capture_bytes: diagnostic.stderr_capture_bytes,
      report_produced: true,
    });
    assert.ok(Number(diagnostic.stdout_capture_bytes) > 64 * 1024);
    assert.ok(Number(diagnostic.stderr_capture_bytes) > 64 * 1024);
    assert.ok(Buffer.byteLength(diagnosticText) < 1024);
    assert.doesNotMatch(
      diagnosticText,
      /private-model-name|ghs_review-|fixture-source-private|fixture-prompt-private/,
    );
    const reportPath = path.join(reportDir, "openclaw-clawsweeper", "commits", `${sha}.md`);
    assert.ok(fs.existsSync(reportPath));
    const report = fs.readFileSync(reportPath, "utf8");
    assert.doesNotMatch(report, /ghs_review-read-token-123456/);
    assert.doesNotMatch(report, /ghs_review-secret-token-123456/);
    assert.doesNotMatch(report, /private-model-name/);
    assert.doesNotMatch(report, /fixture-private-line-abcdef/);
    assert.match(report, /\[REDACTED\]/);
    const uploadedArtifactContents = [diagnosticText, report].join("\n");
    assert.doesNotMatch(uploadedArtifactContents, new RegExp(sourceSecret));
    assert.doesNotMatch(uploadedArtifactContents, new RegExp(promptSecret));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("commit review publishability failure retains a diagnostic report and fails the producer", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "commit-review-failure-")));
  const targetDir = path.join(root, "target");
  const reportDir = path.join(root, "reports");
  const workDir = path.join(root, "work");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(targetDir);
  fs.mkdirSync(binDir);

  try {
    git(targetDir, "init", "-q");
    git(targetDir, "config", "user.name", "Test Author");
    git(targetDir, "config", "user.email", "test@example.com");
    git(targetDir, "config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(targetDir, "review.txt"), "base\n");
    git(targetDir, "add", "review.txt");
    git(targetDir, "commit", "-q", "-m", "base");
    const baseSha = git(targetDir, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(targetDir, "review.txt"), "changed\n");
    git(targetDir, "commit", "-qam", "review target");
    const sha = git(targetDir, "rev-parse", "HEAD");
    const codexPath = path.join(binDir, "codex");
    fs.writeFileSync(
      codexPath,
      "#!/usr/bin/env node\nprocess.stderr.write('synthetic failure fixture-source-private-token-987654\\n');\nprocess.exit(9);\n",
      { mode: 0o755 },
    );

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "review",
        "--target-repo",
        "openclaw/clawsweeper",
        "--target-dir",
        targetDir,
        "--commit-sha",
        sha,
        "--base-sha",
        baseSha,
        "--report-dir",
        reportDir,
        "--artifact-mode",
        "--work-dir",
        workDir,
        "--codex-model",
        "internal",
        "--codex-timeout-ms",
        "10000",
        "--require-publishable-report",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_BIN: codexPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /commit review report result is not publishable: failed/);
    const reportPath = path.join(reportDir, "openclaw-clawsweeper", "commits", `${sha}.md`);
    assert.equal(fs.existsSync(reportPath), true);
    const report = fs.readFileSync(reportPath, "utf8");
    assert.match(report, /^result: failed$/m);
    assert.match(report, /reason: nonzero_exit/);
    assert.match(report, /exit_status: 9/);
    assert.doesNotMatch(report, /synthetic failure|fixture-source-private-token/);
    const diagnostic = fs.readFileSync(path.join(workDir, `${sha}.diagnostic.json`), "utf8");
    assert.doesNotMatch(diagnostic, /synthetic failure|fixture-source-private-token/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(process.env.GIT_BIN ?? "git", args, { cwd, encoding: "utf8" }).trim();
}
