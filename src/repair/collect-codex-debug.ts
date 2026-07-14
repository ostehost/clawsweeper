#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codexSensitiveEnvValues, redactInternalCodexModel } from "../codex-env.js";

type CollectOptions = {
  outDir: string;
  label: string;
  sinceMinutes: number;
  maxBytes: number;
  homeDir: string;
  codexHome?: string;
  repairRunsDir?: string;
  redactValues?: string[];
};

type ManifestEntry = {
  source: string;
  artifact_path: string;
  bytes: number;
  redacted_bytes: number;
  modified_at: string;
  sha256: string;
};

type SkippedEntry = {
  source: string;
  reason: string;
};

const DEFAULT_SINCE_MINUTES = 240;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const SENSITIVE_FIELD_NAME = String.raw`(?=[A-Za-z_])[A-Za-z0-9_.-]*(?:token|api[_-]?key|secret|password|credential|private[_-]?key)[A-Za-z0-9_.-]*`;
const SENSITIVE_HEADER_NAME = String.raw`(?:authorization|proxy-authorization|cookie|set-cookie)`;
const SENSITIVE_HEADER_LINE_SOURCE = `^(\\s*(?:[<>*]\\s*)?${SENSITIVE_HEADER_NAME}\\s*:\\s*)([^\\r\\n]*)$`;
const SENSITIVE_HEADER_TEXT_SOURCE = `(^|[^A-Za-z0-9_-])(${SENSITIVE_HEADER_NAME}\\s*:\\s*)`;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_PEM_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const JSON_NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_FIELD_NAME_PATTERN = new RegExp(
  `^(?:${SENSITIVE_FIELD_NAME}|${SENSITIVE_HEADER_NAME})$`,
  "i",
);

type EncodedJsonStringToken = {
  depth: number;
  start: number;
  closeQuote: number;
  value: string;
};

type StructuredSensitiveValueMatch = {
  depth: number;
  isRedacted: boolean;
  valueStart: number;
  valueEnd: number;
};

type EncodedSensitiveHeaderMatch = {
  depth: number;
  start: number;
  end: number;
  value: string;
};

type SensitiveHeaderValueRange = {
  start: number;
  end: number;
};

type ParsedEncodedJsonValue = {
  end: number;
  stringValue?: string;
};

type EncodedJsonWhitespace = {
  all: string[];
  horizontal: string[];
  lineBreaks: string[];
};

const ENCODED_JSON_WHITESPACE = new Map<number, EncodedJsonWhitespace>();

