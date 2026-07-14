import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectCodexDebug,
  containsSensitiveValue,
  redactSecrets,
} from "../../dist/repair/collect-codex-debug.js";

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
      "Authorization: [REDACTED]",
      "jwt [REDACTED_JWT]",
      '"token":"[REDACTED]"',
      "privateKey: [REDACTED]",
    ].join("\n"),
  );
});

test("redactSecrets masks authorization and cookie headers at every encoding depth", () => {
  const headers = [
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "Proxy-Authorization: Digest username=test,response=secret",
    "Cookie: session=secret; csrf=hidden",
    "Set-Cookie: session=secret; HttpOnly",
  ];
  const input = headers.join("\n");

  assert.equal(containsSensitiveValue(input, []), true);
  const redacted = redactSecrets(input);
  assert.equal(
    redacted,
    [
      "Authorization: [REDACTED]",
      "Proxy-Authorization: [REDACTED]",
      "Cookie: [REDACTED]",
      "Set-Cookie: [REDACTED]",
    ].join("\n"),
  );
  assert.equal(containsSensitiveValue(redacted, []), false);

  const structured = JSON.stringify({
    Authorization: "Basic dXNlcjpwYXNzd29yZA==",
    Cookie: "session=secret",
    visible: "safe",
  });
  for (let depth = 0; depth <= 3; depth += 1) {
    const encoded = encodeJsonDepth(structured, depth);
    assert.equal(containsSensitiveValue(encoded, []), true);
    const retained = JSON.parse(decodeJsonDepth(redactSecrets(encoded), depth));
    assert.deepEqual(retained, {
      Authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
      visible: "safe",
    });
  }
});

test("redactSecrets masks textual headers inside escaped log messages and curl traces", () => {
  const payload = JSON.stringify({
    message: [
      "request failed",
      "> Authorization: Basic dXNlcjpwYXNzd29yZA==",
      "< Set-Cookie: session=secret; HttpOnly",
    ].join("\n"),
    visible: "safe",
  });
  const representations = [
    payload,
    JSON.stringify(payload),
    JSON.stringify(JSON.stringify(payload)),
  ];

  for (const representation of representations) {
    assert.equal(containsSensitiveValue(representation, []), true);
    const redacted = redactSecrets(representation);
    assert.equal(containsSensitiveValue(redacted, []), false);
    assert.doesNotMatch(redacted, /dXNlcjpwYXNzd29yZA|session=secret/);

    let decoded = redacted;
    while (typeof JSON.parse(decoded) === "string") decoded = JSON.parse(decoded);
    assert.deepEqual(JSON.parse(decoded), {
      message: ["request failed", "> Authorization: [REDACTED]", "< Set-Cookie: [REDACTED]"].join(
        "\n",
      ),
      visible: "safe",
    });
  }
});

test("redactSecrets masks a header embedded in an ordinary JSONL message value", () => {
  const input = JSON.stringify({
    type: "event",
    message: "upstream said Authorization: Basic dXNlcjpwYXNzd29yZA==",
  });

  assert.equal(containsSensitiveValue(input, []), true);
  const redacted = redactSecrets(input);
  assert.deepEqual(JSON.parse(redacted), {
    type: "event",
    message: "upstream said Authorization: [REDACTED]",
  });
  assert.equal(containsSensitiveValue(redacted, []), false);
});

test("redactSecrets independently masks repeated headers on one escaped line", () => {
  const input = JSON.stringify({
    message:
      "Cookie: [REDACTED] Authorization: Basic dXNlcjpwYXNzd29yZA== Proxy-Authorization: Digest secret",
  });

  assert.equal(containsSensitiveValue(input, []), true);
  const redacted = redactSecrets(input);
  assert.deepEqual(JSON.parse(redacted), {
    message: "Cookie: [REDACTED] Authorization: [REDACTED] Proxy-Authorization: [REDACTED]",
  });
  assert.equal(containsSensitiveValue(redacted, []), false);
});

