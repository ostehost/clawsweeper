import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendCodexOutputCapture,
  closeCodexOutputCapture,
  codexOutputTail,
  createCodexTextRedactor,
  openCodexOutputCapture,
  publishRedactedCodexOutputLastMessage,
  redactCodexOutputLastMessage,
  redactCodexTextChunk,
} from "../dist/codex-output-capture.js";

test("Codex output redaction spans stream chunk boundaries before persistence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-output-redaction-"));
  const outputPath = path.join(root, "codex.jsonl");
  const secret = "runtime-token-123456";
  const capture = openCodexOutputCapture(outputPath, {
    redactValues: [secret],
    tailBytes: 1024,
  });

  try {
    appendCodexOutputCapture(capture, Buffer.from(`before ${secret.slice(0, 9)}`));
    appendCodexOutputCapture(capture, Buffer.from(`${secret.slice(9)} after\n`));
    closeCodexOutputCapture(capture);

    assert.equal(fs.readFileSync(outputPath, "utf8"), "before [REDACTED] after\n");
    assert.equal(codexOutputTail(capture), "before [REDACTED] after\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex output redaction prefers the longest value and flushes partial suffixes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-output-redaction-overlap-"));
  const outputPath = path.join(root, "codex.log");
  const capture = openCodexOutputCapture(outputPath, {
    redactValues: ["secret-value", "secret"],
    tailBytes: 1024,
  });

  try {
    appendCodexOutputCapture(capture, Buffer.from("secret-value then sec"));
    appendCodexOutputCapture(capture, Buffer.from("ret and harmless-sec"));
    closeCodexOutputCapture(capture);

    assert.equal(
      fs.readFileSync(outputPath, "utf8"),
      "[REDACTED] then [REDACTED] and harmless-sec",
    );
    assert.equal(codexOutputTail(capture), "[REDACTED] then [REDACTED] and harmless-sec");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex output redaction sizes stream overlap by UTF-8 bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-output-redaction-unicode-"));
  const outputPath = path.join(root, "codex.log");
  const secret = "éééééé";
  const encoded = Buffer.from(secret, "utf8");
  const capture = openCodexOutputCapture(outputPath, {
    redactValues: ["1234567", secret],
    tailBytes: 1024,
  });

  try {
    appendCodexOutputCapture(
      capture,
      Buffer.concat([Buffer.from("before ", "utf8"), encoded.subarray(0, 8)]),
    );
    appendCodexOutputCapture(
      capture,
      Buffer.concat([encoded.subarray(8), Buffer.from(" after", "utf8")]),
    );
    closeCodexOutputCapture(capture);

    assert.equal(fs.readFileSync(outputPath, "utf8"), "before [REDACTED] after");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex output redaction spans chunks inside nested JSON-escaped secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-output-redaction-json-"));
  const outputPath = path.join(root, "codex.jsonl");
  const secret = 'runtime\n"quoted"\\token-123456';
  const structuredMessage = JSON.stringify({ summary: secret });
  const event = `${JSON.stringify({
    type: "item.completed",
    item: { text: structuredMessage },
  })}\n`;
  const encodedSecret = JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1);
  const secretOffset = event.indexOf(encodedSecret);
  const capture = openCodexOutputCapture(outputPath, {
    redactValues: [secret],
    tailBytes: 4096,
  });

  try {
    assert.notEqual(secretOffset, -1);
    const firstSplit = secretOffset + encodedSecret.indexOf("\\\\n") + 1;
    const secondSplit = secretOffset + encodedSecret.indexOf('\\\\\\"') + 2;
    const thirdSplit = secretOffset + encodedSecret.indexOf("\\\\\\\\token") + 2;
    appendCodexOutputCapture(capture, Buffer.from(event.slice(0, firstSplit)));
    appendCodexOutputCapture(capture, Buffer.from(event.slice(firstSplit, secondSplit)));
    appendCodexOutputCapture(capture, Buffer.from(event.slice(secondSplit, thirdSplit)));
    appendCodexOutputCapture(capture, Buffer.from(event.slice(thirdSplit)));
    closeCodexOutputCapture(capture);

    const retained = fs.readFileSync(outputPath, "utf8");
    const parsedEvent = JSON.parse(retained) as { item: { text: string } };
    assert.deepEqual(JSON.parse(parsedEvent.item.text), { summary: "[REDACTED]" });
    assert.doesNotMatch(retained, /runtime|quoted|token-123456/);
    assert.equal(codexOutputTail(capture), retained);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex text redaction spans independently delivered chunks", () => {
  const secret = "runtime-token-123456";
  const redactor = createCodexTextRedactor([secret]);

  const first = redactCodexTextChunk(redactor, "before runtime-token-");
  const second = redactCodexTextChunk(redactor, "123456 after", true);

  assert.doesNotMatch(first, /runtime-token/);
  assert.equal(first + second, "before [REDACTED] after");
});

test("Codex text redaction preserves UTF-8 code points split by overlap retention", () => {
  const redactor = createCodexTextRedactor(["abcdef"]);

  const first = redactCodexTextChunk(redactor, "xx😀1234");
  const second = redactCodexTextChunk(redactor, "", true);

  assert.equal(first, "xx");
  assert.equal(first + second, "xx😀1234");
  assert.doesNotMatch(first + second, /�/);
});

test("Codex last-message redaction atomically replaces structured output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-last-message-redaction-"));
  const outputPath = path.join(root, "result.json");
  const secret = 'runtime\n"quoted"\\token-123456';
  fs.writeFileSync(outputPath, `${JSON.stringify({ summary: secret })}\n`);

  try {
    redactCodexOutputLastMessage(["exec", "--output-last-message", outputPath, "--json"], [secret]);

    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), {
      summary: "[REDACTED]",
    });
    assert.doesNotMatch(fs.readFileSync(outputPath, "utf8"), /runtime|quoted|token-123456/);
    assert.deepEqual(fs.readdirSync(root), ["result.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex last-message publication keeps raw output outside the retained tree", () => {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-last-message-raw-"));
  const retainedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-last-message-retained-"));
  const rawPath = path.join(rawRoot, "last-message.raw");
  const retainedPath = path.join(retainedRoot, "reports", "result.json");
  const secret = "runtime-token-123456";
  fs.writeFileSync(rawPath, `${JSON.stringify({ summary: secret })}\n`);

  try {
    assert.equal(fs.existsSync(retainedPath), false);
    publishRedactedCodexOutputLastMessage(rawPath, retainedPath, [secret]);

    assert.equal(fs.readFileSync(rawPath, "utf8").includes(secret), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(retainedPath, "utf8")), {
      summary: "[REDACTED]",
    });
    assert.deepEqual(fs.readdirSync(path.dirname(retainedPath)), ["result.json"]);
  } finally {
    fs.rmSync(rawRoot, { recursive: true, force: true });
    fs.rmSync(retainedRoot, { recursive: true, force: true });
  }
});