export function collectCodexDebug(options: CollectOptions) {
  const codexHome = resolveCodexHome(options);
  const roots = codexDebugRoots(options, codexHome);
  const redactValues = [
    ...(options.redactValues ?? []),
    ...codexSensitiveEnvValues(),
    process.env.CLAWSWEEPER_INTERNAL_MODEL ?? "",
  ];
  const since = Date.now() - options.sinceMinutes * 60 * 1000;
  const manifest: ManifestEntry[] = [];
  const skipped: SkippedEntry[] = [];

  fs.rmSync(options.outDir, { recursive: true, force: true });
  fs.mkdirSync(options.outDir, { recursive: true });

  for (const root of roots) {
    if (!fs.existsSync(root.path)) {
      skipped.push({ source: root.path, reason: "missing" });
      continue;
    }
    for (const filePath of listFiles(root.path)) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < since) continue;
      if (!isAllowedCodexDebugFile(filePath, root.kind)) {
        skipped.push({ source: filePath, reason: "not-codex-debug" });
        continue;
      }
      if (stat.size > options.maxBytes) {
        skipped.push({ source: filePath, reason: `over ${options.maxBytes} bytes` });
        continue;
      }
      const relative = safeRelative(root.path, filePath);
      const artifactPath = path.join(options.outDir, root.name, relative);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      const raw = fs.readFileSync(filePath, "utf8");
      const redacted = redactSecrets(raw, redactValues, codexHome);
      if (containsSensitiveValue(redacted, redactValues)) {
        skipped.push({ source: filePath, reason: "redaction-failed" });
        continue;
      }
      fs.writeFileSync(artifactPath, redacted);
      manifest.push({
        source: path.join(root.name, relative),
        artifact_path: path.relative(options.outDir, artifactPath),
        bytes: stat.size,
        redacted_bytes: Buffer.byteLength(redacted),
        modified_at: stat.mtime.toISOString(),
        sha256: crypto.createHash("sha256").update(redacted).digest("hex"),
      });
    }
  }

  const manifestPath = path.join(options.outDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        label: options.label,
        collected_at: new Date().toISOString(),
        since_minutes: options.sinceMinutes,
        files: manifest,
        skipped,
      },
      null,
      2,
    )}\n`,
  );

  return { manifest, skipped, manifestPath };
}

export function redactSecrets(text: string, redactValues: string[] = [], codexHome?: string) {
  let redacted = redactInternalCodexModel(text, codexHome);
  for (const value of redactValues.map((entry) => entry.trim()).filter(Boolean)) {
    redacted = redacted.replaceAll(value, REDACTED_VALUE);
  }
  redacted = redacted
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(new RegExp(SENSITIVE_HEADER_LINE_SOURCE, "gim"), `$1${REDACTED_VALUE}`)
    .replace(PRIVATE_KEY_PEM_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(
      new RegExp(
        `^(\\s*${SENSITIVE_FIELD_NAME}\\s*:\\s*[>|](?:[+-][1-9]?|[1-9][+-]?)?\\s*)\\r?\\n(?:(?:[ \\t]+[^\\r\\n]*|[ \\t]*)\\r?\\n|[ \\t]+[^\\r\\n]*$)+`,
        "gim",
      ),
      "$1\n  [REDACTED_MULTILINE]\n",
    )
    .replace(
      new RegExp(`\\b(${SENSITIVE_FIELD_NAME})\\s*=\\s*([^\\s"',;]+)`, "gi"),
      `$1=${REDACTED_VALUE}`,
    )
    .replace(
      new RegExp(`\\b(${SENSITIVE_FIELD_NAME})\\s*:\\s*([^\\s"',;]+)`, "gi"),
      `$1: ${REDACTED_VALUE}`,
    );

  return redactStructuredSensitiveValues(redactEncodedSensitiveHeaders(redacted));
}

export function containsSensitiveValue(text: string, redactValues: string[]): boolean {
  if (
    redactValues
      .map((value) => value.trim())
      .filter((value) => value.length >= 6)
      .some((value) => text.includes(value))
  ) {
    return true;
  }
  if (
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(text) ||
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(text) ||
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(text) ||
    new RegExp(JWT_PATTERN.source).test(text) ||
    new RegExp(BEARER_PATTERN.source, "i").test(text) ||
    new RegExp(PRIVATE_KEY_BEGIN_PATTERN.source).test(text)
  ) {
    return true;
  }
  if (
    [...text.matchAll(new RegExp(SENSITIVE_HEADER_LINE_SOURCE, "gim"))].some((match) => {
      const value = String(match[2] ?? "").trim();
      return value !== "" && !isRedactedValue(value);
    })
  ) {
    return true;
  }
  if (encodedSensitiveHeaderMatches(text).length > 0) {
    return true;
  }
  const unquotedNamedValuePatterns = [
    new RegExp(`\\b(${SENSITIVE_FIELD_NAME})\\s*=\\s*([^\\s"',;]+)`, "gi"),
    new RegExp(`\\b(${SENSITIVE_FIELD_NAME})\\s*:\\s*([^\\s"',;]+)`, "gi"),
  ];
  if (
    unquotedNamedValuePatterns.some((pattern) =>
      [...text.matchAll(pattern)].some((match) => !isRedactedValue(String(match[2] ?? ""))),
    )
  ) {
    return true;
  }
  const structured = scanStructuredSensitiveValues(text);
  if (structured.matches.some((match) => !match.isRedacted)) {
    return true;
  }
  return structured.hasIncompleteValue;
}