test("redactSecrets rescans enclosing strings after nested header redaction", () => {
  const input = JSON.stringify({
    message: `${JSON.stringify({ x: "Cookie: INNER" })} Authorization: Basic OUTER`,
  });

  assert.equal(containsSensitiveValue(input, []), true);
  const redacted = redactSecrets(input);
  assert.deepEqual(JSON.parse(redacted), {
    message: `${JSON.stringify({ x: "Cookie: [REDACTED]" })} Authorization: [REDACTED]`,
  });
  assert.equal(containsSensitiveValue(redacted, []), false);
});

test("redactSecrets masks named credentials across JSON escape depths", () => {
  const payload = JSON.stringify({
    token: 'historical-secret "quoted" \\tail\nnext',
    nested: { api_key: "nested-secret" },
    visible: 'quote " slash \\ newline\n',
  });
  const jsonlEvent = JSON.stringify({ type: "item.completed", item: { text: payload } });
  const twiceEncoded = JSON.stringify(jsonlEvent);
  const standaloneEscaped = String.raw`prefix {\"credential\":\"standalone-secret\"} suffix`;

  const redactedEvent = redactSecrets(jsonlEvent);
  const redactedTwice = redactSecrets(twiceEncoded);
  const redactedStandalone = redactSecrets(standaloneEscaped);

  assert.deepEqual(JSON.parse(JSON.parse(redactedEvent).item.text), {
    token: "[REDACTED]",
    nested: { api_key: "[REDACTED]" },
    visible: 'quote " slash \\ newline\n',
  });
  assert.deepEqual(JSON.parse(JSON.parse(JSON.parse(redactedTwice)).item.text), {
    token: "[REDACTED]",
    nested: { api_key: "[REDACTED]" },
    visible: 'quote " slash \\ newline\n',
  });
  assert.equal(redactedStandalone, String.raw`prefix {\"credential\":\"[REDACTED]\"} suffix`);
  assert.doesNotMatch(
    [redactedEvent, redactedTwice, redactedStandalone].join("\n"),
    /historical-secret|nested-secret|standalone-secret/,
  );
});

test("escaped named credential detection stays in parity with redaction", () => {
  const representations = [
    '{"token":"historical-secret"}',
    String.raw`{\"token\":\"historical-secret\"}`,
    JSON.stringify(JSON.stringify({ token: "historical-secret" })),
    JSON.stringify({
      type: "item.completed",
      item: { text: JSON.stringify({ credential: "historical-secret" }) },
    }),
  ];

  for (const representation of representations) {
    assert.equal(containsSensitiveValue(representation, []), true);
    const redacted = redactSecrets(representation);
    assert.equal(containsSensitiveValue(redacted, []), false);
    assert.doesNotMatch(redacted, /historical-secret/);
  }
});

test("redactSecrets decodes Unicode escapes in sensitive JSON field names", () => {
  const input = String.raw`{"to\u006ben":"historical-secret","visible":"safe"}`;
  const redacted = redactSecrets(input);

  assert.deepEqual(JSON.parse(redacted), {
    token: "[REDACTED]",
    visible: "safe",
  });
  assert.doesNotMatch(redacted, /historical-secret/);
  assert.equal(containsSensitiveValue(redacted, []), false);
});

test("redactSecrets preserves JSON when a sensitive value ends with a backslash", () => {
  const input = JSON.stringify({
    token: "historical-secret\\",
    visible: "safe",
  });
  const redacted = redactSecrets(input);

  assert.deepEqual(JSON.parse(redacted), {
    token: "[REDACTED]",
    visible: "safe",
  });
  assert.doesNotMatch(redacted, /historical-secret/);
  assert.equal(containsSensitiveValue(redacted, []), false);
});

test("redactSecrets replaces every JSON value type for sensitive fields", () => {
  const payload = JSON.stringify({
    token: { value: "object-secret" },
    credentials: ["array-secret"],
    password: 123456,
    api_key: true,
    private_key: null,
    visible: { value: "safe" },
  });

  for (let depth = 0; depth <= 3; depth += 1) {
    const input = encodeJsonDepth(payload, depth);
    assert.equal(containsSensitiveValue(input, []), true);
    const redacted = redactSecrets(input);
    const retained = JSON.parse(decodeJsonDepth(redacted, depth));

    assert.deepEqual(retained, {
      token: "[REDACTED]",
      credentials: "[REDACTED]",
      password: "[REDACTED]",
      api_key: "[REDACTED]",
      private_key: "[REDACTED]",
      visible: { value: "safe" },
    });
    assert.doesNotMatch(redacted, /object-secret|array-secret|123456/);
    assert.equal(containsSensitiveValue(redacted, []), false);
  }
});

