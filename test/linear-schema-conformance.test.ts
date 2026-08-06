import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchPinnedLinearSchema,
  LINEAR_SCHEMA_BYTES,
  LINEAR_SCHEMA_COMMIT,
  LINEAR_SCHEMA_SHA256,
  runLinearSchemaConformance,
  validateProductionDocumentsAgainstSchema,
} from "../scripts/linear-schema-conformance.mjs";

test("schema conformance fails closed on a pinned-schema download error", async () => {
  await assert.rejects(
    fetchPinnedLinearSchema(async (_input, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response("unavailable", { status: 503 });
    }),
    /HTTP 503/,
  );
});

test("schema conformance rejects any artifact other than Linear's pinned schema", () => {
  assert.throws(
    () => validateProductionDocumentsAgainstSchema("type Query { viewer: String }"),
    /does not match the repository-pinned artifact/,
  );
});

test(
  "production GraphQL documents conform to Linear's pinned schema",
  { skip: process.env["E2E"] !== "true" },
  async () => {
    const receipt = await runLinearSchemaConformance();
    assert.deepEqual(receipt, {
      schemaCommit: LINEAR_SCHEMA_COMMIT,
      schemaSha256: LINEAR_SCHEMA_SHA256,
      schemaBytes: LINEAR_SCHEMA_BYTES,
      readDocumentCount: 5,
      retainedMutationDocumentCount: 4,
      e2eFixtureMutationDocumentCount: 2,
      allDocumentsValid: true,
    });
  },
);