function redactEncodedSensitiveHeaders(text: string): string {
  let redacted = text;
  while (true) {
    const matches = encodedSensitiveHeaderMatches(redacted);
    if (matches.length === 0) return redacted;
    let next = redacted;
    for (const match of matches.sort((left, right) => right.start - left.start)) {
      next =
        next.slice(0, match.start) +
        encodeJsonStringLiteral(match.value, match.depth) +
        next.slice(match.end);
    }
    if (next === redacted) return redacted;
    redacted = next;
  }
}

function encodedSensitiveHeaderMatches(text: string): EncodedSensitiveHeaderMatch[] {
  const candidates = scanEncodedJsonStrings(text)
    .tokens.map((token) => {
      const value = redactSensitiveHeaderText(token.value);
      if (value === token.value) return null;
      return {
        depth: token.depth,
        start: token.start,
        end: token.closeQuote + 1,
        value,
      };
    })
    .filter((match): match is EncodedSensitiveHeaderMatch => match !== null)
    .sort(
      (left, right) =>
        left.end - left.start - (right.end - right.start) ||
        right.depth - left.depth ||
        left.start - right.start,
    );
  const selected: EncodedSensitiveHeaderMatch[] = [];
  for (const candidate of candidates) {
    if (selected.every((match) => candidate.end <= match.start || candidate.start >= match.end)) {
      selected.push(candidate);
    }
  }
  return selected;
}

function redactSensitiveHeaderText(value: string): string {
  let redacted = value;
  for (const range of sensitiveHeaderValueRanges(value).reverse()) {
    const headerValue = value.slice(range.start, range.end);
    if (isRedactedHeaderTextValue(headerValue)) continue;
    redacted = redacted.slice(0, range.start) + REDACTED_VALUE + redacted.slice(range.end);
  }
  return redacted;
}

function sensitiveHeaderValueRanges(value: string): SensitiveHeaderValueRange[] {
  const headers = [...value.matchAll(new RegExp(SENSITIVE_HEADER_TEXT_SOURCE, "gim"))];
  return headers.map((header, index) => {
    const start = (header.index ?? 0) + header[0].length;
    const nextHeaderStart = headers[index + 1]?.index ?? value.length;
    const lineBreakOffset = value.slice(start).search(/[\r\n]/);
    const lineEnd = lineBreakOffset === -1 ? value.length : start + lineBreakOffset;
    return { start, end: Math.min(nextHeaderStart, lineEnd) };
  });
}

function isRedactedHeaderTextValue(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith(REDACTED_VALUE)) return false;
  const next = trimmed[REDACTED_VALUE.length];
  return next === undefined || /[\\"'})\],]/.test(next);
}

function redactStructuredSensitiveValues(text: string): string {
  const ranges: StructuredSensitiveValueMatch[] = [];
  for (const match of scanStructuredSensitiveValues(text).matches.sort(
    (left, right) => left.valueStart - right.valueStart || right.valueEnd - left.valueEnd,
  )) {
    const previous = ranges.at(-1);
    if (!previous || match.valueStart >= previous.valueEnd) ranges.push(match);
  }
  let redacted = text;
  for (const range of ranges.reverse()) {
    redacted =
      redacted.slice(0, range.valueStart) +
      encodeJsonStringLiteral(REDACTED_VALUE, range.depth) +
      redacted.slice(range.valueEnd);
  }
  return redacted;
}