test("redactSecrets decodes JSON whitespace at every escape depth", () => {
  const payload = [
    "{",
    '"token"',
    ":",
    '{"value":"newline-secret"},',
    '"credential":\t["tab-secret"],',
    '"visible": {"value":"safe"}',
    "}",
  ].join("\n");

  for (let depth = 0; depth <= 3; depth += 1) {
    const input = encodeJsonDepth(payload, depth);
    assert.equal(containsSensitiveValue(input, []), true);
    const redacted = redactSecrets(input);
    const retained = JSON.parse(decodeJsonDepth(redacted, depth));

    assert.deepEqual(retained, {
      token: "[REDACTED]",
      credential: "[REDACTED]",
      visible: { value: "safe" },
    });
    assert.doesNotMatch(redacted, /newline-secret|tab-secret/);
    assert.equal(containsSensitiveValue(redacted, []), false);
  }
});

test("escaped named credential detection fails closed on incomplete JSONL fields", () => {
  const incomplete = String.raw`{\"token\":\"historical-secret`;
  const followingRecord = String.raw`{\"visible\":\"safe\"}`;
  const input = `${incomplete}\n${followingRecord}`;

  assert.equal(redactSecrets(input), input);
  assert.equal(containsSensitiveValue(input, []), true);
});

test("escaped named credential detection fails closed on incomplete JSON containers", () => {
  for (const payload of [
    '{"token":{"value":"object-secret"',
    '{"credential":["array-secret"',
    '{"password":tru',
    '{"api_key":12e',
  ]) {
    for (let depth = 0; depth <= 3; depth += 1) {
      const input = encodeJsonDepth(payload, depth);
      assert.equal(redactSecrets(input), input);
      assert.equal(containsSensitiveValue(input, []), true);
    }
  }
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
    assert.match(artifact, /Authorization: \[REDACTED\]/);
    assert.match(artifact, /"token":"\[REDACTED\]"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("collectCodexDebug redacts nested JSONL credential representations before publication", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-codex-debug-escaped-"));
  const codexHome = path.join(tmp, ".codex");
  const outDir = path.join(tmp, "out");
  const sessionPath = path.join(codexHome, "sessions", "escaped.jsonl");
  const payload = JSON.stringify({
    credentials: {
      access_token: "nested-historical-secret",
      private_key: "nested-private-material",
    },
  });
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(
    sessionPath,
    `${JSON.stringify({ type: "item.completed", item: { text: JSON.stringify(payload) } })}\n`,
  );

  try {
    const result = collectCodexDebug({
      outDir,
      label: "escaped",
      sinceMinutes: 60,
      maxBytes: 1024 * 1024,
      homeDir: tmp,
      codexHome,
    });

    assert.equal(result.manifest.length, 1);
    assert.equal(
      result.skipped.some((entry) => entry.reason === "redaction-failed"),
      false,
    );
    const artifact = fs.readFileSync(path.join(outDir, "sessions", "escaped.jsonl"), "utf8");
    const event = JSON.parse(artifact);
    const retained = JSON.parse(JSON.parse(event.item.text));
    assert.deepEqual(retained, {
      credentials: "[REDACTED]",
    });
    assert.doesNotMatch(artifact, /nested-historical-secret|nested-private-material/);
    assert.equal(containsSensitiveValue(artifact, []), false);
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

function encodeJsonDepth(value: string, depth: number): string {
  let encoded = value;
  for (let index = 0; index < depth; index += 1) encoded = JSON.stringify(encoded);
  return encoded;
}

function decodeJsonDepth(value: string, depth: number): string {
  let decoded = value;
  for (let index = 0; index < depth; index += 1) decoded = JSON.parse(decoded);
  return decoded;
}
