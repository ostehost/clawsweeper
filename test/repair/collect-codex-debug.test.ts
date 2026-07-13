import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectCodexDebug, redactSecrets } from "../../dist/repair/collect-codex-debug.js";

test("collectCodexDebug copies recent Codex session logs and excludes auth files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-"));
  const codexHome = path.join(tmp, ".codex");
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(path.join(codexHome, "sessions", "2026", "05", "02"), { recursive: true });
  fs.mkdirSync(path.join(codexHome, "log"), { recursive: true });

  const sessionPath = path.join(codexHome, "sessions", "2026", "05", "02", "session.jsonl");
  const logPath = path.join(codexHome, "log", "codex-tui.log");
  fs.writeFileSync(
    sessionPath,
    'prompt sk-proj-abcdefghijklmnopqrstuvwxyz\n{"model":"secret-model-for-test"}\n',
  );
  fs.writeFileSync(logPath, "GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456\n");
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-secret"}\n');
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = 'gpt-5.6-sol'\n");

  try {
    const result = collectCodexDebug({
      outDir,
      label: "test",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: tmp,
      codexHome,
      redactValues: ["secret-model-for-test"],
    });

    assert.equal(result.manifest.length, 2);
    assert.equal(
      fs.existsSync(path.join(outDir, "sessions", "2026", "05", "02", "session.jsonl")),
      true,
    );
    assert.equal(fs.existsSync(path.join(outDir, "log", "codex-tui.log")), true);
    assert.equal(fs.existsSync(path.join(outDir, "auth.json")), false);
    assert.equal(fs.existsSync(path.join(outDir, "config.toml")), false);
    assert.match(
      fs.readFileSync(path.join(outDir, "sessions", "2026", "05", "02", "session.jsonl"), "utf8"),
      /\[REDACTED_OPENAI_KEY\]/,
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(outDir, "sessions", "2026", "05", "02", "session.jsonl"), "utf8"),
      /secret-model-for-test/,
    );
    assert.match(
      fs.readFileSync(path.join(outDir, "sessions", "2026", "05", "02", "session.jsonl"), "utf8"),
      /\[REDACTED\]/,
    );
    assert.match(
      fs.readFileSync(path.join(outDir, "log", "codex-tui.log"), "utf8"),
      /GH_TOKEN=\[REDACTED\]/,
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.label, "test");
    assert.equal(manifest.files.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectCodexDebug backs up Codex JSONL from repair run artifacts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-runs-"));
  const codexHome = path.join(tmp, ".codex");
  const repairRunsDir = path.join(tmp, ".clawsweeper-repair", "runs");
  const runDir = path.join(repairRunsDir, "run-1", "fix-execution");
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(codexHome, "log"), { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "adopted-codex-1.jsonl"),
    "GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456\n",
  );
  fs.writeFileSync(path.join(runDir, "adopted-codex-review-1.json"), '{"ok":true}\n');
  fs.writeFileSync(path.join(runDir, "result.json"), '{"status":"ignored"}\n');

  try {
    const result = collectCodexDebug({
      outDir,
      label: "runs",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: tmp,
      codexHome,
      repairRunsDir,
    });

    assert.equal(result.manifest.length, 2);
    assert.equal(
      fs.existsSync(
        path.join(outDir, "repair-runs", "run-1", "fix-execution", "adopted-codex-1.jsonl"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(outDir, "repair-runs", "run-1", "fix-execution", "adopted-codex-review-1.json"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(outDir, "repair-runs", "run-1", "fix-execution", "result.json")),
      false,
    );
    assert.match(
      fs.readFileSync(
        path.join(outDir, "repair-runs", "run-1", "fix-execution", "adopted-codex-1.jsonl"),
        "utf8",
      ),
      /GH_TOKEN=\[REDACTED\]/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectCodexDebug defaults to CODEX_HOME when set", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-env-"));
  const codexHome = path.join(tmp, "isolated-codex-home");
  const outDir = path.join(tmp, "out");
  const previous = process.env.CODEX_HOME;
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "sessions", "run.jsonl"), "ok\n");

  try {
    process.env.CODEX_HOME = codexHome;
    const result = collectCodexDebug({
      outDir,
      label: "env",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: path.join(tmp, "home"),
    });

    assert.equal(result.manifest.length, 1);
    assert.equal(fs.existsSync(path.join(outDir, "sessions", "run.jsonl")), true);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectCodexDebug redacts config model from the default home directory", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-default-home-"));
  const codexHome = path.join(tmp, ".codex");
  const outDir = path.join(tmp, "out");
  const previous = process.env.CODEX_HOME;
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "default-secret-model"\n');
  fs.writeFileSync(
    path.join(codexHome, "sessions", "run.jsonl"),
    '{"model":"default-secret-model"}\n',
  );

  try {
    delete process.env.CODEX_HOME;
    collectCodexDebug({
      outDir,
      label: "default-home",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: tmp,
    });

    const artifact = fs.readFileSync(path.join(outDir, "sessions", "run.jsonl"), "utf8");
    assert.doesNotMatch(artifact, /default-secret-model/);
    assert.match(artifact, /\[REDACTED_INTERNAL_MODEL\]/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("redactSecrets masks common token shapes", () => {
  assert.equal(
    redactSecrets(
      [
        "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz",
        '"GITHUB_TOKEN":"github_pat_abcdefghijklmnopqrstuvwxyz123456"',
        "token ghp_abcdefghijklmnopqrstuvwxyz123456",
        "Authorization: Bearer older-bearer-token-value",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvbGRlciJ9.abcdefghijklmnop",
        '"token":"older-file-token-value"',
        "privateKey: older-private-key-value",
      ].join("\n"),
    ),
    [
      "OPENAI_API_KEY=[REDACTED]",
      '"GITHUB_TOKEN":"[REDACTED]"',
      "token [REDACTED_GITHUB_TOKEN]",
      "Authorization: Bearer [REDACTED]",
      "jwt [REDACTED_JWT]",
      '"token":"[REDACTED]"',
      "privateKey: [REDACTED]",
    ].join("\n"),
  );
});

test("redactSecrets masks multiline credentials and private keys", () => {
  for (const indicator of ["|", "|2", "|2-", "|-2", ">2-"]) {
    const redacted = redactSecrets(
      [
        `private_key: ${indicator}`,
        "  -----BEGIN PRIVATE KEY-----",
        "  sensitive-key-material",
        "  -----END PRIVATE KEY-----",
      ].join("\n"),
    );

    assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY|sensitive-key-material|END PRIVATE KEY/);
    assert.match(redacted, /private_key: \[REDACTED\]\n  \[REDACTED_MULTILINE\]/);
  }
});

test("redactSecrets masks multiline credential paragraphs and truncated private keys", () => {
  const redactedBlock = redactSecrets(
    [
      "credential: >2-",
      "  first-sensitive-paragraph",
      "",
      "  second-sensitive-paragraph",
      "after: visible",
    ].join("\n"),
  );
  assert.doesNotMatch(redactedBlock, /first-sensitive|second-sensitive/);
  assert.match(redactedBlock, /\[REDACTED_MULTILINE\]/);
  assert.match(redactedBlock, /after: visible/);

  const redactedPem = redactSecrets(
    ["before", "-----BEGIN PRIVATE KEY-----", "truncated-sensitive-material"].join("\n"),
  );
  assert.equal(redactedPem, "before\n[REDACTED_PRIVATE_KEY]");
});

test("collectCodexDebug redacts file-sourced credentials absent from the current environment", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-historical-"));
  const codexHome = path.join(tmp, ".codex");
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "sessions", "historical.jsonl"),
    [
      '"actions_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvbGRlciJ9.abcdefghijklmnop"',
      "Authorization: Bearer older-bearer-token-value",
      '"token":"older-file-token-value"',
    ].join("\n"),
  );

  try {
    const result = collectCodexDebug({
      outDir,
      label: "historical",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: tmp,
      codexHome,
    });

    assert.equal(result.manifest.length, 1);
    const artifact = fs.readFileSync(path.join(outDir, "sessions", "historical.jsonl"), "utf8");
    assert.doesNotMatch(artifact, /eyJhbGci|older-bearer|older-file-token/);
    assert.match(artifact, /"actions_token":"\[REDACTED\]"/);
    assert.match(artifact, /Bearer \[REDACTED\]/);
    assert.match(artifact, /"token":"\[REDACTED\]"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectCodexDebug redacts retained multiline private keys", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-private-key-"));
  const codexHome = path.join(tmp, ".codex");
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "sessions", "private-key.jsonl"),
    [
      "private_key: >2-",
      "  first-sensitive-paragraph",
      "",
      "  second-sensitive-paragraph",
      "-----BEGIN PRIVATE KEY-----",
      "truncated-sensitive-key-material",
    ].join("\n"),
  );

  try {
    const result = collectCodexDebug({
      outDir,
      label: "private-key",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: tmp,
      codexHome,
    });

    assert.equal(result.manifest.length, 1);
    const artifact = fs.readFileSync(path.join(outDir, "sessions", "private-key.jsonl"), "utf8");
    assert.doesNotMatch(
      artifact,
      /BEGIN PRIVATE KEY|first-sensitive|second-sensitive|truncated-sensitive/,
    );
    assert.match(artifact, /\[REDACTED_MULTILINE\]/);
    assert.match(artifact, /\[REDACTED_PRIVATE_KEY\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectCodexDebug redacts the internal model from its environment", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-model-"));
  const codexHome = path.join(tmp, ".codex");
  const outDir = path.join(tmp, "out");
  const previous = process.env.CLAWSWEEPER_INTERNAL_MODEL;
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "sessions", "run.jsonl"),
    '{"model":"environment-secret-model"}\n',
  );

  try {
    process.env.CLAWSWEEPER_INTERNAL_MODEL = "environment-secret-model";
    collectCodexDebug({
      outDir,
      label: "model",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: tmp,
      codexHome,
    });

    const artifact = fs.readFileSync(path.join(outDir, "sessions", "run.jsonl"), "utf8");
    assert.doesNotMatch(artifact, /environment-secret-model/);
    assert.match(artifact, /\[REDACTED_INTERNAL_MODEL\]/);
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_INTERNAL_MODEL;
    else process.env.CLAWSWEEPER_INTERNAL_MODEL = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectCodexDebug redacts the internal model from Codex config", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-config-model-"));
  const codexHome = path.join(tmp, ".codex");
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "config-secret-model"\n');
  fs.writeFileSync(
    path.join(codexHome, "sessions", "run.jsonl"),
    '{"model":"config-secret-model"}\n',
  );

  try {
    collectCodexDebug({
      outDir,
      label: "model",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: tmp,
      codexHome,
    });

    const artifact = fs.readFileSync(path.join(outDir, "sessions", "run.jsonl"), "utf8");
    assert.doesNotMatch(artifact, /config-secret-model/);
    assert.match(artifact, /\[REDACTED_INTERNAL_MODEL\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectCodexDebug redacts current Actions credentials by default", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-actions-"));
  const codexHome = path.join(tmp, ".codex");
  const outDir = path.join(tmp, "out");
  const previous = {
    ACTIONS_RUNTIME_TOKEN: process.env.ACTIONS_RUNTIME_TOKEN,
    ACTIONS_RESULTS_URL: process.env.ACTIONS_RESULTS_URL,
  };
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "sessions", "run.jsonl"),
    [
      "ACTIONS_RUNTIME_TOKEN=actions-runtime-token-for-test",
      '{"ACTIONS_RESULTS_URL":"https://results.example.invalid/runtime-secret"}',
    ].join("\n"),
  );

  try {
    process.env.ACTIONS_RUNTIME_TOKEN = "actions-runtime-token-for-test";
    process.env.ACTIONS_RESULTS_URL = "https://results.example.invalid/runtime-secret";
    collectCodexDebug({
      outDir,
      label: "actions",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: tmp,
      codexHome,
    });

    const artifact = fs.readFileSync(path.join(outDir, "sessions", "run.jsonl"), "utf8");
    assert.doesNotMatch(artifact, /actions-runtime-token-for-test|runtime-secret/);
    assert.match(artifact, /ACTIONS_RUNTIME_TOKEN=\[REDACTED\]/);
    assert.match(artifact, /"ACTIONS_RESULTS_URL":"\[REDACTED\]"/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
