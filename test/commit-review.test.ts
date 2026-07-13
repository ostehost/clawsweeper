import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/commit-sweeper.js", import.meta.url));

test("commit review ledger attestation runs outside the Codex review job", () => {
  const workflow = fs.readFileSync(".github/workflows/commit-review.yml", "utf8");
  const review = workflow.slice(workflow.indexOf("\n  review:"), workflow.indexOf("\n  attest:"));
  const attestor = workflow.slice(
    workflow.indexOf("\n  attest:"),
    workflow.indexOf("\n  publish:"),
  );

  assert.doesNotMatch(review, /setup-action-ledger|CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT/);
  assert.doesNotMatch(review, /permission-checks: write|publish-check|finish-review/);
  assert.match(attestor, /setup-action-ledger/);
  assert.match(attestor, /node dist\/commit-sweeper\.js attest-review/);
  assert.match(attestor, /--report-path "\$report_path"/);
  assert.match(attestor, /Finalize commit review action ledger/);
});

test("commit review captures the complete structured Codex stream", () => {
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
    fs.writeFileSync(path.join(targetDir, "review.txt"), "changed\n");
    git(targetDir, "commit", "-qam", "review target");
    const sha = git(targetDir, "rev-parse", "HEAD");

    const codexPath = path.join(binDir, "codex");
    fs.writeFileSync(
      codexPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
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
const outputIndex = args.indexOf("--output-last-message");
const outputPath = args[outputIndex + 1];
process.stdout.write(JSON.stringify({ type: "thread.started", marker: "stream-start" }) + "\\n");
for (let index = 0; index < 1600; index += 1) {
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    index,
    payload: "x".repeat(80)
  }) + "\\n");
}
process.stdout.write(JSON.stringify({ type: "turn.completed", marker: "stream-end" }) + "\\n");
process.stderr.write("stderr-start\\n");
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
  "No findings.",
  ""
].join("\\n"));
`,
      { mode: 0o755 },
    );
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(ghPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

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
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_INTERNAL_MODEL: "private-model-name",
          CODEX_BIN: codexPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const invocation = JSON.parse(fs.readFileSync(invocationPath, "utf8")) as string[];
    assert.ok(invocation.includes("--json"));
    assert.doesNotMatch(invocation.join(" "), /private-model-name/);

    const jsonl = fs.readFileSync(path.join(workDir, `${sha}.jsonl`), "utf8");
    assert.ok(Buffer.byteLength(jsonl) > 64 * 1024);
    const events = jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events[0]?.marker, "stream-start");
    assert.equal(events.at(-1)?.marker, "stream-end");
    assert.equal(events.length, 1602);

    const stderr = fs.readFileSync(path.join(workDir, `${sha}.stderr.log`), "utf8");
    assert.ok(Buffer.byteLength(stderr) > 64 * 1024);
    assert.match(stderr, /^stderr-start\n/);
    assert.match(stderr, /stderr-end\n$/);
    assert.ok(fs.existsSync(path.join(reportDir, "openclaw-clawsweeper", "commits", `${sha}.md`)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(process.env.GIT_BIN ?? "git", args, { cwd, encoding: "utf8" }).trim();
}
