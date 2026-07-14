import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_CODEX_OUTPUT_FILE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_CODEX_OUTPUT_TAIL_BYTES = 64 * 1024;

const TRUNCATION_MARKER = Buffer.from(
  "\n...[Codex output truncated; final tail follows]...\n",
  "utf8",
);
const REDACTION_MARKER = Buffer.from("[REDACTED]", "utf8");
// Covers JSON values retained directly and structured JSON nested inside Codex JSONL.
const MAX_JSON_REDACTION_DEPTH = 2;

export interface CodexOutputCapture {
  file: number;
  maxFileBytes: number;
  tailBytes: number;
  writtenBytes: number;
  truncated: boolean;
  tail: Buffer<ArrayBufferLike>;
  redactions: Buffer<ArrayBufferLike>[];
  pending: Buffer<ArrayBufferLike>;
}

export interface CodexTextRedactor {
  redactions: Buffer<ArrayBufferLike>[];
  pending: Buffer<ArrayBufferLike>;
  decoder: StringDecoder;
}

export function openCodexOutputCapture(
  filePath: string,
  options: { maxFileBytes?: number; tailBytes?: number; redactValues?: readonly string[] } = {},
): CodexOutputCapture {
  const redactions = normalizedRedactions(options.redactValues);
  return {
    file: openSync(filePath, "w"),
    maxFileBytes: normalizedMaxFileBytes(options.maxFileBytes),
    tailBytes: normalizedTailBytes(options.tailBytes),
    writtenBytes: 0,
    truncated: false,
    tail: Buffer.alloc(0),
    redactions,
    pending: Buffer.alloc(0),
  };
}

export function appendCodexOutputCapture(capture: CodexOutputCapture, chunk: Buffer): void {
  if (capture.redactions.length > 0) {
    const combined = Buffer.concat([capture.pending, chunk]);
    const redacted = redactAvailableBuffer(combined, capture.redactions);
    appendCapturedBytes(capture, redacted.output);
    capture.pending = redacted.pending;
    return;
  }
  appendCapturedBytes(capture, chunk);
}

function appendCapturedBytes(capture: CodexOutputCapture, chunk: Buffer): void {
  capture.tail = appendTail(capture.tail, chunk, capture.tailBytes);
  const remaining = capture.maxFileBytes - capture.writtenBytes;
  const retained = chunk.subarray(0, Math.max(0, remaining));
  writeAll(capture.file, retained);
  capture.writtenBytes += retained.length;
  if (chunk.length > retained.length) capture.truncated = true;
}

export function closeCodexOutputCapture(capture: CodexOutputCapture): void {
  try {
    if (capture.pending.length > 0) {
      appendCapturedBytes(
        capture,
        redactAvailableBuffer(capture.pending, capture.redactions, true).output,
      );
      capture.pending = Buffer.alloc(0);
    }
    if (capture.truncated) {
      const tail = capture.tail.subarray(
        Math.max(0, capture.tail.length - availableTailBytes(capture.maxFileBytes)),
      );
      const headBytes = capture.maxFileBytes - TRUNCATION_MARKER.length - tail.length;
      ftruncateSync(capture.file, headBytes);
      writeAll(capture.file, TRUNCATION_MARKER, headBytes);
      writeAll(capture.file, tail, headBytes + TRUNCATION_MARKER.length);
    }
  } finally {
    closeSync(capture.file);
  }
}

export function codexOutputTail(capture: CodexOutputCapture): string {
  return capture.tail.toString("utf8");
}