function scanStructuredSensitiveValues(text: string): {
  matches: StructuredSensitiveValueMatch[];
  hasIncompleteValue: boolean;
} {
  const { tokens } = scanEncodedJsonStrings(text);
  const tokenByStart = new Map(
    tokens.map((token) => [encodedTokenKey(token.depth, token.start), token]),
  );
  const parsedValues = new Map<string, ParsedEncodedJsonValue | null>();
  const matches: StructuredSensitiveValueMatch[] = [];
  let hasIncompleteValue = false;

  for (const keyToken of tokens) {
    if (!SENSITIVE_FIELD_NAME_PATTERN.test(keyToken.value)) continue;
    let cursor = skipEncodedJsonWhitespace(text, keyToken.closeQuote + 1, keyToken.depth);
    if (text[cursor] !== ":") continue;
    cursor = skipEncodedJsonWhitespace(text, cursor + 1, keyToken.depth);
    const value = parseEncodedJsonValue({
      text,
      start: cursor,
      depth: keyToken.depth,
      tokenByStart,
      parsedValues,
      nesting: 0,
    });
    if (!value) {
      hasIncompleteValue = true;
      continue;
    }
    matches.push({
      depth: keyToken.depth,
      isRedacted: value.stringValue === REDACTED_VALUE,
      valueStart: cursor,
      valueEnd: value.end,
    });
  }

  return { matches, hasIncompleteValue };
}

function scanEncodedJsonStrings(text: string): {
  tokens: EncodedJsonStringToken[];
} {
  const quotesByDepth = new Map<
    number,
    Array<{ index: number; line: number; backslashes: number }>
  >();
  let line = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n" || character === "\r") {
      line += 1;
      continue;
    }
    if (character !== '"') continue;
    const backslashes = backslashRunBefore(text, index);
    const depth = encodedJsonDepth(backslashes);
    const quotes = quotesByDepth.get(depth) ?? [];
    quotes.push({ index, line, backslashes });
    quotesByDepth.set(depth, quotes);
  }

  const tokens: EncodedJsonStringToken[] = [];
  for (const [depth, quotes] of quotesByDepth) {
    const delimiterBackslashes = 2 ** depth - 1;
    for (let index = 0; index + 1 < quotes.length; index += 1) {
      const opening = quotes[index]!;
      const closing = quotes[index + 1]!;
      if (opening.line !== closing.line || opening.backslashes !== delimiterBackslashes) continue;
      const start = opening.index - delimiterBackslashes;
      const value = decodeEncodedJsonString(text.slice(start, closing.index + 1), depth);
      if (value === null) continue;
      tokens.push({
        depth,
        start,
        closeQuote: closing.index,
        value,
      });
    }
  }

  return { tokens };
}

function parseEncodedJsonValue({
  text,
  start,
  depth,
  tokenByStart,
  parsedValues,
  nesting,
}: {
  text: string;
  start: number;
  depth: number;
  tokenByStart: Map<string, EncodedJsonStringToken>;
  parsedValues: Map<string, ParsedEncodedJsonValue | null>;
  nesting: number;
}): ParsedEncodedJsonValue | null {
  const cursor = skipEncodedJsonWhitespace(text, start, depth);
  const cacheKey = encodedTokenKey(depth, cursor);
  if (parsedValues.has(cacheKey)) return parsedValues.get(cacheKey) ?? null;
  if (nesting > 256) {
    parsedValues.set(cacheKey, null);
    return null;
  }

  const stringToken = tokenByStart.get(cacheKey);
  if (stringToken) {
    const parsed = encodedJsonScalarEnd(text, stringToken.closeQuote + 1, depth, {
      stringValue: stringToken.value,
    });
    parsedValues.set(cacheKey, parsed);
    return parsed;
  }

  const character = text[cursor];
  let parsed: ParsedEncodedJsonValue | null;
  if (character === "{") {
    parsed = parseEncodedJsonObject({
      text,
      start: cursor,
      depth,
      tokenByStart,
      parsedValues,
      nesting,
    });
  } else if (character === "[") {
    parsed = parseEncodedJsonArray({
      text,
      start: cursor,
      depth,
      tokenByStart,
      parsedValues,
      nesting,
    });
  } else if (text.startsWith("true", cursor)) {
    parsed = encodedJsonScalarEnd(text, cursor + 4, depth);
  } else if (text.startsWith("false", cursor)) {
    parsed = encodedJsonScalarEnd(text, cursor + 5, depth);
  } else if (text.startsWith("null", cursor)) {
    parsed = encodedJsonScalarEnd(text, cursor + 4, depth);
  } else {
    JSON_NUMBER_PATTERN.lastIndex = cursor;
    const number = JSON_NUMBER_PATTERN.exec(text);
    parsed = number ? encodedJsonScalarEnd(text, JSON_NUMBER_PATTERN.lastIndex, depth) : null;
  }
  parsedValues.set(cacheKey, parsed);
  return parsed;
}

