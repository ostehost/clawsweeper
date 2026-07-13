import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

test("repair output schema keeps every strict object property required", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "schema/repair/codex-result.schema.json"), "utf8"),
  );

  const visit = (value: unknown, location: string): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (node.type === "object" && node.additionalProperties === false) {
      const properties = Object.keys((node.properties ?? {}) as Record<string, unknown>).sort();
      const required = Array.isArray(node.required) ? node.required.map(String).sort() : [];
      assert.deepEqual(required, properties, `${location} must require every declared property`);
    }
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child)) {
        child.forEach((entry, index) => visit(entry, `${location}.${key}[${index}]`));
      } else {
        visit(child, `${location}.${key}`);
      }
    }
  };

  visit(schema, "schema");
});

test("run-worker starts Codex in the target checkout when one is available", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-run-worker-"));
  const fakeBin = path.join(tmp, "bin");
  const targetCheckout = path.join(tmp, "target-openclaw");
  const cwdFile = path.join(tmp, "codex-cwd.txt");
  const argsFile = path.join(tmp, "codex-args.json");
  const jobName = `run-worker-target-checkout-${path.basename(tmp)}`;
  const jobPath = path.join(tmp, `${jobName}.md`);

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(targetCheckout, { recursive: true });
  fs.writeFileSync(path.join(targetCheckout, "target-marker.txt"), "target\n");
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw') {",
      "  process.stdout.write(JSON.stringify({ default_branch: 'main' }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/branches/main') {",
      "  process.stdout.write(JSON.stringify({ commit: { sha: '1111111111111111111111111111111111111111' } }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "codex"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.FAKE_CODEX_CWD_FILE, process.cwd());",
      "fs.writeFileSync(process.env.FAKE_CODEX_ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
      "if (process.env.CLAWSWEEPER_INTERNAL_MODEL) process.exit(9);",
      "if (process.env.ACTIONS_RUNTIME_TOKEN) process.exit(10);",
      "if (process.env.ACTIONS_RESULTS_URL) process.exit(11);",
      "if (process.env.AMBIENT_DEPLOY_SECRET) process.exit(12);",
      "const outputIndex = process.argv.indexOf('--output-last-message');",
      "const outputPath = process.argv[outputIndex + 1];",
      "const secret = 'actions-runtime-token-for-test';",
      "const result = {",
      "  status: 'planned',",
      "  repo: 'openclaw/openclaw',",
      "  cluster_id: 'clawsweeper-run-worker-target-checkout',",
      "  mode: 'plan',",
      "  summary: secret,",
      "  actions: [],",
      "  needs_human: [],",
      "  canonical: null,",
      "  canonical_issue: null,",
      "  canonical_pr: null,",
      "  merge_preflight: [],",
      "  fix_artifact: null,",
      "};",
      "fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\\n`);",
      'process.stdout.write("actions-runtime-");',
      'process.stdout.write("token-for-test\\n");',
      'process.stdout.write("s".repeat(2 * 1024 * 1024));',
      'process.stdout.write(\'{"type":"fake"}\\n\');',
      'process.stderr.write("actions-runtime-token-for-test\\n");',
      'process.stderr.write("e".repeat(2 * 1024 * 1024));',
    ].join("\n"),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/openclaw",
      "cluster_id: clawsweeper-run-worker-target-checkout",
      "mode: plan",
      "allowed_actions:",
      "  - fix",
      "source: clawsweeper_commit",
      "commit_sha: 1111111111111111111111111111111111111111",
      "security_policy: central_security_only",
      "security_sensitive: false",
      "---",
      "Plan only.",
      "",
    ].join("\n"),
  );

  try {
    execFileSync(process.execPath, ["dist/repair/run-worker.js", jobPath, "--mode", "plan"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAWSWEEPER_TARGET_CHECKOUT: targetCheckout,
        FAKE_CODEX_CWD_FILE: cwdFile,
        FAKE_CODEX_ARGS_FILE: argsFile,
        CLAWSWEEPER_INTERNAL_MODEL: "secret-model-for-test",
        ACTIONS_RUNTIME_TOKEN: "actions-runtime-token-for-test",
        ACTIONS_RESULTS_URL: "https://results.example.invalid/runtime-secret",
        AMBIENT_DEPLOY_SECRET: "ambient-secret-for-test",
        CLAWSWEEPER_CODEX_STDIO_MAX_BUFFER_MB: "1",
        CLAWSWEEPER_STEERABLE_CODEX: "0",
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: "pipe",
    });

    assert.equal(fs.readFileSync(cwdFile, "utf8"), fs.realpathSync(targetCheckout));
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(args[args.indexOf("--cd") + 1], targetCheckout);
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(args.includes("--model"), false);
    assert.equal(args.includes("secret-model-for-test"), false);
    const runDirs = fs.globSync(path.join(repoRoot, `.clawsweeper-repair/runs/${jobName}-plan-*`));
    assert.equal(runDirs.length, 1);
    const runDir = runDirs[0];
    assert.ok(runDir);
    const rawOutputPath = args[args.indexOf("--output-last-message") + 1];
    assert.equal(path.relative(os.tmpdir(), rawOutputPath).startsWith(".."), false);
    assert.equal(path.relative(runDir, rawOutputPath).startsWith(".."), true);
    assert.ok(fs.statSync(path.join(runDir, "codex.jsonl")).size > 2 * 1024 * 1024);
    assert.ok(fs.statSync(path.join(runDir, "codex.stderr.log")).size >= 2 * 1024 * 1024);
    for (const artifact of ["result.json", "codex.jsonl", "codex.stderr.log"]) {
      assert.doesNotMatch(
        fs.readFileSync(path.join(runDir, artifact), "utf8"),
        /actions-runtime-token-for-test/,
      );
    }
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8")).summary,
      "[REDACTED]",
    );
  } finally {
    for (const runDir of fs.globSync(
      path.join(repoRoot, `.clawsweeper-repair/runs/${jobName}-plan-*`),
    )) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("run-worker preserves short failed Codex output after capture close", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-run-worker-failure-"));
  const fakeBin = path.join(tmp, "bin");
  const targetCheckout = path.join(tmp, "target-openclaw");

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(targetCheckout, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw') {",
      "  process.stdout.write(JSON.stringify({ default_branch: 'main' }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'api' && args[1] === 'repos/openclaw/openclaw/branches/main') {",
      "  process.stdout.write(JSON.stringify({ commit: { sha: '1111111111111111111111111111111111111111' } }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`);",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "codex"),
    [
      "#!/usr/bin/env node",
      "const stream = process.env.FAKE_CODEX_FAILURE_STREAM;",
      "const message = process.env.FAKE_CODEX_FAILURE_MESSAGE;",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process[stream].write(`${message}\\n`, () => process.exit(17));",
      "});",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    for (const stream of ["stderr", "stdout"] as const) {
      const message = `short ${stream} failure`;
      const jobName = `run-worker-short-${stream}-${path.basename(tmp)}`;
      const jobPath = path.join(tmp, `${jobName}.md`);
      fs.writeFileSync(
        jobPath,
        [
          "---",
          "repo: openclaw/openclaw",
          `cluster_id: ${jobName}`,
          "mode: plan",
          "allowed_actions:",
          "  - fix",
          "source: clawsweeper_commit",
          "commit_sha: 1111111111111111111111111111111111111111",
          "security_policy: central_security_only",
          "security_sensitive: false",
          "---",
          "Plan only.",
          "",
        ].join("\n"),
      );

      const run = spawnSync(
        process.execPath,
        ["dist/repair/run-worker.js", jobPath, "--mode", "plan"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            CLAWSWEEPER_TARGET_CHECKOUT: targetCheckout,
            CLAWSWEEPER_STEERABLE_CODEX: "0",
            FAKE_CODEX_FAILURE_STREAM: stream,
            FAKE_CODEX_FAILURE_MESSAGE: message,
            LONG_FAILURE_CAPTURE_SECRET: "x".repeat(256),
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(run.status, 1);
      assert.match(run.stderr, new RegExp(message));
      const runDirs = fs.globSync(
        path.join(repoRoot, `.clawsweeper-repair/runs/${jobName}-plan-*`),
      );
      assert.equal(runDirs.length, 1);
      const runDir = runDirs[0];
      assert.ok(runDir);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8")).summary,
        message,
      );
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  } finally {
    for (const runDir of fs.globSync(
      path.join(
        repoRoot,
        `.clawsweeper-repair/runs/run-worker-short-*-${path.basename(tmp)}-plan-*`,
      ),
    )) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