export function redactCodexText(value: string, redactValues: readonly string[]): string {
  return normalizedRedactionStrings(redactValues).reduce(
    (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
    value,
  );
}

export function createCodexTextRedactor(redactValues: readonly string[] = []): CodexTextRedactor {
  return {
    redactions: normalizedRedactions(redactValues),
    pending: Buffer.alloc(0),
    decoder: new StringDecoder("utf8"),
  };
}

export function redactCodexTextChunk(
  redactor: CodexTextRedactor,
  value: string,
  flush = false,
): string {
  const combined = Buffer.concat([redactor.pending, Buffer.from(value, "utf8")]);
  const redacted = redactAvailableBuffer(combined, redactor.redactions, flush);
  redactor.pending = redacted.pending;
  return flush ? redactor.decoder.end(redacted.output) : redactor.decoder.write(redacted.output);
}

export function redactCodexOutputLastMessage(
  args: readonly string[],
  redactValues: readonly string[],
): void {
  const outputIndex = args.indexOf("--output-last-message");
  const filePath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (!filePath || !existsSync(filePath)) return;
  publishRedactedCodexOutputLastMessage(filePath, filePath, redactValues);
}

export function publishRedactedCodexOutputLastMessage(
  rawPath: string,
  retainedPath: string,
  redactValues: readonly string[],
): void {
  if (!existsSync(rawPath)) return;
  mkdirSync(dirname(retainedPath), { recursive: true });
  const temporaryPath = join(
    dirname(retainedPath),
    `.${basename(retainedPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const redacted = redactCodexText(readFileSync(rawPath, "utf8"), redactValues);
    writeFileSync(temporaryPath, redacted, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, retainedPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (rawPath === retainedPath) rmSync(rawPath, { force: true });
    throw error;
  }
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (chunk.length >= maxBytes) return chunk.subarray(chunk.length - maxBytes);
  const combined = Buffer.concat([current, chunk]);
  return combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;
}

function normalizedMaxFileBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_FILE_BYTES;
  const normalized = Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_FILE_BYTES;
  return Math.max(TRUNCATION_MARKER.length, normalized);
}

function normalizedTailBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODEX_OUTPUT_TAIL_BYTES;
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CODEX_OUTPUT_TAIL_BYTES);
}

function availableTailBytes(maxFileBytes: number): number {
  return Math.max(0, maxFileBytes - TRUNCATION_MARKER.length);
}

function normalizedRedactions(values: readonly string[] | undefined): Buffer[] {
  return normalizedRedactionStrings(values)
    .map((value) => Buffer.from(value, "utf8"))
    .sort((left, right) => right.length - left.length);
}

function normalizedRedactionStrings(values: readonly string[] | undefined): string[] {
  const secrets = new Set(
    (values ?? []).map((value) => value.trim()).filter((value) => value.length >= 6),
  );
  const variants = new Set<string>();
  for (const secret of secrets) {
    let variant = secret;
    for (let depth = 0; depth <= MAX_JSON_REDACTION_DEPTH; depth += 1) {
      variants.add(variant);
      const encoded = JSON.stringify(variant).slice(1, -1);
      if (encoded === variant) break;
      variant = encoded;
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function redactAvailableBuffer(
  value: Buffer,
  redactions: readonly Buffer[],
  flush = false,
): { output: Buffer; pending: Buffer } {
  if (value.length === 0 || redactions.length === 0) {
    return { output: value, pending: Buffer.alloc(0) };
  }
  const safeEnd = flush
    ? value.length
    : Math.max(0, value.length - (redactions[0]?.length ?? 1) + 1);
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < safeEnd) {
    let nextIndex = -1;
    let nextRedaction: Buffer | null = null;
    for (const redaction of redactions) {
      const candidate = value.indexOf(redaction, offset);
      if (
        candidate >= 0 &&
        candidate < safeEnd &&
        (nextIndex < 0 ||
          candidate < nextIndex ||
          (candidate === nextIndex && redaction.length > (nextRedaction?.length ?? 0)))
      ) {
        nextIndex = candidate;
        nextRedaction = redaction;
      }
    }
    if (nextIndex < 0 || !nextRedaction) {
      parts.push(value.subarray(offset, safeEnd));
      offset = safeEnd;
      break;
    }
    if (nextIndex > offset) parts.push(value.subarray(offset, nextIndex));
    parts.push(REDACTION_MARKER);
    offset = nextIndex + nextRedaction.length;
  }
  return {
    output: Buffer.concat(parts),
    pending: Buffer.from(value.subarray(offset)),
  };
}

function writeAll(file: number, value: Buffer, position?: number): void {
  let offset = 0;
  while (offset < value.length) {
    const written = writeSync(
      file,
      value,
      offset,
      value.length - offset,
      position === undefined ? undefined : position + offset,
    );
    if (written === 0) throw new Error("Codex output file write made no progress.");
    offset += written;
  }
}