function parseEncodedJsonObject({
  text,
  start,
  depth,
  tokenByStart,
  parsedValues,
  nesting,
}: {
  text: string;
  start: number;
  depth: number;
  tokenByStart: Map<string, EncodedJsonStringToken>;
  parsedValues: Map<string, ParsedEncodedJsonValue | null>;
  nesting: number;
}): ParsedEncodedJsonValue | null {
  let cursor = skipEncodedJsonWhitespace(text, start + 1, depth);
  if (text[cursor] === "}") return { end: cursor + 1 };

  while (cursor < text.length) {
    const key = tokenByStart.get(encodedTokenKey(depth, cursor));
    if (!key) return null;
    cursor = skipEncodedJsonWhitespace(text, key.closeQuote + 1, depth);
    if (text[cursor] !== ":") return null;
    const value = parseEncodedJsonValue({
      text,
      start: cursor + 1,
      depth,
      tokenByStart,
      parsedValues,
      nesting: nesting + 1,
    });
    if (!value) return null;
    cursor = skipEncodedJsonWhitespace(text, value.end, depth);
    if (text[cursor] === "}") return { end: cursor + 1 };
    if (text[cursor] !== ",") return null;
    cursor = skipEncodedJsonWhitespace(text, cursor + 1, depth);
  }
  return null;
}

function parseEncodedJsonArray({
  text,
  start,
  depth,
  tokenByStart,
  parsedValues,
  nesting,
}: {
  text: string;
  start: number;
  depth: number;
  tokenByStart: Map<string, EncodedJsonStringToken>;
  parsedValues: Map<string, ParsedEncodedJsonValue | null>;
  nesting: number;
}): ParsedEncodedJsonValue | null {
  let cursor = skipEncodedJsonWhitespace(text, start + 1, depth);
  if (text[cursor] === "]") return { end: cursor + 1 };

  while (cursor < text.length) {
    const value = parseEncodedJsonValue({
      text,
      start: cursor,
      depth,
      tokenByStart,
      parsedValues,
      nesting: nesting + 1,
    });
    if (!value) return null;
    cursor = skipEncodedJsonWhitespace(text, value.end, depth);
    if (text[cursor] === "]") return { end: cursor + 1 };
    if (text[cursor] !== ",") return null;
    cursor = skipEncodedJsonWhitespace(text, cursor + 1, depth);
  }
  return null;
}

function encodedJsonScalarEnd(
  text: string,
  end: number,
  depth: number,
  value: Omit<ParsedEncodedJsonValue, "end"> = {},
): ParsedEncodedJsonValue | null {
  let cursor = end;
  const whitespace = encodedJsonWhitespace(depth);
  while (cursor < text.length) {
    const match = whitespace.horizontal.find((entry) => text.startsWith(entry, cursor));
    if (!match) break;
    cursor += match.length;
  }
  if (whitespace.lineBreaks.some((entry) => text.startsWith(entry, cursor))) {
    return { end, ...value };
  }
  const boundary = skipEncodedJsonWhitespace(text, end, depth);
  return boundary === text.length || /[,}\]]/.test(text[boundary] ?? "") ? { end, ...value } : null;
}

