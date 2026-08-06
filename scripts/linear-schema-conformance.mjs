#!/usr/bin/env node

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { buildSchema, parse, validate } from "graphql";

import { COMMENT_CREATE_MUTATION, COMMENT_UPDATE_MUTATION } from "../dist/linear/comment.js";
import {
  ISSUE_BY_IDENTIFIER_QUERY,
  ISSUE_LABEL_CREATE_MUTATION,
  ISSUE_LABELS_QUERY,
  ISSUE_SET_LABELS_MUTATION,
  ISSUES_QUERY,
  PROJECTS_QUERY,
  TEAMS_QUERY,
} from "../dist/linear/queries.js";

export const LINEAR_SCHEMA_COMMIT = "eabc85d0df87617b4647e56d2f236e60bc2ed117";
export const LINEAR_SCHEMA_SHA256 =
  "96adbda3c82893f2877afd36496801a9450ca6a3e8385773cbcec05d9e28ea51";
export const LINEAR_SCHEMA_BYTES = 1_270_042;
export const LINEAR_SCHEMA_FETCH_TIMEOUT_MS = 20_000;
export const LINEAR_SCHEMA_URL =
  `https://raw.githubusercontent.com/linear/linear/${LINEAR_SCHEMA_COMMIT}` +
  "/packages/sdk/src/schema.graphql";

export const PRODUCTION_LINEAR_READ_DOCUMENTS = Object.freeze([
  { name: "TEAMS_QUERY", source: TEAMS_QUERY },
  { name: "PROJECTS_QUERY", source: PROJECTS_QUERY },
  { name: "ISSUES_QUERY", source: ISSUES_QUERY },
  { name: "ISSUE_BY_IDENTIFIER_QUERY", source: ISSUE_BY_IDENTIFIER_QUERY },
  { name: "ISSUE_LABELS_QUERY", source: ISSUE_LABELS_QUERY },
]);

export const RETAINED_LINEAR_MUTATION_DOCUMENTS = Object.freeze([
  { name: "ISSUE_LABEL_CREATE_MUTATION", source: ISSUE_LABEL_CREATE_MUTATION },
  { name: "ISSUE_SET_LABELS_MUTATION", source: ISSUE_SET_LABELS_MUTATION },
  { name: "COMMENT_CREATE_MUTATION", source: COMMENT_CREATE_MUTATION },
  { name: "COMMENT_UPDATE_MUTATION", source: COMMENT_UPDATE_MUTATION },
]);

export async function fetchPinnedLinearSchema(
  fetchImpl = fetch,
  signal = AbortSignal.timeout(LINEAR_SCHEMA_FETCH_TIMEOUT_MS),
) {
  const response = await fetchImpl(LINEAR_SCHEMA_URL, { signal });
  if (!response.ok) {
    throw new Error(`pinned Linear schema fetch failed with HTTP ${response.status}`);
  }
  return response.text();
}

export function validateProductionDocumentsAgainstSchema(schemaSource) {
  const bytes = Buffer.byteLength(schemaSource);
  const sha256 = createHash("sha256").update(schemaSource).digest("hex");
  if (bytes !== LINEAR_SCHEMA_BYTES || sha256 !== LINEAR_SCHEMA_SHA256) {
    throw new Error("downloaded Linear schema does not match the repository-pinned artifact");
  }

  const schema = buildSchema(schemaSource);
  for (const document of [
    ...PRODUCTION_LINEAR_READ_DOCUMENTS,
    ...RETAINED_LINEAR_MUTATION_DOCUMENTS,
  ]) {
    const errors = validate(schema, parse(document.source));
    if (errors.length > 0) {
      throw new Error(
        `pinned Linear schema rejected ${document.name}: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
  }

  return {
    schemaCommit: LINEAR_SCHEMA_COMMIT,
    schemaSha256: sha256,
    schemaBytes: bytes,
    readDocumentCount: PRODUCTION_LINEAR_READ_DOCUMENTS.length,
    retainedMutationDocumentCount: RETAINED_LINEAR_MUTATION_DOCUMENTS.length,
    allDocumentsValid: true,
  };
}

export async function runLinearSchemaConformance(deps = {}) {
  const schemaSource =
    deps.schemaSource ??
    (await fetchPinnedLinearSchema(deps.fetchImpl ?? fetch, deps.signal ?? undefined));
  return validateProductionDocumentsAgainstSchema(schemaSource);
}

async function main() {
  try {
    console.log(JSON.stringify(await runLinearSchemaConformance()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