function decodeEncodedJsonString(segment: string, depth: number): string | null {
  try {
    let decoded = segment;
    for (let index = 0; index < depth; index += 1) {
      const value = JSON.parse(`"${decoded}"`);
      if (typeof value !== "string") return null;
      decoded = value;
    }
    const value = JSON.parse(decoded);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function encodedJsonDepth(backslashes: number): number {
  // Depth d delimiters have 2^d - 1 slashes; encoded content adds multiples of 2^(d + 1).
  let depth = 0;
  let value = backslashes + 1;
  while (value % 2 === 0) {
    depth += 1;
    value /= 2;
  }
  return depth;
}

function backslashRunBefore(text: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    count += 1;
  }
  return count;
}

function encodedTokenKey(depth: number, start: number): string {
  return `${depth}:${start}`;
}

function skipEncodedJsonWhitespace(text: string, start: number, depth: number): number {
  const whitespace = encodedJsonWhitespace(depth);
  let cursor = start;
  while (cursor < text.length) {
    const match = whitespace.all.find((entry) => text.startsWith(entry, cursor));
    if (!match) break;
    cursor += match.length;
  }
  return cursor;
}

function encodedJsonWhitespace(depth: number): EncodedJsonWhitespace {
  const cached = ENCODED_JSON_WHITESPACE.get(depth);
  if (cached) return cached;
  const horizontal = [" ", "\t"].map((value) => encodeJsonStringContent(value, depth));
  const lineBreaks = ["\n", "\r"].map((value) => encodeJsonStringContent(value, depth));
  const whitespace = { all: [...horizontal, ...lineBreaks], horizontal, lineBreaks };
  ENCODED_JSON_WHITESPACE.set(depth, whitespace);
  return whitespace;
}

function encodeJsonStringLiteral(value: string, depth: number): string {
  return encodeJsonStringContent(JSON.stringify(value), depth);
}

function encodeJsonStringContent(value: string, depth: number): string {
  let encoded = value;
  for (let index = 0; index < depth; index += 1) {
    encoded = JSON.stringify(encoded).slice(1, -1);
  }
  return encoded;
}

function isRedactedValue(value: string): boolean {
  return value === REDACTED_VALUE;
}

function resolveCodexHome(options: CollectOptions): string {
  return (
    options.codexHome || process.env.CODEX_HOME?.trim() || path.join(options.homeDir, ".codex")
  );
}

function codexDebugRoots(options: CollectOptions, codexHome = resolveCodexHome(options)) {
  const repairRunsDir =
    options.repairRunsDir || path.join(process.cwd(), ".clawsweeper-repair", "runs");
  return [
    { name: "sessions", path: path.join(codexHome, "sessions"), kind: "codex-home" },
    { name: "log", path: path.join(codexHome, "log"), kind: "codex-home" },
    { name: "repair-runs", path: repairRunsDir, kind: "repair-runs" },
  ];
}

function isAllowedCodexDebugFile(filePath: string, kind = "codex-home") {
  const base = path.basename(filePath).toLowerCase();
  if (base === "auth.json" || base === "config.toml" || base === "config.json") return false;
  if (kind === "repair-runs" && !base.includes("codex")) return false;
  return /\.(json|jsonl|ndjson|log|txt)$/i.test(base);
}

function* listFiles(root: string): Generator<string> {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) yield* listFiles(filePath);
    else if (entry.isFile()) yield filePath;
  }
}

function safeRelative(root: string, filePath: string) {
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to copy file outside root: ${filePath}`);
  }
  return relative;
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function numberArg(value: string | boolean | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(value: string | boolean | undefined, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const outDir = stringArg(args.out, ".clawsweeper-repair/codex-debug");
  const codexHome =
    typeof args["codex-home"] === "string" ? args["codex-home"] : process.env.CODEX_HOME;
  const repairRunsDir =
    typeof args["repair-runs-dir"] === "string" ? args["repair-runs-dir"] : undefined;
  const result = collectCodexDebug({
    outDir,
    label: stringArg(args.label, "codex"),
    sinceMinutes: numberArg(args["since-minutes"], DEFAULT_SINCE_MINUTES),
    maxBytes: numberArg(args["max-bytes"], DEFAULT_MAX_BYTES),
    homeDir: os.homedir(),
    ...(codexHome ? { codexHome } : {}),
    ...(repairRunsDir ? { repairRunsDir } : {}),
  });
  console.log(
    JSON.stringify({
      out_dir: outDir,
      files: result.manifest.length,
      skipped: result.skipped.length,
      manifest: result.manifestPath,
    }),
  );
}
